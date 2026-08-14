/**
 * Refund / fee policy (R13 / PHASE_2_IMPLEMENTATION_PLAN.md §4, spec §58). One pure function that
 * turns a transaction + its order state into the exact amounts refunded and the Stripe flags to
 * apply, plus a plain-language disclosure of what's returned (U6). Used by both the preview
 * (customer/vendor sees it before confirming) and the actual refund, so the two never disagree.
 *
 * ── The four components of a charge ────────────────────────────────────────────────────────────
 * `amount_cents` is the FULL total the customer paid, which is the sum of:
 *   goods       — merchandise + tax + delivery (what the vendor is actually selling)
 *   serviceFee  — the platform's optional customer-service fee (R10 / spec §33)
 *   processing  — the payment-processor pass-through (R8 / spec §31)
 *   tip         — tip + round-up, pass-through to the vendor, never fee'd
 * Each is refunded on its own terms, so all four must be known. Reading `goods` as
 * `amount − tip` (as this file used to) silently refunded the service and processing fees even in
 * the branch whose disclosure says they are non-refundable.
 *
 * ── Policy (spec §58) ──────────────────────────────────────────────────────────────────────────
 *  - Full pre-fulfillment cancel → the order never happened, so the customer gets EVERYTHING back
 *    (goods + tip + service fee + processing fee), and the platform RETURNS its marketplace fee so
 *    the vendor is made whole. The processor still keeps its own cut; the PLATFORM absorbs that,
 *    which is why the customer can honestly be told they were charged nothing.
 *  - Partial (e.g. an out-of-stock line) → refund that portion of the GOODS, with the marketplace
 *    fee reduced proportionally. Tip, service fee, and processing are untouched: the rest of the
 *    order still stands.
 *  - Post-fulfillment (completed service) → the service fee, processing fee, and tip are
 *    NON-REFUNDABLE; only the goods portion is returned and the platform keeps its fee.
 *
 * ── Processing fees ────────────────────────────────────────────────────────────────────────────
 * Payment processors do not return their fee when a charge is refunded. That is reported honestly
 * in two separate numbers, because "the processor kept it" and "the customer is out of pocket" are
 * different facts and conflating them is what made the old single field misleading:
 *   `processingRetainedCents`        — what the PROCESSOR keeps (always the full fee, any refund).
 *   `processingBorneByCustomerCents` — of that, what the CUSTOMER does not get back (0 whenever the
 *                                      platform absorbs it).
 * Only the second belongs in a sentence addressed to the customer.
 */
export type RefundScenario = 'full_pre_fulfillment' | 'partial' | 'post_fulfillment';

export interface RefundableTxn {
  amount_cents: number;
  tip_cents?: number | null;
  round_up_cents?: number | null;
  /** Customer-service fee charged on this transaction (R10). 0/absent when the fee is off. */
  service_fee_cents?: number | null;
  /** Payment-processing pass-through charged on this transaction (R8). 0/absent when off. */
  processing_fee_cents?: number | null;
  platform_fee_cents: number;
}

