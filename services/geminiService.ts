import {
  KnowledgeReference,
  MentionedProduct,
  PolishedVariant,
  PolishRequest,
  PolishResponse,
  ProductRecommendation,
  RecommendationSource,
  RecommendationConfidence,
  TokenRiskLevel,
  Tone,
} from "../types";
import { retrieveCatalogContext, ScoredCatalogChunk } from "./catalogKnowledgeService";
import { retrieveProductListContext, ScoredProductListItem } from "./productListKnowledgeService";

export const MODEL_NAME = "google/gemini-3-flash-preview";

const PROXY_API_URL = "/api/polish";
const CATALOG_URL_BASE = "https://ec.dgs.com.tw/catalog/catalog.html#p=";
const DEFAULT_KNOWLEDGE_CHUNKS = 5;
const MERGED_CANDIDATE_POOL_SIZE = 8;
const FALLBACK_REFERENCE_LIMIT = 3;
const ESTIMATED_OUTPUT_TOKENS = 1200;
const MAX_SOURCE_TEXT_LENGTH = 1000;
const CATALOG_WEIGHT = 0.4;
const PRODUCT_LIST_WEIGHT = 0.6;
const EXACT_MATCH_BOOST = 0.1;
const TONE_ORDER: Tone[] = [Tone.CONCISE, Tone.STANDARD, Tone.FORMAL];

interface ProductValidationIssue {
  name: string;
  page: number;
  reason: string;
}

interface ProductValidationResult {
  variants: PolishedVariant[];
  rejectedProducts: ProductValidationIssue[];
  acceptedProducts: number;
}

type RetrievalSource = "catalog" | "product_list";

interface MergedRetrievalItem {
  key: string;
  source: RetrievalSource;
  score: number;
  matchedTerms: string[];
  page?: number;
  finalCode?: string;
  url: string;
  preview: string;
  charCount: number;
  catalogChunk?: ScoredCatalogChunk;
  productItem?: ScoredProductListItem;
}

function normalizeSections(sections: string[] | undefined): string[] {
  if (!Array.isArray(sections)) {
    return [];
  }
  return [...new Set(sections.map((section) => String(section).trim().toUpperCase()).filter((section) => /^[A-Z]$/.test(section)))];
}

function parseConfidence(value: unknown): RecommendationConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function normalizeModel(value: string): string {
  return normalizeForMatch(value).replace(/[^a-z0-9]/g, "");
}

