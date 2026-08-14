import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { NOTIFICATION_PREF_CATEGORIES } from '../src/config/constants';
import { NotificationModel } from '../src/modules/notifications/notifications.model';
import { notificationsService } from '../src/modules/notifications/notifications.service';
import {
  InventoryCheckoutModel,
  InventorySaleModel,
  SettlementModel,
} from '../src/modules/consignment/consignment.model';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Frontend-tracked backend gaps (owner = backend): notification inbox (GAP-3), web-push
 * subscriptions (GAP-4), admin ops overview (GAP-2), seller earnings feed (GAP-6).
 */
const app = createApp();

describe('GAP-3 — notification inbox', () => {
  it('lists a user’s notifications newest-first with an unread count, and marks read', async () => {
    const userId = await seedUser({ authProviderId: 'gap|inbox', roles: ['customer'] });
    const token = await mintToken('gap|inbox');

    const older = await NotificationModel.create({
      user_id: userId,
      category: 'order',
      title: 'Order ready',
      body: 'Your tacos are ready.',
      created_at: new Date(Date.now() - 60_000),
    });
    const newer = await NotificationModel.create({
      user_id: userId,
      category: 'wave',
      title: 'Wave accepted',
      body: 'Bean Bus is on the way.',
    });

    const list = await request(app)
      .get('/api/v1/users/me/notifications')
      .set(...bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.data.map((n: { id: string }) => n.id)).toEqual([
      String(newer._id),
      String(older._id),
    ]);
    expect(list.body.meta.unread).toBe(2);
    expect(list.body.data[0]).toMatchObject({ category: 'wave', read: false });

    const read = await request(app)
      .post(`/api/v1/users/me/notifications/${String(newer._id)}/read`)
      .set(...bearer(token));
    expect(read.status).toBe(200);

    const after = await request(app)
      .get('/api/v1/users/me/notifications')
      .set(...bearer(token));
    expect(after.body.meta.unread).toBe(1);
  });

  /**
   * The inbox must carry the two fields the client turns into a timestamp and a destination:
   * `createdAt` (else "NaN min ago") and the `data` bag (else every row is inert). Shared-category
   * events (wave_down, order) also carry `data.audience` so the client can route vendor vs customer.
   */
  it('returns createdAt + a routable data bag (with audience on vendor-facing events)', async () => {
    const userId = await seedUser({ authProviderId: 'gap|route', roles: ['vendor'] });
    const token = await mintToken('gap|route');
    await NotificationModel.create({
      user_id: userId,
      category: 'wave_down',
      title: 'New wave down',
      body: 'A customer waved you down',
      data: { waveDownId: 'wd_1', audience: 'vendor' },
    });

    const row = (
      await request(app)
        .get('/api/v1/users/me/notifications')
        .set(...bearer(token))
    ).body.data[0];
    expect(typeof row.createdAt).toBe('string');
    expect(new Date(row.createdAt).getTime()).not.toBeNaN();
    expect(row.data).toMatchObject({ waveDownId: 'wd_1', audience: 'vendor' });
  });

  it('scopes the inbox to the owner (no cross-user reads) and requires auth', async () => {
    const ownerId = await seedUser({ authProviderId: 'gap|owner', roles: ['customer'] });
    await seedUser({ authProviderId: 'gap|other', roles: ['customer'] });
    const otherToken = await mintToken('gap|other');
    const secret = await NotificationModel.create({
      user_id: ownerId,
      category: 'payout',
      title: 'Payout sent',
      body: 'private',
    });

    const other = await request(app)
      .get('/api/v1/users/me/notifications')
      .set(...bearer(otherToken));
    expect(other.body.data).toHaveLength(0);

    // Marking someone else's notification read is a 404, not a silent success.
    const cross = await request(app)
      .post(`/api/v1/users/me/notifications/${String(secret._id)}/read`)
      .set(...bearer(otherToken));
    expect(cross.status).toBe(404);

    expect((await request(app).get('/api/v1/users/me/notifications')).status).toBe(401);
  });

  it('notify() persists to the durable inbox (reconnect catch-up)', async () => {
    const userId = await seedUser({ authProviderId: 'gap|notify', roles: ['customer'] });
    notificationsService.notify(userId, { category: 'system', title: 'Hi', body: 'there' });
    // notify persists fire-and-forget; give the write a beat.
    await new Promise((r) => setTimeout(r, 100));
    const count = await NotificationModel.countDocuments({ user_id: userId }).exec();
    expect(count).toBe(1);
  });
});

