import {
  POSTCARD_MARGIN_BASIS,
  POSTCARD_PRODUCTS,
  POSTCARD_QUOTE_TTL_MINUTES,
  type PostcardProduct,
} from '../../config/constants';
import { ValidationError } from '../../shared/errors';
import type { MailClass } from '../../integrations/print';

/**
 * Turning a wholesale cost into what the buyer pays (ADR-007 §4, Topology B).
 *
 * Pure arithmetic, deliberately separated from the service so the money maths can be read and
 * tested without a database — the same split `rto.pricing.ts` makes.
 */

export interface OrderPrice {
  quantity: number;
  vendorUnitCostCents: number;
  /** What the vendor charges us for the whole run. */
  vendorCostCents: number;
  /** StreetServe's margin. */
  marginCents: number;
  /** What the buyer pays. */
  totalCents: number;
  marginBps: number;
  basis: typeof POSTCARD_MARGIN_BASIS;
}

export function findProduct(sku: string): PostcardProduct | null {
  return POSTCARD_PRODUCTS.find((p) => p.sku === sku && p.active) ?? null;
}

export function quoteExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + POSTCARD_QUOTE_TTL_MINUTES * 60_000);
}

export function isQuoteExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  // A missing expiry is treated as expired, not as valid forever. Failing closed on money is right.
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

/**
 * Validates a requested run against the product registry.
 *
 * Separate from pricing because the buyer should be told *why* a run is not orderable — "this size
 * is First Class only" is actionable, a rejected quote is not.
 */
export function assertOrderable(
  product: PostcardProduct,
  mailClass: MailClass,
  quantity: number,
): void {
  if (!product.mailClasses.includes(mailClass)) {
    throw ValidationError(
      `${product.label} can only be mailed ${product.mailClasses
        .map((m) => (m === 'first_class' ? 'First Class' : 'Standard'))
        .join(' or ')}.`,
    );
  }
  if (!Number.isInteger(quantity) || quantity < product.minQuantity) {
    throw ValidationError(
      `A ${product.label} mailing needs at least ${product.minQuantity.toLocaleString()} pieces.`,
    );
  }
  if (quantity > product.maxQuantity) {
    throw ValidationError(
      `A single order tops out at ${product.maxQuantity.toLocaleString()} pieces. Split it across orders.`,
    );
  }
}

/**
 * Applies the margin.
 *
 * `retail` basis: the rate is a share of what the buyer pays, so the price is grossed UP —
 * `total = wholesale / (1 - rate)`. A 10% margin on a $450 wholesale run is a $500 order with $50
 * to us, matching the brief's worked example.
 *
 * `cost` basis marks the wholesale price up instead, which on the same run yields $495 and an
 * effective 9.1%. The difference is about a point of margin, which is why the basis is configured
 * and named rather than left implicit in a multiplication.
 */
export function priceOrder(input: {
  quantity: number;
  vendorUnitCostCents: number;
  marginBps: number;
}): OrderPrice {
  const { quantity, vendorUnitCostCents, marginBps } = input;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw ValidationError('Quantity must be a positive whole number.');
  }
  if (!Number.isFinite(vendorUnitCostCents) || vendorUnitCostCents <= 0) {
    throw ValidationError('The mailing rate is unavailable, so this cannot be priced right now.');
  }
  if (marginBps < 0 || marginBps >= 10_000) {
    // A rate at or above 100% makes the retail basis divide by zero or go negative.
    throw ValidationError('The configured postcard margin is not a usable rate.');
  }

  const vendorCostCents = Math.round(vendorUnitCostCents * quantity);
  const totalCents =
    POSTCARD_MARGIN_BASIS === 'retail'
      ? Math.round(vendorCostCents / (1 - marginBps / 10_000))
      : Math.round(vendorCostCents * (1 + marginBps / 10_000));

  return {
    quantity,
    vendorUnitCostCents,
    vendorCostCents,
    /**
     * Derived by subtraction rather than computed independently, so the three numbers always add
     * up. Two roundings that each look right can leave a cent unaccounted for on the invoice.
     */
    marginCents: totalCents - vendorCostCents,
    totalCents,
    marginBps,
    basis: POSTCARD_MARGIN_BASIS,
  };
}
