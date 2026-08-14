import { describe, expect, it } from 'vitest';

import {
  availableSlots,
  resolvePickupSlot,
  roundToSlot,
  scheduledPickupView,
} from '../src/modules/orders/scheduling';

/**
 * 7.5 / P-14 — scheduled pickup.
 *
 * The design decision under test is that a scheduled order does **not** require the business to be
 * Parked (that check lives in `orders.service.ts` and applies to `pickup_now` only). What this file
 * pins is the vendor's side of the bargain: their opt-in, their notice period, their horizon — the
 * promises that replace the Parked check.
 */
describe('scheduled pickup (7.5)', () => {
  const config = {
    enabled: true,
    min_lead_minutes: 30,
    max_days_ahead: 7,
    slot_minutes: 15,
  };
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('is off unless the vendor turned it on', () => {
    // A vendor who has not thought about it will not be at a pitch to hand over an order at 4pm,
    // and a scheduled order nobody shows up for is a refund and a bad review.
    expect(scheduledPickupView(undefined).enabled).toBe(false);
    expect(() =>
      resolvePickupSlot(new Date('2026-08-03T14:00:00.000Z'), undefined, now),
    ).toThrow(/does not take orders ahead/);
  });

  it('rounds UP to the next slot, never down', () => {
    // Down would move a pickup earlier than the customer asked for — the direction that makes
    // someone miss their food.
    expect(roundToSlot(new Date('2026-08-03T12:01:00.000Z'), 15).toISOString()).toBe(
      '2026-08-03T12:15:00.000Z',
    );
    expect(roundToSlot(new Date('2026-08-03T12:15:00.000Z'), 15).toISOString()).toBe(
      '2026-08-03T12:15:00.000Z',
    );
  });

  it('accepts a time past the notice period', () => {
    const slot = resolvePickupSlot(new Date('2026-08-03T14:07:00.000Z'), config, now);
    expect(slot.toISOString()).toBe('2026-08-03T14:15:00.000Z');
  });

  it('refuses a time inside the notice period, and says what to do instead', () => {
    // "Invalid time" leaves the customer guessing, and guessing means abandoning the order.
    expect(() => resolvePickupSlot(new Date('2026-08-03T12:10:00.000Z'), config, now)).toThrow(
      /at least 30 minutes/,
    );
    expect(() => resolvePickupSlot(new Date('2026-08-03T12:10:00.000Z'), config, now)).toThrow(
      /order now if they are open/,
    );
  });

  it('refuses a time past the vendor’s horizon', () => {
    expect(() =>
      resolvePickupSlot(new Date('2026-09-03T12:00:00.000Z'), config, now),
    ).toThrow(/up to 7 day/);
  });

  it('generates slots that all clear the notice period', () => {
    const slots = availableSlots(config, { now, horizonHours: 4 });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.getTime() - now.getTime()).toBeGreaterThanOrEqual(30 * 60_000);
      // Every slot is on a boundary, so the vendor sees "three at 12:15" rather than 12:01, 12:03…
      expect(slot.getTime() % (15 * 60_000)).toBe(0);
    }
  });

  it('generates nothing when the vendor has not opted in', () => {
    expect(availableSlots({ enabled: false }, { now })).toEqual([]);
  });

  it('never offers a slot beyond the vendor’s horizon, whatever horizon is asked for', () => {
    const tight = { ...config, max_days_ahead: 1 };
    const slots = availableSlots(tight, { now, horizonHours: 24 * 30, limit: 1000 });
    const last = slots[slots.length - 1]!;
    expect(last.getTime() - now.getTime()).toBeLessThanOrEqual(86_400_000);
  });

  it('honours a custom slot size', () => {
    const halfHourly = { ...config, slot_minutes: 30 };
    const slots = availableSlots(halfHourly, { now, horizonHours: 3 });
    for (const slot of slots) expect(slot.getTime() % (30 * 60_000)).toBe(0);
  });
});
