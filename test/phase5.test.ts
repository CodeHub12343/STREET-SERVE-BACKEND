import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import {
  GiftModel,
  BlockPartyEventModel,
  PingBudgetTopupModel,
} from '../src/modules/growth/growth.model';
import { blockPartyService } from '../src/modules/growth/blockparty.service';
import { UserModel } from '../src/modules/identity/identity.model';
import { FraudFlagModel } from '../src/shared/fraud';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 5 exit criterion: "paid pings pay tips only to genuinely qualifying recipients; farming
 * attempts are flagged, not paid." Plus gifting/giveaways/Spot-Me gates and Block Party detection.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
});

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

async function openCategory(slug: string): Promise<string> {
  const c = await CategoryModel.create({
    slug,
    name: slug,
    top_level_tab: 'food',
    requires_license: false,
  });
  return String(c._id);
}

async function makeVendor(prefix: string): Promise<{ token: string; businessId: string }> {
  const categoryId = await openCategory(`${prefix}-cat`);
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Biz`, categoryId });
  const businessId = biz.body.data.id as string;
  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
  return { token, businessId };
}

/**
 * Fund a ping budget the way production does: the top-up opens a real card charge and the balance
 * is credited ONLY once that charge settles. Posting the budget alone leaves the balance at zero —
 * deliberately, because crediting on request would pay sharers with money that does not exist yet,
 * funding tips from platform capital. So the test has to settle the charge too.
 */
async function fundPingBudget(
  token: string,
  businessId: string,
  reloadCents: number,
  perShareTipCents: number,
) {
  await request(app)
    .post(`/api/v1/ping-budgets/${businessId}`)
    .set(...bearer(token))
    .send({ reloadCents, perShareTipCents });
  const topup = await PingBudgetTopupModel.findOne({
    business_id: businessId,
    status: 'pending',
  }).lean();
  await stripeEvent('payment_intent.succeeded', { id: topup!.stripe_payment_intent_id });
}

async function share(token: string, businessId: string, contact: string, device: string) {
  return request(app)
    .post('/api/v1/pings')
    .set(...bearer(token))
    .send({ businessId, recipientContact: contact, deviceFingerprint: device });
}

describe('paid ping economy (Phase 5 exit): qualifying tips paid, farming flagged not paid', () => {
  it('pays a tip to a genuine new recipient and rejects every farming vector', async () => {
    const { token: vendorToken, businessId } = await makeVendor('p5p');
    await fundPingBudget(vendorToken, businessId, 1000, 50);

    const senderId = await seedUser({ authProviderId: 'p5p|sender', roles: ['customer'] });
    const sender = await mintToken('p5p|sender');
    void senderId;

    // ── Happy path: genuine new recipient qualifies on a different device → tip paid.
    const s1 = await share(sender, businessId, 'alice@example.com', 'device-A');
    expect(s1.body.data.isPaid).toBe(true);
    await seedUser({ authProviderId: 'p5p|alice', roles: ['customer'] }); // new account
    const alice = await mintToken('p5p|alice');
    const q1 = await request(app)
      .post(`/api/v1/pings/${s1.body.data.pingId}/qualify`)
      .set(...bearer(alice))
      .send({ deviceFingerprint: 'device-B' });
    expect(q1.body.data.qualified).toBe(true);
    expect(q1.body.data.tipCents).toBe(50);

    // ── Farm 1 — self-referral: the sender tries to qualify their own ping.
    const s2 = await share(sender, businessId, 'self@example.com', 'device-S');
    const q2 = await request(app)
      .post(`/api/v1/pings/${s2.body.data.pingId}/qualify`)
      .set(...bearer(sender))
      .send({ deviceFingerprint: 'device-X' });
    expect(q2.body.data.qualified).toBe(false);
    expect(q2.body.data.reason).toBe('self_referral');

    // ── Farm 2 — recipient is an established (old) account, not new/dormant.
    const s3 = await share(sender, businessId, 'bob@example.com', 'device-C');
    await seedUser({ authProviderId: 'p5p|bob', roles: ['customer'], createdDaysAgo: 200 });
    const bob = await mintToken('p5p|bob');
    const q3 = await request(app)
      .post(`/api/v1/pings/${s3.body.data.pingId}/qualify`)
      .set(...bearer(bob))
      .send({ deviceFingerprint: 'device-D' });
    expect(q3.body.data.qualified).toBe(false);
    expect(q3.body.data.reason).toBe('recipient_already_active');

    // ── Farm 3 — same device as the sender's ping.
    const s4 = await share(sender, businessId, 'carol@example.com', 'device-E');
    await seedUser({ authProviderId: 'p5p|carol', roles: ['customer'] });
    const carol = await mintToken('p5p|carol');
    const q4 = await request(app)
      .post(`/api/v1/pings/${s4.body.data.pingId}/qualify`)
      .set(...bearer(carol))
      .send({ deviceFingerprint: 'device-E' });
    expect(q4.body.data.qualified).toBe(false);
    expect(q4.body.data.reason).toBe('device_match');

    // ── Duplicate recipient per vendor → the second share is free, not paid.
    const s5 = await share(sender, businessId, 'alice@example.com', 'device-F');
    expect(s5.body.data.isPaid).toBe(false);
    expect(s5.body.data.reason).toBe('recipient_already_shared');

    // Exactly one tip (50c) was paid → budget went 1000 → 950.
    const budget = await request(app)
      .patch(`/api/v1/ping-budgets/${businessId}`)
      .set(...bearer(vendorToken))
      .send({ status: 'active' });
    expect(budget.body.data.balanceCents).toBe(950);

    // Farming attempts were flagged for review (self-referral + device-match at minimum).
    const flags = await FraudFlagModel.countDocuments({ type: 'ping' });
    expect(flags).toBeGreaterThanOrEqual(2);
  });

  /**
   * The solvency guard, which the fixture above quietly depended on and nothing asserted: a top-up
   * that has been REQUESTED but not paid must not fund a single tip. Crediting on request would
   * mean the platform paying sharers out of its own capital for money a vendor never sent.
   */
  it('does not fund tips from a top-up whose charge has not settled', async () => {
    const { token: vendorToken, businessId } = await makeVendor('p5unpaid');
    await request(app)
      .post(`/api/v1/ping-budgets/${businessId}`)
      .set(...bearer(vendorToken))
      .send({ reloadCents: 1000, perShareTipCents: 50 });

    await seedUser({ authProviderId: 'p5unpaid|sender', roles: ['customer'] });
    const sender = await mintToken('p5unpaid|sender');

    const unfunded = await share(sender, businessId, 'nope@example.com', 'device-U');
    expect(unfunded.body.data.isPaid).toBe(false);
    expect(unfunded.body.data.reason).toBe('budget_unavailable');

    // Once the money actually arrives, the very next share is paid.
    const topup = await PingBudgetTopupModel.findOne({
      business_id: businessId,
      status: 'pending',
    }).lean();
    await stripeEvent('payment_intent.succeeded', { id: topup!.stripe_payment_intent_id });

    const funded = await share(sender, businessId, 'yes@example.com', 'device-V');
    expect(funded.body.data.isPaid).toBe(true);
  });

  it('labels shares free when the budget is depleted', async () => {
    const { businessId } = await makeVendor('p5f');
    await seedUser({ authProviderId: 'p5f|sender', roles: ['customer'] });
    const sender = await mintToken('p5f|sender');
    // No budget funded → every share is free.
    const s = await share(sender, businessId, 'x@example.com', 'dev');
    expect(s.body.data.isPaid).toBe(false);
    expect(s.body.data.label).toBe('free');
  });
});

describe('gifting', () => {
  it('creates a gift, redeems once, and rejects re-redeem and expired redeem', async () => {
    const { businessId } = await makeVendor('p5g');
    await seedUser({ authProviderId: 'p5g|buyer', roles: ['customer'] });
    const buyer = await mintToken('p5g|buyer');

    const gift = await request(app)
      .post('/api/v1/gifts')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'gift-1')
      .send({
        businessId,
        itemName: 'Coffee',
        amountCents: 500,
        recipientContact: 'friend@example.com',
      });
    expect(gift.status).toBe(201);
    const code = gift.body.data.redemptionCode as string;

    await seedUser({ authProviderId: 'p5g|friend', roles: ['customer'] });
    const friend = await mintToken('p5g|friend');
    const redeem = await request(app)
      .post(`/api/v1/gifts/${code}/redeem`)
      .set(...bearer(friend));
    expect(redeem.status).toBe(200);
    const again = await request(app)
      .post(`/api/v1/gifts/${code}/redeem`)
      .set(...bearer(friend));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GIFT_ALREADY_REDEEMED');

    // Expired gift.
    const gift2 = await request(app)
      .post('/api/v1/gifts')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'gift-2')
      .send({
        businessId,
        itemName: 'Tea',
        amountCents: 300,
        recipientContact: 'other@example.com',
      });
    const code2 = gift2.body.data.redemptionCode as string;
    await GiftModel.updateOne(
      { redemption_code: code2 },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    const expired = await request(app)
      .post(`/api/v1/gifts/${code2}/redeem`)
      .set(...bearer(friend));
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('GIFT_EXPIRED');
  });
});

describe('giveaways', () => {
  it('enforces the daily cap and one claim per user per day', async () => {
    const { token: vendorToken, businessId } = await makeVendor('p5v');
    const g = await request(app)
      .post('/api/v1/giveaways')
      .set(...bearer(vendorToken))
      .send({ businessId, productName: 'Sample', dailyQuantityCap: 2 });
    const giveawayId = g.body.data.id as string;

    for (const name of ['u1', 'u2']) {
      await seedUser({ authProviderId: `p5v|${name}`, roles: ['customer'] });
      const token = await mintToken(`p5v|${name}`);
      const res = await request(app)
        .post(`/api/v1/giveaways/${giveawayId}/claim`)
        .set(...bearer(token));
      expect(res.status).toBe(200);
    }
    // Cap reached for a third user.
    await seedUser({ authProviderId: 'p5v|u3', roles: ['customer'] });
    const u3 = await mintToken('p5v|u3');
    const capped = await request(app)
      .post(`/api/v1/giveaways/${giveawayId}/claim`)
      .set(...bearer(u3));
    expect(capped.status).toBe(422);
    expect(capped.body.error.code).toBe('GIVEAWAY_CAP_REACHED');
  });
});

describe('Spot Me gates', () => {
  it('blocks under-30-day or below-Bronze accounts and allows eligible ones', async () => {
    // Eligible: 60-day-old, Bronze.
    await seedUser({
      authProviderId: 'p5s|ok',
      roles: ['customer'],
      tier: 'bronze',
      createdDaysAgo: 60,
    });
    const ok = await mintToken('p5s|ok');
    const req = await request(app)
      .post('/api/v1/spot-me')
      .set(...bearer(ok))
      .send({
        counterpartyType: 'vendor',
        counterpartyId: 'somevendor',
        amountCents: 1000,
        repayBy: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    expect(req.status).toBe(201);

    // Too new.
    await seedUser({ authProviderId: 'p5s|new', roles: ['customer'], tier: 'bronze' });
    const nu = await mintToken('p5s|new');
    const tooNew = await request(app)
      .post('/api/v1/spot-me')
      .set(...bearer(nu))
      .send({
        counterpartyType: 'vendor',
        counterpartyId: 'v',
        amountCents: 1000,
        repayBy: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    expect(tooNew.status).toBe(422);
    expect(tooNew.body.error.code).toBe('SPOT_ME_INELIGIBLE');

    // Old enough but below Bronze.
    await seedUser({ authProviderId: 'p5s|lowtier', roles: ['customer'], createdDaysAgo: 60 });
    const low = await mintToken('p5s|lowtier');
    const lowTier = await request(app)
      .post('/api/v1/spot-me')
      .set(...bearer(low))
      .send({
        counterpartyType: 'vendor',
        counterpartyId: 'v',
        amountCents: 1000,
        repayBy: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    expect(lowTier.status).toBe(422);
  });
});

describe('Block Party detection', () => {
  it('detects a cluster of ≥2 live vendors and broadcasts to nearby opted-in users', async () => {
    // Two vendors go live within ~15m of each other.
    const coords: [number, number][] = [
      [-121.0, 37.6],
      [-121.0001, 37.6],
    ];
    for (let i = 0; i < 2; i += 1) {
      const categoryId = await openCategory(`p5bp-${i}`);
      await seedUser({ authProviderId: `p5bp|v${i}`, roles: ['vendor'] });
      const token = await mintToken(`p5bp|v${i}`);
      const biz = await request(app)
        .post('/api/v1/businesses')
        .set(...bearer(token))
        .send({ name: `BP ${i}`, categoryId });
      await request(app).post('/api/v1/agreements/regular_sale/accept').set(...bearer(token)).send({});
      await request(app)
        .post('/api/v1/live-sessions/start')
        .set(...bearer(token))
        .send({
          actorType: 'business',
          actorId: biz.body.data.id,
          lng: coords[i]![0],
          lat: coords[i]![1],
          status: 'parked',
        });
    }

    // A customer whose home is near the cluster centroid.
    const customerId = await seedUser({ authProviderId: 'p5bp|cust', roles: ['customer'] });
    await UserModel.updateOne(
      { _id: customerId },
      { $set: { home_location: { type: 'Point', coordinates: [-121.0, 37.6] } } },
    );

    // overlapMs 0 → a single sweep confirms the sustained cluster.
    const events = await blockPartyService.detectAndBroadcast({ overlapMs: 0 });
    expect(events.length).toBe(1);
    expect(events[0]!.participantCount).toBe(2);

    const stored = await BlockPartyEventModel.findById(events[0]!.eventId).lean();
    expect(stored!.participant_actor_ids.length).toBe(2);
    expect(stored!.notified_user_count).toBeGreaterThanOrEqual(1);
  });
});
