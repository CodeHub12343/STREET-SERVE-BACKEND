import { describe, expect, it } from 'vitest';

import { computeRefund } from '../src/modules/payments/refundPolicy';

/**
 * R13 / spec §58 refund-fee policy (pure math).
 *
 * Two fixtures, because the whole point of the policy is that a charge is made of parts that come
 * back on different terms:
 *   `txn`     — the MVP shape: goods + tip only, no customer-facing fees (fees off at launch).
 *   `feeTxn`  — the same order with the §33 service fee and §31 processing pass-through ON, which
 *               is the configuration the policy has to be honest about.
 */
const txn = { amount_cents: 1000, tip_cents: 100, round_up_cents: 0, platform_fee_cents: 90 };

/** $9.00 goods + $1.00 tip + 27¢ service fee + 30¢ processing = $10.57 charged. */
const feeTxn = {
  amount_cents: 1057,
  tip_cents: 100,
  round_up_cents: 0,
  service_fee_cents: 27,
  processing_fee_cents: 30,
  platform_fee_cents: 90,
};

describe('computeRefund (R13) — fees off', () => {
  it('full pre-fulfillment cancel returns everything — goods + tip — and the platform fee', () => {
    const q = computeRefund(txn, { fulfilled: false });
    expect(q.scenario).toBe('full_pre_fulfillment');
    expect(q.refundedCents).toBe(1000); // whole charge back to the customer
    expect(q.tipCents).toBe(100); // tip returned
    expect(q.marketplaceFeeReturnedCents).toBe(90); // platform fee handed back
    expect(q.reverseTransfer).toBe(true);
    expect(q.refundApplicationFee).toBe(true);
    expect(q.disclosure).toMatch(/Full refund/);
  });

  it('partial refund returns the portion with a proportional fee; tip untouched', () => {
    const q = computeRefund(txn, { fulfilled: true, partialCents: 300 });
    expect(q.scenario).toBe('partial');
    expect(q.refundedCents).toBe(300);
    // Pro-rata against GOODS (900), not the gross total — the marketplace fee was charged on the
    // goods base, so dividing by the gross would under-return the vendor's fee on every partial.
    expect(q.marketplaceFeeReturnedCents).toBe(30); // floor(90 * 300/900)
    expect(q.tipCents).toBe(0);
    expect(q.refundApplicationFee).toBe(true);
  });

  it('post-fulfillment refund returns only goods — the tip is NON-refundable', () => {
    const q = computeRefund(txn, { fulfilled: true });
    expect(q.scenario).toBe('post_fulfillment');
    expect(q.refundedCents).toBe(900); // goods only (1000 − 100 tip)
    expect(q.tipCents).toBe(0);
    expect(q.marketplaceFeeReturnedCents).toBe(0); // fee retained
    expect(q.refundApplicationFee).toBe(false);
    expect(q.disclosure).toMatch(/non-refundable/);
  });

  it('reports no retained processing when no processing fee was charged', () => {
    for (const opts of [{ fulfilled: false }, { fulfilled: true }] as const) {
      const q = computeRefund(txn, opts);
      expect(q.processingRetainedCents).toBe(0);
      expect(q.processingBorneByCustomerCents).toBe(0);
    }
  });
});

describe('computeRefund (spec §58) — service + processing fees ON', () => {
  it('refunds every component on a full pre-fulfillment cancel, and says so', () => {
    const q = computeRefund(feeTxn, { fulfilled: false });
    expect(q.scenario).toBe('full_pre_fulfillment');
    // The order never happened: the customer gets the whole charge back, fees included.
    expect(q.refundedCents).toBe(1057);
    expect(q.goodsCents).toBe(900);
    expect(q.tipCents).toBe(100);
    expect(q.serviceFeeRefundedCents).toBe(27);
    expect(q.marketplaceFeeReturnedCents).toBe(90);
    // The processor keeps its cut, but the PLATFORM absorbs it — so the customer is out nothing,
    // which is exactly what the disclosure promises.
    expect(q.processingRetainedCents).toBe(30);
    expect(q.processingBorneByCustomerCents).toBe(0);
    expect(q.disclosure).toContain('$1.00 tip');
    expect(q.disclosure).toContain('$0.27 service fee');
    expect(q.disclosure).toContain('$0.30 processing fee');
    expect(q.disclosure).toContain("you're charged nothing");
  });

  it('does NOT refund the service or processing fee once the order is completed', () => {
    const q = computeRefund(feeTxn, { fulfilled: true });
    expect(q.scenario).toBe('post_fulfillment');
    // The regression this guards: goods must exclude the fees. Reading goods as `amount − tip`
    // handed back 957¢ — the service and processing fees included — while the disclosure said
    // they were non-refundable.
    expect(q.refundedCents).toBe(900);
    expect(q.serviceFeeRefundedCents).toBe(0);
    expect(q.tipCents).toBe(0);
    expect(q.processingRetainedCents).toBe(30);
    expect(q.processingBorneByCustomerCents).toBe(30);
    expect(q.disclosure).toContain('$1.00 tip');
    expect(q.disclosure).toContain('$0.27 service fee');
    expect(q.disclosure).toContain('$0.30 processing fee');
    expect(q.disclosure).toMatch(/are non-refundable/);
  });

  it('leaves tip and fees alone on a partial, and caps the refund at the goods portion', () => {
    const q = computeRefund(feeTxn, { fulfilled: true, partialCents: 300 });
    expect(q.refundedCents).toBe(300);
    expect(q.serviceFeeRefundedCents).toBe(0);
    expect(q.tipCents).toBe(0);
    expect(q.processingBorneByCustomerCents).toBe(0);
    expect(q.disclosure).toMatch(/service fee are unchanged/);

    // A caller asking for more than the goods portion can never claw back the tip or the fees.
    const over = computeRefund(feeTxn, { fulfilled: true, partialCents: 5000 });
    expect(over.refundedCents).toBe(900);
    expect(over.marketplaceFeeReturnedCents).toBe(90);
  });

  it('never returns a negative refund on a malformed row', () => {
    const q = computeRefund(
      { amount_cents: 50, tip_cents: 100, service_fee_cents: 27, platform_fee_cents: 0 },
      { fulfilled: true },
    );
    expect(q.refundedCents).toBe(0);
    expect(q.goodsCents).toBe(0);
  });
});
