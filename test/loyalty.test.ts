import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { LoyaltyRewardModel } from '../src/modules/loyalty/loyalty.service';
import {
  REFERRAL_LIFETIME_CAP,
  ReferralCodeModel,
  ReferralCreditModel,
  ReferralModel,
  referralsService,
} from '../src/modules/loyalty/referrals.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * 7.3 / 7.4 — loyalty stamps and referral rewards.
 *
 * Both are reward mechanics, and both are farmed the moment they are worth farming. What these
 * tests pin is the anti-abuse shape rather than the happy path: one stamp per ORDER (not per item),
 * stamps only on COMPLETION (not payment), one reward per full card even under a race, and a
 * referral that converts only when the referred person spends real money.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

async function vendorWithMenu(prefix: string) {
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
    .send({ name: `${prefix} Coffee`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(
      JSON.stringify({
        id: `evt_${Math.random()}`,
        type: 'account.updated',
        data: { object: { id: acct!.stripe_account_id } },
      }),
    );

  const item = await request(app)
    .post(`/api/v1/businesses/${businessId}/menu`)
    .set(...bearer(token))
    .send({ name: 'Coffee', priceCents: 500 });

  // Going live requires the current Seller Terms of Sale to be accepted.
  const terms = await request(app).get('/api/v1/agreements/regular_sale');
  await request(app)
    .post('/api/v1/agreements/regular_sale/accept')
    .set(...bearer(token))
    .send({ version: terms.body.data.version, contentHash: terms.body.data.contentHash });

  // Orders are only accepted while Parked.
  const live = await request(app)
    .post('/api/v1/live-sessions/start')
    .set(...bearer(token))
    .send({ actorType: 'business', actorId: businessId, status: 'parked', lng: -120.99, lat: 37.64 });
  if (live.status >= 400) throw new Error(`live start failed: ${live.status} ${JSON.stringify(live.body)}`);

  return { token, businessId, menuItemId: item.body.data.id as string };
}

async function customer(prefix: string) {
  const userId = await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return { userId, token: await mintToken(`${prefix}|cust`) };
}

/** Place and complete one order — the only thing that earns a stamp. */
async function buyAndComplete(
  v: { token: string; businessId: string; menuItemId: string },
  c: { token: string },
  key: string,
) {
  const order = await request(app)
    .post('/api/v1/orders')
    .set(...bearer(c.token))
    .set('Idempotency-Key', key)
    .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });
  if (order.status !== 201) throw new Error(`order failed: ${order.status} ${JSON.stringify(order.body)}`);
  const orderId = order.body.data?.id as string;
  await request(app).post(`/api/v1/orders/${orderId}/accept`).set(...bearer(v.token));
  await request(app).post(`/api/v1/orders/${orderId}/ready`).set(...bearer(v.token));
  await request(app).post(`/api/v1/orders/${orderId}/complete`).set(...bearer(v.token));
  return orderId;
}

