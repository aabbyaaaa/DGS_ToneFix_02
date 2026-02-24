import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIR = path.resolve("data/catalog");
const PUBLIC_KNOWLEDGE_DIR = path.resolve("public/knowledge");
const SOURCE_NAME = "dgs_ecatalog";

const SECTION_CONFIGS = [
  { section: "A", startPage: 14, endPage: 176 },
  { section: "B", startPage: 178, endPage: 229 },
  { section: "C", startPage: 232, endPage: 252 },
  { section: "D", startPage: 254, endPage: 307 },
  { section: "E", startPage: 310, endPage: 600 },
  { section: "F", startPage: 602, endPage: 627 },
];

function sectionForPage(page) {
  for (const config of SECTION_CONFIGS) {
    if (page >= config.startPage && page <= config.endPage) {
      return config.section;
    }
  }
  return undefined;
}

function toRangeTag(startPage, endPage) {
  return `p${startPage}_p${endPage}`;
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escapeCsvCell(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function writeJsonl(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, lines ? `${lines}\n` : "", "utf8");
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_KNOWLEDGE_DIR, { recursive: true });

  const mergedPages = [];
  const mergedChunks = [];
  const missingFiles = [];

  for (const config of SECTION_CONFIGS) {
    const rangeTag = toRangeTag(config.startPage, config.endPage);
    const pagesPath = path.join(OUTPUT_DIR, `catalog_${rangeTag}_pages.jsonl`);
    const chunksPath = path.join(OUTPUT_DIR, `catalog_${rangeTag}_chunks.jsonl`);

    try {
      const [pages, chunks] = await Promise.all([readJsonl(pagesPath), readJsonl(chunksPath)]);

      for (const page of pages) {
        mergedPages.push({
          ...page,
          section: typeof page.section === "string" ? page.section : config.section ?? sectionForPage(Number(page.page)),
        });
      }

      for (const chunk of chunks) {
        mergedChunks.push({
          ...chunk,
          section: typeof chunk.section === "string" ? chunk.section : config.section ?? sectionForPage(Number(chunk.page)),
        });
      }
    } catch (error) {
      missingFiles.push({
        section: config.section,
        pagesPath,
        chunksPath,
        error: error?.message ?? String(error),
      });
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(`Missing section files: ${JSON.stringify(missingFiles, null, 2)}`);
  }

  mergedPages.sort((a, b) => Number(a.page) - Number(b.page));
  mergedChunks.sort((a, b) => {
    const pageDiff = Number(a.page) - Number(b.page);
    if (pageDiff !== 0) {
      return pageDiff;
    }
    return Number(a.chunkIndex) - Number(b.chunkIndex);
  });

  const outputPagesJsonlPath = path.join(OUTPUT_DIR, "catalog_A_F_pages.jsonl");
  const outputChunksJsonlPath = path.join(OUTPUT_DIR, "catalog_A_F_chunks.jsonl");
  const outputChunksCsvPath = path.join(OUTPUT_DIR, "catalog_A_F_chunks.csv");
  const outputChunksJsonPath = path.join(PUBLIC_KNOWLEDGE_DIR, "catalog_A_F_chunks.json");
  const outputManifestPath = path.join(OUTPUT_DIR, "catalog_A_F_manifest.json");

  await writeJsonl(outputPagesJsonlPath, mergedPages);
  await writeJsonl(outputChunksJsonlPath, mergedChunks);
  await fs.writeFile(outputChunksCsvPath, toCsv(mergedChunks), "utf8");
  await fs.writeFile(outputChunksJsonPath, JSON.stringify(mergedChunks, null, 2), "utf8");

  const sectionStats = SECTION_CONFIGS.map((config) => {
    const pagesCount = mergedPages.filter((row) => row.section === config.section).length;
    const chunksCount = mergedChunks.filter((row) => row.section === config.section).length;
    return {
      section: config.section,
      startPage: config.startPage,
      endPage: config.endPage,
      pagesExtracted: pagesCount,
      chunksExtracted: chunksCount,
    };
  });

  const extractedAt = new Date().toISOString();
  await fs.writeFile(
    outputManifestPath,
    JSON.stringify(
      {
        source: SOURCE_NAME,
        sections: SECTION_CONFIGS,
        files: {
          pagesJsonlPath: outputPagesJsonlPath,
          chunksJsonlPath: outputChunksJsonlPath,
          chunksCsvPath: outputChunksCsvPath,
          chunksJsonPath: outputChunksJsonPath,
        },
        stats: {
          totalPagesExtracted: mergedPages.length,
          totalChunksExtracted: mergedChunks.length,
          sectionStats,
        },
        extractedAt,
      },
      null,
      2
    ),
    "utf8"
  );

  process.stdout.write(`Merged A-F complete. Pages: ${mergedPages.length}, Chunks: ${mergedChunks.length}\n`);
  process.stdout.write(`Manifest: ${outputManifestPath}\n`);
}

run().catch((error) => {
  process.stderr.write(`Catalog merge failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
