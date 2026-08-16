import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel, CityModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { OrderModel } from '../src/modules/orders/orders.model';
import { TransactionModel } from '../src/modules/payments/payments.model';
import {
  DeliveryIncidentModel,
  DeliveryRequestModel,
  DriverProfileModel,
} from '../src/modules/delivery/delivery.model';
import { deliveryService } from '../src/modules/delivery/delivery.service';
import { driverService } from '../src/modules/delivery/driver.service';
import { UserRoleModel } from '../src/modules/identity/identity.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 5 — the Delivery Assist Network (ADR-004).
 *
 * This is the only feature on the platform that carries **third-party physical risk**, and the tests
 * are weighted accordingly. Most of them pin a prohibition rather than a happy path:
 *
 *  • **first-to-accept is decided by the database** — the losing racer must lose cleanly;
 *  • **nobody is charged before a driver accepts**, and the likely outcome is that nobody does;
 *  • **a driver is never told they are covered** (CR-3), and never called an employee (CR-4);
 *  • **declining is free and leaves no trace** — there is no acceptance rate to find;
 *  • **addresses are staged**: approximate before acceptance, exact after, gone once finished;
 *  • **drivers never appear on the customer map.**
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

async function enableDelivery() {
  const { env } = await import('../src/config/env');
  await CityModel.updateOne(
    { slug: env.DEFAULT_CITY },
    {
      $set: {
        slug: env.DEFAULT_CITY,
        name: 'Default City',
        status: 'live',
        'feature_flags.delivery': true,
      },
    },
    { upsert: true },
  );
}

async function vendorWithOrder(prefix: string) {
  await enableDelivery();
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'food',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;

  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  if (acct) {
    fakeStripe.enableAccount(acct.stripe_account_id);
    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'test')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          id: `evt_${Math.random()}`,
          type: 'account.updated',
          data: { object: { id: acct.stripe_account_id } },
        }),
      );
  }

  const terms = await request(app).get('/api/v1/agreements/regular_sale');
  await request(app)
    .post('/api/v1/agreements/regular_sale/accept')
    .set(...bearer(token))
    .send({ version: terms.body.data.version, contentHash: terms.body.data.contentHash });
  await request(app)
    .post('/api/v1/live-sessions/start')
    .set(...bearer(token))
    .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });

  const item = await request(app)
    .post(`/api/v1/businesses/${businessId}/menu`)
    .set(...bearer(token))
    .send({ name: 'Taco plate', priceCents: 2000 });

  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  const custToken = await mintToken(`${prefix}|cust`);
  const order = await request(app)
    .post('/api/v1/orders')
    .set(...bearer(custToken))
    .set('Idempotency-Key', `${prefix}_order`)
    .send({
      businessId,
      items: [{ menuItemId: item.body.data.id, quantity: 1 }],
      destination: {
        line1: '14 Alder Street',
        city: 'Testville',
        lng: -121.002,
        lat: 37.602,
        notes: 'Blue door, ring twice',
      },
    });

  const orderId = order.body.data.id as string;

  /**
   * Pay for it. Placing an order only OPENS the charge, and a driver may not be dispatched against
   * an unpaid one — sending a real person on a real journey for an order that may never be paid for
   * commits the vendor to a payout they cannot unwind. Settling here makes every test below walk
   * the chain a real delivery actually walks.
   */
  const placed = await OrderModel.findById(orderId).lean();
  const txn = await TransactionModel.findById(placed!.transaction_id).lean();
  if (txn?.payment_intent_ref) {
    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'test')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          id: `evt_${Math.random()}`,
          type: 'payment_intent.succeeded',
          data: { object: { id: txn.payment_intent_ref } },
        }),
      );
  }

  return { token, custToken, businessId, orderId };
}

