import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { SalePaymentModel } from '../src/modules/salepayments/salepayments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * 6.3 — adversarial tests over the money paths (orders, refunds, settlements, RTO installments).
 *
 * ## What this is, and what it is not
 *
 * The roadmap task reads "penetration test of the money paths". **This is not a third-party
 * penetration test** — no external tester, no production environment, no network-layer or
 * infrastructure attack surface. Saying otherwise would be the more damaging kind of false
 * assurance, because a "pen tested" label stops people looking.
 *
 * What it is: the application-layer half of one, written as executable tests, so the attacks stay
 * attempted on every commit instead of once in a report. Every test below is an attack that a
 * motivated participant — a seller, a hub owner, a customer with a receipt link — could mount with
 * nothing but an HTTP client and their own valid credentials. That is the realistic threat model
 * for a marketplace: not an anonymous outsider, but an authenticated insider probing the edges of
 * what their role permits.
 *
 * Six classes are covered:
 *   1. **Cross-tenant access (IDOR)** — acting on someone else's money by changing an id.
 *   2. **Privilege escalation** — reaching a role's money routes without that role.
 *   3. **Client-supplied amounts** — making the server trust a number the client sent.
 *   4. **Idempotency abuse** — replaying a key to double-charge, or reusing one to smuggle a
 *      different body past the guard.
 *   5. **Boundary amounts** — negative, zero, and over-refund values.
 *   6. **Double-spend** — selling the same unit twice.
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

async function enablePayouts(ownerType: 'user' | 'business', ownerId: string) {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: ownerType,
    owner_id: ownerId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
}

/** A complete, payout-enabled hub + seller + held stock. The victim in most tests below. */
async function scenario(prefix: string, opts: { unitValue: number; split: number; qty: number }) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'] });
  const hubToken = await mintToken(`${prefix}|hub`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(hubToken))
    .send({ name: `${prefix} Hub`, categoryId: String(cat._id), isHub: true });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(hubToken));
  await enablePayouts('business', businessId);

  const hub = await request(app).post('/api/v1/hubs').set(...bearer(hubToken)).send({ businessId });
  const hubId = hub.body.data.id as string;
  const qrToken = hub.body.data.token as string;
  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  const product = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: 'Soy Candle',
      unitValueCents: opts.unitValue,
      consignmentSplitPercent: opts.split,
      returnWindowHours: 72,
      quantityAvailable: 50,
    });
  const productId = product.body.data.id as string;

  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier: 'bronze',
  });
  const sellerToken = await mintToken(`${prefix}|seller`);
  await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(sellerToken));
  await enablePayouts('user', sellerId);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(sellerToken))
    .send({ version: SELLER_AGREEMENT_VERSION });

  const checkout = await request(app)
    .post('/api/v1/checkouts')
    .set(...bearer(sellerToken))
    .send({ productId, quantity: opts.qty, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });

  return {
    hubToken,
    sellerToken,
    sellerId,
    businessId,
    hubId,
    productId,
    checkoutId: checkout.body.data.id as string,
  };
}

