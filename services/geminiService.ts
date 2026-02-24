import {
  KnowledgeReference,
  MentionedProduct,
  PolishedVariant,
  PolishRequest,
  PolishResponse,
  ProductRecommendation,
  RecommendationConfidence,
  TokenRiskLevel,
  Tone,
} from "../types";
import { retrieveCatalogContext, ScoredCatalogChunk } from "./catalogKnowledgeService";

export const MODEL_NAME = "google/gemini-3-flash-preview";

const PROXY_API_URL = "/api/polish";
const CATALOG_URL_BASE = "https://ec.dgs.com.tw/catalog/catalog.html#p=";
const DEFAULT_KNOWLEDGE_CHUNKS = 5;
const FALLBACK_REFERENCE_LIMIT = 3;
const ESTIMATED_OUTPUT_TOKENS = 1200;
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

function buildKnowledgeContextBlock(knowledgeChunks: ScoredCatalogChunk[]): string {
  if (knowledgeChunks.length === 0) {
    return "No matching catalog context was found.";
  }

  return knowledgeChunks
    .map(
      (chunk, index) => `
[K${index + 1}] section=${chunk.section ?? "-"} page=${chunk.page} score=${chunk.score}
sourceUrl=${chunk.sourceUrl}
catalogUrl=${chunk.catalogUrl}
content:
${chunk.text}
`.trim()
    )
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

function buildMentionedProductsFooter(mentionedProducts: MentionedProduct[] | undefined): string {
  if (!mentionedProducts || mentionedProducts.length === 0) {
    return "";
  }

  const lines = ["🟦 推薦產品"];
  for (const product of mentionedProducts) {
    const modelPart = product.models.length > 0 ? `（${product.models.join("、")}）` : "";
    lines.push(`${product.name}${modelPart}：${buildCatalogProductUrl(product.page)}`);
  }

  return lines.join("\n");
}

function appendMentionedProductsFooter(content: string, mentionedProducts: MentionedProduct[] | undefined): string {
  const footer = buildMentionedProductsFooter(mentionedProducts);
  if (!footer) {
    return content;
  }
  if (content.includes("\n推薦產品") || content.includes("🟦 推薦產品")) {
    return content;
  }
  return `${content.trim()}\n\n${footer}`;
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

  const knowledgeLimit =
    typeof maxKnowledgeChunks === "number" && Number.isInteger(maxKnowledgeChunks) && maxKnowledgeChunks > 0
      ? maxKnowledgeChunks
      : DEFAULT_KNOWLEDGE_CHUNKS;
  const selectedSections = normalizeSections(catalogSections);
  const knowledgeEnabled = useCatalogKnowledge && selectedSections.length > 0;

  const retrievalResult = knowledgeEnabled
    ? await retrieveCatalogContext(sourceText, knowledgeLimit, selectedSections, { enableFallbackRetrieval })
    : {
        selectedSections,
        scopedChunks: 0,
        items: [],
        queryDiagnostics: {
          modelTokens: [],
          alphaNumTokens: [],
          chineseTerms: [],
          fallbackUsed: false,
          noHitReason: "未啟用型錄知識檢索。",
        },
      };
  const matchedKnowledgeChunks = retrievalResult.items;
  const fallbackReferences = toFallbackReferences(matchedKnowledgeChunks);
  const knowledgeBlock = buildKnowledgeContextBlock(matchedKnowledgeChunks);
  const matchedPages = new Set(matchedKnowledgeChunks.map((chunk) => chunk.page));
  const pageSectionMap = new Map<number, string>();
  const pageEvidenceMap = new Map<number, string>();

  for (const chunk of matchedKnowledgeChunks) {
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

    CATALOG CONTEXT RULES:
    1. You may use the provided "Catalog Context" only when relevant to the user's technical text.
    2. Never fabricate catalog data that is not in the context.
    3. If no catalog context is relevant, keep references as an empty array and mentionedProducts as an empty array.
    4. mentionedProducts must list products explicitly mentioned in that variant content.
    5. page in mentionedProducts must come from the provided context.
    6. Do NOT include standalone lines like "型錄參考：第X頁" in content.

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

    Catalog Context:
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

    const validationResult = validateMentionedProductsInVariants(normalizedVariants, matchedKnowledgeChunks, strictGrounding);

    const variantsWithFooter = validationResult.variants.map((variant) => {
      const contentWithoutCitations = stripCatalogCitationLines(variant.content);
      const contentWithProducts = appendMentionedProductsFooter(
        contentWithoutCitations,
        knowledgeEnabled ? variant.mentionedProducts : []
      );
      return {
        ...variant,
        content: contentWithProducts,
      };
    });

    const recommendedProducts = buildRecommendationsFromVariants(validationResult.variants, pageSectionMap, pageEvidenceMap);

    return {
      variants: variantsWithFooter,
      recommendedProducts,
      knowledge: {
        enabled: knowledgeEnabled,
        selectedSections,
        scopedChunks: retrievalResult.scopedChunks,
        matchedChunks: matchedKnowledgeChunks.length,
        retrievedTopK: matchedKnowledgeChunks.length,
        matchedPages: [...matchedPages].sort((a, b) => a - b),
        tokenEstimate,
        queryDiagnostics: retrievalResult.queryDiagnostics,
        validation: {
          rejectedProducts: validationResult.rejectedProducts,
          acceptedProducts: validationResult.acceptedProducts,
        },
        topChunks: matchedKnowledgeChunks.map((chunk) => ({
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

