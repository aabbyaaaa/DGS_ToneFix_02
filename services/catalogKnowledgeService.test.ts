import { beforeAll, describe, expect, it, vi } from 'vitest';
import { retrieveCatalogContext } from './catalogKnowledgeService';

const mockChunks = [
  {
    id: 'dgs-p180-c1',
    source: 'dgs_ecatalog',
    section: 'B',
    page: 180,
    chunkIndex: 1,
    totalChunksOnPage: 1,
    text: 'B 區內容：20ml 計數瓶與玻璃耗材。',
    sourceUrl: 'https://example.com/p180',
    catalogUrl: 'https://ec.dgs.com.tw/catalog/catalog.html#p=180',
    extractedAt: '2026-02-24T00:00:00.000Z',
  },
  {
    id: 'dgs-p462-c1',
    source: 'dgs_ecatalog',
    section: 'E',
    page: 462,
    chunkIndex: 1,
    totalChunksOnPage: 1,
    text: 'CHEMKER 系列耐酸鹼真空幫浦，型號 169411 / 169611，推薦搭配使用。',
    sourceUrl: 'https://example.com/p462',
    catalogUrl: 'https://ec.dgs.com.tw/catalog/catalog.html#p=462',
    extractedAt: '2026-02-24T00:00:00.000Z',
  },
  {
    id: 'dgs-p463-c1',
    source: 'dgs_ecatalog',
    section: 'E',
    page: 463,
    chunkIndex: 1,
    totalChunksOnPage: 1,
    text: 'NEWLAB D9EL-AS3 水流抽氣機，耐 pH 2~10。',
    sourceUrl: 'https://example.com/p463',
    catalogUrl: 'https://ec.dgs.com.tw/catalog/catalog.html#p=463',
    extractedAt: '2026-02-24T00:00:00.000Z',
  },
];

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockChunks,
    })
  );
});

describe('catalog retrieval', () => {
  it('filters by selected section only', async () => {
    const result = await retrieveCatalogContext('169411', 5, ['E']);

    expect(result.scopedChunks).toBe(2);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.section === 'E')).toBe(true);
  });

  it('uses fallback retrieval when lexical misses', async () => {
    const result = await retrieveCatalogContext('請問推薦', 5, ['E'], { enableFallbackRetrieval: true });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.queryDiagnostics.fallbackUsed).toBe(true);
    expect(result.queryDiagnostics.noHitReason).toContain('fallback');
  });

  it('returns explainable no-hit reason when query has no searchable tokens', async () => {
    const result = await retrieveCatalogContext('？？？', 5, ['E'], { enableFallbackRetrieval: true });

    expect(result.items.length).toBe(0);
    expect(result.queryDiagnostics.noHitReason).toBeTruthy();
  });
});
