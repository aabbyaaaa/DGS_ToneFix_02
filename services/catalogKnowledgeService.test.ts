import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('catalog_A_F_chunks.json')) {
        return Promise.resolve({ ok: true, json: async () => mockChunks });
      }
      if (String(url).includes('catalog_A_F_hybrid_index.json')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    })
  );
});

describe('catalog retrieval', () => {
  it('filters by selected section only', async () => {
    const result = await retrieveCatalogContext('169411', 5, ['E'], { retrievalMode: 'lexical' });

    expect(result.scopedChunks).toBe(2);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.section === 'E')).toBe(true);
    expect(result.queryDiagnostics.retrievalMode).toBe('lexical');
  });

  it('uses fallback retrieval when lexical misses', async () => {
    const result = await retrieveCatalogContext('請問推薦', 5, ['E'], {
      enableFallbackRetrieval: true,
      retrievalMode: 'lexical',
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.queryDiagnostics.fallbackUsed).toBe(true);
    expect(result.queryDiagnostics.noHitReason).toContain('fallback');
  });

  it('degrades hybrid retrieval to lexical when hybrid index is unavailable', async () => {
    const result = await retrieveCatalogContext('169411', 5, ['E'], {
      retrievalMode: 'hybrid',
      enableFallbackRetrieval: true,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.queryDiagnostics.retrievalMode).toBe('hybrid');
    expect(result.queryDiagnostics.hybridUsed).toBe(false);
    expect(result.queryDiagnostics.degradedToLexical).toBe(true);
  });
});