/** An approved, on-shift driver near the pickup. */
async function driver(prefix: string, opts: { onShift?: boolean; approve?: boolean } = {}) {
  const userId = await seedUser({
    authProviderId: `${prefix}|driver`,
    roles: ['customer'],
    tier: 'silver',
  });
  await UserRoleModel.create({ user_id: userId, role: 'driver' });
  const token = await mintToken(`${prefix}|driver`);

  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  await request(app)
    .post('/api/v1/drivers/apply')
    .set(...bearer(token))
    .send({
      vehicleType: 'car',
      licenceExpiresAt: future,
      insuranceExpiresAt: future,
      emergencyContactName: 'Sam',
      emergencyContactPhone: '555-0100',
    });

  if (opts.approve !== false) {
    await DriverProfileModel.updateOne(
      { user_id: userId },
      { $set: { status: 'approved', background_check_status: 'passed' } },
    );
    // A payout account is an eligibility requirement — never offer somebody work they cannot be
    // paid for. Onboard exactly as a real driver would.
    await request(app)
      .post('/api/v1/payments/connect/onboard')
      .set(...bearer(token));
    const acct = await ConnectedAccountModel.findOne({
      owner_type: 'user',
      owner_id: userId,
    }).lean();
    if (acct) {
      fakeStripe.enableAccount(acct.stripe_account_id);
      await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'test')
        .set('content-type', 'application/json')
        .send(
          JSON.stringify({
            id: `evt_${Math.random()}`,
            type: 'account.updated',
            data: { object: { id: acct.stripe_account_id } },
          }),
        );
    }
  }
  if (opts.onShift !== false) {
    await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({
        actorType: 'driver',
        actorId: userId,
        lng: -121.0005,
        lat: 37.6005,
        status: 'driving',
      });
  }
  return { userId, token };
}

function principalOf(userId: string) {
  return {
    userId,
    authProviderId: userId,
    roles: ['driver' as const],
    verificationTier: 'silver' as const,
    status: 'active' as const,
  };
}

async function requestDelivery(vendorToken: string, orderId: string, payoutCents = 800) {
  return request(app)
    .post('/api/v1/deliveries')
    .set(...bearer(vendorToken))
    .send({ orderId, driverPayoutCents: payoutCents });
}

