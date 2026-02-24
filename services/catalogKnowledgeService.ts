import { CatalogChunk } from "../types";

const CATALOG_CHUNKS_PATH = "/knowledge/catalog_A_F_chunks.json";
const DEFAULT_RETRIEVE_LIMIT = 5;
const CHINESE_STOP_TERMS = new Set(["請問", "推薦", "有", "嗎", "的", "我", "想", "要"]);

let chunksCachePromise: Promise<CatalogChunk[]> | null = null;

export interface ScoredCatalogChunk extends CatalogChunk {
  score: number;
  matchedTerms: string[];
  charCount: number;
}

export interface QueryDiagnostics {
  modelTokens: string[];
  alphaNumTokens: string[];
  chineseTerms: string[];
  fallbackUsed: boolean;
  noHitReason: string | null;
}

export interface CatalogRetrievalResult {
  selectedSections: string[];
  scopedChunks: number;
  items: ScoredCatalogChunk[];
  queryDiagnostics: QueryDiagnostics;
}

export interface CatalogRetrievalOptions {
  enableFallbackRetrieval?: boolean;
}

function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

export function getModelLikeTokens(text: string): string[] {
  return normalizeForMatch(text).match(/[a-z0-9]+(?:[-_/][a-z0-9]+)+/g) ?? [];
}

export function getAlphaNumTokens(text: string): string[] {
  return (normalizeForMatch(text).match(/[a-z0-9]{2,}/g) ?? []).filter((token) => /\d/.test(token) || token.length >= 3);
}

export function getChineseTerms(text: string): string[] {
  const terms: string[] = [];
  const sequences = normalizeForMatch(text).match(/[\u4e00-\u9fff]+/g) ?? [];

  for (const sequence of sequences) {
    if (sequence.length <= 4 && !CHINESE_STOP_TERMS.has(sequence)) {
      terms.push(sequence);
    }

    for (const ngramSize of [3, 4]) {
      if (sequence.length < ngramSize) {
        continue;
      }
      for (let index = 0; index <= sequence.length - ngramSize; index += 1) {
        const ngram = sequence.slice(index, index + ngramSize);
        if (!CHINESE_STOP_TERMS.has(ngram)) {
          terms.push(ngram);
        }
      }
    }
  }

  return terms;
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function normalizeSections(sections: string[] | undefined): string[] {
  if (!Array.isArray(sections)) {
    return [];
  }
  return uniqueTokens(
    sections
      .map((section) => String(section).trim().toUpperCase())
      .filter((section) => /^[A-Z]$/.test(section))
  );
}

function cleanForNgram(text: string): string {
  return normalizeForMatch(text).replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

export function buildCharacterNgrams(text: string, sizes: number[] = [2, 3]): string[] {
  const cleaned = cleanForNgram(text);
  const ngrams: string[] = [];

  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 2 || cleaned.length < size) {
      continue;
    }
    for (let index = 0; index <= cleaned.length - size; index += 1) {
      ngrams.push(cleaned.slice(index, index + size));
    }
  }

  return uniqueTokens(ngrams);
}

function scoreChunkLexical(chunk: CatalogChunk, alphaNumTokens: string[], chineseTerms: string[], modelTokens: string[]) {
  const chunkText = normalizeForMatch(chunk.text);
  const matchedModelTokens: string[] = [];
  const matchedAlphaNumTokens: string[] = [];
  const matchedChineseTerms: string[] = [];
  let score = 0;

  for (const token of modelTokens) {
    if (chunkText.includes(token)) {
      matchedModelTokens.push(token);
      score += 12;
    }
  }

  for (const token of alphaNumTokens) {
    if (chunkText.includes(token)) {
      matchedAlphaNumTokens.push(token);
      score += /\d/.test(token) ? 8 : 4;
    }
  }

  for (const term of chineseTerms) {
    if (chunkText.includes(term)) {
      matchedChineseTerms.push(term);
      score += term.length >= 4 ? 3 : 2;
    }
  }

  return {
    score,
    matchedTerms: uniqueTokens([...matchedModelTokens, ...matchedAlphaNumTokens, ...matchedChineseTerms]).slice(0, 12),
    charCount: chunk.text.length,
  };
}

function scoreChunkFallback(chunk: CatalogChunk, ngram2: string[], ngram3: string[]) {
  const chunkText = normalizeForMatch(chunk.text);
  const matched2: string[] = [];
  const matched3: string[] = [];

  for (const term of ngram2) {
    if (chunkText.includes(term)) {
      matched2.push(term);
    }
  }

  for (const term of ngram3) {
    if (chunkText.includes(term)) {
      matched3.push(term);
    }
  }

  const score = matched2.length + matched3.length * 2;
  return {
    score,
    matchedTerms: uniqueTokens([...matched3, ...matched2]).slice(0, 12),
    charCount: chunk.text.length,
  };
}

function resolveNoHitReason(params: {
  cleanedQuery: string;
  modelTokens: string[];
  alphaNumTokens: string[];
  chineseTerms: string[];
  scopedChunks: number;
  fallbackTried: boolean;
  fallbackNgramCount: number;
}): string {
  const { cleanedQuery, modelTokens, alphaNumTokens, chineseTerms, scopedChunks, fallbackTried, fallbackNgramCount } = params;

  if (!cleanedQuery) {
    return "查詢文字為空。";
  }
  if (scopedChunks <= 0) {
    return "所選分區內沒有可檢索內容。";
  }
  if (cleanedQuery.length < 2) {
    return "關鍵詞過短，無法有效檢索。";
  }

  const tokenCount = modelTokens.length + alphaNumTokens.length + chineseTerms.length;
  if (tokenCount === 0) {
    return "查詢缺少可檢索關鍵詞（可能停用詞比例過高）。";
  }

  if (fallbackTried && fallbackNgramCount === 0) {
    return "查詢可比對字串過短，無法啟用 fallback 檢索。";
  }

  return "在所選分區中找不到對應型錄內容。";
}

