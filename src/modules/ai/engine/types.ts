/**
 * The recommendation-engine boundary. Phase 6 ships a rule-based implementation; this interface is
 * the stable seam for the future Python/FastAPI ML service (MODULE_BREAKDOWN.md §14, Arch §3).
 * Swapping engines is one setRecommendationEngine() call — no consumer changes.
 *
 * Every recommendation carries a `reasonSummary` — recommendations are EXPLAINABLE and ADVISORY,
 * never an opaque black box (FR-9.1/9.2).
 */
export interface SellerContext {
  sellerId: string;
  lng?: number;
  lat?: number;
  /** UTC hour override (for deterministic tests); defaults to the current hour. */
  hourUtc?: number;
}

export interface ProductRecommendation {
  productId: string;
  hubId: string;
  name: string;
  unitValueCents: number;
  score: number;
  reasonSummary: string;
  factors: string[];
}

export interface LocationRecommendation {
  hubId: string;
  score: number;
  recentUnits: number;
  recentRevenueCents: number;
  reasonSummary: string;
}

export interface PricingSuggestion {
  productId: string;
  suggestedPriceCents: number;
  lowCents: number;
  highCents: number;
  sampleSize: number;
  reasonSummary: string;
  advisoryOnly: true;
}

export interface RecommendationEngine {
  readonly version: string;
  recommendProducts(ctx: SellerContext, limit: number): Promise<ProductRecommendation[]>;
  recommendLocations(ctx: SellerContext, limit: number): Promise<LocationRecommendation[]>;
  suggestPricing(productId: string): Promise<PricingSuggestion>;
}