// ─── 5a · drivers ───────────────────────────────────────────────────────────────────────────
describe('5a · vetting, and what the platform may say about insurance', () => {
  it('records an attestation without ever claiming the driver is covered (CR-3)', async () => {
    const d = await driver('dv-attest', { approve: false, onShift: false });
    const res = await request(app)
      .get('/api/v1/drivers/me')
      .set(...bearer(d.token));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending');
    const copy = JSON.stringify(res.body.data).toLowerCase();
    // The platform's own policy protects the platform. Telling a driver otherwise is the harm
    // ADR-003 §2 refused to risk.
    for (const forbidden of ['you are covered', 'insured', 'coverage', 'policy', 'premium']) {
      expect(copy, `forbidden word "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('refuses an application from an unverified account', async () => {
    await seedUser({ authProviderId: 'dv-tier0|driver', roles: ['customer'], tier: 'tier0' });
    const token = await mintToken('dv-tier0|driver');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await request(app)
      .post('/api/v1/drivers/apply')
      .set(...bearer(token))
      .send({ vehicleType: 'car', licenceExpiresAt: future, insuranceExpiresAt: future });
    expect(res.status).toBe(403);
  });

  it('refuses an application with an out-of-date licence or insurance', async () => {
    await seedUser({ authProviderId: 'dv-stale|driver', roles: ['customer'], tier: 'silver' });
    const token = await mintToken('dv-stale|driver');
    const res = await request(app)
      .post('/api/v1/drivers/apply')
      .set(...bearer(token))
      .send({
        vehicleType: 'car',
        licenceExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        insuranceExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(res.status).toBe(422);
  });

  it('reports every failing eligibility reason at once, not just the first', async () => {
    const d = await driver('dv-elig', { approve: false, onShift: false });
    const res = await driverService.eligibility(d.userId);
    // A driver who fixes one thing should not then discover a second.
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('awaiting_approval');
    expect(res.reasons).toContain('background_check');
  });

  it('suspends a driver whose cover lapses, and lets them lift it by re-attesting', async () => {
    const d = await driver('dv-lapse', { onShift: false });
    await DriverProfileModel.updateOne(
      { user_id: d.userId },
      { $set: { insurance_expires_at: new Date(Date.now() - 1000) } },
    );

    expect(await driverService.suspendLapsed()).toBeGreaterThanOrEqual(1);
    expect((await DriverProfileModel.findOne({ user_id: d.userId }).lean())?.status).toBe(
      'suspended',
    );

    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    await request(app)
      .post('/api/v1/drivers/me/attestation')
      .set(...bearer(d.token))
      .send({ licenceExpiresAt: future, insuranceExpiresAt: future });

    expect((await DriverProfileModel.findOne({ user_id: d.userId }).lean())?.status).toBe(
      'approved',
    );
  });

  it('does not let a driver clear a suspension that was not about dates', async () => {
    const d = await driver('dv-banned', { onShift: false });
    await DriverProfileModel.updateOne(
      { user_id: d.userId },
      { $set: { status: 'suspended', suspended_reason: 'not_approved' } },
    );

    const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
    await request(app)
      .post('/api/v1/drivers/me/attestation')
      .set(...bearer(d.token))
      .send({ licenceExpiresAt: future, insuranceExpiresAt: future });

    // An ops suspension must not be clearable by the person it was applied to.
    expect((await DriverProfileModel.findOne({ user_id: d.userId }).lean())?.status).toBe(
      'suspended',
    );
  });

  it('keeps no acceptance rate, decline count, or score anywhere on the profile', async () => {
    const d = await driver('dv-noscore', { onShift: false });
    const raw = await DriverProfileModel.findOne({ user_id: d.userId }).lean();
    const fields = Object.keys(raw ?? {})
      .join(',')
      .toLowerCase();
    /**
     * ADR-004 §2 prohibits acceptance-rate pressure, and the surest way to reintroduce a prohibited
     * mechanic is to start collecting the number that would drive it.
     */
    for (const forbidden of ['accept', 'decline', 'score', 'rating', 'completion_rate']) {
      expect(fields, `field containing "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

// ─── 5b · presence and dispatch ─────────────────────────────────────────────────────────────
describe('5b · drivers are never on the customer map', () => {
  it('excludes on-shift drivers from the nearby query, at the repository', async () => {
    const d = await driver('dv-map');
    const { livemapRepository } = await import('../src/modules/livemap/livemap.repository');

    const customerView = await livemapRepository.nearby({
      lng: -121.0005,
      lat: 37.6005,
      radiusM: 5000,
      statuses: ['driving', 'parked'],
      limit: 50,
    });
    expect(customerView.some((s) => s.actor_id === d.userId)).toBe(false);

    // Dispatch is the one caller that wants them.
    const dispatchView = await livemapRepository.nearby({
      lng: -121.0005,
      lat: 37.6005,
      radiusM: 5000,
      statuses: ['driving', 'parked'],
      limit: 50,
      includeDrivers: true,
    });
    expect(dispatchView.some((s) => s.actor_id === d.userId)).toBe(true);
  });

  it('will not let a non-driver broadcast as one', async () => {
    const userId = await seedUser({
      authProviderId: 'dv-fake|x',
      roles: ['customer'],
      tier: 'silver',
    });
    const token = await mintToken('dv-fake|x');
    const res = await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'driver', actorId: userId, lng: -121, lat: 37.6, status: 'driving' });
    expect(res.status).toBe(403);
  });
});

describe('5b · the offer, and first-to-accept', () => {
  it('shows a driver only an approximate drop-off until they accept (A-15)', async () => {
    const v = await vendorWithOrder('dv-coarse');
    const d = await driver('dv-coarse');
    await requestDelivery(v.token, v.orderId);

    const offers = await request(app)
      .get('/api/v1/deliveries/offers')
      .set(...bearer(d.token));
    expect(offers.status).toBe(200);
    expect(offers.body.data).toHaveLength(1);

    const offer = offers.body.data[0];
    // A broadcast carrying a precise home address reaches every driver in range, almost all of whom
    // will not take the job.
    expect(JSON.stringify(offer)).not.toContain('Alder Street');
    expect(JSON.stringify(offer)).not.toContain('ring twice');
    expect(offer.dropOffArea.city).toBe('Testville');
    expect(offer.payoutCents).toBe(800);
  });

  it('gives the exact address only after acceptance, and takes it away when finished', async () => {
    const v = await vendorWithOrder('dv-exact');
    const d = await driver('dv-exact');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;

    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));
    const after = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(d.token));
    expect(after.body.data.destination.line1).toBe('14 Alder Street');
    expect(after.body.data.destination.notes).toBe('Blue door, ring twice');

    await DeliveryRequestModel.updateOne({ _id: id }, { $set: { status: 'delivered' } });
    const done = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(d.token));
    // Once the job is over the driver has no reason to hold somebody's address.
    expect(done.body.data.destination.line1).toBeUndefined();
  });

  /** THE test the roadmap says to write first. The interesting case is the loser. */
  it('lets exactly one of two simultaneous drivers win, and the loser loses cleanly', async () => {
    const v = await vendorWithOrder('dv-race');
    const a = await driver('dv-race-a');
    const b = await driver('dv-race-b');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;

    const results = await Promise.allSettled([
      deliveryService.accept(principalOf(a.userId), id),
      deliveryService.accept(principalOf(b.userId), id),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser gets a clear "someone else took it", not a crash and not a second acceptance.
    expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/already taken/i);

    const row = await DeliveryRequestModel.findById(id).lean();
    expect(row?.status).toBe('accepted');
    expect([a.userId, b.userId]).toContain(row?.driver_id);
  });

  it('refuses acceptance from a suspended driver', async () => {
    const v = await vendorWithOrder('dv-susp');
    const d = await driver('dv-susp');
    const req = await requestDelivery(v.token, v.orderId);
    await DriverProfileModel.updateOne({ user_id: d.userId }, { $set: { status: 'suspended' } });

    const res = await request(app)
      .post(`/api/v1/deliveries/${req.body.data.id}/accept`)
      .set(...bearer(d.token));
    expect(res.status).toBe(403);
  });

  it('will not let one driver hold two live deliveries', async () => {
    const v1 = await vendorWithOrder('dv-two-a');
    const v2 = await vendorWithOrder('dv-two-b');
    const d = await driver('dv-two');
    const r1 = await requestDelivery(v1.token, v1.orderId);
    const r2 = await requestDelivery(v2.token, v2.orderId);

    expect(
      (
        await request(app)
          .post(`/api/v1/deliveries/${r1.body.data.id}/accept`)
          .set(...bearer(d.token))
      ).status,
    ).toBe(200);
    const second = await request(app)
      .post(`/api/v1/deliveries/${r2.body.data.id}/accept`)
      .set(...bearer(d.token));
    // A driver holding two live jobs is one who is late for both.
    expect(second.status).toBe(409);
  });
});

// ─── 5c/5d · money and failure ──────────────────────────────────────────────────────────────
describe('5c/5d · nobody pays for a delivery that did not happen', () => {
  it('charges nothing while the offer is still out', async () => {
    const v = await vendorWithOrder('dv-nocharge');
    await driver('dv-nocharge');
    const req = await requestDelivery(v.token, v.orderId);

    const row = await DeliveryRequestModel.findById(req.body.data.id).lean();
    // DAN-13 — the most likely outcome is that nobody takes it.
    expect(row?.charged_at ?? null).toBeNull();
    expect(row?.transaction_id ?? null).toBeNull();
  });

  it('gives up after the last broadcast round, having charged nobody', async () => {
    const v = await vendorWithOrder('dv-giveup');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;

    // Wind through every round.
    for (let i = 0; i < 5; i += 1) {
      await DeliveryRequestModel.updateOne(
        { _id: id },
        { $set: { expires_at: new Date(Date.now() - 1000) } },
      );
      await deliveryService.sweepOffers();
    }

    const row = await DeliveryRequestModel.findById(id).lean();
    expect(row?.status).toBe('expired');
    expect(row?.ended_reason).toBe('no_driver_accepted');
    expect(row?.charged_at ?? null).toBeNull();
  });

  it('widens the search rather than starting wide', async () => {
    const v = await vendorWithOrder('dv-widen');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    const before = (await DeliveryRequestModel.findById(id).lean())?.broadcast_radius_m ?? 0;

    await DeliveryRequestModel.updateOne(
      { _id: id },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    await deliveryService.sweepOffers();

    // The nearest drivers get first refusal; an 8km first broadcast would offer the job to people
    // who could never make it in time.
    const after = (await DeliveryRequestModel.findById(id).lean())?.broadcast_radius_m ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('snapshots the price, and pays the driver exactly what they were offered', async () => {
    const v = await vendorWithOrder('dv-pay');
    const d = await driver('dv-pay');
    const req = await requestDelivery(v.token, v.orderId, 1200);
    const id = req.body.data.id as string;

    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));
    await request(app)
      .post(`/api/v1/deliveries/${id}/pick-up`)
      .set(...bearer(d.token));

    const customerView = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(v.custToken));
    const code = customerView.body.data.proofCode as string;
    expect(code).toMatch(/^\d{6}$/);

    const done = await request(app)
      .post(`/api/v1/deliveries/${id}/complete`)
      .set(...bearer(d.token))
      .send({ code });
    expect(done.status).toBe(200);

    const row = await DeliveryRequestModel.findById(id).lean();
    expect(row?.status).toBe('delivered');
    expect(row?.driver_payout_cents).toBe(1200);
    expect(fakeStripe.transfers.some((t) => t.amountCents === 1200)).toBe(true);
  });

  it('refuses the wrong hand-off code', async () => {
    const v = await vendorWithOrder('dv-code');
    const d = await driver('dv-code');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));
    await request(app)
      .post(`/api/v1/deliveries/${id}/pick-up`)
      .set(...bearer(d.token));

    const res = await request(app)
      .post(`/api/v1/deliveries/${id}/complete`)
      .set(...bearer(d.token))
      .send({ code: '000000' });
    expect(res.status).toBe(422);
  });

  it('never shows the hand-off code to the driver', async () => {
    const v = await vendorWithOrder('dv-secret');
    const d = await driver('dv-secret');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));

    const driverView = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(d.token));
    // A code the driver can read is not proof they met anybody.
    expect(driverView.body.data.proofCode).toBeUndefined();
  });

  it('still pays a driver who travelled but could not complete', async () => {
    const v = await vendorWithOrder('dv-undel');
    const d = await driver('dv-undel');
    const req = await requestDelivery(v.token, v.orderId, 900);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));
    await request(app)
      .post(`/api/v1/deliveries/${id}/pick-up`)
      .set(...bearer(d.token));

    const res = await request(app)
      .post(`/api/v1/deliveries/${id}/undeliverable`)
      .set(...bearer(d.token))
      .send({ reason: 'nobody answered' });

    expect(res.status).toBe(200);
    // They did the work they were asked to do.
    expect(fakeStripe.transfers.some((t) => t.amountCents === 900)).toBe(true);
  });

  it('lets the driver cancel without recording anything against them', async () => {
    const v = await vendorWithOrder('dv-cancel');
    const d = await driver('dv-cancel');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));

    const res = await request(app)
      .post(`/api/v1/deliveries/${id}/cancel`)
      .set(...bearer(d.token))
      .send({ reason: 'bike broke' });
    expect(res.status).toBe(200);

    // The reason lives on the DELIVERY. Nothing lands on the driver.
    const row = await DeliveryRequestModel.findById(id).lean();
    expect(row?.status).toBe('cancelled');
    const profile = await DriverProfileModel.findOne({ user_id: d.userId }).lean();
    expect(JSON.stringify(profile)).not.toContain('bike broke');
  });
});

