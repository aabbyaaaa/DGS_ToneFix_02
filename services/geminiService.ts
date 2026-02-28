import {
  PolishedVariant,
  PolishRequest,
  PolishResponse,
  ProductRecommendation,
  RecommendationConfidence,
  TokenRiskLevel,
  Tone,
} from "../types";
import { ScoredProductListItem, retrieveProductListContext } from "./productListKnowledgeService";

export const MODEL_NAME = "google/gemini-3-flash-preview";

const PROXY_API_URL = "/api/polish";
const DEFAULT_KNOWLEDGE_CHUNKS = 5;
const ESTIMATED_OUTPUT_TOKENS = 1200;
const MAX_SOURCE_TEXT_LENGTH = 1000;
const TONE_ORDER: Tone[] = [Tone.CONCISE, Tone.STANDARD, Tone.FORMAL];

function parseConfidence(value: unknown): RecommendationConfidence {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
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

function stripBuiltInRecommendationBlock(content: string): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^\s*(🟦\s*)?推薦產品/.test(line.trim()));
  if (startIndex < 0) {
    return content.trim();
  }
  return lines.slice(0, startIndex).join("\n").trim();
}

function buildReasonFromMatchedTerms(matchedTerms: string[]): string {
  if (matchedTerms.length === 0) {
    return "與查詢內容語義接近";
  }
  return `命中關鍵詞：${matchedTerms.slice(0, 4).join("、")}`;
}

