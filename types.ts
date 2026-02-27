export enum Tone {
  CONCISE = 'concise',
  STANDARD = 'standard',
  FORMAL = 'formal',
}

export interface PolishRequest {
  sourceText: string;
  customerName?: string;
  customerTitle?: string;
  maxKnowledgeChunks?: number;
}

export type TokenRiskLevel = 'low' | 'medium' | 'high';

export type RecommendationConfidence = 'high' | 'medium' | 'low';
export type RecommendationSource = 'product_list';

export interface KnowledgeReference {
  source: string;
  page?: number;
  excerpt?: string;
  sourceUrl?: string;
}

export interface PolishedVariant {
  tone: Tone;
  subject?: string; // Optional email subject suggestion
  content: string;
  references?: KnowledgeReference[];
  mentionedProducts?: MentionedProduct[];
}

export interface PolishResponse {
  variants: PolishedVariant[];
  recommendedProducts: ProductRecommendation[];
  knowledge: {
    retrievalMode: 'product_list_only';
    enabled: true;
    scopedItems: number;
    matchedItems: number;
    retrievedTopK: number;
    mergedContext: Array<{
      source: RecommendationSource;
      score: number;
      matchedTerms: string[];
      headCode: string;
      finalCode: string;
      url: string;
      preview: string;
      charCount: number;
    }>;
    tokenEstimate: {
      inputChars: number;
      contextChars: 0;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      estimatedTotalTokens: number;
      riskLevel: TokenRiskLevel;
      warning: string | null;
    };
    queryDiagnostics: {
      modelTokens: string[];
      alphaNumTokens: string[];
      chineseTerms: string[];
      accessoryIntent: boolean;
      noHitReason: string | null;
    };
    topItems: Array<{
      finalCode: string;
      headCode: string;
      name: string;
      score: number;
      matchedTerms: string[];
      productUrl: string;
      preview: string;
      charCount: number;
    }>;
  };
}

export interface ProductRecommendation {
  rank: 1 | 2 | 3;
  name: string;
  models: string[];
  section?: string;
  reason: string;
  productUrl: string;
  evidenceExcerpt: string;
  confidence: RecommendationConfidence;
  tones: Tone[];
  source: 'product_list';
  finalCode: string;
  headCode: string;
}

export interface MentionedProduct {
  name: string;
  models: string[];
  page?: number;
  reason?: string;
  confidence?: RecommendationConfidence;
  productUrl?: string;
  finalCode?: string;
}

export interface CatalogChunk {
  id: string;
  source: string;
  section?: string;
  page: number;
  chunkIndex: number;
  totalChunksOnPage: number;
  text: string;
  sourceUrl: string;
  catalogUrl: string;
  extractedAt: string;
}

export interface LoadingState {
  isLoading: boolean;
  step: string; // e.g., "Analyzing terms...", "Polishing...", "Finalizing"
}
