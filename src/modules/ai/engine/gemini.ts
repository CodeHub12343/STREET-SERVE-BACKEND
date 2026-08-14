/**
 * Gemini-backed recommendation engine.
 *
 * ── What Gemini does and does NOT do here ───────────────────────────────────────────────────────
 * It does NOT choose products, rank hubs, or set prices. Those come from `RuleBasedEngine`, which
 * scores real first-party signals (inventory_sales, checkouts) and is auditable line by line.
 * Gemini rewrites the machine-generated `reasonSummary` into something a street seller actually
 * wants to read, from the same facts.
 *
 * That split is deliberate:
 *  - `suggestPricing` produces a number a seller prices real inventory on. A model that invents
 *    prices from plausible-sounding text would be guessing with someone's income. The cents stay
 *    computed from observed sales; only the sentence explaining them is generated.
 *  - FR-9.1/9.2 require recommendations to be EXPLAINABLE. `factors` — the actual scoring inputs —
 *    are preserved untouched on every recommendation, so the generated prose is always checkable
 *    against the reasons the deterministic engine used.
 *
 * Every method falls back to the rule-based copy if Gemini is unavailable, slow, rate-limited, or
 * returns anything unexpected. The feature degrades in wording, never in function.
 */
import { AI_ENGINE_VERSION } from '../../../config/constants';
import { gemini } from '../../../integrations/gemini';
import { RuleBasedEngine } from './ruleBased';
import type {
  LocationRecommendation,
  PricingSuggestion,
  ProductRecommendation,
  RecommendationEngine,
  SellerContext,
} from './types';

/** Grounding rules. Kept out of the fact payload so user data can never read as instructions. */
const SYSTEM = [
  'You write one-line explanations for a street vendor marketplace called StreetServe.',
  'Your readers are independent street sellers deciding what to stock and where to set up.',
  'RULES:',
  '- Use ONLY the facts given. Never invent numbers, prices, trends, locations, or dates.',
  '- One sentence, max 20 words, plain spoken English. No emoji, no marketing hype.',
  '- Say WHY it is worth their time, not what the item is.',
  '- These are suggestions, never guarantees. Never promise sales or income.',
].join('\n');

const WHY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' }, why: { type: 'STRING' } },
        required: ['id', 'why'],
      },
    },
  },
  required: ['items'],
} as const;

interface WhyResponse {
  items?: { id?: string; why?: string }[];
}

/** A rewritten line is only accepted if it is non-empty and plausibly one sentence. */
function usable(why: unknown): why is string {
  return typeof why === 'string' && why.trim().length > 0 && why.length <= 240;
}

/**
 * Ask for one rewritten line per fact row, keyed by id. Returns an empty map on any failure, so
 * callers keep their deterministic strings.
 */
async function rewriteWhy(
  intro: string,
  rows: { id: string; facts: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rows.length === 0 || !gemini.available) return out;

  const prompt = [
    intro,
    'Write one explanation for each item below. Reply with the same ids.',
    '',
    ...rows.map((r) => `id: ${r.id}\nfacts: ${r.facts}`),
  ].join('\n');

  const res = await gemini.generateJson<WhyResponse>({
    prompt,
    schema: WHY_SCHEMA,
    systemInstruction: SYSTEM,
    fast: true, // short rewrites, one per card — flash-lite is the right tool
    temperature: 0.4,
    maxOutputTokens: 80 * rows.length + 128,
  });

  for (const item of res?.items ?? []) {
    if (item?.id && usable(item.why)) out.set(item.id, item.why.trim());
  }
  return out;
}

export class GeminiEngine implements RecommendationEngine {
  /** Recorded on every logged recommendation, so rows are attributable to the engine that made them. */
  readonly version = `${AI_ENGINE_VERSION}+gemini`;

  private readonly base = new RuleBasedEngine();

  async recommendProducts(ctx: SellerContext, limit: number): Promise<ProductRecommendation[]> {
    const recs = await this.base.recommendProducts(ctx, limit);
    const whys = await rewriteWhy(
      'Each item is stock a seller could pick up and resell today.',
      recs.map((r) => ({
        id: r.productId,
        facts: [
          `product: ${r.name}`,
          `unit value: $${(r.unitValueCents / 100).toFixed(2)}`,
          `signals: ${r.factors.length ? r.factors.join(', ') : 'available inventory nearby'}`,
        ].join('; '),
      })),
    );
    // `factors` deliberately survive untouched — the audit trail behind whatever prose we show.
    return recs.map((r) => ({ ...r, reasonSummary: whys.get(r.productId) ?? r.reasonSummary }));
  }

  async recommendLocations(ctx: SellerContext, limit: number): Promise<LocationRecommendation[]> {
    const recs = await this.base.recommendLocations(ctx, limit);
    const whys = await rewriteWhy(
      'Each item is a hub location a seller could set up at or restock from.',
      recs.map((r) => ({
        id: r.hubId,
        facts: [
          `recent sales: ${r.recentUnits} units`,
          `recent revenue: $${(r.recentRevenueCents / 100).toFixed(2)}`,
          `ranking score: ${r.score.toFixed(2)} out of 1`,
        ].join('; '),
      })),
    );
    return recs.map((r) => ({ ...r, reasonSummary: whys.get(r.hubId) ?? r.reasonSummary }));
  }

  /**
   * The suggested price, range and sample size are returned EXACTLY as computed. Gemini only gets
   * to explain them — and only when there were real comparable sales to explain.
   */
  async suggestPricing(productId: string): Promise<PricingSuggestion> {
    const suggestion = await this.base.suggestPricing(productId);
    if (suggestion.sampleSize === 0) return suggestion;

    const whys = await rewriteWhy(
      'This is a price suggestion for a seller, based on what similar items recently sold for.',
      [
        {
          id: suggestion.productId,
          facts: [
            `suggested price: $${(suggestion.suggestedPriceCents / 100).toFixed(2)}`,
            `recent comparable sales ranged $${(suggestion.lowCents / 100).toFixed(2)} to $${(suggestion.highCents / 100).toFixed(2)}`,
            `based on ${suggestion.sampleSize} sale(s)`,
            'the seller sets the final price',
          ].join('; '),
        },
      ],
    );
    const why = whys.get(suggestion.productId);
    return why
      ? { ...suggestion, reasonSummary: `${why} Advisory only — you set the final price.` }
      : suggestion;
  }
}