describe('GAP-4 — web-push subscriptions', () => {
  it('registers a push subscription and is idempotent on the endpoint', async () => {
    await seedUser({ authProviderId: 'gap|push', roles: ['customer'] });
    const token = await mintToken('gap|push');
    const sub = {
      endpoint: 'https://push.example.com/sub/abc123',
      keys: { p256dh: 'BPk_key_material', auth: 'auth_secret' },
      userAgent: 'Chrome/PWA',
    };

    const first = await request(app)
      .post('/api/v1/users/me/push-tokens')
      .set(...bearer(token))
      .send(sub);
    expect(first.status).toBe(201);

    // Re-registering the same endpoint upserts (no duplicate).
    const again = await request(app)
      .post('/api/v1/users/me/push-tokens')
      .set(...bearer(token))
      .send({ ...sub, keys: { p256dh: 'rotated', auth: 'auth_secret' } });
    expect(again.status).toBe(201);

    const del = await request(app)
      .delete('/api/v1/users/me/push-tokens')
      .set(...bearer(token))
      .send({ endpoint: sub.endpoint });
    expect(del.status).toBe(200);
    expect(del.body.data.removed).toBe(true);
  });

  it('rejects a malformed subscription (validation)', async () => {
    await seedUser({ authProviderId: 'gap|push2', roles: ['customer'] });
    const token = await mintToken('gap|push2');
    const res = await request(app)
      .post('/api/v1/users/me/push-tokens')
      .set(...bearer(token))
      .send({ endpoint: 'not-a-url', keys: {} });
    expect(res.status).toBe(400);
  });
});