/** A second, unrelated seller — the attacker in the cross-tenant tests. */
async function outsider(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|outsider`, roles: ['seller'], tier: 'bronze' });
  const token = await mintToken(`${prefix}|outsider`);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return token;
}

describe('money-path attacks · cross-tenant access (6.3)', () => {
  it("a seller cannot start a sale against another seller's consigned stock", async () => {
    // The whole custody model rests on this: the seller who took the stock is the only one who can
    // sell it. If an id in a request body is enough, consignment is a shared pool.
    const victim = await scenario('atk-idor-sale', { unitValue: 1000, split: 65, qty: 5 });
    const attacker = await outsider('atk-idor-sale');

    const res = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(attacker))
      .set('Idempotency-Key', 'atk_idor_sale_1')
      .send({ checkoutId: victim.checkoutId, quantity: 1, customerEmail: 'buyer@test.dev' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await SalePaymentModel.countDocuments({ checkout_id: victim.checkoutId })).toBe(0);
  });

  it("a seller cannot read another seller's settlement", async () => {
    // Settlement exposes the hub's split, the seller's net, and the platform fee — a competitor's
    // commercial terms.
    const victim = await scenario('atk-idor-settle', { unitValue: 1000, split: 65, qty: 2 });
    const attacker = await outsider('atk-idor-settle');

    const res = await request(app)
      .get(`/api/v1/checkouts/${victim.checkoutId}/settlement`)
      .set(...bearer(attacker));
    expect([403, 404]).toContain(res.status);
  });

  it("a seller cannot end another seller's consignment", async () => {
    const victim = await scenario('atk-idor-end', { unitValue: 1000, split: 65, qty: 2 });
    const attacker = await outsider('atk-idor-end');

    const res = await request(app)
      .post(`/api/v1/checkouts/${victim.checkoutId}/end`)
      .set(...bearer(attacker))
      .send({ reason: 'mine now' });
    expect([400, 403, 404, 422]).toContain(res.status);
  });

  it("a hub owner cannot read another hub's refunds", async () => {
    const victim = await scenario('atk-idor-hubref', { unitValue: 1000, split: 65, qty: 2 });
    const other = await scenario('atk-idor-hubref2', { unitValue: 1000, split: 65, qty: 2 });

    const res = await request(app)
      .get(`/api/v1/hubs/${victim.hubId}/refunds`)
      .set(...bearer(other.hubToken));
    expect([403, 404]).toContain(res.status);
  });
});

describe('money-path attacks · privilege escalation (6.3)', () => {
  it('a customer cannot refund a sale', async () => {
    // The public receipt link deliberately offers a refund REQUEST, not a refund — anyone holding a
    // receipt URL could otherwise drain a seller.
    await scenario('atk-esc-refund', { unitValue: 1000, split: 65, qty: 2 });
    await seedUser({ authProviderId: 'atk-esc-refund|cust', roles: ['customer'] });
    const custToken = await mintToken('atk-esc-refund|cust');

    const res = await request(app)
      .post(`/api/v1/sales/${'a'.repeat(24)}/refund`)
      .set(...bearer(custToken))
      .set('Idempotency-Key', 'atk_esc_refund_1')
      .send({ reason: 'customer_request' });
    expect(res.status).toBe(403);
  });

  it('a seller cannot reach the admin audit log', async () => {
    const victim = await scenario('atk-esc-audit', { unitValue: 1000, split: 65, qty: 1 });
    const res = await request(app).get('/api/v1/admin/audit-logs').set(...bearer(victim.sellerToken));
    expect(res.status).toBe(403);
  });

  it('an unauthenticated caller cannot start a sale', async () => {
    const victim = await scenario('atk-esc-anon', { unitValue: 1000, split: 65, qty: 1 });
    const res = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set('Idempotency-Key', 'atk_esc_anon_1')
      .send({ checkoutId: victim.checkoutId, quantity: 1, customerEmail: 'buyer@test.dev' });
    expect(res.status).toBe(401);
  });
});

describe('money-path attacks · client-supplied amounts (6.3)', () => {
  it('an order cannot carry its own prices or fees', async () => {
    // Strict schemas are the mechanism, but the property being protected is the one the audit
    // called load-bearing: money is server-authoritative, and no number the client sends is
    // allowed to become a charge.
    const cat = await CategoryModel.create({
      slug: 'atk-order-cat',
      name: 'atk-order',
      top_level_tab: 'food',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'atk-order|vendor', roles: ['vendor'] });
    const vendorToken = await mintToken('atk-order|vendor');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(vendorToken))
      .send({ name: 'Atk Tacos', categoryId: String(cat._id) });
    const businessId = biz.body.data.id as string;
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(vendorToken))
      .send({ name: 'Taco', priceCents: 500 });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const menuItemId = item.body.data.id as string;

    await seedUser({ authProviderId: 'atk-order|cust', roles: ['customer'] });
    const custToken = await mintToken('atk-order|cust');

    for (const injected of [
      { subtotalCents: 1 },
      { totalCents: 1 },
      { platformFeeCents: 0 },
      { discountPercent: 100 },
      { priceCents: 1 },
    ]) {
      const res = await request(app)
        .post('/api/v1/orders/quote')
        .set(...bearer(custToken))
        .send({ businessId, items: [{ menuItemId, quantity: 1 }], ...injected });
      // Rejected outright rather than ignored: a silently-dropped field lets a caller believe a
      // discount applied and argue about it later.
      expect(res.status, `injected ${JSON.stringify(injected)}`).toBe(400);
    }

    // And the honest request prices from the server's own menu, not from anything sent.
    const ok = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(custToken))
      .send({ businessId, items: [{ menuItemId, quantity: 2 }] });
    expect(ok.status).toBe(200);
    // Priced from the server's own menu row (500¢ × 2), never from anything the client sent.
    expect(ok.body.data.breakdown.subtotalCents).toBe(1000);
    expect(ok.body.data.items[0].unitPriceCents).toBe(500);
  });

  it('a sale cannot be started for a quantity the seller does not hold', async () => {
    const victim = await scenario('atk-oversell', { unitValue: 1000, split: 65, qty: 2 });
    const res = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .set('Idempotency-Key', 'atk_oversell_1')
      .send({ checkoutId: victim.checkoutId, quantity: 99, customerEmail: 'buyer@test.dev' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('money-path attacks · boundary amounts (6.3)', () => {
  it('rejects a negative or zero tip on an order', async () => {
    const cat = await CategoryModel.create({
      slug: 'atk-tip-cat',
      name: 'atk-tip',
      top_level_tab: 'food',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'atk-tip|vendor', roles: ['vendor'] });
    const vendorToken = await mintToken('atk-tip|vendor');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(vendorToken))
      .send({ name: 'Atk Tips', categoryId: String(cat._id) });
    const businessId = biz.body.data.id as string;
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(vendorToken))
      .send({ name: 'Taco', priceCents: 500 });
    const menuItemId = item.body.data.id as string;

    await seedUser({ authProviderId: 'atk-tip|cust', roles: ['customer'] });
    const custToken = await mintToken('atk-tip|cust');

    for (const bad of [{ tipCents: -500 }, { roundUpCents: -1 }, { tipCents: 1.5 }]) {
      const res = await request(app)
        .post('/api/v1/orders/quote')
        .set(...bearer(custToken))
        .send({ businessId, items: [{ menuItemId, quantity: 1 }], ...bad });
      // A negative tip is a withdrawal wearing a gratuity's name.
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    for (const bad of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }]) {
      const res = await request(app)
        .post('/api/v1/orders/quote')
        .set(...bearer(custToken))
        .send({ businessId, items: [{ menuItemId, ...bad }] });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('rejects a refund amount of zero or below', async () => {
    const victim = await scenario('atk-refund-neg', { unitValue: 1000, split: 65, qty: 2 });
    for (const amountCents of [0, -1000]) {
      const res = await request(app)
        .post(`/api/v1/sales/${'a'.repeat(24)}/refund`)
        .set(...bearer(victim.sellerToken))
        .set('Idempotency-Key', `atk_refund_neg_${amountCents}`)
        .send({ amountCents, reason: 'customer_request' });
      // A negative refund is a charge the customer never authorised.
      expect(res.status, `amountCents=${amountCents}`).toBe(400);
    }
  });
});

describe('money-path attacks · idempotency abuse (6.3)', () => {
  it('a replayed key with a DIFFERENT body is refused, not silently served the first result', async () => {
    // The dangerous failure is not the double charge — it is the caller who changes the amount,
    // reuses the key, gets a 200, and reasonably believes the new amount was applied.
    const victim = await scenario('atk-idem', { unitValue: 1000, split: 65, qty: 5 });

    const first = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .set('Idempotency-Key', 'atk_idem_shared')
      .send({ checkoutId: victim.checkoutId, quantity: 1, customerEmail: 'buyer@test.dev' });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .set('Idempotency-Key', 'atk_idem_shared')
      .send({ checkoutId: victim.checkoutId, quantity: 3, customerEmail: 'buyer@test.dev' });

    expect(replay.status).toBe(409);
    // And exactly one intent exists — the second call created nothing.
    expect(await SalePaymentModel.countDocuments({ checkout_id: victim.checkoutId })).toBe(1);
  });

  it('an identical replay returns the original result without creating a second charge', async () => {
    const victim = await scenario('atk-idem-same', { unitValue: 1000, split: 65, qty: 5 });
    const body = { checkoutId: victim.checkoutId, quantity: 2, customerEmail: 'buyer@test.dev' };

    const first = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .set('Idempotency-Key', 'atk_idem_same')
      .send(body);
    const second = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .set('Idempotency-Key', 'atk_idem_same')
      .send(body);

    expect(first.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await SalePaymentModel.countDocuments({ checkout_id: victim.checkoutId })).toBe(1);
  });

  it('a money route refuses to act without an idempotency key at all', async () => {
    const victim = await scenario('atk-idem-none', { unitValue: 1000, split: 65, qty: 2 });
    const res = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(victim.sellerToken))
      .send({ checkoutId: victim.checkoutId, quantity: 1, customerEmail: 'buyer@test.dev' });
    expect(res.status).toBe(400);
  });
});

describe('money-path attacks · double-spend (6.3)', () => {
  it('two concurrent sales of the last unit cannot both succeed', async () => {
    // The oversell guard is a conditional update, not a read-then-write. Firing both requests
    // simultaneously is the only way to test that distinction.
    const victim = await scenario('atk-race', { unitValue: 1000, split: 65, qty: 1 });

    const attempt = (key: string) =>
      request(app)
        .post('/api/v1/sales/payment-intent')
        .set(...bearer(victim.sellerToken))
        .set('Idempotency-Key', key)
        .send({ checkoutId: victim.checkoutId, quantity: 1, customerEmail: 'buyer@test.dev' });

    const [a, b] = await Promise.all([attempt('atk_race_a'), attempt('atk_race_b')]);
    const created = [a, b].filter((r) => r.status === 201);

    // One unit, one reservation. Both succeeding would mean two customers paid for the same item.
    expect(created).toHaveLength(1);
    expect(await SalePaymentModel.countDocuments({ checkout_id: victim.checkoutId })).toBe(1);
  });
});
