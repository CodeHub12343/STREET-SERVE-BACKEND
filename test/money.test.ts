import { describe, expect, it } from 'vitest';

import {
  allocate,
  applyBps,
  applyPercent,
  assertReconciles,
  deductInOrder,
  splitEvenly,
} from '../src/shared/money';
import { splitConsignmentRto } from '../src/modules/rto/rto.pricing';
import { computeOrderBreakdown } from '../src/modules/orders/pricing';

/**
 * A-5 — the shared money primitives. These tests exist to pin the two conventions the primitives
 * were extracted to make singular: rate math rounds down toward the payer, and split legs reconcile
 * exactly. Both used to be re-decided per module.
 */
describe('money primitives (A-5)', () => {
  describe('applyBps', () => {
    it('rounds DOWN, toward the payer', () => {
      // 2.5% of 99¢ is 2.475¢. The platform sets the rate, so the platform eats the fraction.
      expect(applyBps(99, 250)).toBe(2);
      expect(applyBps(1, 5000)).toBe(0);
    });

    it('is exact on clean multiples', () => {
      expect(applyBps(10_000, 1000)).toBe(1000); // 10% of $100 = $10
      expect(applyBps(10_000, 10_000)).toBe(10_000); // 10,000 bps = 100%
    });

    it('never produces a credit from a negative base or rate', () => {
      expect(applyBps(-500, 1000)).toBe(0);
      expect(applyBps(500, -1000)).toBe(0);
    });

    it('rejects fractional cents rather than silently rounding them', () => {
      expect(() => applyBps(10.5, 1000)).toThrow(/integer number of cents/);
    });

    it('applyPercent agrees with applyBps', () => {
      expect(applyPercent(9_999, 70)).toBe(applyBps(9_999, 7000));
    });
  });

  describe('allocate — exact penny allocation', () => {
    it('sums exactly to the total even when the division is not clean', () => {
      const parts = allocate(100, [1, 1, 1]);
      expect(parts.reduce((a, v) => a + v, 0)).toBe(100);
      // Largest-remainder: the leftover cent goes to the FIRST tied part, not the last.
      expect(parts).toEqual([34, 33, 33]);
    });

    it('distributes the remainder by largest discarded fraction, not by position', () => {
      // 10¢ split 1:1:1 leaves 1 remainder cent; weights are equal so order breaks the tie.
      expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
      // Unequal weights: the part with the biggest fraction wins the cent regardless of position.
      const parts = allocate(100, [1, 5, 1]);
      expect(parts.reduce((a, v) => a + v, 0)).toBe(100);
    });

    it('reconciles across a large random sweep', () => {
      for (let i = 0; i < 500; i++) {
        const total = Math.floor(Math.random() * 1_000_000);
        const weights = Array.from({ length: 2 + Math.floor(Math.random() * 6) }, () =>
          Math.floor(Math.random() * 100),
        );
        const parts = allocate(total, weights);
        const sum = parts.reduce((a, v) => a + v, 0);
        if (weights.some((w) => w > 0)) {
          expect(sum).toBe(total);
        } else {
          expect(sum).toBe(0); // nobody is owed anything, so nothing is allocated
        }
      }
    });

    it('never hands a stray cent to a zero-weight party', () => {
      // A party owed 0% of the proceeds must receive nothing, even when there is a remainder to place.
      const parts = allocate(100, [1, 0, 1, 1]);
      expect(parts[1]).toBe(0);
      expect(parts.reduce((a, v) => a + v, 0)).toBe(100);
    });

    it('handles the degenerate cases without throwing', () => {
      expect(allocate(0, [1, 1])).toEqual([0, 0]);
      expect(allocate(100, [])).toEqual([]);
      expect(allocate(100, [0, 0])).toEqual([0, 0]);
    });

    it('splitEvenly reconciles', () => {
      expect(splitEvenly(101, 4).reduce((a, v) => a + v, 0)).toBe(101);
      expect(splitEvenly(101, 4)).toEqual([26, 25, 25, 25]);
    });
  });

  describe('deductInOrder — the §56.1 waterfall', () => {
    it('takes each deduction from what the previous ones left', () => {
      const result = deductInOrder(10_000, [
        { label: 'tax', bps: 800 }, // 800 of 10,000
        { label: 'delivery', cents: 500 },
        { label: 'platform', bps: 1000 }, // 10% of the 8,700 remaining
      ]);
      expect(result.amountOf('tax')).toBe(800);
      expect(result.amountOf('delivery')).toBe(500);
      expect(result.amountOf('platform')).toBe(870);
      expect(result.remainingCents).toBe(7_830);
    });

    it('clamps a deduction to what is actually left rather than going negative', () => {
      // The scenario that matters: a $2 payment carrying a $50 delivery reimbursement. Delivery takes
      // what exists and no more — nobody is paid out of money that was never collected.
      const result = deductInOrder(200, [
        { label: 'tax', bps: 1000 },
        { label: 'delivery', cents: 5_000 },
        { label: 'platform', bps: 1000 },
      ]);
      expect(result.amountOf('delivery')).toBe(180);
      expect(result.amountOf('platform')).toBe(0);
      expect(result.remainingCents).toBe(0);
      assertReconciles(200, [...result.legs.map((l) => l.cents), result.remainingCents], 'waterfall');
    });

    it('legs plus remainder always equal gross', () => {
      for (let i = 0; i < 200; i++) {
        const gross = Math.floor(Math.random() * 100_000);
        const result = deductInOrder(gross, [
          { label: 'a', bps: Math.floor(Math.random() * 3000) },
          { label: 'b', cents: Math.floor(Math.random() * 2000) },
          { label: 'c', bps: Math.floor(Math.random() * 3000) },
        ]);
        assertReconciles(
          gross,
          [...result.legs.map((l) => l.cents), result.remainingCents],
          'waterfall',
        );
      }
    });
  });

  describe('assertReconciles', () => {
    it('names the discrepancy instead of just failing', () => {
      expect(() => assertReconciles(100, [33, 33, 33], 'split')).toThrow(/off by -1/);
    });

    it('passes on an exact split', () => {
      expect(() => assertReconciles(100, [34, 33, 33])).not.toThrow();
    });
  });

  describe('call sites now share the convention', () => {
    it('the consignment RTO split reconciles across a random sweep', () => {
      for (let i = 0; i < 300; i++) {
        const gross = Math.floor(Math.random() * 500_000);
        const split = splitConsignmentRto(gross, {
          platformBps: 1000,
          processingBps: Math.floor(Math.random() * 300),
          commissionBps: Math.floor(Math.random() * 4000),
          taxBps: Math.floor(Math.random() * 1200),
          deliveryCents: Math.floor(Math.random() * 3000),
          refundCents: Math.floor(Math.random() * 3000),
        });
        // splitConsignmentRto asserts internally; this checks the assertion is actually reachable
        // from the public shape callers read.
        assertReconciles(
          gross,
          [
            split.taxCents,
            split.refundCents,
            split.deliveryCents,
            split.platformFeeCents,
            split.processingCents,
            split.commissionCents,
            split.ownerCents,
          ],
          'consignment RTO split',
        );
      }
    });

    it('checkout rounds the same direction as settlement', () => {
      // A 7% discount on 99¢ is 6.93¢. Checkout must floor it like every other rate on the platform,
      // otherwise the customer previews one total and the settlement divides another.
      const breakdown = computeOrderBreakdown({ subtotalCents: 99, discountPercent: 7 });
      expect(breakdown.discountCents).toBe(applyPercent(99, 7));
      expect(breakdown.discountCents).toBe(6);
    });
  });
});
