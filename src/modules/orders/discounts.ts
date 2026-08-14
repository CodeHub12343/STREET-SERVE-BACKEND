import { applyPercent } from '../../shared/money';

/**
 * A-7 — the single price-discount abstraction.
 *
 * ## The problem this replaces
 *
 * Four things on this platform were called "a discount" and only two of them were the same kind of
 * thing:
 *
 *   1. **Queue position discount** — time-decaying, applied at join, reduces what the customer pays.
 *   2. **Flash sale** (MS-10, not yet built) — product-scoped, window-based, reduces what the
 *      customer pays.
 *   3. **Trust-band fee discount** — reduces the PLATFORM'S FEE. The customer pays the same.
 *   4. **Seller Plus / subscription fee discount** — same: platform fee, not price.
 *
 * (3) and (4) are not discounts on a price at all; they are the platform charging itself less, and
 * they are correctly implemented elsewhere (`consignment.service.ts`, funded out of the platform's
 * cut so the hub's share is never touched). **Nothing in this file applies to them**, and conflating
 * the two is the mistake that makes discount code dangerous: a bug that mixes them either
 * short-pays a seller or gives away platform revenue, and both look like "the discount worked".
 *
 * This module is only about (1) and (2): money the CUSTOMER does not pay.
 *
 * ## The rules, decided once
 *
 *   - **Discounts do not stack. The single best one wins.** Two 40%-off rules that compose reach
 *     64% off, three reach 78%, and nobody authored that number. Best-wins is predictable, is what
 *     a customer expects, and cannot run away.
 *   - **A window of `null` means always on.** The queue schedule has no window; flash sales do.
 *   - **A hard ceiling applies after resolution** (`MAX_DISCOUNT_PERCENT`), so a misconfigured
 *     schedule cannot produce a free item.
 *   - **Percent, not basis points.** Prices are quoted to customers in whole percent ("20% off");
 *     the fee registry uses bps because fee rates are fractional. Keeping the units aligned with how
 *     each number is *communicated* is what stops a 1000× error.
 */

/** The most a price discount may ever reduce a price, however it was configured. */
export const MAX_DISCOUNT_PERCENT = 90;

export type DiscountScope =
  | { kind: 'queue'; ownerType: 'business' | 'seller'; ownerId: string }
  | { kind: 'product'; productId: string }
  | { kind: 'business'; businessId: string };

export type DiscountSource = 'queue_position' | 'flash_sale' | 'business_promo';

export interface DiscountWindow {
  startsAt: Date;
  endsAt: Date;
}

export interface PriceDiscount {
  source: DiscountSource;
  scope: DiscountScope;
  /** Whole percent off the price, 0–100 before the ceiling is applied. */
  percent: number;
  /** `null` = no window, always in force (the queue schedule). */
  window: DiscountWindow | null;
  /** Customer-facing reason, shown wherever the discount is applied. Never a bare percentage. */
  label: string;
}

export interface ResolvedDiscount {
  percent: number;
  label: string;
  source: DiscountSource | null;
  /** Every candidate that was in force, best first — so a receipt can explain what did NOT apply. */
  considered: PriceDiscount[];
}

export function isInWindow(discount: PriceDiscount, at: Date = new Date()): boolean {
  if (!discount.window) return true;
  return at >= discount.window.startsAt && at <= discount.window.endsAt;
}

/**
 * Pick the discount that applies. Best-wins among those in force, then clamped to the ceiling.
 *
 * Returns `percent: 0` with a null source when nothing applies — callers should not have to
 * distinguish "no discount" from "no candidates", and a zero discount priced through the normal
 * path produces the normal price.
 */
export function resolveDiscount(
  candidates: PriceDiscount[],
  at: Date = new Date(),
): ResolvedDiscount {
  const inForce = candidates
    .filter((c) => c.percent > 0 && isInWindow(c, at))
    .sort((a, b) => b.percent - a.percent);

  const best = inForce[0];
  if (!best) return { percent: 0, label: '', source: null, considered: [] };

  return {
    percent: Math.min(best.percent, MAX_DISCOUNT_PERCENT),
    label: best.label,
    source: best.source,
    considered: inForce,
  };
}

/** Apply a resolved discount to a price. Rounds down like every other rate on the money path. */
export function applyDiscount(
  priceCents: number,
  resolved: ResolvedDiscount,
): { discountCents: number; discountedCents: number } {
  const discountCents = applyPercent(priceCents, resolved.percent);
  return { discountCents, discountedCents: priceCents - discountCents };
}

/**
 * Retrofit: express a queue position discount in the shared shape.
 *
 * The queue schedule predates this abstraction and keeps its own storage — tiers by position, with
 * a cap beyond the last tier — because position-indexed tiers are genuinely queue-specific and
 * flattening them into a generic table would lose the "strictly increasing by position" invariant
 * the service enforces. What it does NOT keep is its own answer to "which discount applies and how
 * is it applied": that comes through here, so when flash sales land there is one contest, not two
 * parallel ones.
 */
export function queuePositionDiscount(input: {
  ownerType: 'business' | 'seller';
  ownerId: string;
  position: number;
  percent: number;
}): PriceDiscount {
  return {
    source: 'queue_position',
    scope: { kind: 'queue', ownerType: input.ownerType, ownerId: input.ownerId },
    percent: input.percent,
    window: null, // in force whenever the customer holds the position
    label: `${input.percent}% off for being #${input.position} in line`,
  };
}

/**
 * The shape MS-10 will produce. Defined here, ahead of the feature, so the flash sale is built
 * against the existing contest rather than introducing a third discount system — which was the
 * whole point of doing A-7 before MS-10.
 */
export function flashSaleDiscount(input: {
  productId: string;
  percent: number;
  startsAt: Date;
  endsAt: Date;
  label?: string;
}): PriceDiscount {
  return {
    source: 'flash_sale',
    scope: { kind: 'product', productId: input.productId },
    percent: input.percent,
    window: { startsAt: input.startsAt, endsAt: input.endsAt },
    label: input.label ?? `${input.percent}% off — limited time`,
  };
}