function buildEvidenceExcerpt(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 120)}...`;
}

function buildRecommendationFooter(recommendations: ProductRecommendation[]): string {
  if (recommendations.length === 0) {
    return "";
  }

  const lines = ["🟦 推薦產品"];
  for (const product of recommendations) {
    lines.push(`${product.name}（${product.finalCode}）：${product.productUrl}`);
  }
  return lines.join("\n");
}

function appendRecommendationFooter(content: string, recommendations: ProductRecommendation[]): string {
  const cleaned = stripBuiltInRecommendationBlock(content);
  const footer = buildRecommendationFooter(recommendations);
  if (!footer) {
    return cleaned;
  }
  return `${cleaned}\n\n${footer}`;
}

function normalizeAdviceLeadSpacing(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const leadIndex = lines.findIndex((line) => /^工程師(?:的)?建議如下：$/.test(line.trim()));
  if (leadIndex < 0) {
    return content.trim();
  }

  lines[leadIndex] = "工程師的建議如下：";
  if (lines[leadIndex + 1] !== undefined && lines[leadIndex + 1].trim() !== "") {
    lines.splice(leadIndex + 1, 0, "");
  }

  return lines.join("\n").trim();
}

function normalizePolishVariants(raw: unknown): PolishedVariant[] {
  const rawVariants = Array.isArray((raw as { variants?: unknown[] } | undefined)?.variants)
    ? ((raw as { variants: unknown[] }).variants as unknown[])
    : [];
  const variantMap = new Map<string, Record<string, unknown>>();

  for (const variant of rawVariants) {
    if (typeof variant !== "object" || variant === null) {
      continue;
    }
    const row = variant as Record<string, unknown>;
    variantMap.set(String(row.tone), row);
  }

  return TONE_ORDER.map((tone) => {
    const rawVariant = variantMap.get(tone);
    const content = typeof rawVariant?.content === "string" ? rawVariant.content.trim() : "";

    if (!content) {
      throw new Error(`Model output is missing content for tone: ${tone}`);
    }

    return {
      tone,
      subject: typeof rawVariant?.subject === "string" ? rawVariant.subject.trim() : undefined,
      content,
      references: [],
      mentionedProducts: [],
    };
  });
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

function estimateTokenUsage(systemInstruction: string, userPrompt: string) {
  const inputChars = systemInstruction.length + userPrompt.length;
  const estimatedInputTokens = Math.ceil(inputChars / 4);
  const estimatedOutputTokens = ESTIMATED_OUTPUT_TOKENS;
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const riskLevel = getTokenRiskLevel(estimatedTotalTokens);
  const warning = riskLevel === "high" ? "估算 token 過高，建議縮短原始內容。" : null;

  return {
    inputChars,
    contextChars: 0 as const,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    riskLevel,
    warning,
  };
}

export function buildRecommendationsFromProductList(items: ScoredProductListItem[]): ProductRecommendation[] {
  return items.slice(0, 3).map((item, index) => ({
    rank: (index + 1) as 1 | 2 | 3,
    name: item.name,
    models: [item.finalCode],
    section: item.class3,
    reason: buildReasonFromMatchedTerms(item.matchedTerms),
    productUrl: item.finalUrl,
    evidenceExcerpt: buildEvidenceExcerpt(item.description || item.searchText),
    confidence: scoreToConfidence(item.score),
    tones: [Tone.STANDARD],
    source: "product_list",
    finalCode: item.finalCode,
    headCode: item.headCode,
  }));
}

export const polishText = async (request: PolishRequest): Promise<PolishResponse> => {
  const { sourceText, maxKnowledgeChunks } = request;

  if (sourceText.length > MAX_SOURCE_TEXT_LENGTH) {
    throw new Error(`技術回覆內容最多 ${MAX_SOURCE_TEXT_LENGTH} 字，請縮短後再試。`);
  }

  const knowledgeLimit =
    typeof maxKnowledgeChunks === "number" && Number.isInteger(maxKnowledgeChunks) && maxKnowledgeChunks > 0
      ? maxKnowledgeChunks
      : DEFAULT_KNOWLEDGE_CHUNKS;

  const productListResult = await retrieveProductListContext(sourceText, knowledgeLimit);
  const topItems = productListResult.items;
  const recommendedProducts = buildRecommendationsFromProductList(topItems);

  const systemInstruction = `
    You are a specialized "Technical Customer Service Polishing Assistant".
    Your goal is to take raw technical notes from engineers and convert them into polite, professional customer service replies in Traditional Chinese (繁體中文).

    CRITICAL RULES (Hard Constraints):
    1. **Term Integrity**: DO NOT change, translate, or remove any technical terms, model numbers (e.g., ABC-1234), values (e.g., 0.22 μm), units, or part numbers. Verify this strictly.
    2. **Language**: Output MUST be in Traditional Chinese (Taiwan).
    3. **Formatting & Layout Strategy (Crucial)**:
      - **Smart Paragraphing**: Content MUST be broken into logical paragraphs using line breaks. Do not produce a single block of text ("wall of text").
      - **Auto-Bulleting**: REGARDLESS of the tone (Concise, Standard, or Formal), if the content involves technical specifications, step-by-step instructions, multiple distinct issues, or a list of items, YOU MUST use bullet points (•) or numbered lists (1., 2.) to present them clearly.
    4. **Tone Variance**: You must generate exactly 3 versions in this order:
      1) **Concise (精簡)**: Direct, efficient. Heavily favor bullet points for quick reading.
      2) **Standard (標準)**: Balanced, friendly. Use natural paragraphs for explanations and bullet points for specs/steps.
      3) **Formal (正式)**: Highly respectful, professional. Structured paragraphs, but use lists for technical details to improve clarity (like a professional report).
    5. **Structure**:
      - Line 1 must be a natural opening sentence based on the source text context, and include the topic/use case. Do NOT use a fixed template.
      - Line 2 must be exactly: 「工程師的建議如下：」
      - Line 3 must be a blank line.
      - Starting from the next line after Line 2, output technical points immediately as bullets (•) or numbered list.
      - Do NOT add any extra lead-in sentence after Line 2.
      - Forbidden phrases after Line 2: 「相關評估如下」, 「具體建議規格如下」, 「技術要點如下」, 「說明如下」.
      - Do NOT use generic greetings like: 「您好，感謝您的詢問」.
      - Include the technical content (following the formatting rules above).
      - End with a polite closing (e.g., "如需補充資訊，歡迎告知").

    Return strictly valid JSON:
    {
      "variants": [
        { "tone": "concise", "subject": "主旨", "content": "..." },
        { "tone": "standard", "subject": "主旨", "content": "..." },
        { "tone": "formal", "subject": "主旨", "content": "..." }
      ]
    }
  `;

  const userPrompt = `
    Raw Technical Text:
    """
    ${sourceText}
    """

    Please generate the 3 variants now in JSON.
  `;

  const tokenEstimate = estimateTokenUsage(systemInstruction, userPrompt);

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
  const variants = normalizePolishVariants(parsed).map((variant) => {
    const normalizedContent = normalizeAdviceLeadSpacing(variant.content);
    return {
      ...variant,
      content: appendRecommendationFooter(normalizedContent, recommendedProducts),
    };
  });

  return {
    variants,
    recommendedProducts,
    knowledge: {
      enabled: true,
      retrievalMode: "product_list_only",
      scopedItems: productListResult.scopedItems,
      matchedItems: topItems.length,
      retrievedTopK: topItems.length,
      mergedContext: topItems.map((item) => ({
        source: "product_list",
        score: item.score,
        matchedTerms: item.matchedTerms,
        headCode: item.headCode,
        finalCode: item.finalCode,
        url: item.finalUrl,
        preview: buildEvidenceExcerpt(item.description || item.searchText),
        charCount: item.searchText.length,
      })),
      tokenEstimate,
      queryDiagnostics: {
        modelTokens: productListResult.queryDiagnostics.modelTokens,
        alphaNumTokens: productListResult.queryDiagnostics.alphaNumTokens,
        chineseTerms: productListResult.queryDiagnostics.chineseTerms,
        accessoryIntent: productListResult.accessoryIntent,
        noHitReason: productListResult.queryDiagnostics.noHitReason,
      },
      topItems: topItems.map((item) => ({
        finalCode: item.finalCode,
        headCode: item.headCode,
        name: item.name,
        score: item.score,
        matchedTerms: item.matchedTerms,
        productUrl: item.finalUrl,
        preview: buildEvidenceExcerpt(item.description || item.searchText),
        charCount: item.searchText.length,
      })),
    },
  };
};