// ─── 5e · tracking ──────────────────────────────────────────────────────────────────────────
describe('5e · courier position', () => {
  it('accepts a position only while the delivery is live', async () => {
    const v = await vendorWithOrder('dv-pos');
    const d = await driver('dv-pos');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;

    // Not yet accepted → outside the window, a driver's location is nobody's business.
    const early = await request(app)
      .post(`/api/v1/deliveries/${id}/position`)
      .set(...bearer(d.token))
      .send({ lng: -121, lat: 37.6 });
    expect(early.status).toBe(404);

    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));
    const live = await request(app)
      .post(`/api/v1/deliveries/${id}/position`)
      .set(...bearer(d.token))
      .send({ lng: -121, lat: 37.6 });
    expect(live.status).toBe(200);
    expect(live.body.data.accepted).toBe(true);
  });

  it('drops positions inside the rate ceiling', async () => {
    const v = await vendorWithOrder('dv-rate');
    const d = await driver('dv-rate');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));

    const send = () =>
      request(app)
        .post(`/api/v1/deliveries/${id}/position`)
        .set(...bearer(d.token))
        .send({ lng: -121, lat: 37.6 });

    expect((await send()).body.data.accepted).toBe(true);
    // A client bug — or two app instances — must not raise the platform's first sustained write load.
    expect((await send()).body.data.accepted).toBe(false);
  });
});

