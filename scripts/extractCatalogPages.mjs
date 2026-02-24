import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_START_PAGE = 178;
const DEFAULT_END_PAGE = 229;
const DEFAULT_CHUNK_SIZE = 520;
const DEFAULT_CHUNK_OVERLAP = 90;

const SOURCE_NAME = "dgs_ecatalog";
const CATALOG_ROOT_URL = "https://ec.dgs.com.tw/catalog/catalog.html";
const PAGE_HTML_BASE = "https://ec.dgs.com.tw/catalog/files/basic-html/page";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key.startsWith("--") && value && !value.startsWith("--")) {
      args.set(key, value);
      index += 1;
    }
  }

  const startPage = Number(args.get("--start") ?? DEFAULT_START_PAGE);
  const endPage = Number(args.get("--end") ?? DEFAULT_END_PAGE);
  const chunkSize = Number(args.get("--chunk-size") ?? DEFAULT_CHUNK_SIZE);
  const chunkOverlap = Number(args.get("--chunk-overlap") ?? DEFAULT_CHUNK_OVERLAP);
  const outputDir = args.get("--out") ?? "data/catalog";
  const section = args.get("--section")?.toUpperCase();

  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    throw new Error("Invalid page range. Example: --start 178 --end 229");
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 100) {
    throw new Error("Invalid --chunk-size. Use a value >= 100.");
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error("Invalid --chunk-overlap. Use 0 <= overlap < chunk-size.");
  }
  if (section && !/^[A-Z]$/.test(section)) {
    throw new Error("Invalid --section. Use a single letter like A/B/C.");
  }

  return { startPage, endPage, chunkSize, chunkOverlap, outputDir, section };
}

function decodeHtmlEntities(text) {
  const decodedPercentText = text
    .replace(/%u([a-fA-F0-9]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/%(?!u)([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

  return decodedPercentText
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function stripHtml(rawHtml) {
  return rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function normalizeText(rawText) {
  const boilerplatePatterns = [
    /^Basic HTML Version$/i,
    /^Table of Contents$/i,
    /^View Full Version$/i,
    /^Page \d+ - Demo$/i,
    /^P\.\s*\d+$/i,
    /^\d+(?: \d+){4,}$/,
  ];

  return rawText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => Boolean(line) && !boilerplatePatterns.some((pattern) => pattern.test(line)))
    .join("\n");
}

function extractPageText(html) {
  const pMatches = [...html.matchAll(/<p[^>]*class=["'][^"']*text-container[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)];
  const spanMatches = [...html.matchAll(/<span[^>]*class=["'][^"']*text-container[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)];

  let textCandidate = "";
  if (pMatches.length > 0 || spanMatches.length > 0) {
    textCandidate = [...pMatches, ...spanMatches].map((match) => match[1]).join("\n");
  } else {
    const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
    textCandidate = bodyMatch ? bodyMatch[1] : html;
  }

  const decoded = decodeHtmlEntities(stripHtml(textCandidate));
  return normalizeText(decoded);
}

function splitIntoChunks(text, chunkSize, overlap) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const chunk = text.slice(cursor, cursor + chunkSize).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (cursor + chunkSize >= text.length) {
      break;
    }
    cursor += chunkSize - overlap;
  }
  return chunks;
}

function escapeCsvCell(value) {
  const cell = String(value ?? "");
  const escaped = cell.replaceAll("\"", "\"\"");
  return `"${escaped}"`;
}

function toCsv(rows) {
  if (rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  const csvLines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    csvLines.push(headers.map((header) => escapeCsvCell(row[header])).join(","));
  }
  return `${csvLines.join("\n")}\n`;
}

async function fetchPageHtml(page, retries = 2) {
  const url = `${PAGE_HTML_BASE}${page}.html`;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; DGS-Catalog-Extractor/1.0)",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
      }
      const html = await response.text();
      return { url, html };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

async function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, lines ? `${lines}\n` : "", "utf8");
}

async function run() {
  const { startPage, endPage, chunkSize, chunkOverlap, outputDir, section } = parseArgs(process.argv.slice(2));
  const outputRoot = path.resolve(outputDir);
  const publicKnowledgeDir = path.resolve("public/knowledge");

  await fs.mkdir(outputRoot, { recursive: true });
  await fs.mkdir(publicKnowledgeDir, { recursive: true });

  const pages = [];
  const chunks = [];
  const extractedAt = new Date().toISOString();

  for (let page = startPage; page <= endPage; page += 1) {
    process.stdout.write(`Fetching page ${page}...\n`);
    try {
      const { url, html } = await fetchPageHtml(page);
      const text = extractPageText(html);

      pages.push({
        source: SOURCE_NAME,
        section,
        page,
        sourceUrl: url,
        catalogUrl: `${CATALOG_ROOT_URL}#p=${page}`,
        text,
        extractedAt,
      });

      const pageChunks = splitIntoChunks(text, chunkSize, chunkOverlap);
      pageChunks.forEach((chunkText, index) => {
        chunks.push({
          id: `${SOURCE_NAME}-p${page}-c${index + 1}`,
          source: SOURCE_NAME,
          section,
          page,
          chunkIndex: index + 1,
          totalChunksOnPage: pageChunks.length,
          text: chunkText,
          sourceUrl: url,
          catalogUrl: `${CATALOG_ROOT_URL}#p=${page}`,
          extractedAt,
        });
      });
    } catch (error) {
      process.stderr.write(`Failed on page ${page}: ${error?.message ?? String(error)}\n`);
    }
  }

  const rangeTag = `p${startPage}_p${endPage}`;
  const pagesJsonlPath = path.join(outputRoot, `catalog_${rangeTag}_pages.jsonl`);
  const chunksJsonlPath = path.join(outputRoot, `catalog_${rangeTag}_chunks.jsonl`);
  const chunksCsvPath = path.join(outputRoot, `catalog_${rangeTag}_chunks.csv`);
  const chunksJsonPath = path.join(publicKnowledgeDir, `catalog_${rangeTag}_chunks.json`);
  const manifestPath = path.join(outputRoot, `catalog_${rangeTag}_manifest.json`);

  await writeJsonl(pagesJsonlPath, pages);
  await writeJsonl(chunksJsonlPath, chunks);
  await fs.writeFile(chunksCsvPath, toCsv(chunks), "utf8");
  await fs.writeFile(chunksJsonPath, JSON.stringify(chunks, null, 2), "utf8");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        source: SOURCE_NAME,
        section,
        range: { startPage, endPage },
        files: {
          pagesJsonlPath,
          chunksJsonlPath,
          chunksCsvPath,
          chunksJsonPath,
        },
        stats: {
          totalPagesRequested: endPage - startPage + 1,
          pagesExtracted: pages.length,
          chunksExtracted: chunks.length,
        },
        extractedAt,
      },
      null,
      2
    ),
    "utf8"
  );

  process.stdout.write(`Done. Pages: ${pages.length}, Chunks: ${chunks.length}\n`);
  process.stdout.write(`Manifest: ${manifestPath}\n`);
}

run().catch((error) => {
  process.stderr.write(`Catalog extraction failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
