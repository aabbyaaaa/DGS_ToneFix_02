import { describe, expect, it } from "vitest";
import { buildRecommendationsFromProductList } from "./geminiService";
import { ScoredProductListItem } from "./productListKnowledgeService";

const sampleItems: ScoredProductListItem[] = [
  {
    id: "pl-1",
    headCode: "H1",
    finalCode: "F1",
    finalUrl: "https://dgs.com.tw/product/H1/F1",
    name: "真空幫浦 A",
    description: "適用於甲醇蒸氣環境",
    brand: "DGS",
    class3: "泛用儀器",
    class2: "幫浦",
    class1: "真空",
    isAccessory: false,
    units: ["台"],
    searchSpecs: ["PTFE"],
    searchText: "真空幫浦 A F1 PTFE",
    score: 28,
    matchedTerms: ["真空幫浦", "F1"],
    sourceLabel: "product_list",
  },
  {
    id: "pl-2",
    headCode: "H2",
    finalCode: "F2",
    finalUrl: "https://dgs.com.tw/product/H2/F2",
    name: "真空幫浦 B",
    description: "標準型",
    brand: "DGS",
    class3: "泛用儀器",
    class2: "幫浦",
    class1: "真空",
    isAccessory: false,
    units: ["台"],
    searchSpecs: ["PTFE"],
    searchText: "真空幫浦 B F2",
    score: 16,
    matchedTerms: ["F2"],
    sourceLabel: "product_list",
  },
];

describe("buildRecommendationsFromProductList", () => {
  it("maps top items into product_list recommendations with finalUrl", () => {
    const recommendations = buildRecommendationsFromProductList(sampleItems);
    expect(recommendations.length).toBe(2);
    expect(recommendations[0].source).toBe("product_list");
    expect(recommendations[0].productUrl).toBe("https://dgs.com.tw/product/H1/F1");
    expect(recommendations[0].finalCode).toBe("F1");
    expect(recommendations[0].headCode).toBe("H1");
  });

  it("assigns confidence by score tier", () => {
    const recommendations = buildRecommendationsFromProductList(sampleItems);
    expect(recommendations[0].confidence).toBe("high");
    expect(recommendations[1].confidence).toBe("medium");
  });
});