export async function loadCatalogChunks(): Promise<CatalogChunk[]> {
  if (!chunksCachePromise) {
    chunksCachePromise = fetch(CATALOG_CHUNKS_PATH)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Catalog chunks not found at ${CATALOG_CHUNKS_PATH}`);
        }
        return response.json();
      })
      .then((data) => {
        if (!Array.isArray(data)) {
          return [];
        }
        return data.filter(
          (chunk): chunk is CatalogChunk =>
            typeof chunk?.id === "string" &&
            typeof chunk?.page === "number" &&
            typeof chunk?.text === "string" &&
            typeof chunk?.sourceUrl === "string" &&
            typeof chunk?.catalogUrl === "string"
        );
      })
      .catch((error) => {
        console.warn("Catalog knowledge loading failed:", error);
        return [];
      });
  }

  return chunksCachePromise;
}

export async function retrieveCatalogContext(
  query: string,
  limit = DEFAULT_RETRIEVE_LIMIT,
  sections: string[] = [],
  options: CatalogRetrievalOptions = {}
): Promise<CatalogRetrievalResult> {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RETRIEVE_LIMIT;
  const selectedSections = normalizeSections(sections);
  const cleanedQuery = query.trim();
  const enableFallbackRetrieval = options.enableFallbackRetrieval ?? true;

  if (!cleanedQuery || selectedSections.length === 0) {
    return {
      selectedSections,
      scopedChunks: 0,
      items: [],
      queryDiagnostics: {
        modelTokens: [],
        alphaNumTokens: [],
        chineseTerms: [],
        fallbackUsed: false,
        noHitReason: !cleanedQuery ? "查詢文字為空。" : "未選擇任何型錄分區。",
      },
    };
  }

  const chunks = await loadCatalogChunks();
  if (chunks.length === 0) {
    return {
      selectedSections,
      scopedChunks: 0,
      items: [],
      queryDiagnostics: {
        modelTokens: [],
        alphaNumTokens: [],
        chineseTerms: [],
        fallbackUsed: false,
        noHitReason: "型錄知識尚未載入。",
      },
    };
  }

  const scopedChunks = chunks.filter(
    (chunk) => typeof chunk.section === "string" && selectedSections.includes(chunk.section.toUpperCase())
  );
  if (scopedChunks.length === 0) {
    return {
      selectedSections,
      scopedChunks: 0,
      items: [],
      queryDiagnostics: {
        modelTokens: [],
        alphaNumTokens: [],
        chineseTerms: [],
        fallbackUsed: false,
        noHitReason: "所選分區內沒有可檢索內容。",
      },
    };
  }

  const modelTokens = uniqueTokens(getModelLikeTokens(cleanedQuery));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(cleanedQuery));
  const chineseTerms = uniqueTokens(getChineseTerms(cleanedQuery));

  const ranked = scopedChunks
    .map((chunk) => {
      const metrics = scoreChunkLexical(chunk, alphaNumTokens, chineseTerms, modelTokens);
      return {
        chunk,
        score: metrics.score,
        matchedTerms: metrics.matchedTerms,
        charCount: metrics.charCount,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked.length > 0) {
    const items = ranked.slice(0, normalizedLimit).map((row) => ({
      ...row.chunk,
      score: row.score,
      matchedTerms: row.matchedTerms,
      charCount: row.charCount,
    }));

    return {
      selectedSections,
      scopedChunks: scopedChunks.length,
      items,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        fallbackUsed: false,
        noHitReason: null,
      },
    };
  }

  if (!enableFallbackRetrieval) {
    return {
      selectedSections,
      scopedChunks: scopedChunks.length,
      items: [],
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        fallbackUsed: false,
        noHitReason: resolveNoHitReason({
          cleanedQuery,
          modelTokens,
          alphaNumTokens,
          chineseTerms,
          scopedChunks: scopedChunks.length,
          fallbackTried: false,
          fallbackNgramCount: 0,
        }),
      },
    };
  }

  const fallbackNgram2 = buildCharacterNgrams(cleanedQuery, [2]);
  const fallbackNgram3 = buildCharacterNgrams(cleanedQuery, [3]);

  const fallbackRanked = scopedChunks
    .map((chunk) => {
      const metrics = scoreChunkFallback(chunk, fallbackNgram2, fallbackNgram3);
      return {
        chunk,
        score: metrics.score,
        matchedTerms: metrics.matchedTerms,
        charCount: metrics.charCount,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  if (fallbackRanked.length > 0) {
    const items = fallbackRanked.slice(0, normalizedLimit).map((row) => ({
      ...row.chunk,
      score: row.score,
      matchedTerms: row.matchedTerms,
      charCount: row.charCount,
    }));

    return {
      selectedSections,
      scopedChunks: scopedChunks.length,
      items,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        fallbackUsed: true,
        noHitReason: "Lexical 未命中，已啟用 fallback n-gram 檢索。",
      },
    };
  }

  return {
    selectedSections,
    scopedChunks: scopedChunks.length,
    items: [],
    queryDiagnostics: {
      modelTokens,
      alphaNumTokens,
      chineseTerms,
      fallbackUsed: true,
      noHitReason: resolveNoHitReason({
        cleanedQuery,
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        scopedChunks: scopedChunks.length,
        fallbackTried: true,
        fallbackNgramCount: fallbackNgram2.length + fallbackNgram3.length,
      }),
    },
  };
}
