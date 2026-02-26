import fs from 'node:fs/promises';
import path from 'node:path';

const CHUNKS_PATH = path.resolve('public/knowledge/catalog_A_F_chunks.json');
const OUTPUT_DIR = path.resolve('data/knowledge');
const PUBLIC_KNOWLEDGE_DIR = path.resolve('public/knowledge');
const INDEX_OUTPUT_PATH = path.join(OUTPUT_DIR, 'catalog_A_F_hybrid_index.json');
const MANIFEST_OUTPUT_PATH = path.join(OUTPUT_DIR, 'catalog_A_F_hybrid_manifest.json');
const PUBLIC_INDEX_OUTPUT_PATH = path.join(PUBLIC_KNOWLEDGE_DIR, 'catalog_A_F_hybrid_index.json');

const EMBEDDING_API_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 32);
const BM25_K1 = 1.2;
const BM25_B = 0.75;

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

function tokenizeForBm25(text) {
  const merged = uniqueTokens([
    ...getModelLikeTokens(text),
    ...getAlphaNumTokens(text),
    ...getChineseTerms(text),
  ]);
  if (merged.length > 0) {
    return merged;
  }
  return buildCharacterNgrams(text, [2, 3]);
}

function chunkArray(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

async function embedBatch(inputs, apiKey, retries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(EMBEDDING_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: inputs,
        }),
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`OpenAI embeddings error ${response.status}: ${bodyText}`);
      }

      const parsed = JSON.parse(bodyText);
      const vectors = Array.isArray(parsed?.data)
        ? parsed.data
            .sort((a, b) => Number(a.index) - Number(b.index))
            .map((item) => (Array.isArray(item.embedding) ? item.embedding.map((x) => Number(x)) : []))
        : [];

      if (vectors.length !== inputs.length || vectors.some((vector) => vector.length === 0)) {
        throw new Error('Embedding response shape is invalid.');
      }

      return vectors;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

async function run() {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required.');
  }

  const chunksRaw = await fs.readFile(CHUNKS_PATH, 'utf8');
  const chunks = JSON.parse(chunksRaw);

  if (!Array.isArray(chunks)) {
    throw new Error('catalog_A_F_chunks.json is invalid.');
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_KNOWLEDGE_DIR, { recursive: true });

  const preparedChunks = chunks
    .filter((chunk) => typeof chunk?.id === 'string' && typeof chunk?.text === 'string')
    .map((chunk) => {
      const tokens = tokenizeForBm25(chunk.text);
      return {
        ...chunk,
        tokens,
        docLen: tokens.length || 1,
      };
    });

  const totalDocLen = preparedChunks.reduce((sum, chunk) => sum + chunk.docLen, 0);
  const avgdl = preparedChunks.length > 0 ? totalDocLen / preparedChunks.length : 1;

  const df = {};
  for (const chunk of preparedChunks) {
    for (const token of new Set(chunk.tokens)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }

  const embeddingInputs = preparedChunks.map((chunk) => chunk.text);
  const batches = chunkArray(embeddingInputs, Math.max(1, EMBEDDING_BATCH_SIZE));
  const vectors = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    process.stdout.write(`Embedding batch ${batchIndex + 1}/${batches.length}\n`);
    const embedded = await embedBatch(batches[batchIndex], openAiApiKey);
    vectors.push(...embedded);
  }

  if (vectors.length !== preparedChunks.length) {
    throw new Error('Vector count mismatch after embedding.');
  }

  const indexChunks = preparedChunks.map((chunk, index) => ({
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
    tokens: chunk.tokens,
    docLen: chunk.docLen,
    vector: vectors[index],
  }));

  const builtAt = new Date().toISOString();
  const index = {
    version: '1.0.0',
    builtAt,
    embeddingModel: EMBEDDING_MODEL,
    bm25: {
      k1: BM25_K1,
      b: BM25_B,
      avgdl,
      df,
    },
    chunks: indexChunks,
  };

  const manifest = {
    sourceFile: CHUNKS_PATH,
    outputIndexPath: INDEX_OUTPUT_PATH,
    publicIndexPath: PUBLIC_INDEX_OUTPUT_PATH,
    embeddingModel: EMBEDDING_MODEL,
    stats: {
      totalChunks: indexChunks.length,
      vectorDimensions: indexChunks[0]?.vector?.length ?? 0,
      avgdl,
      uniqueTerms: Object.keys(df).length,
    },
    builtAt,
  };

  await fs.writeFile(INDEX_OUTPUT_PATH, JSON.stringify(index), 'utf8');
  await fs.writeFile(PUBLIC_INDEX_OUTPUT_PATH, JSON.stringify(index), 'utf8');
  await fs.writeFile(MANIFEST_OUTPUT_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  process.stdout.write(`Hybrid index written: ${INDEX_OUTPUT_PATH}\n`);
  process.stdout.write(`Public index written: ${PUBLIC_INDEX_OUTPUT_PATH}\n`);
  process.stdout.write(`Manifest: ${MANIFEST_OUTPUT_PATH}\n`);
}

run().catch((error) => {
  process.stderr.write(`buildHybridIndex failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
