import { describe, expect, it } from 'vitest';

import {
  MAX_DISCOUNT_PERCENT,
  applyDiscount,
  flashSaleDiscount,
  queuePositionDiscount,
  resolveDiscount,
} from '../src/modules/orders/discounts';

/**
 * A-7 — one price-discount abstraction, tested before MS-10 adds the second producer to it. The
 * rules pinned here are the ones that stop a discount system from running away.
 */
describe('price discounts (A-7)', () => {
  const NOW = new Date('2026-08-02T12:00:00Z');
  const queue = queuePositionDiscount({
    ownerType: 'business',
    ownerId: 'biz1',
    position: 3,
    percent: 15,
  });
  const flash = flashSaleDiscount({
    productId: 'p1',
    percent: 25,
    startsAt: new Date('2026-08-02T00:00:00Z'),
    endsAt: new Date('2026-08-03T00:00:00Z'),
  });

  it('does NOT stack — the single best discount wins', () => {
    // Stacked, 15% and 25% would compound to 36.25% off. Nobody authored that number.
    const resolved = resolveDiscount([queue, flash], NOW);
    expect(resolved.percent).toBe(25);
    expect(resolved.source).toBe('flash_sale');
    expect(resolved.considered).toHaveLength(2);
  });

  it('ignores a discount outside its window', () => {
    const expired = flashSaleDiscount({
      productId: 'p1',
      percent: 50,
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: new Date('2026-07-02T00:00:00Z'),
    });
    const resolved = resolveDiscount([queue, expired], NOW);
    expect(resolved.percent).toBe(15);
    expect(resolved.source).toBe('queue_position');
  });

  it('treats a null window as always in force (the queue schedule)', () => {
    expect(queue.window).toBeNull();
    expect(resolveDiscount([queue], new Date('2030-01-01T00:00:00Z')).percent).toBe(15);
  });

  it('clamps a misconfigured discount to the ceiling — a free item is never a pricing outcome', () => {
    const runaway = flashSaleDiscount({
      productId: 'p1',
      percent: 100,
      startsAt: new Date('2026-08-01T00:00:00Z'),
      endsAt: new Date('2026-08-05T00:00:00Z'),
    });
    expect(resolveDiscount([runaway], NOW).percent).toBe(MAX_DISCOUNT_PERCENT);
  });

  it('returns a zero discount rather than a special case when nothing applies', () => {
    const resolved = resolveDiscount([], NOW);
    expect(resolved).toEqual({ percent: 0, label: '', source: null, considered: [] });
    expect(applyDiscount(1000, resolved)).toEqual({ discountCents: 0, discountedCents: 1000 });
  });

  it('labels the discount with a reason, not a bare percentage', () => {
    // A receipt line reading "-15%" tells a customer nothing about why they got it.
    expect(queue.label).toBe('15% off for being #3 in line');
  });

  it('rounds the discount down, like every other rate on the money path', () => {
    // 15% of 99¢ is 14.85¢.
    const resolved = resolveDiscount([queue], NOW);
    expect(applyDiscount(99, resolved)).toEqual({ discountCents: 14, discountedCents: 85 });
  });
});
