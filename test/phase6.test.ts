import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 6 exit criterion: "explainable, advisory recommendations served from real first-party
 * signals." Drives real consignment sales, then asserts the rule-based engine ranks by them and
 * explains why.
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

async function enablePayouts(ownerType: 'user' | 'business', ownerId: string) {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: ownerType,
    owner_id: ownerId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
}

async function makeHub(prefix: string, categoryId: string) {
  await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'] });
  const hubToken = await mintToken(`${prefix}|hub`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(hubToken))
    .send({ name: `${prefix} Hub`, categoryId, isHub: true });
  const businessId = biz.body.data.id as string;
  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(hubToken));
  await enablePayouts('business', businessId);
  const hub = await request(app)
    .post('/api/v1/hubs')
    .set(...bearer(hubToken))
    .send({ businessId });
  // These tests need real sales data to feed the AI signals. Since Phase 3 trust is earned, a new
  // seller (40) sits below the default 85 auto-approve floor, so checkouts would sit pending and
  // never produce sales. Auto-approve here keeps the focus on recommendations.
  await request(app)
    .patch(`/api/v1/hubs/${hub.body.data.id}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });
  return {
    hubToken,
    hubId: hub.body.data.id as string,
    qrToken: hub.body.data.token as string,
  };
}

async function addProduct(
  hubToken: string,
  hubId: string,
  opts: { name: string; categoryId: string; unit: number; qty: number },
) {
  const p = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: opts.name,
      categoryId: opts.categoryId,
      unitValueCents: opts.unit,
      consignmentSplitPercent: 70,
      returnWindowHours: 72,
      quantityAvailable: opts.qty,
    });
  return p.body.data.id as string;
}

async function makeSeller(prefix: string) {
  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    // Gold: Phase 3 caps Bronze at $200 of held stock, and these fixtures deliberately check out
    // large quantities to generate sell-through signal.
    tier: 'gold',
  });
  const token = await mintToken(`${prefix}|seller`);
  await request(app)
    .post('/api/v1/payments/connect/onboard')
    .set(...bearer(token));
  await enablePayouts('user', sellerId);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return { sellerId, token };
}

/** Check out a product, sell `soldQty`, then return the rest → generates real sales data. */
async function sellSome(
  token: string,
  productId: string,
  qrToken: string,
  checkoutQty: number,
  soldQty: number,
) {
  const checkout = await request(app)
    .post('/api/v1/checkouts')
    .set(...bearer(token))
    .send({
      productId,
      quantity: checkoutQty,
      conditionPhotoUrl: 'https://cdn.test/c.jpg',
      qrToken,
    });
  const checkoutId = checkout.body.data.id as string;
  if (soldQty > 0) {
    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(token))
      .send({ quantitySold: soldQty, saleAmountCents: soldQty * 900 });
  }
  await request(app)
    .post(`/api/v1/checkouts/${checkoutId}/return`)
    .set(...bearer(token))
    .send({ quantityReturned: checkoutQty - soldQty });
}

describe('AI product recommendations (Phase 6 exit): explainable, from real signals', () => {
  it('ranks a high-sell-through product first with a reason summary', async () => {
    const created = await CategoryModel.create({
      slug: 'p6-food',
      name: 'Food',
      top_level_tab: 'food',
      requires_license: false,
    });
    const catFood = String(created._id);
    const { hubToken, hubId, qrToken } = await makeHub('p6r', catFood);
    const hot = await addProduct(hubToken, hubId, {
      name: 'Hot Seller',
      categoryId: String(catFood),
      unit: 1000,
      qty: 50,
    });
    const cold = await addProduct(hubToken, hubId, {
      name: 'Cold Item',
      categoryId: String(catFood),
      unit: 1000,
      qty: 50,
    });

    const { token: sellerToken } = await makeSeller('p6r');
    // Real first-party signal: the "hot" product actually sells more.
    await sellSome(sellerToken, hot, qrToken, 10, 8);
    await sellSome(sellerToken, cold, qrToken, 10, 1);

    // Recommend for a fresh seller (hour 12 UTC → food time band boosts food).
    const { token: newSeller } = await makeSeller('p6r-buyer');
    const res = await request(app)
      .get('/api/v1/ai/recommendations/products')
      .query({ hourUtc: 12, limit: 5 })
      .set(...bearer(newSeller));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);

    // The higher-sell-through product ranks first, and every rec explains itself.
    expect(res.body.data[0].productId).toBe(hot);
    expect(res.body.data[0].reasonSummary).toContain('sell-through');
    expect(res.body.data[0].reasonSummary.toLowerCase()).toContain('time of day');
    expect(res.body.data[0].recommendationId).toBeTruthy();

    // Accepting a recommendation records the first-party signal.
    const accept = await request(app)
      .post(`/api/v1/ai/recommendations/${res.body.data[0].recommendationId}/accept`)
      .set(...bearer(newSeller));
    expect(accept.status).toBe(200);
    expect(accept.body.data.accepted).toBe(true);
  });

  it('recommends busy locations (hubs) by recent revenue with a reason', async () => {
    const cat = String(
      (
        await CategoryModel.create({
          slug: 'p6-loc',
          name: 'Shop',
          top_level_tab: 'shopping',
          requires_license: false,
        })
      )._id,
    );
    const { hubToken, hubId, qrToken } = await makeHub('p6l', cat);
    const prod = await addProduct(hubToken, hubId, {
      name: 'Widget',
      categoryId: cat,
      unit: 1000,
      qty: 50,
    });
    const { token: sellerToken } = await makeSeller('p6l');
    await sellSome(sellerToken, prod, qrToken, 12, 10);

    const { token: newSeller } = await makeSeller('p6l-buyer');
    const res = await request(app)
      .get('/api/v1/ai/recommendations/locations')
      .set(...bearer(newSeller));
    expect(res.status).toBe(200);
    const found = res.body.data.find((r: { hubId: string }) => r.hubId === hubId);
    expect(found).toBeTruthy();
    expect(found.reasonSummary).toContain('busy this week');
  });
});

describe('AI pricing suggestion (advisory)', () => {
  it('suggests a price from comparable recent sales and flags advisory-only', async () => {
    const cat = String(
      (
        await CategoryModel.create({
          slug: 'p6-price',
          name: 'Crafts',
          top_level_tab: 'shopping',
          requires_license: false,
        })
      )._id,
    );
    const { hubToken, hubId, qrToken } = await makeHub('p6p', cat);
    const a = await addProduct(hubToken, hubId, {
      name: 'Mug A',
      categoryId: cat,
      unit: 1000,
      qty: 20,
    });
    const target = await addProduct(hubToken, hubId, {
      name: 'Mug B',
      categoryId: cat,
      unit: 1000,
      qty: 20,
    });
    const { token: sellerToken } = await makeSeller('p6p');
    await sellSome(sellerToken, a, qrToken, 10, 5); // sales at 900c/unit generate comparables

    const { token: hubOwner } = { token: hubToken };
    const res = await request(app)
      .get('/api/v1/ai/pricing-suggestion')
      .query({ productId: target })
      .set(...bearer(hubOwner));
    expect(res.status).toBe(200);
    expect(res.body.data.advisoryOnly).toBe(true);
    expect(res.body.data.sampleSize).toBeGreaterThanOrEqual(1);
    expect(res.body.data.suggestedPriceCents).toBe(900);
  });
});

describe('AI sales coaching', () => {
  it('returns scripted responses from the content library for an objection', async () => {
    await seedUser({ authProviderId: 'p6c|seller', roles: ['seller'] });
    const token = await mintToken('p6c|seller');
    const res = await request(app)
      .post('/api/v1/ai/sales-coaching')
      .set(...bearer(token))
      .send({ objection: 'price' });
    expect(res.status).toBe(200);
    expect(res.body.data.objection).toBe('price');
    expect(res.body.data.source).toBe('content_library');
    expect(res.body.data.scripts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AI hub dashboard', () => {
  it('shows per-product sell-through + reallocation suggestions for the hub owner', async () => {
    const cat = String(
      (
        await CategoryModel.create({
          slug: 'p6-dash',
          name: 'Goods',
          top_level_tab: 'shopping',
          requires_license: false,
        })
      )._id,
    );
    const { hubToken, hubId, qrToken } = await makeHub('p6d', cat);
    const fast = await addProduct(hubToken, hubId, {
      name: 'Fast',
      categoryId: cat,
      unit: 1000,
      qty: 3,
    });
    await addProduct(hubToken, hubId, { name: 'Slow', categoryId: cat, unit: 1000, qty: 20 });
    const { token: sellerToken } = await makeSeller('p6d');
    await sellSome(sellerToken, fast, qrToken, 3, 3);

    const res = await request(app)
      .get(`/api/v1/ai/hubs/${hubId}/dashboard`)
      .set(...bearer(hubToken));
    expect(res.status).toBe(200);
    expect(res.body.data.advisoryOnly).toBe(true);
    const fastRow = res.body.data.products.find((p: { name: string }) => p.name === 'Fast');
    expect(fastRow.recentUnits).toBe(3);
    expect(fastRow.suggestion).toContain('Restock');

    // A non-owner cannot read the hub dashboard.
    await seedUser({ authProviderId: 'p6d|other', roles: ['hub'] });
    const other = await mintToken('p6d|other');
    const denied = await request(app)
      .get(`/api/v1/ai/hubs/${hubId}/dashboard`)
      .set(...bearer(other));
    expect(denied.status).toBe(403);
  });
});