describe('loyalty stamps (7.3)', () => {
  it('stamps once per completed order and mints a reward when the card fills', async () => {
    const v = await vendorWithMenu('loy-card');
    const c = await customer('loy-card');

    await request(app)
      .put(`/api/v1/businesses/${v.businessId}/loyalty`)
      .set(...bearer(v.token))
      .send({ stampsRequired: 3, rewardDescription: 'A free coffee' });

    for (let i = 0; i < 3; i++) {
      await buyAndComplete(v, c, `loy-card-${i}`);
    }
    await new Promise((r) => setTimeout(r, 600));

    const rewards = await request(app).get('/api/v1/users/me/loyalty/rewards').set(...bearer(c.token));
    expect(rewards.body.data).toHaveLength(1);
    expect(rewards.body.data[0].description).toBe('A free coffee');

    // The stamps that bought the reward are consumed — the card starts again, it does not keep
    // paying out.
    const cards = await request(app).get('/api/v1/users/me/loyalty/cards').set(...bearer(c.token));
    expect(cards.body.data[0].stamps).toBe(0);
    expect(cards.body.data[0].lifetimeStamps).toBe(3);
  });

  it('stamps per ORDER, not per item — ten coffees on one receipt is one visit', async () => {
    const v = await vendorWithMenu('loy-qty');
    const c = await customer('loy-qty');
    await request(app)
      .put(`/api/v1/businesses/${v.businessId}/loyalty`)
      .set(...bearer(v.token))
      .send({ stampsRequired: 5, rewardDescription: 'A free coffee' });

    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(c.token))
      .set('Idempotency-Key', 'loy-qty-1')
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 10 }] });
    const orderId = order.body.data.id as string;
    await request(app).post(`/api/v1/orders/${orderId}/accept`).set(...bearer(v.token));
    await request(app).post(`/api/v1/orders/${orderId}/ready`).set(...bearer(v.token));
    await request(app).post(`/api/v1/orders/${orderId}/complete`).set(...bearer(v.token));
    await new Promise((r) => setTimeout(r, 600));

    const cards = await request(app).get('/api/v1/users/me/loyalty/cards').set(...bearer(c.token));
    expect(cards.body.data[0].stamps).toBe(1);
  });

  it('does not stamp a paid-but-uncompleted order', async () => {
    // A stamp a cancellation could reverse is a free-reward machine.
    const v = await vendorWithMenu('loy-uncompleted');
    const c = await customer('loy-uncompleted');
    await request(app)
      .put(`/api/v1/businesses/${v.businessId}/loyalty`)
      .set(...bearer(v.token))
      .send({ stampsRequired: 3, rewardDescription: 'A free coffee' });

    await request(app)
      .post('/api/v1/orders')
      .set(...bearer(c.token))
      .set('Idempotency-Key', 'loy-uncompleted-1')
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });
    await new Promise((r) => setTimeout(r, 600));

    const cards = await request(app).get('/api/v1/users/me/loyalty/cards').set(...bearer(c.token));
    expect(cards.body.data).toHaveLength(0);
  });

  it('a reward can be redeemed once; a second attempt says so plainly', async () => {
    // Two staff scanning the same code must not both give it away, and the second one needs to know
    // which case they are in.
    const v = await vendorWithMenu('loy-redeem');
    const c = await customer('loy-redeem');
    await request(app)
      .put(`/api/v1/businesses/${v.businessId}/loyalty`)
      .set(...bearer(v.token))
      .send({ stampsRequired: 3, rewardDescription: 'A free coffee' });
    for (let i = 0; i < 3; i++) await buyAndComplete(v, c, `loy-redeem-${i}`);
    await new Promise((r) => setTimeout(r, 600));

    const reward = await LoyaltyRewardModel.findOne({ user_id: c.userId }).lean();
    expect(reward).not.toBeNull();

    const first = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/loyalty/redeem`)
      .set(...bearer(v.token))
      .send({ code: reward!.code });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/businesses/${v.businessId}/loyalty/redeem`)
      .set(...bearer(v.token))
      .send({ code: reward!.code });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toContain('already redeemed');
  });

  it("a vendor cannot redeem another business's reward code", async () => {
    const v = await vendorWithMenu('loy-idor');
    const other = await vendorWithMenu('loy-idor-other');
    const c = await customer('loy-idor');
    await request(app)
      .put(`/api/v1/businesses/${v.businessId}/loyalty`)
      .set(...bearer(v.token))
      .send({ stampsRequired: 3, rewardDescription: 'A free coffee' });
    for (let i = 0; i < 3; i++) await buyAndComplete(v, c, `loy-idor-${i}`);
    await new Promise((r) => setTimeout(r, 600));
    const reward = await LoyaltyRewardModel.findOne({ user_id: c.userId }).lean();

    const res = await request(app)
      .post(`/api/v1/businesses/${other.businessId}/loyalty/redeem`)
      .set(...bearer(other.token))
      .send({ code: reward!.code });
    expect(res.status).toBe(404);
  });

  it('no programme means no stamps — loyalty is opt-in for the vendor', async () => {
    const v = await vendorWithMenu('loy-none');
    const c = await customer('loy-none');
    await buyAndComplete(v, c, 'loy-none-1');
    await new Promise((r) => setTimeout(r, 600));

    const cards = await request(app).get('/api/v1/users/me/loyalty/cards').set(...bearer(c.token));
    expect(cards.body.data).toHaveLength(0);
  });
});

