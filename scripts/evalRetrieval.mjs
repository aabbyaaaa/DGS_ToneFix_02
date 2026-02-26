import fs from 'node:fs/promises';
import path from 'node:path';

const KNOWLEDGE_FILE = path.resolve('public/knowledge/catalog_A_F_chunks.json');
const HYBRID_INDEX_FILE = path.resolve('public/knowledge/catalog_A_F_hybrid_index.json');
const QUERY_FILE = path.resolve('data/eval/queries.json');
const REPORT_JSON = path.resolve('data/eval/retrieval-report.json');
const REPORT_MD = path.resolve('data/eval/retrieval-report.md');
const OPENAI_EMBEDDINGS_API_URL = 'https://api.openai.com/v1/embeddings';

const TOP_K = 5;
const LEGACY_HIT_THRESHOLD = 0.85;
const HYBRID_HIT_THRESHOLD = 0.9;
const HYBRID_P95_MS_THRESHOLD = 250;

const HYBRID_WEIGHTS = {
  bm25: 0.55,
  vector: 0.45,
  exactBoost: 0.1,
};

const CHINESE_STOP_TERMS = new Set(['請問', '推薦', '有', '嗎', '的', '我', '想', '要']);

function normalizeForMatch(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

function uniqueTokens(tokens) {
  return [...new Set(tokens)];
}

function getModelLikeTokens(text) {
  return normalizeForMatch(text).match(/[a-z0-9]+(?:[-_/][a-z0-9]+)+/g) ?? [];
}

function getAlphaNumTokens(text) {
  return (normalizeForMatch(text).match(/[a-z0-9]{2,}/g) ?? []).filter((token) => /\d/.test(token) || token.length >= 3);
}

function getChineseTerms(text) {
  const terms = [];
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

function cleanForNgram(text) {
  return normalizeForMatch(text).replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function buildCharacterNgrams(text, sizes = [2, 3]) {
  const cleaned = cleanForNgram(text);
  const ngrams = [];

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

function scoreLexical(chunkText, alphaNumTokens, chineseTerms, modelTokens) {
  const text = normalizeForMatch(chunkText);
  const matchedTerms = [];
  let score = 0;

  for (const token of modelTokens) {
    if (text.includes(token)) {
      matchedTerms.push(token);
      score += 12;
    }
  }

  for (const token of alphaNumTokens) {
    if (text.includes(token)) {
      matchedTerms.push(token);
      score += /\d/.test(token) ? 8 : 4;
    }
  }

  for (const term of chineseTerms) {
    if (text.includes(term)) {
      matchedTerms.push(term);
      score += term.length >= 4 ? 3 : 2;
    }
  }

  return { score, matchedTerms: uniqueTokens(matchedTerms).slice(0, 12) };
}

function scoreFallback(chunkText, ngram2, ngram3) {
  const text = normalizeForMatch(chunkText);
  const matched2 = [];
  const matched3 = [];

  for (const term of ngram2) {
    if (text.includes(term)) {
      matched2.push(term);
    }
  }

  for (const term of ngram3) {
    if (text.includes(term)) {
      matched3.push(term);
    }
  }

  return {
    score: matched2.length + matched3.length * 2,
    matchedTerms: uniqueTokens([...matched3, ...matched2]).slice(0, 12),
  };
}

function retrieveLexical(chunks, query, sections) {
  const selectedSections = uniqueTokens((sections ?? []).map((section) => String(section).toUpperCase()));
  if (!query?.trim() || selectedSections.length === 0) {
    return { items: [], fallbackUsed: false, noHitReason: 'query empty or no sections selected' };
  }

  const scoped = chunks.filter((chunk) => typeof chunk.section === 'string' && selectedSections.includes(chunk.section.toUpperCase()));
  if (scoped.length === 0) {
    return { items: [], fallbackUsed: false, noHitReason: 'no chunks in selected sections' };
  }

  const modelTokens = uniqueTokens(getModelLikeTokens(query));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(query));
  const chineseTerms = uniqueTokens(getChineseTerms(query));

  const lexical = scoped
    .map((chunk) => {
      const metrics = scoreLexical(chunk.text, alphaNumTokens, chineseTerms, modelTokens);
      return { ...chunk, score: metrics.score, matchedTerms: metrics.matchedTerms };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  if (lexical.length > 0) {
    return { items: lexical, fallbackUsed: false, noHitReason: null };
  }

  const ngram2 = buildCharacterNgrams(query, [2]);
  const ngram3 = buildCharacterNgrams(query, [3]);

  const fallback = scoped
    .map((chunk) => {
      const metrics = scoreFallback(chunk.text, ngram2, ngram3);
      return { ...chunk, score: metrics.score, matchedTerms: metrics.matchedTerms };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  if (fallback.length > 0) {
    return { items: fallback, fallbackUsed: true, noHitReason: 'lexical miss, fallback used' };
  }

  return { items: [], fallbackUsed: true, noHitReason: 'no match after fallback' };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
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

function getTermFrequency(tokens) {
  const frequencies = {};
  for (const token of tokens) {
    frequencies[token] = (frequencies[token] ?? 0) + 1;
  }
  return frequencies;
}

function retrieveHybrid(index, query, sections, queryVector) {
  const selectedSections = uniqueTokens((sections ?? []).map((section) => String(section).toUpperCase()));
  if (!query?.trim() || selectedSections.length === 0) {
    return { items: [], noHitReason: 'query empty or no sections selected' };
  }

  const scoped = index.chunks.filter((chunk) => typeof chunk.section === 'string' && selectedSections.includes(chunk.section.toUpperCase()));
  if (scoped.length === 0) {
    return { items: [], noHitReason: 'no chunks in selected sections' };
  }

  const modelTokens = uniqueTokens(getModelLikeTokens(query));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(query));
  const chineseTerms = uniqueTokens(getChineseTerms(query));
  const queryTerms = uniqueTokens([...modelTokens, ...alphaNumTokens, ...chineseTerms]);

  const totalDocs = scoped.length;
  const bm25Rows = scoped.map((chunk) => {
    const tf = getTermFrequency(chunk.tokens);
    const dl = chunk.docLen || chunk.tokens.length || 1;

    let bm25Score = 0;
    for (const term of queryTerms) {
      const termTf = tf[term] ?? 0;
      if (termTf === 0) {
        continue;
      }
      const df = index.bm25.df[term] ?? 0;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      bm25Score += idf * ((termTf * (index.bm25.k1 + 1)) / (termTf + index.bm25.k1 * (1 - index.bm25.b + index.bm25.b * (dl / index.bm25.avgdl))));
    }

    const vectorScore = cosineSimilarity(queryVector, chunk.vector);
    const exactBoost = modelTokens.some((token) => normalizeForMatch(chunk.text).includes(token)) ? HYBRID_WEIGHTS.exactBoost : 0;

    return {
      chunk,
      bm25Score,
      vectorScore,
      exactBoost,
    };
  });

  const bm25TopScore = bm25Rows.reduce((max, row) => (row.bm25Score > max ? row.bm25Score : max), 0);
  const vectorTopScore = bm25Rows.reduce((max, row) => (row.vectorScore > max ? row.vectorScore : max), 0);

  const ranked = bm25Rows
    .map((row) => {
      const bm25Norm = bm25TopScore > 0 ? row.bm25Score / bm25TopScore : 0;
      const vectorNorm = vectorTopScore > 0 ? Math.max(0, row.vectorScore / vectorTopScore) : 0;
      const score = HYBRID_WEIGHTS.bm25 * bm25Norm + HYBRID_WEIGHTS.vector * vectorNorm + row.exactBoost;
      return { ...row, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map((row) => ({ ...row.chunk, score: row.score }));

  if (ranked.length === 0) {
    return { items: [], noHitReason: 'hybrid no match' };
  }

  return {
    items: ranked,
    noHitReason: null,
    bm25TopScore,
    vectorTopScore,
  };
}

async function embedQuery(query, apiKey, model) {
  const response = await fetch(OPENAI_EMBEDDINGS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: query }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Embedding API error ${response.status}: ${bodyText}`);
  }

  const parsed = JSON.parse(bodyText);
  const vector = parsed?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding response missing vector.');
  }

  return vector.map((value) => Number(value));
}

function p95(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)];
}

function toPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(report) {
  const { summary, results } = report;
  const lines = [
    '# Retrieval Evaluation Report (Lexical vs Hybrid)',
    '',
    `- Total queries: ${summary.totalQueries}`,
    `- Lexical hit rate: ${toPercent(summary.lexicalHitRate)} (${summary.lexicalHitQueries}/${summary.totalQueries})`,
    `- Hybrid hit rate: ${toPercent(summary.hybridHitRate)} (${summary.hybridHitQueries}/${summary.totalQueries})`,
    `- Delta: ${toPercent(summary.hybridHitRate - summary.lexicalHitRate)}`,
    `- Hybrid p95 latency: ${summary.hybridP95LatencyMs} ms`,
    `- Hybrid evaluated: ${summary.hybridEvaluated ? 'YES' : 'NO (degraded)'}`,
    `- Thresholds: hit >= ${toPercent(summary.hybridHitThreshold)}, p95 <= ${summary.hybridP95ThresholdMs} ms`,
    `- Pass: ${summary.passed ? 'YES' : 'NO'}`,
    '',
    '## Per-query Results',
    '',
  ];

  for (const row of results) {
    lines.push(
      `- ${row.id}: lexicalHit=${row.lexical.hit} hybridHit=${row.hybrid.hit} degraded=${row.hybrid.degraded} hybridMs=${row.hybrid.latencyMs} topPages=${row.hybrid.topPages.join(',') || '-'} query=${row.query}`
    );
  }

  return `${lines.join('\n')}\n`;
}

async function run() {
  const [chunksRaw, queriesRaw] = await Promise.all([
    fs.readFile(KNOWLEDGE_FILE, 'utf8'),
    fs.readFile(QUERY_FILE, 'utf8'),
  ]);

  const chunks = JSON.parse(chunksRaw);
  const queries = JSON.parse(queriesRaw);

  if (!Array.isArray(chunks) || !Array.isArray(queries)) {
    throw new Error('Invalid eval inputs.');
  }

  let hybridIndex = null;
  try {
    const hybridRaw = await fs.readFile(HYBRID_INDEX_FILE, 'utf8');
    hybridIndex = JSON.parse(hybridRaw);
  } catch {
    hybridIndex = null;
  }

  const openAiApiKey = process.env.OPENAI_API_KEY;
  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const canEvaluateHybrid = Boolean(openAiApiKey && hybridIndex && Array.isArray(hybridIndex?.chunks) && hybridIndex?.bm25);

  const results = [];
  const hybridLatencies = [];

  for (const row of queries) {
    const query = String(row.query ?? '');
    const sections = Array.isArray(row.sections) ? row.sections : [];
    const id = String(row.id ?? query);

    const lexical = retrieveLexical(chunks, query, sections);

    let hybrid = {
      items: lexical.items,
      noHitReason: lexical.noHitReason,
      degraded: true,
      latencyMs: 0,
    };

    if (canEvaluateHybrid) {
      const startedAt = Date.now();
      try {
        const queryVector = await embedQuery(query, openAiApiKey, embeddingModel);
        const hybridResult = retrieveHybrid(hybridIndex, query, sections, queryVector);
        hybrid = {
          items: hybridResult.items,
          noHitReason: hybridResult.noHitReason,
          degraded: false,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        hybrid = {
          items: lexical.items,
          noHitReason: `degraded: ${error instanceof Error ? error.message : String(error)}`,
          degraded: true,
          latencyMs: Date.now() - startedAt,
        };
      }
      hybridLatencies.push(hybrid.latencyMs);
    }

    results.push({
      id,
      query,
      sections,
      lexical: {
        hit: lexical.items.length > 0,
        fallbackUsed: lexical.fallbackUsed,
        noHitReason: lexical.noHitReason,
        topPages: lexical.items.map((item) => item.page),
      },
      hybrid: {
        hit: hybrid.items.length > 0,
        degraded: hybrid.degraded,
        noHitReason: hybrid.noHitReason,
        topPages: hybrid.items.map((item) => item.page),
        latencyMs: hybrid.latencyMs,
      },
    });
  }

  const totalQueries = results.length;
  const lexicalHitQueries = results.filter((row) => row.lexical.hit).length;
  const hybridHitQueries = results.filter((row) => row.hybrid.hit).length;

  const lexicalHitRate = totalQueries > 0 ? lexicalHitQueries / totalQueries : 0;
  const hybridHitRate = totalQueries > 0 ? hybridHitQueries / totalQueries : 0;
  const hybridP95LatencyMs = Math.round(p95(hybridLatencies));

  const passed = canEvaluateHybrid
    ? hybridHitRate >= HYBRID_HIT_THRESHOLD && hybridP95LatencyMs <= HYBRID_P95_MS_THRESHOLD
    : lexicalHitRate >= LEGACY_HIT_THRESHOLD;

  const summary = {
    generatedAt: new Date().toISOString(),
    totalQueries,
    lexicalHitQueries,
    hybridHitQueries,
    lexicalHitRate,
    hybridHitRate,
    hybridP95LatencyMs,
    hybridEvaluated: canEvaluateHybrid,
    hybridHitThreshold: HYBRID_HIT_THRESHOLD,
    hybridP95ThresholdMs: HYBRID_P95_MS_THRESHOLD,
    passed,
    notes: canEvaluateHybrid
      ? null
      : 'Hybrid evaluation degraded to lexical because OPENAI_API_KEY or hybrid index is missing.',
  };

  const report = { summary, results };

  await fs.writeFile(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(REPORT_MD, renderMarkdown(report), 'utf8');

  process.stdout.write(`Eval done. Lexical=${toPercent(lexicalHitRate)} Hybrid=${toPercent(hybridHitRate)}\n`);
  process.stdout.write(`Hybrid p95 latency: ${hybridP95LatencyMs} ms\n`);
  process.stdout.write(`Report JSON: ${REPORT_JSON}\n`);
  process.stdout.write(`Report MD: ${REPORT_MD}\n`);

  if (!passed) {
    process.stderr.write(
      canEvaluateHybrid
        ? `Hybrid thresholds not met: hit >= ${toPercent(HYBRID_HIT_THRESHOLD)} and p95 <= ${HYBRID_P95_MS_THRESHOLD}ms\n`
        : `Lexical fallback threshold not met: hit >= ${toPercent(LEGACY_HIT_THRESHOLD)}\n`
    );
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`Retrieval eval failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
