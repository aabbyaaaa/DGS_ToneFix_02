import { describe, expect, it } from 'vitest';
import { buildRecommendationsFromVariants, validateMentionedProductsInVariants } from './geminiService';
import { Tone } from '../types';
import { ScoredCatalogChunk } from './catalogKnowledgeService';

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
});