describe('referral rewards (7.4)', () => {
  it('converts only when the referred user COMPLETES an order, not on claim', async () => {
    // Signing up is free, so rewarding signup rewards account creation.
    const v = await vendorWithMenu('ref-convert');
    const referrer = await customer('ref-convert-a');
    const referred = await customer('ref-convert-b');

    const code = await request(app)
      .post('/api/v1/users/me/referrals/code')
      .set(...bearer(referrer.token));
    const claim = await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(referred.token))
      .send({ code: code.body.data.code });
    expect(claim.status).toBe(201);
    expect(claim.body.data.status).toBe('pending');
    expect(await ReferralCreditModel.countDocuments({})).toBe(0);

    await buyAndComplete(v, referred, 'ref-convert-1');
    await new Promise((r) => setTimeout(r, 600));

    // BOTH sides earn — a one-sided programme asks the referred user to do the work for nothing.
    expect(await ReferralCreditModel.countDocuments({ user_id: referrer.userId })).toBe(1);
    expect(await ReferralCreditModel.countDocuments({ user_id: referred.userId })).toBe(1);
  });

  it('refuses self-referral', async () => {
    const c = await customer('ref-self');
    const code = await request(app).post('/api/v1/users/me/referrals/code').set(...bearer(c.token));
    const res = await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(c.token))
      .send({ code: code.body.data.code });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('yourself');
  });

  it('allows one referral per account, ever', async () => {
    const a = await customer('ref-once-a');
    const b = await customer('ref-once-b');
    const c = await customer('ref-once-c');
    const codeA = await request(app).post('/api/v1/users/me/referrals/code').set(...bearer(a.token));
    const codeB = await request(app).post('/api/v1/users/me/referrals/code').set(...bearer(b.token));

    await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(c.token))
      .send({ code: codeA.body.data.code });
    const second = await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(c.token))
      .send({ code: codeB.body.data.code });

    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toContain('one per account');
  });

  it('earns nothing twice, however many orders the referred user completes', async () => {
    const v = await vendorWithMenu('ref-twice');
    const referrer = await customer('ref-twice-a');
    const referred = await customer('ref-twice-b');
    const code = await request(app)
      .post('/api/v1/users/me/referrals/code')
      .set(...bearer(referrer.token));
    await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(referred.token))
      .send({ code: code.body.data.code });

    await buyAndComplete(v, referred, 'ref-twice-1');
    await buyAndComplete(v, referred, 'ref-twice-2');
    await new Promise((r) => setTimeout(r, 600));

    expect(await ReferralCreditModel.countDocuments({ user_id: referrer.userId })).toBe(1);
  });

  it('stops paying at the lifetime cap, and records that it did', async () => {
    // An uncapped programme has an unbounded liability. The cap is a number someone chose rather
    // than a number an attacker chose.
    const v = await vendorWithMenu('ref-cap');
    const referrer = await customer('ref-cap-a');
    const referred = await customer('ref-cap-b');
    const code = await request(app)
      .post('/api/v1/users/me/referrals/code')
      .set(...bearer(referrer.token));
    await ReferralCodeModel.updateOne(
      { user_id: referrer.userId },
      { $set: { rewards_earned: REFERRAL_LIFETIME_CAP } },
    );
    await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(referred.token))
      .send({ code: code.body.data.code });

    await buyAndComplete(v, referred, 'ref-cap-1');
    await new Promise((r) => setTimeout(r, 600));

    expect(await ReferralCreditModel.countDocuments({ user_id: referrer.userId })).toBe(0);
    // The referral still converted — the cap bit, the referral was not lost.
    const referral = await ReferralModel.findOne({ referred_user_id: referred.userId }).lean();
    expect(referral!.status).toBe('converted');
  });

  it('lapses a pending referral past its window, so "pending" means something', async () => {
    const referrer = await customer('ref-lapse-a');
    const referred = await customer('ref-lapse-b');
    const code = await request(app)
      .post('/api/v1/users/me/referrals/code')
      .set(...bearer(referrer.token));
    await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(referred.token))
      .send({ code: code.body.data.code });

    await ReferralModel.updateOne(
      { referred_user_id: referred.userId },
      { $set: { expires_at: new Date(Date.now() - 86_400_000) } },
    );
    expect(await referralsService.sweepLapsed()).toBeGreaterThanOrEqual(1);

    const referral = await ReferralModel.findOne({ referred_user_id: referred.userId }).lean();
    expect(referral!.status).toBe('lapsed');
  });

  it('a lapsed referral no longer converts', async () => {
    const v = await vendorWithMenu('ref-lapsed-order');
    const referrer = await customer('ref-lapsed-order-a');
    const referred = await customer('ref-lapsed-order-b');
    const code = await request(app)
      .post('/api/v1/users/me/referrals/code')
      .set(...bearer(referrer.token));
    await request(app)
      .post('/api/v1/users/me/referrals/claim')
      .set(...bearer(referred.token))
      .send({ code: code.body.data.code });
    await ReferralModel.updateOne(
      { referred_user_id: referred.userId },
      { $set: { expires_at: new Date(Date.now() - 86_400_000) } },
    );

    await buyAndComplete(v, referred, 'ref-lapsed-order-1');
    await new Promise((r) => setTimeout(r, 600));
    expect(await ReferralCreditModel.countDocuments({ user_id: referrer.userId })).toBe(0);
  });

  it('returns a stable code — people share it', async () => {
    const c = await customer('ref-stable');
    const first = await request(app).post('/api/v1/users/me/referrals/code').set(...bearer(c.token));
    const second = await request(app).post('/api/v1/users/me/referrals/code').set(...bearer(c.token));
    expect(second.body.data.code).toBe(first.body.data.code);
  });
});
