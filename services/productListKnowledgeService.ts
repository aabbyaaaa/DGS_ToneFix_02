import { buildCharacterNgrams, getAlphaNumTokens, getChineseTerms, getModelLikeTokens } from "./catalogKnowledgeService";

const PRODUCT_LIST_INDEX_PATH = "/knowledge/product_list_index.json";
const DEFAULT_RETRIEVE_LIMIT = 5;
const ACCESSORY_HINT_TERMS = ["配件", "耗材", "替換", "電極", "矽膠管", "探頭", "電線", "夾具"];

const SECTION_TO_CLASS3: Record<string, string> = {
  A: "基礎實驗器材",
  B: "容器",
  C: "濾紙試紙",
  D: "液體處理設備",
  E: "泛用儀器",
  F: "公安無塵設備",
};

let productListCachePromise: Promise<ProductListIndexItem[]> | null = null;

export interface ProductListIndexItem {
  id: string;
  headCode: string;
  finalCode: string;
  finalUrl: string;
  name: string;
  description: string;
  brand: string;
  class3: string;
  class2: string;
  class1: string;
  isAccessory: boolean;
  units: string[];
  searchSpecs: string[];
  searchText: string;
}

export interface ScoredProductListItem extends ProductListIndexItem {
  score: number;
  matchedTerms: string[];
  sourceLabel: "product_list";
}

export interface ProductListRetrievalResult {
  selectedSections: string[];
  scopedItems: number;
  items: ScoredProductListItem[];
  accessoryIntent: boolean;
}

function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
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

function detectAccessoryIntent(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return ACCESSORY_HINT_TERMS.some((term) => normalized.includes(normalizeForMatch(term)));
}

function scoreItem(item: ProductListIndexItem, modelTokens: string[], alphaNumTokens: string[], chineseTerms: string[]) {
  const target = normalizeForMatch(item.searchText);
  const compactTarget = target.replace(/\s+/g, "");
  const matchedModelTokens: string[] = [];
  const matchedAlphaNumTokens: string[] = [];
  const matchedChineseTerms: string[] = [];
  let score = 0;

  for (const token of modelTokens) {
    if (target.includes(token)) {
      matchedModelTokens.push(token);
      score += 12;
    }
  }

  for (const token of alphaNumTokens) {
    if (target.includes(token)) {
      matchedAlphaNumTokens.push(token);
      score += /\d/.test(token) ? 8 : 4;
    }
  }

  for (const term of chineseTerms) {
    if (target.includes(term) || compactTarget.includes(term)) {
      matchedChineseTerms.push(term);
      score += term.length >= 4 ? 3 : 2;
    }
  }

  return {
    score,
    matchedTerms: uniqueTokens([...matchedModelTokens, ...matchedAlphaNumTokens, ...matchedChineseTerms]).slice(0, 12),
  };
}

export async function loadProductListIndex(): Promise<ProductListIndexItem[]> {
  if (!productListCachePromise) {
    productListCachePromise = fetch(PRODUCT_LIST_INDEX_PATH)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Product list index not found at ${PRODUCT_LIST_INDEX_PATH}`);
        }
        return response.json();
      })
      .then((data) => {
        const items = (data as { items?: unknown[] })?.items;
        if (!Array.isArray(items)) {
          return [];
        }

        return items.filter(
          (item): item is ProductListIndexItem =>
            typeof (item as ProductListIndexItem)?.id === "string" &&
            typeof (item as ProductListIndexItem)?.headCode === "string" &&
            typeof (item as ProductListIndexItem)?.finalCode === "string" &&
            typeof (item as ProductListIndexItem)?.finalUrl === "string" &&
            typeof (item as ProductListIndexItem)?.name === "string" &&
            typeof (item as ProductListIndexItem)?.searchText === "string"
        );
      })
      .catch((error) => {
        console.warn("Product list knowledge loading failed:", error);
        return [];
      });
  }

  return productListCachePromise;
}

export async function retrieveProductListContext(
  query: string,
  limit = DEFAULT_RETRIEVE_LIMIT,
  sections: string[] = []
): Promise<ProductListRetrievalResult> {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RETRIEVE_LIMIT;
  const selectedSections = normalizeSections(sections);
  const cleanedQuery = query.trim();
  const accessoryIntent = detectAccessoryIntent(cleanedQuery);

  if (!cleanedQuery || selectedSections.length === 0) {
    return {
      selectedSections,
      scopedItems: 0,
      items: [],
      accessoryIntent,
    };
  }

  const items = await loadProductListIndex();
  if (items.length === 0) {
    return {
      selectedSections,
      scopedItems: 0,
      items: [],
      accessoryIntent,
    };
  }

  const allowedClass3 = new Set(
    selectedSections
      .map((section) => SECTION_TO_CLASS3[section])
      .filter(Boolean)
      .map((label) => normalizeForMatch(label))
  );

  const scopedItems = items.filter((item) => allowedClass3.has(normalizeForMatch(item.class3)));
  if (scopedItems.length === 0) {
    return {
      selectedSections,
      scopedItems: 0,
      items: [],
      accessoryIntent,
    };
  }

  const modelTokens = uniqueTokens(getModelLikeTokens(cleanedQuery));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(cleanedQuery));
  const chineseTerms = uniqueTokens(getChineseTerms(cleanedQuery));

  const lexicalTerms =
    modelTokens.length + alphaNumTokens.length + chineseTerms.length > 0
      ? { modelTokens, alphaNumTokens, chineseTerms }
      : {
          modelTokens: [],
          alphaNumTokens: buildCharacterNgrams(cleanedQuery, [2]),
          chineseTerms: buildCharacterNgrams(cleanedQuery, [3]),
        };

  const ranked = scopedItems
    .filter((item) => accessoryIntent || !item.isAccessory)
    .map((item) => {
      const metrics = scoreItem(item, lexicalTerms.modelTokens, lexicalTerms.alphaNumTokens, lexicalTerms.chineseTerms);
      return {
        item,
        score: metrics.score,
        matchedTerms: metrics.matchedTerms,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  const dedupByFinalCode = new Set<string>();
  const deduped: ScoredProductListItem[] = [];
  for (const row of ranked) {
    if (dedupByFinalCode.has(row.item.finalCode)) {
      continue;
    }
    dedupByFinalCode.add(row.item.finalCode);
    deduped.push({
      ...row.item,
      score: row.score,
      matchedTerms: row.matchedTerms,
      sourceLabel: "product_list",
    });
    if (deduped.length >= normalizedLimit) {
      break;
    }
  }

  return {
    selectedSections,
    scopedItems: scopedItems.length,
    items: deduped,
    accessoryIntent,
  };
}
