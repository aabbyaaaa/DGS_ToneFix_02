import fs from 'node:fs/promises';
import path from 'node:path';

const KNOWLEDGE_FILE = path.resolve('public/knowledge/catalog_A_F_chunks.json');
const QUERY_FILE = path.resolve('data/eval/queries.json');
const REPORT_JSON = path.resolve('data/eval/retrieval-report.json');
const REPORT_MD = path.resolve('data/eval/retrieval-report.md');
const TOP_K = 5;
const MIN_HIT_RATE = 0.85;

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

function retrieve(chunks, query, sections) {
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

function toPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(summary, results) {
  const lines = [
    '# Retrieval Evaluation Report',
    '',
    `- Total queries: ${summary.totalQueries}`,
    `- Hit queries: ${summary.hitQueries}`,
    `- Hit rate: ${toPercent(summary.hitRate)}`,
    `- Fallback used: ${summary.fallbackUsedQueries}`,
    `- Threshold: ${toPercent(summary.threshold)}`,
    `- Pass: ${summary.passed ? 'YES' : 'NO'}`,
    '',
    '## Missed Queries',
    '',
  ];

  const misses = results.filter((item) => !item.hit);
  if (misses.length === 0) {
    lines.push('- None');
  } else {
    for (const miss of misses) {
      lines.push(`- ${miss.id}: ${miss.query} | sections=${miss.sections.join(',')} | reason=${miss.noHitReason}`);
    }
  }

  lines.push('', '## Per-query Results', '');
  for (const row of results) {
    lines.push(`- ${row.id}: hit=${row.hit} fallback=${row.fallbackUsed} topPages=${row.topPages.join(',') || '-'} query=${row.query}`);
  }

  return `${lines.join('\n')}\n`;
}

async function run() {
  const [knowledgeRaw, queryRaw] = await Promise.all([
    fs.readFile(KNOWLEDGE_FILE, 'utf8'),
    fs.readFile(QUERY_FILE, 'utf8'),
  ]);

  const chunks = JSON.parse(knowledgeRaw);
  const queries = JSON.parse(queryRaw);

  if (!Array.isArray(chunks) || !Array.isArray(queries)) {
    throw new Error('Invalid eval inputs.');
  }

  const results = queries.map((row) => {
    const query = String(row.query ?? '');
    const sections = Array.isArray(row.sections) ? row.sections : [];
    const id = String(row.id ?? query);
    const retrieval = retrieve(chunks, query, sections);

    return {
      id,
      query,
      sections,
      hit: retrieval.items.length > 0,
      fallbackUsed: retrieval.fallbackUsed,
      noHitReason: retrieval.noHitReason,
      topPages: retrieval.items.map((item) => item.page),
      topSections: retrieval.items.map((item) => item.section),
    };
  });

  const totalQueries = results.length;
  const hitQueries = results.filter((row) => row.hit).length;
  const fallbackUsedQueries = results.filter((row) => row.fallbackUsed).length;
  const hitRate = totalQueries > 0 ? hitQueries / totalQueries : 0;
  const passed = hitRate >= MIN_HIT_RATE;

  const summary = {
    totalQueries,
    hitQueries,
    hitRate,
    fallbackUsedQueries,
    threshold: MIN_HIT_RATE,
    passed,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(REPORT_JSON, JSON.stringify({ summary, results }, null, 2), 'utf8');
  await fs.writeFile(REPORT_MD, renderMarkdown(summary, results), 'utf8');

  process.stdout.write(`Eval done. Hit rate=${toPercent(hitRate)} (${hitQueries}/${totalQueries})\n`);
  process.stdout.write(`Report JSON: ${REPORT_JSON}\n`);
  process.stdout.write(`Report MD: ${REPORT_MD}\n`);

  if (!passed) {
    process.stderr.write(`Hit rate below threshold ${toPercent(MIN_HIT_RATE)}\n`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(`Retrieval eval failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
