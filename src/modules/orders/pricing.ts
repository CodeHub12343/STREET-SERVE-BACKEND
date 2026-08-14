/**
 * Server-authoritative checkout pricing (R9 / PHASE_1_IMPLEMENTATION_PLAN.md §3). The single place
 * that turns a resolved cart into an itemized breakdown, used by BOTH the quote (preview) and the
 * place (charge) paths so the customer can never be charged a different total than they previewed.
 * Integer cents throughout.
 *
 * MVP is "transparency-first": every mandated line exists in the shape, but tax / delivery / service
 * / processing default to $0 (config-driven via `OrderFeeRates`). The 10% platform fee is paid by the
 * vendor and reported as `platformFeeCents` for display only — the customer is NOT charged it.
 *
 * All rate math goes through `applyBps` (A-5) so checkout rounds the same direction as settlement,
 * RTO, and the fee registry. Previously each of those spelled the same floor-divide out for itself.
 */
import { applyBps, applyPercent } from '../../shared/money';
export interface OrderFeeRates {
  taxBps: number;
  serviceFeeBps: number;
  /** Customer-service fee bounds (R10). Applied only when serviceFeeBps > 0; 0 = no floor/cap. */
  serviceFeeMinCents: number;
  serviceFeeMaxCents: number;
  processingBps: number;
  processingFlatCents: number;
  deliveryCents: number;
}

/** Pickup MVP: no customer-facing tax/delivery/service/processing (Transparency-first decision). */
export const MVP_ORDER_FEE_RATES: OrderFeeRates = {
  taxBps: 0,
  serviceFeeBps: 0,
  serviceFeeMinCents: 0,
  serviceFeeMaxCents: 0,
  processingBps: 0,
  processingFlatCents: 0,
  deliveryCents: 0,
};

export interface OrderBreakdown {
  subtotalCents: number;
  discountPercent: number;
  discountCents: number;
  taxCents: number;
  deliveryCents: number;
  serviceFeeCents: number;
  processingFeeCents: number;
  tipCents: number;
  roundUpCents: number;
  totalCents: number;
  /** Informational only: the platform fee the vendor pays on this sale; not charged to the customer. */
  platformFeeCents: number;
}

/**
 * Compute the full breakdown. Order of operations: discount off subtotal, then tax/delivery/service
 * on the discounted goods, then tip + round-up (pass-through, never fee'd), then processing on the
 * running total. With MVP rates all zero this reduces to `subtotal − discount + tip + roundUp`.
 */
export function computeOrderBreakdown(input: {
  subtotalCents: number;
  discountPercent?: number;
  tipCents?: number;
  roundUpCents?: number;
  platformFeeCents?: number;
  rates?: OrderFeeRates;
}): OrderBreakdown {
  const rates = input.rates ?? MVP_ORDER_FEE_RATES;
  const discountPercent = input.discountPercent ?? 0;
  const tipCents = input.tipCents ?? 0;
  const roundUpCents = input.roundUpCents ?? 0;

  const discountCents = applyPercent(input.subtotalCents, discountPercent);
  const discountedSubtotal = input.subtotalCents - discountCents;

  const taxCents = applyBps(discountedSubtotal, rates.taxBps);
  // Customer-service fee (R10): a % of the discounted goods, floored/capped when the fee is on.
  let serviceFeeCents = applyBps(discountedSubtotal, rates.serviceFeeBps);
  if (rates.serviceFeeBps > 0) {
    if (rates.serviceFeeMinCents > 0) serviceFeeCents = Math.max(serviceFeeCents, rates.serviceFeeMinCents);
    if (rates.serviceFeeMaxCents > 0) serviceFeeCents = Math.min(serviceFeeCents, rates.serviceFeeMaxCents);
  }
  const deliveryCents = rates.deliveryCents;

  const preProcessing =
    discountedSubtotal + taxCents + deliveryCents + serviceFeeCents + tipCents + roundUpCents;
  const processingFeeCents =
    rates.processingBps || rates.processingFlatCents
      ? applyBps(preProcessing, rates.processingBps) + rates.processingFlatCents
      : 0;

  return {
    subtotalCents: input.subtotalCents,
    discountPercent,
    discountCents,
    taxCents,
    deliveryCents,
    serviceFeeCents,
    processingFeeCents,
    tipCents,
    roundUpCents,
    totalCents: preProcessing + processingFeeCents,
    platformFeeCents: input.platformFeeCents ?? 0,
  };
}
