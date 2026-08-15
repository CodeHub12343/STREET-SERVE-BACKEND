import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { paymentsService } from '../src/modules/payments/payments.service';
import { subscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Monetization subscriptions (R29/R30): Pro (lower marketplace fee), Featured (Trending boost),
 * Verified badge + AI assistant (entitlements). Four plans over existing hooks.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

async function businessWithAccount(prefix: string): Promise<{ token: string; businessId: string }> {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Biz`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({ owner_type: 'business', owner_id: businessId }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
  return { token, businessId };
}

describe('subscription plans + entitlements (R29/R30)', () => {
  it('lists the four plans and grants/revokes an entitlement on subscribe/cancel', async () => {
    const plans = await request(app).get('/api/v1/subscriptions/plans');
    expect(plans.status).toBe(200);
    expect(plans.body.data.map((p: { plan: string }) => p.plan)).toEqual(
      expect.arrayContaining(['pro', 'featured', 'verified_badge', 'ai_assistant']),
    );

    await seedUser({ authProviderId: 'sub|user', roles: ['seller'] });
    const token = await mintToken('sub|user');
    const sub = await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(token))
      .set('Idempotency-Key', 'sub-ai-1')
      .send({ plan: 'ai_assistant' });
    expect(sub.status).toBe(201);
    expect(sub.body.data.status).toBe('active');

    const mine1 = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(mine1.body.data.aiAssistant).toBe(true);

    const cancel = await request(app)
      .post('/api/v1/subscriptions/ai_assistant/cancel')
      .set(...bearer(token))
      .send({});
    expect(cancel.status).toBe(200);
    const mine2 = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(mine2.body.data.aiAssistant).toBe(false);
  });
});

describe('Pro membership discounts the marketplace fee (R29)', () => {
  it('a Pro business pays 7% instead of 10% on a sale', async () => {
    const { token, businessId } = await businessWithAccount('sub-pro');
    await seedUser({ authProviderId: 'sub-pro|cust', roles: ['customer'] });
    const customerId = await seedUser({ authProviderId: 'sub-pro|c2', roles: ['customer'] });

    // Baseline: no subscription → 10% of $100 = $10.
    const base = await paymentsService.charge({
      customerId,
      counterpartyType: 'business',
      counterpartyId: businessId,
      amountCents: 10000,
      idempotencyKey: 'sub-pro-base',
    });
    expect(base.platformFeeCents).toBe(1000);

    // Subscribe the business to Pro, then charge again → 7% = $7.
    const proSub = await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(token))
      .set('Idempotency-Key', 'sub-pro-1')
      .send({ plan: 'pro', businessId });
    expect(proSub.status).toBe(201);

    const withPro = await paymentsService.charge({
      customerId,
      counterpartyType: 'business',
      counterpartyId: businessId,
      amountCents: 10000,
      idempotencyKey: 'sub-pro-with',
    });
    expect(withPro.platformFeeCents).toBe(700); // 10% − 3% Pro discount
  });
});

describe('Featured placement boosts Trending (R30)', () => {
  async function liveBusiness(prefix: string, lng: number, lat: number) {
    const { token, businessId } = await businessWithAccount(prefix);
    await request(app).post('/api/v1/agreements/regular_sale/accept').set(...bearer(token)).send({});
    await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng, lat, status: 'parked' });
    return { token, businessId };
  }

  it('a Featured vendor outranks an identical non-featured one', async () => {
    const a = await liveBusiness('sub-feat-a', -122.4, 37.77);
    const b = await liveBusiness('sub-feat-b', -122.4, 37.77);
    await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(a.token))
      .set('Idempotency-Key', 'sub-feat-1')
      .send({ plan: 'featured', businessId: a.businessId });

    const res = await request(app).get('/api/v1/map/trending').query({ lat: 37.77, lng: -122.4, limit: 50 });
    const rows = res.body.data as { businessId: string; featured: boolean; score: number }[];
    const ia = rows.findIndex((r) => r.businessId === a.businessId);
    const ib = rows.findIndex((r) => r.businessId === b.businessId);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ia).toBeLessThan(ib); // featured ranks first
    expect(rows[ia]!.featured).toBe(true);
    expect(rows[ia]!.score).toBeGreaterThan(rows[ib]!.score);
  });
});

/**
 * The recurring half of a subscription's life.
 *
 * `subscribe` records a status and `confirm` settles it after the first payment — and nothing else
 * ever touched the record again. Entitlement is read from `status` alone, so a card that failed the
 * following month left every paid feature running indefinitely, unpaid, with nothing in the system
 * able to notice. These are the assertions that had no code to pass against.
 */
describe('subscription lifecycle after the first payment', () => {
  async function subscribedUser(prefix: string) {
    await seedUser({ authProviderId: `${prefix}|u`, roles: ['seller'] });
    const token = await mintToken(`${prefix}|u`);
    await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(token))
      .set('Idempotency-Key', `${prefix}-1`)
      .send({ plan: 'ai_assistant' });
    const subscriptionId = fakeStripe.lastSubscriptionId()!;
    const mine = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(mine.body.data.aiAssistant).toBe(true); // entitled before anything goes wrong
    return { token, subscriptionId };
  }

  it('revokes the entitlement when the renewal payment fails', async () => {
    const { token, subscriptionId } = await subscribedUser('sub-lapse');

    await stripeEvent('customer.subscription.updated', {
      id: subscriptionId,
      status: 'past_due',
      cancel_at_period_end: false,
    });

    const mine = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(mine.body.data.aiAssistant).toBe(false);
  });

  it('restores the entitlement when the payment recovers', async () => {
    // Dunning succeeding on a retry must give the plan back — a lapse is not a cancellation.
    const { token, subscriptionId } = await subscribedUser('sub-recover');
    await stripeEvent('customer.subscription.updated', { id: subscriptionId, status: 'past_due' });
    expect(
      (await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token))).body.data
        .aiAssistant,
    ).toBe(false);

    await stripeEvent('customer.subscription.updated', { id: subscriptionId, status: 'active' });
    expect(
      (await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token))).body.data
        .aiAssistant,
    ).toBe(true);
  });

  it('ends the entitlement when the subscription is deleted at Stripe', async () => {
    const { token, subscriptionId } = await subscribedUser('sub-deleted');

    await stripeEvent('customer.subscription.deleted', { id: subscriptionId, status: 'canceled' });

    const mine = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(mine.body.data.aiAssistant).toBe(false);
  });

  it('catches a lapse the webhook never delivered', async () => {
    /**
     * The safety net. Stripe stops retrying a failed delivery long before a person would notice, and
     * the failure mode is a cancelled plan that keeps every entitlement — so the sweep has to reach
     * the same answer with no webhook at all.
     */
    const { token, subscriptionId } = await subscribedUser('sub-sweep');
    fakeStripe.setSubscriptionStatus(subscriptionId, 'canceled'); // no event dispatched

    const stillEntitled = await request(app)
      .get('/api/v1/subscriptions/mine')
      .set(...bearer(token));
    expect(stillEntitled.body.data.aiAssistant).toBe(true); // nothing has told us yet

    const result = await subscriptionsService.reconcile();
    expect(result.changed).toBeGreaterThanOrEqual(1);

    const after = await request(app).get('/api/v1/subscriptions/mine').set(...bearer(token));
    expect(after.body.data.aiAssistant).toBe(false);
  });

  it('lets a trialing subscriber cancel', async () => {
    // `trialing` is entitled, but an exact `active` check refused to cancel it — telling the
    // subscriber most likely to want out that they had nothing to cancel.
    await seedUser({ authProviderId: 'sub-trial|u', roles: ['seller'] });
    const token = await mintToken('sub-trial|u');
    fakeStripe.nextSubscriptionStatus = 'trialing';
    await request(app)
      .post('/api/v1/subscriptions')
      .set(...bearer(token))
      .set('Idempotency-Key', 'sub-trial-1')
      .send({ plan: 'ai_assistant' });
    fakeStripe.nextSubscriptionStatus = 'active';

    const cancel = await request(app)
      .post('/api/v1/subscriptions/ai_assistant/cancel')
      .set(...bearer(token))
      .send({});
    expect(cancel.status).toBe(200);
  });

  it('ignores an event for a subscription it has never seen', async () => {
    // Stripe delivers events for objects created in its own dashboard. Throwing would have the
    // event retried forever for something that can never resolve.
    const res = await stripeEvent('customer.subscription.updated', {
      id: 'sub_never_recorded',
      status: 'canceled',
    });
    expect(res.status).toBe(200);
  });
});
