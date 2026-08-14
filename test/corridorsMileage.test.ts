import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CorridorModel, corridorsService, distanceToCorridor } from '../src/modules/livemap/corridors.service';
import { NotificationModel } from '../src/modules/notifications/notifications.model';
import { LiveSessionModel, LocationPingModel } from '../src/modules/livemap/livemap.model';
import { mileageService } from '../src/modules/livemap/mileage.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * 7.7 / 7.8 — mileage and corridor alerts.
 *
 * A corridor is a description of where someone travels every day and a mileage log is a movement
 * history. Between them they are the most sensitive data the platform holds about a person, so the
 * access tests here matter at least as much as the geometry ones.
 */
const app = createApp();

async function customer(prefix: string) {
  const userId = await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return { userId, token: await mintToken(`${prefix}|cust`) };
}

/** A roughly east–west line through Modesto, about 4km long. */
const COMMUTE: [number, number][] = [
  [-121.0, 37.64],
  [-120.955, 37.64],
];

/**
 * Notifications are persisted fire-and-forget (`notify` does not await the write, so the many
 * synchronous callers keep their void signature). Reading immediately after can therefore beat the
 * insert — a race that only shows up under a loaded full-suite run, which is the worst way to find
 * it. Poll instead of sleeping a fixed amount: fast when it is fast, and it does not silently start
 * passing for the wrong reason on a slow machine.
 */
async function waitForNotifications(userId: string, category: string, atLeast = 1) {
  for (let i = 0; i < 40; i++) {
    const found = await NotificationModel.find({ user_id: userId, category }).lean();
    if (found.length >= atLeast) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return NotificationModel.find({ user_id: userId, category }).lean();
}

describe('corridor geometry (7.8)', () => {
  it('measures distance to the LINE, not to its endpoints', () => {
    // The whole reason for a polyline: a point beside the middle of the route is on the route, and
    // a radius from either endpoint would miss it.
    const midpointSide: [number, number] = [-120.9775, 37.6427];
    const distance = distanceToCorridor(midpointSide, COMMUTE);
    expect(distance).toBeLessThan(400);

    // …while the same distance perpendicular, further out, is not.
    const farOff: [number, number] = [-120.9775, 37.68];
    expect(distanceToCorridor(farOff, COMMUTE)).toBeGreaterThan(3000);
  });

  it('is exact at the endpoints', () => {
    expect(distanceToCorridor([-121.0, 37.64], COMMUTE)).toBeLessThan(1);
  });

  it('handles a degenerate one-point-repeated path without dividing by zero', () => {
    const degenerate: number[][] = [
      [-121.0, 37.64],
      [-121.0, 37.64],
    ];
    expect(distanceToCorridor([-121.0, 37.64], degenerate)).toBeLessThan(1);
  });
});

describe('corridor alerts (7.8)', () => {
  it('alerts a user when a vendor goes live on their route', async () => {
    const c = await customer('cor-alert');
    const created = await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Commute', path: COMMUTE, radiusM: 500 });
    expect(created.status).toBe(201);

    const alerted = await corridorsService.onVendorLive({
      businessId: 'biz-on-route',
      businessName: 'Taco Loco',
      category: null,
      lngLat: [-120.9775, 37.6427],
      status: 'parked',
    });
    expect(alerted).toBe(1);

    const notes = await waitForNotifications(c.userId, 'proximity');
    expect(notes[0]!.title).toContain('Commute');
  });

  it('does not alert for a vendor nowhere near the route', async () => {
    const c = await customer('cor-far');
    await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Commute', path: COMMUTE, radiusM: 500 });

    await corridorsService.onVendorLive({
      businessId: 'biz-far',
      businessName: 'Far Truck',
      category: null,
      lngLat: [-120.9775, 37.72],
      status: 'parked',
    });
    expect(
      await NotificationModel.countDocuments({ user_id: c.userId, category: 'proximity' }),
    ).toBe(0);
  });

  it('throttles repeat alerts for the same vendor — a parked truck is not news every minute', async () => {
    const c = await customer('cor-throttle');
    await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Commute', path: COMMUTE });

    for (let i = 0; i < 3; i++) {
      await corridorsService.onVendorLive({
        businessId: 'biz-repeat',
        businessName: 'Repeat Truck',
        category: null,
        lngLat: [-120.9775, 37.6427],
        status: 'parked',
      });
    }
    expect((await waitForNotifications(c.userId, 'proximity')).length).toBe(1);
  });

  it('respects the category filter — coffee on the way in, not a furniture hub', async () => {
    const c = await customer('cor-cat');
    await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Commute', path: COMMUTE, categories: ['coffee'] });

    await corridorsService.onVendorLive({
      businessId: 'biz-furniture',
      businessName: 'Sofa Hub',
      category: 'furniture',
      lngLat: [-120.9775, 37.6427],
      status: 'parked',
    });
    expect(
      await NotificationModel.countDocuments({ user_id: c.userId, category: 'proximity' }),
    ).toBe(0);
  });

  it('a paused corridor alerts nobody', async () => {
    // Paused rather than deleted — a commute is a weekday thing.
    const c = await customer('cor-paused');
    const created = await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Commute', path: COMMUTE });
    await request(app)
      .patch(`/api/v1/users/me/corridors/${created.body.data.id}`)
      .set(...bearer(c.token))
      .send({ active: false });

    await corridorsService.onVendorLive({
      businessId: 'biz-paused',
      businessName: 'Truck',
      category: null,
      lngLat: [-120.9775, 37.6427],
      status: 'parked',
    });
    expect(
      await NotificationModel.countDocuments({ user_id: c.userId, category: 'proximity' }),
    ).toBe(0);
  });

  it("cannot read, pause, or delete someone else's corridor", async () => {
    const owner = await customer('cor-idor-owner');
    const intruder = await customer('cor-idor-intruder');
    const created = await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(owner.token))
      .send({ label: 'Home to school', path: COMMUTE });

    const list = await request(app).get('/api/v1/users/me/corridors').set(...bearer(intruder.token));
    expect(list.body.data).toHaveLength(0);

    const patched = await request(app)
      .patch(`/api/v1/users/me/corridors/${created.body.data.id}`)
      .set(...bearer(intruder.token))
      .send({ active: false });
    expect(patched.status).toBe(404);

    const deleted = await request(app)
      .delete(`/api/v1/users/me/corridors/${created.body.data.id}`)
      .set(...bearer(intruder.token));
    expect(deleted.status).toBe(404);
    expect(await CorridorModel.countDocuments({ user_id: owner.userId })).toBe(1);
  });

  it('refuses a corridor with too many points', async () => {
    // A "corridor" spanning a state is a subscription to everything.
    const c = await customer('cor-toolong');
    const path = Array.from({ length: 40 }, (_, i) => [-121 + i * 0.01, 37.64]);
    const res = await request(app)
      .post('/api/v1/users/me/corridors')
      .set(...bearer(c.token))
      .send({ label: 'Everything', path });
    expect(res.status).toBe(400);
  });
});

