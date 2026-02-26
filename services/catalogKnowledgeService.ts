import { CatalogChunk, RetrievalMode } from "../types";

const CATALOG_CHUNKS_PATH = "/knowledge/catalog_A_F_chunks.json";
const HYBRID_INDEX_PATH = "/knowledge/catalog_A_F_hybrid_index.json";
const DEFAULT_RETRIEVE_LIMIT = 5;
const EMBEDDING_TIMEOUT_MS = 10000;
const CHINESE_STOP_TERMS = new Set(["請問", "推薦", "有", "嗎", "的", "我", "想", "要"]);

const HYBRID_WEIGHTS = {
  bm25: 0.55,
  vector: 0.45,
  exactBoost: 0.1,
} as const;

let chunksCachePromise: Promise<CatalogChunk[]> | null = null;
let hybridIndexCachePromise: Promise<HybridIndex | null> | null = null;
const chunkTermFrequencyCache = new Map<string, Record<string, number>>();

export interface ScoredCatalogChunk extends CatalogChunk {
  score: number;
  matchedTerms: string[];
  charCount: number;
}

export interface QueryDiagnostics {
  modelTokens: string[];
  alphaNumTokens: string[];
  chineseTerms: string[];
  retrievalMode: RetrievalMode;
  hybridUsed: boolean;
  degradedToLexical: boolean;
  fallbackUsed: boolean;
  noHitReason: string | null;
  bm25TopScore?: number;
  vectorTopScore?: number;
  hybridWeights?: {
    bm25: number;
    vector: number;
    exactBoost: number;
  };
}

export interface CatalogRetrievalResult {
  selectedSections: string[];
  scopedChunks: number;
  items: ScoredCatalogChunk[];
  queryDiagnostics: QueryDiagnostics;
}

export interface CatalogRetrievalOptions {
  enableFallbackRetrieval?: boolean;
  retrievalMode?: RetrievalMode;
}

interface HybridIndexChunk {
  id: string;
  source: string;
  section?: string;
  page: number;
  chunkIndex: number;
  totalChunksOnPage: number;
  text: string;
  sourceUrl: string;
  catalogUrl: string;
  extractedAt: string;
  tokens: string[];
  vector: number[];
  docLen?: number;
}

interface HybridIndex {
  version: string;
  builtAt: string;
  embeddingModel: string;
  bm25: {
    k1: number;
    b: number;
    avgdl: number;
    df: Record<string, number>;
  };
  chunks: HybridIndexChunk[];
}

interface LexicalResult {
  items: ScoredCatalogChunk[];
  fallbackUsed: boolean;
  noHitReason: string | null;
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

function runLexicalRetrieval(params: {
  scopedChunks: CatalogChunk[];
  cleanedQuery: string;
  normalizedLimit: number;
  modelTokens: string[];
  alphaNumTokens: string[];
  chineseTerms: string[];
  enableFallbackRetrieval: boolean;
}): LexicalResult {
  const { scopedChunks, cleanedQuery, normalizedLimit, modelTokens, alphaNumTokens, chineseTerms, enableFallbackRetrieval } = params;

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
    return {
      items: ranked.slice(0, normalizedLimit).map((row) => ({
        ...row.chunk,
        score: row.score,
        matchedTerms: row.matchedTerms,
        charCount: row.charCount,
      })),
      fallbackUsed: false,
      noHitReason: null,
    };
  }

  if (!enableFallbackRetrieval) {
    return {
      items: [],
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
    return {
      items: fallbackRanked.slice(0, normalizedLimit).map((row) => ({
        ...row.chunk,
        score: row.score,
        matchedTerms: row.matchedTerms,
        charCount: row.charCount,
      })),
      fallbackUsed: true,
      noHitReason: "Lexical 未命中，已啟用 fallback n-gram 檢索。",
    };
  }

  return {
    items: [],
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
  };
}

function tokenizeForBm25(text: string): string[] {
  const modelTokens = getModelLikeTokens(text);
  const alphaNumTokens = getAlphaNumTokens(text);
  const chineseTerms = getChineseTerms(text);
  const merged = uniqueTokens([...modelTokens, ...alphaNumTokens, ...chineseTerms]);
  if (merged.length > 0) {
    return merged;
  }
  return buildCharacterNgrams(text, [2, 3]);
}

function getChunkTermFrequencies(chunk: HybridIndexChunk): Record<string, number> {
  const cached = chunkTermFrequencyCache.get(chunk.id);
  if (cached) {
    return cached;
  }

  const frequencies: Record<string, number> = {};
  for (const token of chunk.tokens) {
    frequencies[token] = (frequencies[token] ?? 0) + 1;
  }
  chunkTermFrequencyCache.set(chunk.id, frequencies);
  return frequencies;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchQueryEmbedding(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch("/api/embedding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Embedding API failed: ${response.status}`);
    }

    const payload = await response.json();
    const vector = payload?.vector;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Embedding API returned empty vector");
    }

    return vector.map((value: unknown) => Number(value));
  } finally {
    clearTimeout(timeoutId);
  }
}