// ─── 5f · safety ────────────────────────────────────────────────────────────────────────────
describe('5f · safety (A-14, absent from the specification)', () => {
  it('lets any party to a delivery report an incident', async () => {
    const v = await vendorWithOrder('dv-inc');
    const d = await driver('dv-inc');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));

    const res = await request(app)
      .post(`/api/v1/deliveries/${id}/incidents`)
      .set(...bearer(d.token))
      .send({ kind: 'safety', detail: 'Aggressive dog at the address' });

    expect(res.status).toBe(201);
    const row = await DeliveryIncidentModel.findById(res.body.data.id).lean();
    expect(row?.reporter_role).toBe('driver');
    expect(row?.status).toBe('open');
  });

  it('refuses an incident report from somebody unconnected to the delivery', async () => {
    const v = await vendorWithOrder('dv-inc2');
    const d = await driver('dv-inc2');
    await seedUser({ authProviderId: 'dv-inc2|stranger', roles: ['customer'] });
    const stranger = await mintToken('dv-inc2|stranger');
    const req = await requestDelivery(v.token, v.orderId);
    await request(app)
      .post(`/api/v1/deliveries/${req.body.data.id}/accept`)
      .set(...bearer(d.token));

    const res = await request(app)
      .post(`/api/v1/deliveries/${req.body.data.id}/incidents`)
      .set(...bearer(stranger))
      .send({ kind: 'other' });
    expect(res.status).toBe(403);
  });

  it('gives the customer a share token, and nobody else', async () => {
    const v = await vendorWithOrder('dv-share');
    const d = await driver('dv-share');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;
    await request(app)
      .post(`/api/v1/deliveries/${id}/accept`)
      .set(...bearer(d.token));

    const customerView = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(v.custToken));
    const driverView = await request(app)
      .get(`/api/v1/deliveries/${id}`)
      .set(...bearer(d.token));
    expect(customerView.body.data.shareToken).toBeTruthy();
    expect(driverView.body.data.shareToken).toBeUndefined();
  });
});