export interface RefundQuote {
  scenario: RefundScenario;
  /** What lands back on the customer's card. */
  refundedCents: number;
  /** Merchandise + tax + delivery portion returned. */
  goodsCents: number;
  tipCents: number;
  /** Customer-service fee returned (0 once the service has been rendered). */
  serviceFeeRefundedCents: number;
  /** Platform fee handed back (to the vendor) — 0 when the fee is retained. */
  marketplaceFeeReturnedCents: number;
  /** Processor's own fee — never returned by the processor on a refund. */
  processingRetainedCents: number;
  /** The share of that the customer does not get back; 0 when the platform absorbs it. */
  processingBorneByCustomerCents: number;
  reverseTransfer: boolean;
  refundApplicationFee: boolean;
  disclosure: string;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function computeRefund(
  txn: RefundableTxn,
  opts: { fulfilled: boolean; partialCents?: number },
): RefundQuote {
  const amount = txn.amount_cents;
  const tip = (txn.tip_cents ?? 0) + (txn.round_up_cents ?? 0);
  const serviceFee = txn.service_fee_cents ?? 0;
  const processingFee = txn.processing_fee_cents ?? 0;
  // The vendor's actual sale: everything that is not a tip or a platform/processor fee. Floored at
  // 0 so a malformed row can never produce a negative refund.
  const goods = Math.max(0, amount - tip - serviceFee - processingFee);

  // ── Partial: refund a portion of the GOODS; fee pro-rata; everything else untouched ──
  if (opts.partialCents != null) {
    // Capped at `goods`, not at `amount`: a removed line can only give back merchandise, never the
    // customer's tip or the fees on the part of the order they are still receiving.
    const refunded = Math.max(0, Math.min(opts.partialCents, goods));
    // Pro-rata against GOODS, because the marketplace fee was charged on the goods base — dividing
    // by the gross total under-returns the vendor's fee on every partial refund.
    const feeReturned = goods > 0 ? Math.floor((txn.platform_fee_cents * refunded) / goods) : 0;
    return {
      scenario: 'partial',
      refundedCents: refunded,
      goodsCents: refunded,
      tipCents: 0,
      serviceFeeRefundedCents: 0,
      marketplaceFeeReturnedCents: feeReturned,
      processingRetainedCents: processingFee,
      processingBorneByCustomerCents: 0,
      reverseTransfer: true,
      refundApplicationFee: true,
      disclosure:
        `Refunding ${usd(refunded)} for the removed item(s); the platform fee is reduced ` +
        `proportionally. Your tip${serviceFee > 0 ? ' and service fee are' : ' is'} unchanged.`,
    };
  }

  // ── Full pre-fulfillment cancel: everything back; platform returns its fee and eats the processor's ──
  if (!opts.fulfilled) {
    const extras = [
      tip > 0 ? `your ${usd(tip)} tip` : null,
      serviceFee > 0 ? `the ${usd(serviceFee)} service fee` : null,
      processingFee > 0 ? `the ${usd(processingFee)} processing fee` : null,
    ].filter((s): s is string => s !== null);
    return {
      scenario: 'full_pre_fulfillment',
      refundedCents: amount,
      goodsCents: goods,
      tipCents: tip,
      serviceFeeRefundedCents: serviceFee,
      marketplaceFeeReturnedCents: txn.platform_fee_cents,
      processingRetainedCents: processingFee,
      // The platform absorbs the processor's cut on an order that never happened, so the customer
      // genuinely pays nothing — which is what the sentence below promises.
      processingBorneByCustomerCents: 0,
      reverseTransfer: true,
      refundApplicationFee: true,
      disclosure:
        `Full refund of ${usd(amount)}` +
        (extras.length > 0 ? ` (including ${listPhrase(extras)})` : '') +
        `. The platform fee is returned — you're charged nothing.`,
    };
  }

  // ── Post-fulfillment: service rendered → service fee, processing, and tip are non-refundable ──
  // Only what the CUSTOMER paid is named here. The retained marketplace fee is the vendor's cost,
  // not theirs, so putting it in customer-facing copy would misstate who is out of pocket.
  const nonRefundable = [
    tip > 0 ? `${usd(tip)} tip` : null,
    serviceFee > 0 ? `${usd(serviceFee)} service fee` : null,
    processingFee > 0 ? `${usd(processingFee)} processing fee` : null,
  ].filter((s): s is string => s !== null);
  return {
    scenario: 'post_fulfillment',
    refundedCents: goods,
    goodsCents: goods,
    tipCents: 0,
    serviceFeeRefundedCents: 0,
    marketplaceFeeReturnedCents: 0,
    processingRetainedCents: processingFee,
    processingBorneByCustomerCents: processingFee,
    reverseTransfer: true,
    refundApplicationFee: false,
    disclosure:
      `Refunding ${usd(goods)} for your order.` +
      (nonRefundable.length > 0
        ? ` Your ${listPhrase(nonRefundable)} ${nonRefundable.length > 1 ? 'are' : 'is'}` +
          ` non-refundable once the order is completed.`
        : ''),
  };
}

/** "a", "a and b", "a, b and c" — so a disclosure never reads like a machine wrote it. */
function listPhrase(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
