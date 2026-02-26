import { describe, expect, it } from 'vitest';
import { buildRecommendationsFromVariants, mergeRecommendations, mergeRetrievalContexts, validateMentionedProductsInVariants } from './geminiService';
import { ProductRecommendation, Tone } from '../types';
import { ScoredCatalogChunk } from './catalogKnowledgeService';
import { ScoredProductListItem } from './productListKnowledgeService';

const matchedChunks: ScoredCatalogChunk[] = [
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
    score: 24,
    matchedTerms: ['169411'],
    charCount: 40,
  },
];

const matchedProductItems: ScoredProductListItem[] = [
  {
    id: 'pl-1',
    headCode: 'AK14000',
    finalCode: '169411',
    finalUrl: 'https://dgs.com.tw/product/AK14000/169411',
    name: 'CHEMKER 系列耐酸鹼真空幫浦',
    description: '適用甲醇蒸氣與真空乾燥環境。',
    brand: 'ROCKER',
    class3: '泛用儀器',
    class2: '幫浦',
    class1: '真空',
    isAccessory: false,
    units: ['台'],
    searchSpecs: ['PTFE', '169411'],
    searchText: 'CHEMKER 系列耐酸鹼真空幫浦 169411 PTFE',
    score: 32,
    matchedTerms: ['169411', '幫浦'],
    sourceLabel: 'product_list',
  },
];

describe('mentioned product validation', () => {
  it('keeps only verifiable products in strict mode', () => {
    const variants = [
      {
        tone: Tone.STANDARD,
        content: '內容',
        references: [],
        mentionedProducts: [
          { name: 'CHEMKER 系列耐酸鹼真空幫浦', models: ['169411'], page: 462, confidence: 'high' as const },
          { name: '不存在產品', models: ['X999'], page: 470, confidence: 'low' as const },
        ],
      },
    ];

    const result = validateMentionedProductsInVariants(variants, matchedChunks, true);

    expect(result.acceptedProducts).toBe(1);
    expect(result.rejectedProducts.length).toBe(1);
    expect(result.variants[0].mentionedProducts?.length).toBe(1);
    expect(result.variants[0].mentionedProducts?.[0].name).toContain('CHEMKER');
  });

  it('deduplicates same product across tones and keeps evidence', () => {
    const variants = [
      {
        tone: Tone.CONCISE,
        content: '內容',
        references: [],
        mentionedProducts: [
          { name: 'CHEMKER 系列耐酸鹼真空幫浦', models: ['169411'], page: 462, confidence: 'medium' as const },
        ],
      },
      {
        tone: Tone.FORMAL,
        content: '內容',
        references: [],
        mentionedProducts: [
          { name: 'CHEMKER 系列耐酸鹼真空幫浦', models: ['169411'], page: 462, confidence: 'high' as const },
        ],
      },
    ];

    const recommendations = buildRecommendationsFromVariants(
      variants,
      new Map([[462, 'E']]),
      new Map([[462, 'CHEMKER 系列耐酸鹼真空幫浦，型號 169411 / 169611']])
    );

    expect(recommendations.length).toBe(1);
    expect(recommendations[0].confidence).toBe('high');
    expect(recommendations[0].tones.length).toBe(2);
    expect(recommendations[0].evidenceExcerpt.length).toBeGreaterThan(0);
  });

  it('merges dual retrieval results and keeps both sources in topK', () => {
    const merged = mergeRetrievalContexts(matchedChunks, matchedProductItems, 5, ['169411']);

    expect(merged.length).toBeGreaterThan(0);
    expect(merged.some((item) => item.source === 'catalog')).toBe(true);
    expect(merged.some((item) => item.source === 'product_list')).toBe(true);
  });

  it('prefers productUrl when catalog and product-list recommendations overlap', () => {
    const catalogRecommendations: ProductRecommendation[] = [
      {
        rank: 1,
        name: 'CHEMKER 系列耐酸鹼真空幫浦',
        models: ['169411'],
        section: 'E',
        page: 462,
        reason: '型錄命中',
        catalogUrl: 'https://ec.dgs.com.tw/catalog/catalog.html#p=462',
        evidenceExcerpt: '型錄證據',
        confidence: 'high',
        tones: [Tone.STANDARD],
        source: 'catalog',
      },
    ];

    const productRecommendations: ProductRecommendation[] = [
      {
        rank: 1,
        name: 'CHEMKER 系列耐酸鹼真空幫浦',
        models: ['169411'],
        reason: '產品清單命中',
        productUrl: 'https://dgs.com.tw/product/AK14000/169411',
        evidenceExcerpt: '清單證據',
        confidence: 'medium',
        tones: [Tone.STANDARD],
        source: 'product_list',
        finalCode: '169411',
        headCode: 'AK14000',
      },
    ];

    const mergedRecommendations = mergeRecommendations(catalogRecommendations, productRecommendations);

    expect(mergedRecommendations.length).toBe(1);
    expect(mergedRecommendations[0].source).toBe('both');
    expect(mergedRecommendations[0].productUrl).toBe('https://dgs.com.tw/product/AK14000/169411');
    expect(mergedRecommendations[0].catalogUrl).toBe('https://ec.dgs.com.tw/catalog/catalog.html#p=462');
  });
});