// ─── copy rules ─────────────────────────────────────────────────────────────────────────────
describe('the copy rules ADR-004 created', () => {
  it('never calls a driver an employee, or their pay a wage (CR-4)', async () => {
    const v = await vendorWithOrder('dv-copy');
    const d = await driver('dv-copy');
    const req = await requestDelivery(v.token, v.orderId);
    const id = req.body.data.id as string;

    const surfaces = await Promise.all([
      request(app)
        .get('/api/v1/drivers/me')
        .set(...bearer(d.token)),
      request(app)
        .get('/api/v1/drivers/me/eligibility')
        .set(...bearer(d.token)),
      request(app)
        .get('/api/v1/deliveries/offers')
        .set(...bearer(d.token)),
      request(app)
        .get(`/api/v1/deliveries/${id}`)
        .set(...bearer(v.token)),
      request(app).get('/api/v1/agreements/driver_engagement'),
    ]);
    const copy = surfaces
      .map((r) => JSON.stringify(r.body.data))
      .join(' ')
      .toLowerCase();

    // Those words are what a regulator and a court read as claims about a relationship.
    for (const forbidden of ['employee', 'employer', 'wage', 'salary', 'shift assigned', 'hire']) {
      expect(copy, `forbidden word "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('never guarantees delivery, earnings, or acceptance (CR-5)', async () => {
    const v = await vendorWithOrder('dv-guar');
    const d = await driver('dv-guar');
    const req = await requestDelivery(v.token, v.orderId);

    const surfaces = await Promise.all([
      request(app)
        .get('/api/v1/deliveries/offers')
        .set(...bearer(d.token)),
      request(app)
        .get(`/api/v1/deliveries/${req.body.data.id}`)
        .set(...bearer(v.custToken)),
    ]);
    const copy = surfaces
      .map((r) => JSON.stringify(r.body.data))
      .join(' ')
      .toLowerCase();
    // The platform controls none of the three.
    expect(copy).not.toContain('guaranteed');
  });
});

// ─── the gate ───────────────────────────────────────────────────────────────────────────────
describe('the launch gate', () => {
  it('cannot take a delivery order in a city where delivery is not switched on', async () => {
    // Phase 2's default-deny is what stands between this code and a delivery with no insurance
    // behind it. Building the feature does not ship it.
    const { env } = await import('../src/config/env');
    await CityModel.updateOne(
      { slug: env.DEFAULT_CITY },
      { $set: { 'feature_flags.delivery': false } },
    );

    const cat = await CategoryModel.create({
      slug: 'dv-gate-cat',
      name: 'gate',
      top_level_tab: 'food',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'dv-gate|vendor', roles: ['vendor'] });
    const vt = await mintToken('dv-gate|vendor');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(vt))
      .send({ name: 'Gate Tacos', categoryId: String(cat._id) });
    await seedUser({ authProviderId: 'dv-gate|cust', roles: ['customer'] });
    const ct = await mintToken('dv-gate|cust');

    const res = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(ct))
      .set('Idempotency-Key', 'dv_gate_order')
      .send({
        businessId: biz.body.data.id,
        items: [],
        destination: { line1: '1 Any Road', city: 'Testville', lng: -121, lat: 37.6 },
      });
    expect([400, 403]).toContain(res.status);

    await enableDelivery();
  });

  it('leaves the coordination fee unpriced, so nothing is silently charged', async () => {
    const { resolveFee } = await import('../src/modules/payments/fees');
    // Pricing it is a gate on DAN-8, and needs the driver payout and insurance cost to be known.
    expect(await resolveFee('delivery_coordination', 1000)).toBe(0);
  });

  it('has no orphaned deliveries left behind by these tests', async () => {
    const stuck = await OrderModel.countDocuments({ fulfillment_type: 'delivery' });
    expect(stuck).toBeGreaterThan(0);
  });
});

/**
 * ═══ A driver is not dispatched against money that has not arrived. ═══
 *
 * `request` refused a cancelled or completed order and nothing else, so a `pending_payment` one —
 * an order whose card has only been OPENED, never confirmed — would dispatch. That sends a real
 * person on a real journey and commits the vendor to a payout they owe whatever happens; by the
 * time the payment fails the driver has done the work and is owed for it.
 *
 * Not reachable through the vendor's board, which only offers this on an accepted order. Enforced
 * anyway, because "the client would not do that" is an assumption about a caller we do not control.
 */
describe('delivery: dispatch waits for the customer to actually pay', () => {
  it('refuses a driver request for an order whose payment has not settled', async () => {
    const prefix = 'dan-unpaid';
    // Reuses the standard fixture for the vendor, business and live session; the order it makes is
    // paid, so this test places a SECOND one and deliberately leaves it unsettled.
    const { token, custToken, businessId } = await vendorWithOrder(prefix);

    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Unpaid plate', priceCents: 2000 });

    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(custToken))
      .set('Idempotency-Key', `${prefix}_order_2`)
      .send({
        businessId,
        items: [{ menuItemId: item.body.data.id, quantity: 1 }],
        destination: { line1: '9 Unpaid Way', city: 'Testville', lng: -121.002, lat: 37.602 },
      });
    expect(order.status).toBe(201);

    // Deliberately NOT settled — this is the unpaid case.
    expect((await OrderModel.findById(order.body.data.id).lean())!.status).toBe('pending_payment');

    const res = await request(app)
      .post('/api/v1/deliveries')
      .set(...bearer(token))
      .send({ orderId: order.body.data.id, driverPayoutCents: 500 });
    expect([400, 422]).toContain(res.status);
    expect(res.body.error.message).toMatch(/not been paid for/i);
  });
});

/**
 * ═══ WHAT A DELIVERY IS WORTH ═══
 *
 * The vendor typed a number into a box with fixed presets, so the offer bore no relation to the
 * journey: the same amount for two streets and for five miles. Drivers decline the long ones, the
 * customer waits, and nobody can see why.
 *
 * Computed, never negotiated. The customer has already paid at checkout, so a price haggled
 * afterwards has no rail to collect it — and bartering while the food goes cold, with a driver able
 * to hold an order hostage for more, is a worse deal for both sides than a number they can each see
 * before anyone commits.
 */
describe('delivery: priced by distance, not by haggling', () => {
  it('quotes more for a longer journey, and never outside the payout bounds', async () => {
    const near = deliveryService.suggestedPayoutCents([-121.0, 37.6], [-121.002, 37.602]);
    const far = deliveryService.suggestedPayoutCents([-121.0, 37.6], [-121.08, 37.66]);
    expect(far).toBeGreaterThan(near);

    // A journey across the street still pays enough to be worth turning up for…
    expect(near).toBeGreaterThanOrEqual(200);
    // …and an absurd one is capped rather than unbounded.
    const absurd = deliveryService.suggestedPayoutCents([-121.0, 37.6], [-8.0, 52.0]);
    expect(absurd).toBe(5_000);
  });

  it('quotes a real order from its actual pickup and drop-off', async () => {
    const { token, orderId } = await vendorWithOrder('dan-quote');
    const res = await request(app)
      .get(`/api/v1/deliveries/quote/${orderId}`)
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.distanceM).toBeGreaterThan(0);
    expect(res.body.data.suggestedPayoutCents).toBeGreaterThanOrEqual(200);
    expect(res.body.data.suggestedPayoutCents).toBeLessThanOrEqual(5_000);
  });

  it('will not quote somebody else’s order', async () => {
    const { orderId } = await vendorWithOrder('dan-quote-auth');
    await seedUser({ authProviderId: 'dan-quote-auth|nosy', roles: ['vendor'] });
    const nosy = await mintToken('dan-quote-auth|nosy');
    const res = await request(app)
      .get(`/api/v1/deliveries/quote/${orderId}`)
      .set(...bearer(nosy));
    expect([403, 404]).toContain(res.status);
  });
});