function normalizeName(value: string): string {
  return normalizeForMatch(value).replace(/\s+/g, "");
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeScore(value: number, min: number, max: number): number {
  if (max <= min) {
    return value > 0 ? 1 : 0;
  }
  return (value - min) / (max - min);
}

function getScoreBounds(values: number[]): { min: number; max: number } {
  if (values.length === 0) {
    return { min: 0, max: 0 };
  }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function hasExactTokenMatch(text: string, tokens: string[]): boolean {
  const normalizedText = normalizeForMatch(text);
  return tokens.some((token) => token.length >= 3 && normalizedText.includes(token));
}

function toFallbackReferences(knowledgeChunks: ScoredCatalogChunk[]): KnowledgeReference[] {
  return knowledgeChunks.slice(0, FALLBACK_REFERENCE_LIMIT).map((chunk) => ({
    source: chunk.source,
    page: chunk.page,
    excerpt: chunk.text.slice(0, 120),
    sourceUrl: chunk.sourceUrl,
    catalogUrl: chunk.catalogUrl,
  }));
}

function normalizeReferences(rawReferences: unknown, fallbackReferences: KnowledgeReference[]): KnowledgeReference[] {
  if (!Array.isArray(rawReferences)) {
    return fallbackReferences;
  }

  const normalized = rawReferences
    .map((reference) => {
      if (
        typeof reference !== "object" ||
        reference === null ||
        typeof (reference as Record<string, unknown>).source !== "string" ||
        typeof (reference as Record<string, unknown>).page !== "number"
      ) {
        return null;
      }
      const row = reference as Record<string, unknown>;
      return {
        source: String(row.source),
        page: Number(row.page),
        excerpt: typeof row.excerpt === "string" ? row.excerpt : undefined,
        sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : undefined,
        catalogUrl: typeof row.catalogUrl === "string" ? row.catalogUrl : undefined,
      } as KnowledgeReference;
    })
    .filter((row): row is KnowledgeReference => Boolean(row));

  return normalized.length > 0 ? normalized : fallbackReferences;
}

function normalizeMentionedProducts(rawMentionedProducts: unknown): MentionedProduct[] {
  if (!Array.isArray(rawMentionedProducts)) {
    return [];
  }

  const dedupe = new Set<string>();
  const products: MentionedProduct[] = [];

  for (const item of rawMentionedProducts) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const page = Number(row.page);
    if (!name || !Number.isInteger(page)) {
      continue;
    }

    const rawModels = Array.isArray(row.models)
      ? row.models
      : typeof row.model === "string"
        ? [row.model]
        : [];
    const models = [...new Set(rawModels.map((model) => String(model).trim()).filter(Boolean))];

    const key = `${name.toLowerCase()}|${page}|${models.slice().sort().join("|")}`;
    if (dedupe.has(key)) {
      continue;
    }

    dedupe.add(key);
    products.push({
      name,
      models,
      page,
      reason: typeof row.reason === "string" ? row.reason.trim() : undefined,
      confidence: parseConfidence(row.confidence),
    });
  }

  return products;
}

function normalizePolishVariants(raw: unknown, fallbackReferences: KnowledgeReference[]): PolishedVariant[] {
  const rawVariants = Array.isArray((raw as { variants?: unknown[] } | undefined)?.variants)
    ? ((raw as { variants: unknown[] }).variants as unknown[])
    : [];

  const variantMap = new Map<string, Record<string, unknown>>();
  for (const variant of rawVariants) {
    if (typeof variant === "object" && variant !== null) {
      const row = variant as Record<string, unknown>;
      variantMap.set(String(row.tone), row);
    }
  }

  return TONE_ORDER.map((tone) => {
    const rawVariant = variantMap.get(tone);
    const content = typeof rawVariant?.content === "string" ? rawVariant.content.trim() : "";

    if (!content) {
      throw new Error(`Model output is missing content for tone: ${tone}`);
    }

    return {
      tone,
      subject: typeof rawVariant?.subject === "string" ? rawVariant.subject : undefined,
      content,
      references: normalizeReferences(rawVariant?.references, fallbackReferences),
      mentionedProducts: normalizeMentionedProducts(rawVariant?.mentionedProducts),
    };
  });
}

export function mergeRetrievalContexts(
  catalogChunks: ScoredCatalogChunk[],
  productItems: ScoredProductListItem[],
  limit: number,
  exactTokens: string[]
): MergedRetrievalItem[] {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_KNOWLEDGE_CHUNKS;

  const catalogScoreBounds = getScoreBounds(catalogChunks.map((chunk) => chunk.score));
  const productScoreBounds = getScoreBounds(productItems.map((item) => item.score));

  const catalogCandidates: MergedRetrievalItem[] = catalogChunks.map((chunk) => {
    const normalized = normalizeScore(chunk.score, catalogScoreBounds.min, catalogScoreBounds.max);
    const exactBoost = hasExactTokenMatch(chunk.text, exactTokens) ? EXACT_MATCH_BOOST : 0;
    return {
      key: `catalog:${chunk.id}`,
      source: "catalog",
      score: CATALOG_WEIGHT * normalized + exactBoost,
      matchedTerms: chunk.matchedTerms,
      page: chunk.page,
      url: chunk.catalogUrl,
      preview: buildEvidenceExcerpt(chunk.text),
      charCount: chunk.charCount,
      catalogChunk: chunk,
    };
  });

  const productCandidates: MergedRetrievalItem[] = productItems.map((item) => {
    const normalized = normalizeScore(item.score, productScoreBounds.min, productScoreBounds.max);
    const exactBoost = hasExactTokenMatch(`${item.finalCode} ${item.searchText}`, exactTokens) ? EXACT_MATCH_BOOST : 0;
    return {
      key: `product:${item.headCode}:${item.finalCode}:${item.finalUrl}`,
      source: "product_list",
      score: PRODUCT_LIST_WEIGHT * normalized + exactBoost,
      matchedTerms: item.matchedTerms,
      finalCode: item.finalCode,
      url: item.finalUrl,
      preview: buildEvidenceExcerpt(item.description || item.searchText),
      charCount: item.searchText.length,
      productItem: item,
    };
  });

  const ranked = [...catalogCandidates, ...productCandidates].sort((left, right) => right.score - left.score);
  const selected: MergedRetrievalItem[] = [];
  const selectedKeys = new Set<string>();

  if (catalogCandidates.length > 0 && productCandidates.length > 0) {
    const topProduct = ranked.find((item) => item.source === "product_list");
    const topCatalog = ranked.find((item) => item.source === "catalog");
    for (const item of [topProduct, topCatalog]) {
      if (item && !selectedKeys.has(item.key) && selected.length < normalizedLimit) {
        selected.push(item);
        selectedKeys.add(item.key);
      }
    }
  }

  for (const item of ranked) {
    if (selected.length >= normalizedLimit) {
      break;
    }
    if (selectedKeys.has(item.key)) {
      continue;
    }
    selected.push(item);
    selectedKeys.add(item.key);
  }

  return selected;
}

function buildMergedKnowledgeContextBlock(items: MergedRetrievalItem[]): string {
  if (items.length === 0) {
    return "No matching context was found.";
  }

  return items
    .map((item, index) => {
      if (item.source === "catalog" && item.catalogChunk) {
        return `
[M${index + 1}] source=catalog section=${item.catalogChunk.section ?? "-"} page=${item.catalogChunk.page} score=${item.score.toFixed(3)}
catalogUrl=${item.catalogChunk.catalogUrl}
sourceUrl=${item.catalogChunk.sourceUrl}
matchedTerms=${item.catalogChunk.matchedTerms.join(", ") || "-"}
content:
${item.catalogChunk.text}
`.trim();
      }

      if (item.source === "product_list" && item.productItem) {
        return `
[M${index + 1}] source=product_list class3=${item.productItem.class3} headCode=${item.productItem.headCode} finalCode=${item.productItem.finalCode} score=${item.score.toFixed(3)}
finalUrl=${item.productItem.finalUrl}
name=${item.productItem.name}
matchedTerms=${item.productItem.matchedTerms.join(", ") || "-"}
description=${item.productItem.description}
specs=${item.productItem.searchSpecs.slice(0, 6).join("; ")}
`.trim();
      }

      return `[M${index + 1}] source=${item.source} score=${item.score.toFixed(3)} url=${item.url}`;
    })
    .join("\n\n");
}

function stripCatalogCitationLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*型錄參考[:：]/.test(line.trim()))
    .join("\n")
    .trim();
}