describe('GAP-2 — admin ops overview', () => {
  it('returns the composed snapshot for an admin', async () => {
    await seedUser({ authProviderId: 'gap|admin', roles: ['admin'] });
    const token = await mintToken('gap|admin');
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set(...bearer(token));
    expect(res.status).toBe(200);
    for (const key of [
      'city',
      'liveSessions',
      'activeVendors',
      'gmvTodayCents',
      'ordersToday',
      'openDisputes',
      'fraudFlags',
      'pendingLicenses',
      'newSignups',
    ]) {
      expect(res.body.data).toHaveProperty(key);
    }
    expect(typeof res.body.data.activeVendors).toBe('number');
  });

  it('is forbidden for a plain customer', async () => {
    await seedUser({ authProviderId: 'gap|cust', roles: ['customer'] });
    const token = await mintToken('gap|cust');
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set(...bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('GAP-6 — seller earnings feed', () => {
  it('aggregates settled payouts + pending sales for the seller', async () => {
    const sellerId = await seedUser({
      authProviderId: 'gap|earn',
      roles: ['seller'],
      tier: 'bronze',
    });
    const token = await mintToken('gap|earn');

    // A settled checkout with a sale + settlement.
    const settled = await InventoryCheckoutModel.create({
      seller_id: sellerId,
      product_id: 'p1',
      hub_id: 'h1',
      quantity: 5,
      quantity_sold: 2,
      unit_value_cents: 1000,
      consignment_split_percent: 70,
      condition_photo_url: 'https://img/x',
      seller_agreement_version: 'v1',
      expected_return_at: new Date(),
      status: 'settled',
    });
    await InventorySaleModel.create({
      checkout_id: String(settled._id),
      quantity_sold: 2,
      sale_amount_cents: 2000,
    });
    await SettlementModel.create({
      checkout_id: String(settled._id),
      gross_sales_cents: 2000,
      platform_fee_cents: 200,
      hub_share_cents: 540,
      seller_net_cents: 1260,
      seller_payout_ref: 'po_test_1',
    });

    // An active checkout with a sale not yet settled (pending).
    const active = await InventoryCheckoutModel.create({
      seller_id: sellerId,
      product_id: 'p2',
      hub_id: 'h1',
      quantity: 3,
      quantity_sold: 1,
      unit_value_cents: 1500,
      consignment_split_percent: 70,
      condition_photo_url: 'https://img/y',
      seller_agreement_version: 'v1',
      expected_return_at: new Date(),
      status: 'active',
    });
    await InventorySaleModel.create({
      checkout_id: String(active._id),
      quantity_sold: 1,
      sale_amount_cents: 1500,
    });

    const res = await request(app)
      .get('/api/v1/checkouts/earnings')
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toMatchObject({
      settledNetCents: 1260,
      settledCount: 1,
      lifetimeGrossCents: 3500,
      pendingGrossCents: 1500,
      pendingCheckoutCount: 1,
    });
    expect(res.body.data.payouts[0]).toMatchObject({
      sellerNetCents: 1260,
      payoutRef: 'po_test_1',
    });
    expect(Array.isArray(res.body.data.dailyGross)).toBe(true);
  });

  it('is forbidden for a non-seller', async () => {
    await seedUser({ authProviderId: 'gap|notseller', roles: ['customer'] });
    const token = await mintToken('gap|notseller');
    const res = await request(app)
      .get('/api/v1/checkouts/earnings')
      .set(...bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('R12 — pre-publish fee calculator', () => {
  it('previews net payout server-side from the same fee + split math a real sale uses', async () => {
    await seedUser({ authProviderId: 'r12|seller', roles: ['seller'], tier: 'bronze' });
    const token = await mintToken('r12|seller');

    // $50 unit × 2 = $100 gross, 70% split. Platform (consignment 10%) = 1000 → distributable 9000
    // → seller 70% = 6300, hub = 2700. Customer fees are OFF at launch, so customer total = gross.
    const res = await request(app)
      .get('/api/v1/checkouts/fee-preview')
      .query({ unitPriceCents: 5000, splitPercent: 70, quantity: 2 })
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      grossCents: 10000,
      platformFeeCents: 1000,
      sellerNetCents: 6300,
      hubShareCents: 2700,
      customer: {
        subtotalCents: 10000,
        serviceFeeCents: 0,
        processingFeeCents: 0,
        totalCents: 10000,
      },
      // A plain consignment listing has no rent-to-own deal to price.
      rto: null,
      estimated: true,
    });
  });

  it('is forbidden for a non-seller', async () => {
    await seedUser({ authProviderId: 'r12|notseller', roles: ['customer'] });
    const token = await mintToken('r12|notseller');
    const res = await request(app)
      .get('/api/v1/checkouts/fee-preview')
      .query({ unitPriceCents: 5000, splitPercent: 70 })
      .set(...bearer(token));
    expect(res.status).toBe(403);
  });
});
/**
 * §57.2 — the rent-to-own half of the calculator. Seven rows the spec names, and the file's own
 * header used to say they were "reserved for Phase 3" long after RTO had shipped.
 */
it('§57.2: prices the rent-to-own deal from the same math the customer will be charged', async () => {
  await seedUser({ authProviderId: 'r12rto|seller', roles: ['seller'], tier: 'bronze' });
  const token = await mintToken('r12rto|seller');

  // $100 cash, $20 up front, 4 weekly payments, 10% markup → $110 to own.
  const res = await request(app)
    .get('/api/v1/checkouts/fee-preview')
    .query({
      unitPriceCents: 10000,
      splitPercent: 70,
      quantity: 1,
      rtoInstallmentCount: 4,
      rtoFrequency: 'weekly',
      rtoMarkupBps: 1000,
      rtoInitialPaymentCents: 2000,
    })
    .set(...bearer(token));
  expect(res.status).toBe(200);

  const rto = res.body.data.rto;
  expect(rto.initialPaymentCents).toBe(2000);
  expect(rto.installmentCount).toBe(4);
  expect(rto.totalToOwnCents).toBe(11000);
  expect(rto.costOverCashCents).toBe(1000);
  // The seller sees the platform's cut per payment and what they actually keep overall.
  expect(rto.platformFeePerPaymentCents).toBeGreaterThan(0);
  expect(rto.sellerTotalEarningsCents).toBeLessThan(rto.totalToOwnCents);
  // Payoff on day one is the cash price less the equity the initial payment already bought.
  expect(rto.earlyPayoffCents).toBe(8000);

  /**
   * The number the seller is shown here must be the number their customer is charged — a
   * calculator that approximates is worse than none, because it will be believed. Same
   * `computeRtoQuote` on both sides.
   */
  const disclose = await request(app)
    .post('/api/v1/rto/disclose')
    .set(...bearer(token))
    .send({
      cashPriceCents: 10000,
      initialPaymentCents: 2000,
      installmentCount: 4,
      frequency: 'weekly',
      markupBps: 1000,
    });
  expect(disclose.body.data.installmentAmountCents).toBe(rto.installmentAmountCents);
  expect(disclose.body.data.totalToOwnCents).toBe(rto.totalToOwnCents);
});

/**
 * C-37 Settings has always called GET/PATCH /users/me/notification-preferences, but the route did
 * not exist: every switch read a 404 (so all six rendered ON regardless of intent) and every write
 * 404'd into an optimistic cache that never rolled back. Muting appeared to work and did nothing.
 */
describe('notification preferences (C-37 Settings)', () => {
  it('defaults every category to on', async () => {
    await seedUser({ authProviderId: 'prefs|default', roles: ['customer'] });
    const token = await mintToken('prefs|default');

    const res = await request(app)
      .get('/api/v1/users/me/notification-preferences')
      .set(...bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      wave: true,
      order: true,
      message: true,
      // Phase 2.5 — community network. All three are mutable by deliberate choice; see
      // MUTABLE_NOTIFICATION_CATEGORIES for why `generosity` in particular is not safety-critical.
      delivery: true,
      generosity: true,
      campaign: true,
      payout: true,
      dispute: true,
      verification: true,
    });
    // Notifications are opt-OUT, so a category that is served but missing here would silently
    // default to on without ever appearing in Settings. Pin the two lists together.
    expect(Object.keys(res.body.data as object).sort()).toEqual(
      [...NOTIFICATION_PREF_CATEGORIES].sort(),
    );
  });

  /**
   * Phase 7.3. Until then this preference was stored, read back, and **enforced nowhere** — the
   * third switch in this codebase to look like it worked and do nothing. A preference nothing
   * enforces is worse than no preference, because the user believes the problem is solved.
   */
  it('actually suppresses the live push for a muted category', async () => {
    const userId = await seedUser({ authProviderId: 'prefs|enforce', roles: ['customer'] });
    const token = await mintToken('prefs|enforce');
    await request(app)
      .patch('/api/v1/users/me/notification-preferences')
      .set(...bearer(token))
      .send({ order: false });

    expect(await notificationsService.mayInterrupt(userId, 'order')).toBe(false);
    // A different category the user did not mute is untouched.
    expect(await notificationsService.mayInterrupt(userId, 'message')).toBe(true);
  });

  it('still files a muted notification in the inbox — muting is not deleting', async () => {
    const userId = await seedUser({ authProviderId: 'prefs|inbox', roles: ['customer'] });
    const token = await mintToken('prefs|inbox');
    await request(app)
      .patch('/api/v1/users/me/notification-preferences')
      .set(...bearer(token))
      .send({ order: false });

    await notificationsService.deliver(userId, {
      category: 'order',
      title: 'Order ready',
      body: 'Collect when you can.',
    });

    // "Stop interrupting me" is not "hide this from me" — a customer who silenced order updates
    // still needs to find them when they go looking.
    const inbox = await NotificationModel.countDocuments({ user_id: userId, category: 'order' });
    expect(inbox).toBe(1);
  });

  it('never lets an unmutable category be silenced, whatever the volume', async () => {
    const userId = await seedUser({ authProviderId: 'prefs|payout', roles: ['customer'] });
    // Blow past the hourly ceiling on a safety-critical category.
    for (let i = 0; i < 20; i += 1) {
      await notificationsService.deliver(userId, {
        category: 'payout',
        title: 'Payout sent',
        body: 'Money is on its way.',
      });
    }
    // "Safety-critical alerts can't be turned off" has to be true of the dispatcher for that
    // sentence to mean anything.
    expect(await notificationsService.mayInterrupt(userId, 'payout')).toBe(true);
    const inbox = await NotificationModel.countDocuments({ user_id: userId, category: 'payout' });
    expect(inbox).toBe(20);
  });

  it('caps live pushes of one mutable category per hour, without dropping the record', async () => {
    const userId = await seedUser({ authProviderId: 'prefs|ceiling', roles: ['customer'] });
    for (let i = 0; i < 15; i += 1) {
      await notificationsService.deliver(userId, {
        category: 'generosity',
        title: 'Someone paid it forward',
        body: 'A gift is waiting.',
      });
    }

    // Interruptions stop; the inbox keeps everything. The alternative is a user who disables
    // notifications wholesale and then misses a payout alert.
    expect(await notificationsService.mayInterrupt(userId, 'generosity')).toBe(false);
    const inbox = await NotificationModel.countDocuments({
      user_id: userId,
      category: 'generosity',
    });
    expect(inbox).toBe(15);
  });

  it('persists a mute and echoes the resulting state', async () => {
    await seedUser({ authProviderId: 'prefs|mute', roles: ['customer'] });
    const token = await mintToken('prefs|mute');

    const patch = await request(app)
      .patch('/api/v1/users/me/notification-preferences')
      .set(...bearer(token))
      .send({ wave: false });

    expect(patch.status).toBe(200);
    expect(patch.body.data.wave).toBe(false);
    expect(patch.body.data.order).toBe(true);

    // Survives a re-read — the actual bug was a write that never reached the database.
    const after = await request(app)
      .get('/api/v1/users/me/notification-preferences')
      .set(...bearer(token));
    expect(after.body.data.wave).toBe(false);
  });

  it('refuses to mute a safety-critical category, whatever the client says', async () => {
    await seedUser({ authProviderId: 'prefs|locked', roles: ['customer'] });
    const token = await mintToken('prefs|locked');

    for (const category of ['payout', 'dispute', 'verification']) {
      const res = await request(app)
        .patch('/api/v1/users/me/notification-preferences')
        .set(...bearer(token))
        .send({ [category]: false });
      // The UI disables these switches, but the UI is not an authorization boundary.
      expect(res.status).toBe(400);
    }

    const after = await request(app)
      .get('/api/v1/users/me/notification-preferences')
      .set(...bearer(token));
    expect(after.body.data.payout).toBe(true);
    expect(after.body.data.dispute).toBe(true);
    expect(after.body.data.verification).toBe(true);
  });

  it('rejects an unknown category instead of silently ignoring it', async () => {
    await seedUser({ authProviderId: 'prefs|unknown', roles: ['customer'] });
    const token = await mintToken('prefs|unknown');

    const res = await request(app)
      .patch('/api/v1/users/me/notification-preferences')
      .set(...bearer(token))
      .send({ nonsense: false });

    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/users/me/notification-preferences');
    expect(res.status).toBe(401);
  });
});