describe('mileage (7.7)', () => {
  /** Seed a live session with a track of pings for a seller. */
  async function track(sellerId: string, points: { lngLat: [number, number]; at: Date }[]) {
    const session = await LiveSessionModel.create({
      actor_type: 'seller',
      actor_id: sellerId,
      status: 'driving',
      current_location: { type: 'Point', coordinates: points[0]!.lngLat },
      geohash: '9qc0',
      last_ping_at: new Date(),
    });
    for (const p of points) {
      await LocationPingModel.create({
        session_id: session._id,
        location: { type: 'Point', coordinates: p.lngLat },
        recorded_at: p.at,
      });
    }
    return String(session._id);
  }

  it('estimates distance from the track, in miles and metres', async () => {
    const sellerId = await seedUser({ authProviderId: 'mil-track|seller', roles: ['seller'] });
    const principal = { userId: sellerId } as never;
    const base = new Date('2026-08-03T09:00:00.000Z');
    // Three points about 1km apart along a line, five minutes between each.
    await track(sellerId, [
      { lngLat: [-121.0, 37.64], at: base },
      { lngLat: [-120.9887, 37.64], at: new Date(base.getTime() + 5 * 60_000) },
      { lngLat: [-120.9774, 37.64], at: new Date(base.getTime() + 10 * 60_000) },
    ]);

    const summary = await mileageService.summary(principal, 'seller', sellerId);
    expect(summary.totalMeters).toBeGreaterThan(1500);
    expect(summary.totalMiles).toBeGreaterThan(0.9);
    expect(summary.days[0]!.date).toBe('2026-08-03');
  });

  it('drops an implausible GPS jump rather than inflating the total', async () => {
    // A fix that teleports 40km in 30 seconds is an error, not a drive — and inflating a figure
    // someone may put on a tax return is the wrong direction to be wrong in.
    const sellerId = await seedUser({ authProviderId: 'mil-jump|seller', roles: ['seller'] });
    const principal = { userId: sellerId } as never;
    const base = new Date('2026-08-03T09:00:00.000Z');
    await track(sellerId, [
      { lngLat: [-121.0, 37.64], at: base },
      { lngLat: [-120.5, 37.64], at: new Date(base.getTime() + 30_000) }, // ~44km in 30s
    ]);

    const summary = await mileageService.summary(principal, 'seller', sellerId);
    expect(summary.discardedJumps).toBe(1);
    expect(summary.totalMeters).toBe(0);
  });

  it('ignores stationary noise around a parked vehicle', async () => {
    const sellerId = await seedUser({ authProviderId: 'mil-noise|seller', roles: ['seller'] });
    const principal = { userId: sellerId } as never;
    const base = new Date('2026-08-03T09:00:00.000Z');
    await track(sellerId, [
      { lngLat: [-121.0, 37.64], at: base },
      { lngLat: [-121.00005, 37.64], at: new Date(base.getTime() + 60_000) }, // ~4m
      { lngLat: [-121.0001, 37.64], at: new Date(base.getTime() + 120_000) },
    ]);

    const summary = await mileageService.summary(principal, 'seller', sellerId);
    expect(summary.totalMeters).toBe(0);
  });

  it('carries the estimate caveat in the payload, not just in the UI', async () => {
    // Someone may put this number on a tax return. The caveat has to travel with it.
    const sellerId = await seedUser({ authProviderId: 'mil-disc|seller', roles: ['seller'] });
    const principal = { userId: sellerId } as never;
    const summary = await mileageService.summary(principal, 'seller', sellerId);
    expect(summary.disclosure).toContain('LOWER than the distance you actually drove');
  });

  it('says plainly that it cannot answer beyond the retention window', async () => {
    // A silently short total is worse than no total, because it looks like an answer.
    const sellerId = await seedUser({ authProviderId: 'mil-trunc|seller', roles: ['seller'] });
    const principal = { userId: sellerId } as never;
    const summary = await mileageService.summary(principal, 'seller', sellerId, { days: 365 });
    expect(summary.truncated).toBe(true);
    expect(summary.truncationNotice).toContain('30 days');
  });

  it("refuses another user's track", async () => {
    const mine = await seedUser({ authProviderId: 'mil-mine|seller', roles: ['seller'] });
    const theirs = await seedUser({ authProviderId: 'mil-theirs|seller', roles: ['seller'] });
    await expect(
      mileageService.summary({ userId: mine } as never, 'seller', theirs),
    ).rejects.toThrow(/Not your track/);
  });
});