function buildCatalogProductUrl(page: number): string {
  return `${CATALOG_URL_BASE}${page}`;
}

function buildRecommendationFooter(recommendations: ProductRecommendation[]): string {
  if (recommendations.length === 0) {
    return "";
  }

  const lines = ["🟦 推薦產品"];
  for (const product of recommendations) {
    const modelPart = product.models.length > 0 ? `（${product.models.join("、")}）` : "";
    const codePart = product.finalCode ? `（${product.finalCode}）` : "";
    const link = product.productUrl || product.catalogUrl;
    if (!link) {
      continue;
    }

    if (product.source === "product_list" || product.source === "both") {
      lines.push(`${product.name}${codePart || modelPart}：${link}`);
    } else {
      lines.push(`${product.name}${modelPart}：${link}`);
    }
  }

  return lines.join("\n");
}

function appendFooter(content: string, footer: string): string {
  if (!footer) {
    return content;
  }
  if (content.includes("\n推薦產品") || content.includes("🟦 推薦產品")) {
    return content;
  }
  return `${content.trim()}\n\n${footer}`;
}

function appendRecommendationFooter(content: string, recommendations: ProductRecommendation[]): string {
  const footer = buildRecommendationFooter(recommendations);
  if (!footer) {
    return content;
  }
  return appendFooter(content, footer);
}

