import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import xlsx from "xlsx";

const DEFAULT_INPUT_FILENAME = "德記儀器產品清單_20260226.xlsx";
const OUTPUT_RELATIVE_PATH = "product_list_index.json";

const HEAD_SHEET = "產品內容";
const UNIT_SHEET = "產品單位細項";
const SPEC_SHEET = "產品規格細項";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function toRows(sheet) {
  return xlsx.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
    blankrows: false,
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildSearchText(record) {
  const parts = [
    record.name,
    record.brand,
    record.finalCode,
    record.headCode,
    record.class3,
    record.class2,
    record.class1,
    record.description,
    ...record.units.slice(0, 3),
    ...record.searchSpecs,
  ];
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const inputPath = args.input ? path.resolve(args.input) : path.join(rootDir, DEFAULT_INPUT_FILENAME);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input XLSX not found: ${inputPath}`);
  }

  const workbook = xlsx.readFile(inputPath, { cellDates: false });
  const headSheet = workbook.Sheets[HEAD_SHEET];
  const unitSheet = workbook.Sheets[UNIT_SHEET];
  const specSheet = workbook.Sheets[SPEC_SHEET];

  if (!headSheet || !unitSheet || !specSheet) {
    throw new Error(`Missing required sheets. Expected: ${HEAD_SHEET}, ${UNIT_SHEET}, ${SPEC_SHEET}`);
  }

  const headRows = toRows(headSheet);
  const unitRows = toRows(unitSheet);
  const specRows = toRows(specSheet);

  const headMap = new Map();
  for (const row of headRows) {
    const headCode = normalizeCode(row["帶頭貨號 headCode"]);
    if (!headCode) {
      continue;
    }
    headMap.set(headCode, {
      headCode,
      headUrl: normalizeText(row["帶頭貨號網址"]),
      name: normalizeText(row["中文名稱 name"]),
      enName: normalizeText(row["英文名稱 enName"]),
      brand: normalizeText(row["品牌 brand"]),
      class3: normalizeText(row["主類 class3"]),
      class2: normalizeText(row["二類 class2"]),
      class1: normalizeText(row["三類 class1"]),
      synopsis: normalizeText(row["簡述 synopsis"]),
      tag: normalizeText(row["標籤雲 tag"]),
      additional: normalizeText(row["敘述補充 additional"]),
      shelvesStatus: normalizeText(row["上架狀態 shelvesStatus"]).toUpperCase(),
    });
  }

  const specsMap = new Map();
  for (const row of specRows) {
    const finalCode = normalizeCode(row["最終貨號 specificationCode"]);
    if (!finalCode) {
      continue;
    }
    const specName = normalizeText(row["產品內容名稱 specificationName"]);
    const specValue = normalizeText(row["產品內容值 specificationNameValue"]);
    if (!specName && !specValue) {
      continue;
    }
    const bucket = specsMap.get(finalCode) ?? [];
    bucket.push({ name: specName, value: specValue });
    specsMap.set(finalCode, bucket);
  }

  const normalizedItems = [];
  let skippedMissingHead = 0;
  let skippedNotShelved = 0;

  for (const row of unitRows) {
    const headCode = normalizeCode(row["帶頭貨號 headCode"]);
    const finalCode = normalizeCode(row["最終貨號 specificationCode"]);
    const finalUrl = normalizeText(row["最終貨號網址"]);

    if (!headCode || !finalCode || !finalUrl) {
      continue;
    }

    const head = headMap.get(headCode);
    if (!head) {
      skippedMissingHead += 1;
      continue;
    }
    if (head.shelvesStatus !== "Y") {
      skippedNotShelved += 1;
      continue;
    }

    const units = [
      normalizeText(row["第1訂購單位 specificationUnit1"]),
      normalizeText(row["第2訂購單位 specificationUnit2"]),
      normalizeText(row["第3訂購單位 specificationUnit3"]),
    ].filter(Boolean);

    const specs = (specsMap.get(finalCode) ?? [])
      .map((spec) => ({ name: normalizeText(spec.name), value: normalizeText(spec.value) }))
      .filter((spec) => spec.name || spec.value);
    const searchSpecs = specs
      .slice(0, 8)
      .map((spec) => `${spec.name}:${spec.value}`)
      .filter(Boolean);

    const record = {
      id: `${headCode}__${finalCode}`,
      headCode,
      finalCode,
      finalUrl,
      name: normalizeText(row["貨品名稱 productSpecificationName"]) || head.name,
      description: normalizeText(row["描述 description"]),
      brand: head.brand,
      class3: head.class3,
      class2: head.class2,
      class1: head.class1,
      isAccessory: normalizeText(row["是否為配件 isSubassembly"]) === "配件",
      units,
      searchSpecs,
      searchText: "",
    };

    record.searchText = buildSearchText(record);
    normalizedItems.push(record);
  }

  const payload = {
    version: 1,
    builtAt: new Date().toISOString(),
    sourceFile: path.basename(inputPath),
    stats: {
      headRows: headRows.length,
      unitRows: unitRows.length,
      specRows: specRows.length,
      normalizedRows: normalizedItems.length,
      skippedMissingHead,
      skippedNotShelved,
    },
    items: normalizedItems,
  };

  const outputTargets = [
    path.join(rootDir, "data", "knowledge", OUTPUT_RELATIVE_PATH),
    path.join(rootDir, "public", "knowledge", OUTPUT_RELATIVE_PATH),
  ];

  for (const target of outputTargets) {
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Wrote: ${target}`);
  }

  console.log(`Done. normalizedRows=${normalizedItems.length}`);
}

main();
