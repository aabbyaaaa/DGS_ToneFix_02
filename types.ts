export enum Tone {
  CONCISE = 'concise',
  STANDARD = 'standard',
  FORMAL = 'formal',
}

export interface PolishRequest {
  sourceText: string;
  customerName?: string;
  customerTitle?: string;
  useCatalogKnowledge?: boolean;
  catalogSections?: string[];
  maxKnowledgeChunks?: number;
  strictGrounding?: boolean;
  enableFallbackRetrieval?: boolean;
}

export type TokenRiskLevel = 'low' | 'medium' | 'high';

export type RecommendationConfidence = 'high' | 'medium' | 'low';

export interface KnowledgeReference {
  source: string;
  page: number;
  excerpt?: string;
  sourceUrl?: string;
  catalogUrl?: string;
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
  knowledge?: {
    enabled: boolean;
    selectedSections: string[];
    scopedChunks: number;
    matchedChunks: number;
    retrievedTopK: number;
    matchedPages: number[];
    tokenEstimate: {
      inputChars: number;
      contextChars: number;
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
      fallbackUsed: boolean;
      noHitReason: string | null;
    };
    validation: {
      rejectedProducts: {
        name: string;
        page: number;
        reason: string;
      }[];
      acceptedProducts: number;
    };
    topChunks: {
      id: string;
      section?: string;
      page: number;
      text: string;
      sourceUrl: string;
      catalogUrl: string;
      score: number;
      matchedTerms: string[];
      charCount: number;
    }[];
  };
}

export interface ProductRecommendation {
  rank: 1 | 2 | 3;
  name: string;
  models: string[];
  section: string;
  page: number;
  reason: string;
  catalogUrl: string;
  evidenceExcerpt: string;
  confidence: RecommendationConfidence;
  tones: Tone[];
}

export interface MentionedProduct {
  name: string;
  models: string[];
  page: number;
  reason?: string;
  confidence?: RecommendationConfidence;
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
