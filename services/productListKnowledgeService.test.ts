import { beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveProductListContext } from "./productListKnowledgeService";

const mockIndex = {
  items: [
    {
      id: "H1__F1",
      headCode: "H1",
      finalCode: "F1",
      finalUrl: "https://dgs.com.tw/product/H1/F1",
      name: "計數瓶 20ml",
      description: "玻璃計數瓶 20ml",
      brand: "TEST",
      class3: "容器",
      class2: "x",
      class1: "y",
      isAccessory: false,
      units: ["ea"],
      searchSpecs: ["容量:20ml"],
      searchText: "計數瓶 20ml F1",
    },
    {
      id: "H2__F1",
      headCode: "H2",
      finalCode: "F1",
      finalUrl: "https://dgs.com.tw/product/H2/F1",
      name: "計數瓶 20ml 高分",
      description: "20ml 計數瓶",
      brand: "TEST",
      class3: "容器",
      class2: "x",
      class1: "y",
      isAccessory: false,
      units: ["ea"],
      searchSpecs: ["容量:20ml"],
      searchText: "計數瓶 20ml F1 高分 20ml 20ml",
    },
    {
      id: "H3__F3",
      headCode: "H3",
      finalCode: "F3",
      finalUrl: "https://dgs.com.tw/product/H3/F3",
      name: "電極配件",
      description: "配件 電極",
      brand: "TEST",
      class3: "泛用儀器",
      class2: "x",
      class1: "y",
      isAccessory: true,
      units: ["ea"],
      searchSpecs: [],
      searchText: "電極 配件 F3",
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("product_list_index.json")) {
        return {
          ok: true,
          json: async () => mockIndex,
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    })
  );
});

describe("product list retrieval", () => {
  it("deduplicates by finalCode and keeps highest scored row", async () => {
    const result = await retrieveProductListContext("20ml 計數瓶 高分", 5);
    expect(result.items.length).toBe(1);
    expect(result.items[0].finalCode).toBe("F1");
    expect(result.items[0].headCode).toBe("H2");
  });

  it("excludes accessory by default and includes when accessory intent is present", async () => {
    const normalQuery = await retrieveProductListContext("計數瓶", 5);
    expect(normalQuery.items.some((item) => item.finalCode === "F3")).toBe(false);

    const accessoryQuery = await retrieveProductListContext("請推薦電極配件", 5);
    expect(accessoryQuery.items.some((item) => item.finalCode === "F3")).toBe(true);
  });
});