function toCatalogChunk(chunk: HybridIndexChunk): CatalogChunk {
  return {
    id: chunk.id,
    source: chunk.source,
    section: chunk.section,
    page: chunk.page,
    chunkIndex: chunk.chunkIndex,
    totalChunksOnPage: chunk.totalChunksOnPage,
    text: chunk.text,
    sourceUrl: chunk.sourceUrl,
    catalogUrl: chunk.catalogUrl,
    extractedAt: chunk.extractedAt,
  };
}

function toScoredCatalogChunk(chunk: HybridIndexChunk, score: number, matchedTerms: string[]): ScoredCatalogChunk {
  return {
    ...toCatalogChunk(chunk),
    score,
    matchedTerms,
    charCount: chunk.text.length,
  };
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

async function loadHybridIndex(): Promise<HybridIndex | null> {
  if (!hybridIndexCachePromise) {
    hybridIndexCachePromise = fetch(HYBRID_INDEX_PATH)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Hybrid index not found at ${HYBRID_INDEX_PATH}`);
        }
        return response.json();
      })
      .then((data) => {
        if (
          typeof data !== "object" ||
          data === null ||
          !Array.isArray((data as { chunks?: unknown[] }).chunks) ||
          typeof (data as { bm25?: unknown }).bm25 !== "object"
        ) {
          throw new Error("Hybrid index format is invalid");
        }

        const parsedChunks = ((data as { chunks: unknown[] }).chunks as unknown[]).filter(
          (chunk): chunk is HybridIndexChunk =>
            typeof (chunk as HybridIndexChunk)?.id === "string" &&
            typeof (chunk as HybridIndexChunk)?.page === "number" &&
            typeof (chunk as HybridIndexChunk)?.text === "string" &&
            Array.isArray((chunk as HybridIndexChunk)?.tokens) &&
            Array.isArray((chunk as HybridIndexChunk)?.vector)
        );

        const bm25 = (data as { bm25: HybridIndex["bm25"] }).bm25;
        if (!bm25 || typeof bm25.avgdl !== "number" || typeof bm25.df !== "object") {
          throw new Error("Hybrid index bm25 config is invalid");
        }

        return {
          version: String((data as { version?: unknown }).version ?? "1"),
          builtAt: String((data as { builtAt?: unknown }).builtAt ?? ""),
          embeddingModel: String((data as { embeddingModel?: unknown }).embeddingModel ?? ""),
          bm25,
          chunks: parsedChunks,
        } as HybridIndex;
      })
      .catch((error) => {
        console.warn("Hybrid index loading failed:", error);
        return null;
      });
  }

  return hybridIndexCachePromise;
}

function createDefaultDiagnostics(retrievalMode: RetrievalMode): QueryDiagnostics {
  return {
    modelTokens: [],
    alphaNumTokens: [],
    chineseTerms: [],
    retrievalMode,
    hybridUsed: false,
    degradedToLexical: false,
    fallbackUsed: false,
    noHitReason: null,
  };
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
  const retrievalMode = options.retrievalMode ?? "lexical";

  if (!cleanedQuery || selectedSections.length === 0) {
    return {
      selectedSections,
      scopedChunks: 0,
      items: [],
      queryDiagnostics: {
        ...createDefaultDiagnostics(retrievalMode),
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
        ...createDefaultDiagnostics(retrievalMode),
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
        ...createDefaultDiagnostics(retrievalMode),
        noHitReason: "所選分區內沒有可檢索內容。",
      },
    };
  }

  const modelTokens = uniqueTokens(getModelLikeTokens(cleanedQuery));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(cleanedQuery));
  const chineseTerms = uniqueTokens(getChineseTerms(cleanedQuery));

  if (retrievalMode === "lexical") {
    const lexical = runLexicalRetrieval({
      scopedChunks,
      cleanedQuery,
      normalizedLimit,
      modelTokens,
      alphaNumTokens,
      chineseTerms,
      enableFallbackRetrieval,
    });

    return {
      selectedSections,
      scopedChunks: scopedChunks.length,
      items: lexical.items,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        retrievalMode,
        hybridUsed: false,
        degradedToLexical: false,
        fallbackUsed: lexical.fallbackUsed,
        noHitReason: lexical.noHitReason,
      },
    };
  }

  const lexicalFallback = () => {
    const lexical = runLexicalRetrieval({
      scopedChunks,
      cleanedQuery,
      normalizedLimit,
      modelTokens,
      alphaNumTokens,
      chineseTerms,
      enableFallbackRetrieval,
    });

    return {
      selectedSections,
      scopedChunks: scopedChunks.length,
      items: lexical.items,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        retrievalMode,
        hybridUsed: false,
        degradedToLexical: true,
        fallbackUsed: lexical.fallbackUsed,
        noHitReason: lexical.noHitReason,
        hybridWeights: { ...HYBRID_WEIGHTS },
      },
    } as CatalogRetrievalResult;
  };

  const hybridIndex = await loadHybridIndex();
  if (!hybridIndex || hybridIndex.chunks.length === 0) {
    return lexicalFallback();
  }

  const hybridScopedChunks = hybridIndex.chunks.filter(
    (chunk) => typeof chunk.section === "string" && selectedSections.includes(chunk.section.toUpperCase())
  );

  if (hybridScopedChunks.length === 0) {
    return {
      selectedSections,
      scopedChunks: 0,
      items: [],
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        retrievalMode,
        hybridUsed: false,
        degradedToLexical: false,
        fallbackUsed: false,
        noHitReason: "所選分區內沒有可檢索內容。",
        hybridWeights: { ...HYBRID_WEIGHTS },
      },
    };
  }

  let queryVector: number[];
  try {
    queryVector = await fetchQueryEmbedding(cleanedQuery);
  } catch (error) {
    console.warn("Hybrid retrieval degraded to lexical:", error);
    return lexicalFallback();
  }

  const queryTerms = uniqueTokens([...modelTokens, ...alphaNumTokens, ...chineseTerms]);
  const termsForBm25 = queryTerms.length > 0 ? queryTerms : tokenizeForBm25(cleanedQuery);
  const totalDocs = hybridScopedChunks.length;
  const k1 = hybridIndex.bm25.k1 || 1.2;
  const b = hybridIndex.bm25.b || 0.75;
  const avgdl = hybridIndex.bm25.avgdl > 0 ? hybridIndex.bm25.avgdl : 1;

  const scoredHybrid = hybridScopedChunks.map((chunk) => {
    const termFrequencies = getChunkTermFrequencies(chunk);
    const dl = chunk.docLen || chunk.tokens.length || 1;
    let bm25Score = 0;

    for (const term of termsForBm25) {
      const tf = termFrequencies[term] ?? 0;
      if (tf === 0) {
        continue;
      }

      const df = hybridIndex.bm25.df[term] ?? 0;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      bm25Score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl))));
    }

    const vectorScore = cosineSimilarity(queryVector, chunk.vector);
    const lexicalMetrics = scoreChunkLexical(toCatalogChunk(chunk), alphaNumTokens, chineseTerms, modelTokens);
    const exactBoost = modelTokens.some((token) => normalizeForMatch(chunk.text).includes(token)) ? HYBRID_WEIGHTS.exactBoost : 0;

    return {
      chunk,
      bm25Score,
      vectorScore,
      exactBoost,
      matchedTerms: lexicalMetrics.matchedTerms,
      charCount: lexicalMetrics.charCount,
    };
  });

  const bm25TopScore = scoredHybrid.reduce((max, row) => (row.bm25Score > max ? row.bm25Score : max), 0);
  const vectorTopScore = scoredHybrid.reduce((max, row) => (row.vectorScore > max ? row.vectorScore : max), 0);

  const hybridRanked = scoredHybrid
    .map((row) => {
      const bm25Norm = bm25TopScore > 0 ? row.bm25Score / bm25TopScore : 0;
      const vectorNorm = vectorTopScore > 0 ? Math.max(0, row.vectorScore / vectorTopScore) : 0;
      const score = HYBRID_WEIGHTS.bm25 * bm25Norm + HYBRID_WEIGHTS.vector * vectorNorm + row.exactBoost;

      return {
        ...row,
        score,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, normalizedLimit);

  if (hybridRanked.length === 0) {
    return lexicalFallback();
  }

  return {
    selectedSections,
    scopedChunks: hybridScopedChunks.length,
    items: hybridRanked.map((row) =>
      toScoredCatalogChunk(
        row.chunk,
        Number((row.score * 100).toFixed(2)),
        row.matchedTerms
      )
    ),
    queryDiagnostics: {
      modelTokens,
      alphaNumTokens,
      chineseTerms,
      retrievalMode,
      hybridUsed: true,
      degradedToLexical: false,
      fallbackUsed: false,
      noHitReason: null,
      bm25TopScore: Number(bm25TopScore.toFixed(4)),
      vectorTopScore: Number(vectorTopScore.toFixed(4)),
      hybridWeights: { ...HYBRID_WEIGHTS },
    },
  };
}
