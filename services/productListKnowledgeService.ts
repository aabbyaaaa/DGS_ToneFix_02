import { buildCharacterNgrams, getAlphaNumTokens, getChineseTerms, getModelLikeTokens } from "./catalogKnowledgeService";

const PRODUCT_LIST_INDEX_PATH = "/knowledge/product_list_index.json";
const DEFAULT_RETRIEVE_LIMIT = 5;
const ACCESSORY_HINT_TERMS = ["配件", "耗材", "替換", "電極", "矽膠管", "探頭", "電線", "夾具"];

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
  scopedItems: number;
  items: ScoredProductListItem[];
  accessoryIntent: boolean;
  queryDiagnostics: {
    modelTokens: string[];
    alphaNumTokens: string[];
    chineseTerms: string[];
    noHitReason: string | null;
  };
}

function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
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
  limit = DEFAULT_RETRIEVE_LIMIT
): Promise<ProductListRetrievalResult> {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RETRIEVE_LIMIT;
  const cleanedQuery = query.trim();
  const accessoryIntent = detectAccessoryIntent(cleanedQuery);
  const modelTokens = uniqueTokens(getModelLikeTokens(cleanedQuery));
  const alphaNumTokens = uniqueTokens(getAlphaNumTokens(cleanedQuery));
  const chineseTerms = uniqueTokens(getChineseTerms(cleanedQuery));

  if (!cleanedQuery) {
    return {
      scopedItems: 0,
      items: [],
      accessoryIntent,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        noHitReason: "查詢內容為空，無法進行產品清單檢索。",
      },
    };
  }

  const items = await loadProductListIndex();
  if (items.length === 0) {
    return {
      scopedItems: 0,
      items: [],
      accessoryIntent,
      queryDiagnostics: {
        modelTokens,
        alphaNumTokens,
        chineseTerms,
        noHitReason: "產品清單索引為空，請先重建索引。",
      },
    };
  }

  const scopedItems = items;

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
    scopedItems: scopedItems.length,
    items: deduped,
    accessoryIntent,
    queryDiagnostics: {
      modelTokens: lexicalTerms.modelTokens,
      alphaNumTokens: lexicalTerms.alphaNumTokens,
      chineseTerms: lexicalTerms.chineseTerms,
      noHitReason: deduped.length === 0 ? "產品清單無命中項目。" : null,
    },
  };
}
