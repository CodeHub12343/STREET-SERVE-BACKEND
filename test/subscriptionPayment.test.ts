import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { SubscriptionModel } from '../src/modules/subscriptions/subscriptions.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Upgrading to a paid plan — the part where money actually changes hands.
 *
 * Two defects lived here and both were invisible to the suite, because the fake gateway reported
 * every new subscription as `active` while the real one behaved quite differently:
 *
 *  1. **The Stripe call was malformed.** Subscription items were sent with `price_data.product_data`,
 *     which only exists on Checkout Sessions and invoice items. Stripe rejected every upgrade with
 *     `parameter_unknown`, so the feature had never once worked against a real key. A TypeScript
 *     cast (`as unknown as`) was suppressing the compiler's correct objection.
 *  2. **Entitlement was granted without payment.** The record was written `status: 'active'`
 *     unconditionally, ignoring what Stripe returned. Once (1) was fixed the subscription would come
 *     back `incomplete` — no card charged — and the subscriber would still get the paid plan free.
 *
 * The second is the dangerous one, so it is pinned first and hardest.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => setStripeGateway(fakeStripe));

async function vendorWithBusiness(prefix: string) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|owner`, roles: ['vendor'], tier: 'gold' });
  const token = await mintToken(`${prefix}|owner`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Co`, categoryId: String(cat._id) });
  return { token, businessId: biz.body.data.id as string };
}

const subscribe = (token: string, plan: string, businessId?: string) =>
  request(app)
    .post('/api/v1/subscriptions')
    .set(...bearer(token))
    .set('idempotency-key', `idem_${plan}_${Math.random()}`)
    .send({ plan, ...(businessId ? { businessId } : {}) });

const entitlements = (token: string, businessId: string) =>
  request(app)
    .get('/api/v1/subscriptions/mine')
    .query({ businessId })
    .set(...bearer(token));

describe('a plan is only entitled once it is actually paid for', () => {
  it('withholds the entitlement while the first invoice is unpaid', async () => {
    const { token, businessId } = await vendorWithBusiness('unpaid');
    // Exactly what real Stripe returns for a customer with no card on file.
    fakeStripe.nextSubscriptionStatus = 'incomplete';

    const res = await subscribe(token, 'pro', businessId);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('incomplete');
    // The client is handed something to pay with rather than a false success.
    expect(res.body.data.clientSecret).toBeTruthy();

    const ent = await entitlements(token, businessId);
    expect(ent.body.data.pro, 'an unpaid subscription must not unlock Pro').toBe(false);

    // And it must not be back-dated as though it had been running.
    const row = await SubscriptionModel.findOne({ subscriber_id: businessId, plan: 'pro' }).lean();
    expect(row!.activated_at).toBeNull();

    fakeStripe.nextSubscriptionStatus = 'active';
  });

  it('grants the entitlement once payment is confirmed', async () => {
    const { token, businessId } = await vendorWithBusiness('confirmed');
    fakeStripe.nextSubscriptionStatus = 'incomplete';
    await subscribe(token, 'pro', businessId);

    const before = await entitlements(token, businessId);
    expect(before.body.data.pro).toBe(false);

    const confirmed = await request(app)
      .post('/api/v1/subscriptions/pro/confirm')
      .set(...bearer(token))
      .send({ businessId });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('active');

    const after = await entitlements(token, businessId);
    expect(after.body.data.pro, 'a paid subscription must unlock Pro').toBe(true);

    const row = await SubscriptionModel.findOne({ subscriber_id: businessId, plan: 'pro' }).lean();
    expect(row!.activated_at).toBeInstanceOf(Date);

    fakeStripe.nextSubscriptionStatus = 'active';
  });

  it('confirm reads Stripe rather than trusting the caller', async () => {
    // The subscription never leaves `incomplete` at the gateway, so no amount of confirming helps.
    const { token, businessId } = await vendorWithBusiness('stuck');
    fakeStripe.nextSubscriptionStatus = 'incomplete';
    await subscribe(token, 'pro', businessId);

    // Freeze it unpaid: getSubscription only advances a subscription it can find.
    fakeStripe.subscriptions.length = 0;

    const confirmed = await request(app)
      .post('/api/v1/subscriptions/pro/confirm')
      .set(...bearer(token))
      .send({ businessId });
    expect(confirmed.body.data.status).toBe('incomplete');

    const ent = await entitlements(token, businessId);
    expect(ent.body.data.pro).toBe(false);

    fakeStripe.nextSubscriptionStatus = 'active';
  });
});

describe('the subscribe call itself', () => {
  it('names the plan so the gateway can hang a price off a real product', async () => {
    // Regression for the malformed call: the service must pass the plan's display name through,
    // because the gateway needs it to create/reuse the Stripe Product that `price_data.product`
    // points at. Sending an inline `product_data` instead is what Stripe rejected outright.
    const { token, businessId } = await vendorWithBusiness('named');
    fakeStripe.subscriptionInputs.length = 0;

    await subscribe(token, 'pro', businessId);

    const sent = fakeStripe.subscriptionInputs.at(-1)!;
    expect(sent.plan).toBe('pro');
    expect(sent.planName, 'the gateway needs a product name to hang the price off').toBeTruthy();
  });

  it('is idempotent for a plan that is already live', async () => {
    const { token, businessId } = await vendorWithBusiness('repeat');
    const first = await subscribe(token, 'pro', businessId);
    expect(first.body.data.status).toBe('active');

    const second = await subscribe(token, 'pro', businessId);
    // Nothing further to pay, and no second subscription created at the gateway.
    expect(second.body.data.clientSecret).toBeNull();

    const rows = await SubscriptionModel.countDocuments({ subscriber_id: businessId, plan: 'pro' });
    expect(rows).toBe(1);
  });
});