function getTokenRiskLevel(totalTokens: number): TokenRiskLevel {
  if (totalTokens > 6000) {
    return "high";
  }
  if (totalTokens > 4000) {
    return "medium";
  }
  return "low";
}

function estimateTokenUsage(systemInstruction: string, userPromptWithoutContext: string, contextBlock: string) {
  const inputChars = systemInstruction.length + userPromptWithoutContext.length + contextBlock.length;
  const contextChars = contextBlock.length;
  const estimatedInputTokens = Math.ceil(inputChars / 4);
  const estimatedOutputTokens = ESTIMATED_OUTPUT_TOKENS;
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const riskLevel = getTokenRiskLevel(estimatedTotalTokens);
  const warning = riskLevel === "high" ? "估算 token 過高，建議縮小分區或降低 topK。" : null;

  return {
    inputChars,
    contextChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    riskLevel,
    warning,
  };
}

function confidenceScore(confidence: RecommendationConfidence): number {
  if (confidence === "high") {
    return 3;
  }
  if (confidence === "medium") {
    return 2;
  }
  return 1;
}

function pickHigherConfidence(current: RecommendationConfidence, next: RecommendationConfidence): RecommendationConfidence {
  return confidenceScore(next) > confidenceScore(current) ? next : current;
}

function buildEvidenceExcerpt(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 120)}...`;
}

export function validateMentionedProductsInVariants(
  variants: PolishedVariant[],
  matchedKnowledgeChunks: ScoredCatalogChunk[],
  strictGrounding: boolean
): ProductValidationResult {
  const pageTextMap = new Map<number, string>();
  const matchedPages = new Set<number>();

  for (const chunk of matchedKnowledgeChunks) {
    matchedPages.add(chunk.page);
    pageTextMap.set(chunk.page, `${pageTextMap.get(chunk.page) ?? ""}\n${chunk.text}`);
  }

  if (!strictGrounding) {
    const acceptedProducts = variants.reduce((sum, variant) => sum + (variant.mentionedProducts?.length ?? 0), 0);
    return { variants, rejectedProducts: [], acceptedProducts };
  }

  const rejectedProducts: ProductValidationIssue[] = [];
  let acceptedProducts = 0;

  const validatedVariants = variants.map((variant) => {
    const products = variant.mentionedProducts ?? [];
    const validatedProducts: MentionedProduct[] = [];

    for (const product of products) {
      if (!matchedPages.has(product.page)) {
        rejectedProducts.push({
          name: product.name,
          page: product.page,
          reason: "頁碼不在本次命中範圍",
        });
        continue;
      }

      const pageText = (pageTextMap.get(product.page) ?? "").toUpperCase();
      const matchedName = product.name ? pageText.includes(product.name.toUpperCase()) : false;
      const matchedModels = product.models.filter((model) => pageText.includes(model.toUpperCase()));

      if (!matchedName && matchedModels.length === 0) {
        rejectedProducts.push({
          name: product.name,
          page: product.page,
          reason: "名稱或型號無法在命中 chunk 內驗證",
        });
        continue;
      }

      validatedProducts.push({
        ...product,
        models: matchedModels,
      });
      acceptedProducts += 1;
    }

    return {
      ...variant,
      mentionedProducts: validatedProducts,
    };
  });

  return {
    variants: validatedVariants,
    rejectedProducts,
    acceptedProducts,
  };
}

export function buildRecommendationsFromVariants(
  variants: PolishedVariant[],
  pageSectionMap: Map<number, string>,
  pageEvidenceMap: Map<number, string>
): ProductRecommendation[] {
  const grouped = new Map<
    string,
    {
      name: string;
      models: string[];
      page: number;
      section: string;
      reason: string;
      confidence: RecommendationConfidence;
      tones: Set<Tone>;
      evidenceExcerpt: string;
    }
  >();

  for (const variant of variants) {
    const products = variant.mentionedProducts ?? [];
    for (const product of products) {
      const normalizedModels = [...new Set(product.models.map((model) => model.trim()).filter(Boolean))];
      const key = `${product.name.toLowerCase()}|${product.page}|${normalizedModels.slice().sort().join("|")}`;
      const confidence = parseConfidence(product.confidence);
      const reason = product.reason?.trim() || `來自 ${variant.tone} 回覆內容`;
      const evidenceExcerpt = pageEvidenceMap.get(product.page) ?? "";

      if (!grouped.has(key)) {
        grouped.set(key, {
          name: product.name,
          models: normalizedModels,
          page: product.page,
          section: pageSectionMap.get(product.page) ?? "-",
          reason,
          confidence,
          tones: new Set([variant.tone]),
          evidenceExcerpt,
        });
        continue;
      }

      const existing = grouped.get(key);
      if (!existing) {
        continue;
      }
      existing.tones.add(variant.tone);
      existing.confidence = pickHigherConfidence(existing.confidence, confidence);
      if (existing.reason.length < reason.length) {
        existing.reason = reason;
      }
      if (!existing.evidenceExcerpt && evidenceExcerpt) {
        existing.evidenceExcerpt = evidenceExcerpt;
      }
    }
  }

  const sorted = [...grouped.values()].sort((left, right) => {
    const confidenceDiff = confidenceScore(right.confidence) - confidenceScore(left.confidence);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }
    const toneDiff = right.tones.size - left.tones.size;
    if (toneDiff !== 0) {
      return toneDiff;
    }
    return left.page - right.page;
  });

  return sorted.slice(0, 3).map((item, index) => ({
    rank: (index + 1) as 1 | 2 | 3,
    name: item.name,
    models: item.models,
    section: item.section,
    page: item.page,
    reason: item.reason,
    catalogUrl: buildCatalogProductUrl(item.page),
    evidenceExcerpt: item.evidenceExcerpt,
    confidence: item.confidence,
    tones: [...item.tones],
    source: "catalog" as RecommendationSource,
  }));
}

function scoreToConfidence(score: number): RecommendationConfidence {
  if (score >= 24) {
    return "high";
  }
  if (score >= 12) {
    return "medium";
  }
  return "low";
}

function buildReasonFromMatchedTerms(matchedTerms: string[]): string {
  if (matchedTerms.length === 0) {
    return "與查詢內容語義接近";
  }
  return `命中關鍵詞：${matchedTerms.slice(0, 4).join("、")}`;
}

export function buildRecommendationsFromProductList(items: ScoredProductListItem[]): ProductRecommendation[] {
  return items.slice(0, 3).map((item, index) => ({
    rank: (index + 1) as 1 | 2 | 3,
    name: item.name,
    models: [item.finalCode],
    reason: buildReasonFromMatchedTerms(item.matchedTerms),
    productUrl: item.finalUrl,
    evidenceExcerpt: buildEvidenceExcerpt(item.description || item.searchText),
    confidence: scoreToConfidence(item.score),
    tones: [Tone.STANDARD],
    source: "product_list",
    finalCode: item.finalCode,
    headCode: item.headCode,
    section: item.class3,
  }));
}

function hasModelOverlap(left: ProductRecommendation, right: ProductRecommendation): boolean {
  const leftModels = uniqueValues([...(left.models ?? []), left.finalCode ?? ""].map((value) => normalizeModel(value)));
  const rightModels = uniqueValues([...(right.models ?? []), right.finalCode ?? ""].map((value) => normalizeModel(value)));
  return leftModels.some((model) => rightModels.includes(model));
}

function isSameRecommendedProduct(catalogItem: ProductRecommendation, productItem: ProductRecommendation): boolean {
  if (hasModelOverlap(catalogItem, productItem)) {
    return true;
  }

  const normalizedCatalogName = normalizeName(catalogItem.name);
  const normalizedProductName = normalizeName(productItem.name);

  return Boolean(
    normalizedCatalogName &&
      normalizedProductName &&
      (normalizedCatalogName.includes(normalizedProductName) || normalizedProductName.includes(normalizedCatalogName))
  );
}

function recommendationScore(item: ProductRecommendation): number {
  const sourceWeight = item.source === "both" ? 3 : item.source === "product_list" ? 2 : 1;
  return sourceWeight * 10 + confidenceScore(item.confidence) * 2 + (item.productUrl ? 1 : 0);
}

export function mergeRecommendations(
  catalogRecommendations: ProductRecommendation[],
  productListRecommendations: ProductRecommendation[]
): ProductRecommendation[] {
  const usedProductIndexes = new Set<number>();
  const merged: ProductRecommendation[] = [];

  for (const catalogItem of catalogRecommendations) {
    const productIndex = productListRecommendations.findIndex(
      (productItem, index) => !usedProductIndexes.has(index) && isSameRecommendedProduct(catalogItem, productItem)
    );

    if (productIndex < 0) {
      merged.push(catalogItem);
      continue;
    }

    const productItem = productListRecommendations[productIndex];
    usedProductIndexes.add(productIndex);
    merged.push({
      ...catalogItem,
      models: uniqueValues([...catalogItem.models, ...productItem.models]),
      source: "both",
      productUrl: productItem.productUrl,
      finalCode: productItem.finalCode ?? catalogItem.finalCode,
      headCode: productItem.headCode ?? catalogItem.headCode,
      evidenceExcerpt: catalogItem.evidenceExcerpt || productItem.evidenceExcerpt,
      reason: catalogItem.reason || productItem.reason,
      confidence: pickHigherConfidence(catalogItem.confidence, productItem.confidence),
      tones: [...new Set([...catalogItem.tones, ...productItem.tones])],
    });
  }

  for (const [index, productItem] of productListRecommendations.entries()) {
    if (!usedProductIndexes.has(index)) {
      merged.push(productItem);
    }
  }

  return merged
    .sort((left, right) => recommendationScore(right) - recommendationScore(left))
    .slice(0, 3)
    .map((item, index) => ({
      ...item,
      rank: (index + 1) as 1 | 2 | 3,
    }));
}

export const polishText = async (request: PolishRequest): Promise<PolishResponse> => {
  const {
    sourceText,
    customerName,
    customerTitle,
    useCatalogKnowledge = true,
    catalogSections,
    maxKnowledgeChunks,
    strictGrounding = true,
    enableFallbackRetrieval = true,
  } = request;

  if (sourceText.length > MAX_SOURCE_TEXT_LENGTH) {
    throw new Error(`技術回覆內容最多 ${MAX_SOURCE_TEXT_LENGTH} 字，請縮短後再試。`);
  }

  const knowledgeLimit =
    typeof maxKnowledgeChunks === "number" && Number.isInteger(maxKnowledgeChunks) && maxKnowledgeChunks > 0
      ? maxKnowledgeChunks
      : DEFAULT_KNOWLEDGE_CHUNKS;
  const candidateLimit = Math.max(knowledgeLimit, MERGED_CANDIDATE_POOL_SIZE);
  const selectedSections = normalizeSections(catalogSections);
  const knowledgeEnabled = useCatalogKnowledge && selectedSections.length > 0;

  const [catalogResult, productListResult] = knowledgeEnabled
    ? await Promise.all([
        retrieveCatalogContext(sourceText, candidateLimit, selectedSections, { enableFallbackRetrieval }),
        retrieveProductListContext(sourceText, candidateLimit, selectedSections),
      ])
    : [
        {
          selectedSections,
          scopedChunks: 0,
          items: [] as ScoredCatalogChunk[],
          queryDiagnostics: {
            modelTokens: [] as string[],
            alphaNumTokens: [] as string[],
            chineseTerms: [] as string[],
            fallbackUsed: false,
            noHitReason: "未啟用型錄知識檢索。",
          },
        },
        {
          selectedSections,
          scopedItems: 0,
          items: [] as ScoredProductListItem[],
          accessoryIntent: false,
        },
      ];

  const matchedCatalogChunks = catalogResult.items;
  const matchedProductListItems = productListResult.items;
  const exactTokens = uniqueValues([
    ...catalogResult.queryDiagnostics.modelTokens,
    ...catalogResult.queryDiagnostics.alphaNumTokens.filter((token) => /\d/.test(token)),
  ]).map((token) => normalizeForMatch(token));
  const mergedContextItems = knowledgeEnabled
    ? mergeRetrievalContexts(matchedCatalogChunks, matchedProductListItems, knowledgeLimit, exactTokens)
    : [];
  const mergedCatalogChunks = mergedContextItems
    .filter((item): item is MergedRetrievalItem & { catalogChunk: ScoredCatalogChunk } => item.source === "catalog" && Boolean(item.catalogChunk))
    .map((item) => item.catalogChunk);
  const mergedProductItems = mergedContextItems
    .filter((item): item is MergedRetrievalItem & { productItem: ScoredProductListItem } => item.source === "product_list" && Boolean(item.productItem))
    .map((item) => item.productItem);

  const fallbackReferences = toFallbackReferences(mergedCatalogChunks);
  const knowledgeBlock = buildMergedKnowledgeContextBlock(mergedContextItems);
  const matchedPages = new Set(mergedCatalogChunks.map((chunk) => chunk.page));
  const pageSectionMap = new Map<number, string>();
  const pageEvidenceMap = new Map<number, string>();

  for (const chunk of mergedCatalogChunks) {
    pageSectionMap.set(chunk.page, chunk.section ?? "-");
    if (!pageEvidenceMap.has(chunk.page)) {
      pageEvidenceMap.set(chunk.page, buildEvidenceExcerpt(chunk.text));
    }
  }

  const greetingInstruction =
    customerName || customerTitle
      ? `Address the customer as "${customerName || ""}${customerTitle || ""}".`
      : `Use a generic professional greeting (e.g., "您好，感謝您的詢問").`;

  const systemInstruction = `
    You are a specialized "Technical Customer Service Polishing Assistant".
    Your goal is to take raw technical notes from engineers and convert them into polite, professional customer service replies in Traditional Chinese (繁體中文).

    CRITICAL RULES (Hard Constraints):
    1. Term Integrity: DO NOT change, translate, or remove any technical terms, model numbers (e.g., ABC-1234), values (e.g., 0.22 μm), units, or part numbers.
    2. Language: Output MUST be in Traditional Chinese (Taiwan).
    3. Formatting:
       - Smart Paragraphing: Use line breaks and readable paragraph blocks.
       - Auto-Bulleting: If content includes specifications, steps, multiple issues, or item lists, use bullet points (•) or numbered lists (1., 2.).
    4. Tone Variance: Generate exactly 3 versions:
       - Concise (精簡): Direct, efficient, bullet-oriented.
       - Standard (標準): Balanced and friendly.
       - Formal (正式): Highly respectful and report-like.
    5. Structure:
       - ${greetingInstruction}
       - Include technical content.
       - End with a polite closing sentence.

    KNOWLEDGE CONTEXT RULES:
    1. You may use the provided context only when relevant to the user's technical text.
    2. Never fabricate product data that is not in the context.
    3. If no context is relevant, keep references as an empty array and mentionedProducts as an empty array.
    4. mentionedProducts must list products explicitly mentioned in that variant content.
    5. For catalog references, page in mentionedProducts must come from the provided context.
    6. For product-list references, you may include productUrl and finalCode in mentionedProducts.
    7. Do NOT include standalone lines like "型錄參考：第X頁" in content.

    RESPONSE FORMAT:
    You must output a strictly valid JSON object matching this structure:
    {
      "variants": [
        {
          "tone": "concise",
          "subject": "Email Subject",
          "content": "Full response content...",
          "references": [
            {
              "source": "dgs_ecatalog",
              "page": 178,
              "excerpt": "Quoted snippet from catalog context",
              "sourceUrl": "https://.../page178.html",
              "catalogUrl": "https://.../catalog.html#p=178"
            }
          ],
          "mentionedProducts": [
            {
              "name": "產品名稱",
              "models": ["169411", "169611"],
              "page": 462,
              "productUrl": "https://dgs.com.tw/product/HEAD/FINAL",
              "finalCode": "AK14000-00010",
              "reason": "簡短推薦理由",
              "confidence": "high"
            }
          ]
        },
        {
          "tone": "standard",
          "subject": "Email Subject",
          "content": "Full response content...",
          "references": [],
          "mentionedProducts": []
        },
        {
          "tone": "formal",
          "subject": "Email Subject",
          "content": "Full response content...",
          "references": [],
          "mentionedProducts": []
        }
      ]
    }
  `;

  const userPromptWithoutContext = `
    Raw Technical Text:
    """
    ${sourceText}
    """

    Selected Catalog Sections:
    ${selectedSections.length > 0 ? selectedSections.join(", ") : "none"}
  `;

  const userPrompt = `
    ${userPromptWithoutContext}

    Knowledge Context:
    """
    ${knowledgeBlock}
    """

    Please generate the 3 variants now in JSON.
  `;

  const tokenEstimate = estimateTokenUsage(systemInstruction, userPromptWithoutContext, knowledgeBlock);

  try {
    const response = await fetch(PROXY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      let errorBody = "";
      try {
        const parsed = await response.json();
        errorBody = JSON.stringify(parsed);
      } catch {
        errorBody = await response.text();
      }
      throw new Error(`Proxy API Error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();
    const contentString = data.choices?.[0]?.message?.content;

    if (!contentString) {
      throw new Error("Empty response from AI Provider");
    }

    const parsed = JSON.parse(contentString);
    const normalizedVariants = normalizePolishVariants(parsed, fallbackReferences);

    const validationResult = validateMentionedProductsInVariants(normalizedVariants, mergedCatalogChunks, strictGrounding);
    const productListRecommendations = mergedProductItems.length > 0 ? buildRecommendationsFromProductList(mergedProductItems) : [];
    const catalogRecommendations = buildRecommendationsFromVariants(validationResult.variants, pageSectionMap, pageEvidenceMap);
    const recommendedProducts = mergeRecommendations(catalogRecommendations, productListRecommendations);

    const variantsWithFooter = validationResult.variants.map((variant) => {
      const contentWithoutCitations = stripCatalogCitationLines(variant.content);
      const contentWithProducts = appendRecommendationFooter(contentWithoutCitations, recommendedProducts);
      return {
        ...variant,
        content: contentWithProducts,
      };
    });

    return {
      variants: variantsWithFooter,
      recommendedProducts,
      knowledge: {
        retrievalMode: "dual_merge",
        enabled: knowledgeEnabled,
        selectedSections,
        scopedChunks: catalogResult.scopedChunks,
        matchedChunks: mergedCatalogChunks.length,
        retrievedTopK: mergedContextItems.length,
        sourceStats: {
          catalogMatched: matchedCatalogChunks.length,
          productListMatched: matchedProductListItems.length,
        },
        matchedPages: [...matchedPages].sort((a, b) => a - b),
        mergedContext: mergedContextItems.map((item) => ({
          source: item.source,
          score: Number(item.score.toFixed(3)),
          matchedTerms: item.matchedTerms,
          page: item.page,
          finalCode: item.finalCode,
          url: item.url,
          preview: item.preview,
          charCount: item.charCount,
        })),
        tokenEstimate,
        queryDiagnostics: catalogResult.queryDiagnostics,
        validation: {
          rejectedProducts: validationResult.rejectedProducts,
          acceptedProducts: validationResult.acceptedProducts,
        },
        productList: {
          enabled: knowledgeEnabled,
          fallbackUsed: false,
          matchedItems: matchedProductListItems.length,
          topItems: matchedProductListItems.map((item) => ({
            finalCode: item.finalCode,
            headCode: item.headCode,
            name: item.name,
            sourceLabel: item.sourceLabel,
            score: item.score,
            matchedTerms: item.matchedTerms,
            productUrl: item.finalUrl,
          })),
        },
        topChunks: mergedCatalogChunks.map((chunk) => ({
          id: chunk.id,
          section: chunk.section,
          page: chunk.page,
          text: chunk.text,
          sourceUrl: chunk.sourceUrl,
          catalogUrl: chunk.catalogUrl,
          score: chunk.score,
          matchedTerms: chunk.matchedTerms,
          charCount: chunk.charCount,
        })),
      },
    };
  } catch (error) {
    console.error("AI Service Error:", error);
    throw error;
  }
};



