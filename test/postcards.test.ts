import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  POSTCARD_MARGIN_BASIS,
  POSTCARD_PRODUCTS,
  POSTCARD_QUOTE_TTL_MINUTES,
} from '../src/config/constants';
import {
  createFakePrintVendor,
  resetPrintVendor,
  setPrintVendor,
  POSTCARD_SIZE_KEYS,
} from '../src/integrations/print';
import { POSTCARD_ORDER_STATUSES, PostcardOrderModel } from '../src/modules/postcards/postcards.model';
import { priceOrder, isQuoteExpired } from '../src/modules/postcards/postcards.pricing';
import { FULFILMENT_PIPELINE } from '../src/modules/fulfilment/fulfilment';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { PostcardPilotParticipantModel } from '../src/modules/postcards/pilot.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Phase 3 — Postcard Marketing: building and pricing an order (ADR-007).
 *
 * No money moves in this phase, so these tests are about the two things that decide whether the
 * money phase can be trusted later:
 *
 *  • **the vendor is authoritative** — counts and rates come from them, never from our arithmetic,
 *    because a number we derived would disagree with their invoice after the buyer saw ours (F-9);
 *  • **a quote is a snapshot that expires**, and anything that changes what is being bought throws
 *    the price away rather than carrying it onto a different order (F-8).
 *
 * Plus the boring, load-bearing one: an order belongs to a business, and nobody else can read or
 * touch it.
 */
const app = createApp();

beforeAll(() => setPrintVendor(createFakePrintVendor()));
afterEach(() => {
  resetPrintVendor();
  setPrintVendor(createFakePrintVendor());
});

async function vendorAccount(prefix: string) {
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

  /**
   * Phase 8: postcard ordering is behind an ops-managed pilot allowlist (default-deny). Tests enrol
   * their business explicitly rather than the gate being bypassed under test — a gate that is off in
   * the only place it is exercised is not a gate.
   */
  await PostcardPilotParticipantModel.create({
    business_id: biz.body.data.id as string,
    added_by: 'test',
  });

  return { token, businessId: biz.body.data.id as string };
}

async function makeAudience(token: string, businessId: string, keys = ['95350']) {
  const res = await request(app)
    .post(`/api/v1/postcards/business/${businessId}/audiences`)
    .set(...bearer(token))
    .send({ type: 'zip', listType: 'IRL', keys });
  return res;
}

async function makeOrder(token: string, businessId: string, sku = '68') {
  const res = await request(app)
    .post(`/api/v1/postcards/business/${businessId}/orders`)
    .set(...bearer(token))
    .send({ sku, mailClass: 'standard' });
  return res;
}

/** draft → audience → quoted, the whole happy path in one helper. */
async function quotedOrder(prefix: string) {
  const v = await vendorAccount(prefix);
  const audience = await makeAudience(v.token, v.businessId);
  const order = await makeOrder(v.token, v.businessId);
  const orderId = order.body.data.id as string;
  await request(app)
    .patch(`/api/v1/postcards/orders/${orderId}`)
    .set(...bearer(v.token))
    .send({ audienceId: audience.body.data.id });
  const quoted = await request(app)
    .post(`/api/v1/postcards/orders/${orderId}/quote`)
    .set(...bearer(v.token))
    .send({});
  return { ...v, orderId, audience: audience.body.data, quoted };
}

// ─── the pilot gate (Phase 8) ───────────────────────────────────────────────────────────────
describe('the pilot gate, through the real route', () => {
  it('refuses a business nobody put in the pilot', async () => {
    /**
     * The other tests in this file enrol their business in `vendorAccount`, which means none of them
     * would notice if the gate stopped working. This one deliberately does NOT enrol, so the
     * default-deny is exercised end to end rather than only at the service.
     */
    const prefix = 'pc-nopilot';
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

    const res = await request(app)
      .post(`/api/v1/postcards/business/${biz.body.data.id}/orders`)
      .set(...bearer(token))
      .send({ sku: '68', mailClass: 'standard' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/limited pilot/i);
  });
});

// ─── the product registry ───────────────────────────────────────────────────────────────────
describe('the catalogue (PC-3)', () => {
  it('lists the products a business can order', async () => {
    const res = await request(app).get('/api/v1/postcards/products');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('only offers sizes the vendor actually sells', () => {
    /**
     * The registry is configuration rather than a mirror of the vendor's catalogue, so this is the
     * check that keeps the two honest. A SKU we invented would be an order their API rejects, after
     * the buyer had already been quoted and charged.
     */
    for (const p of POSTCARD_PRODUCTS) {
      expect(POSTCARD_SIZE_KEYS, `unknown vendor size ${p.sku}`).toContain(p.sku);
    }
  });

  it('records that one DESIGNED side still means two printed sides', () => {
    // The vendor requires both `front` and `back` on every order — a mailed postcard must carry an
    // address side. "One side" was always about what the buyer designs.
    for (const p of POSTCARD_PRODUCTS) expect(p.designedSides).toBe(1);
  });

  it('does not offer Standard mail on the size the vendor restricts to First Class', () => {
    // A vendor constraint, not a preference: offering it would produce orders they reject.
    const small = POSTCARD_PRODUCTS.find((p) => p.sku === '46');
    expect(small?.mailClasses).toEqual(['first_class']);
  });
});

// ─── audiences ──────────────────────────────────────────────────────────────────────────────
describe('audiences: the vendor counts, and keeps the addresses (PC-4/5/7)', () => {
  it('resolves a ZIP to a counted audience with no recipient data in it', async () => {
    const v = await vendorAccount('pc-aud');
    const res = await makeAudience(v.token, v.businessId, ['95350', '95351']);

    expect(res.status).toBe(201);
    expect(res.body.data.recordCount).toBe(2_000);
    expect(res.body.data.containsRecipientData).toBe(false);
    /**
     * ADR-007 §6 — the privacy property, asserted on the wire rather than trusted. The vendor's API
     * also accepts an explicit recipients array; if anyone ever switches to it, this fails.
     */
    expect(JSON.stringify(res.body.data)).not.toMatch(/address|firstName|lastName/i);
  });

  it('accepts carrier routes and a radius', async () => {
    const v = await vendorAccount('pc-aud2');
    const route = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/audiences`)
      .set(...bearer(v.token))
      .send({ type: 'carrier_route', listType: 'IRL', keys: ['95350:C002'] });
    expect(route.status).toBe(201);

    const radius = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/audiences`)
      .set(...bearer(v.token))
      .send({
        type: 'radius',
        listType: 'IRL',
        radius: { miles: 3, address: '1 Main St', city: 'Modesto', state: 'CA', zip: '95350' },
      });
    expect(radius.status).toBe(201);
  });

  it('rejects a malformed area before spending a vendor call on it', async () => {
    const v = await vendorAccount('pc-aud3');
    for (const body of [
      { type: 'zip', listType: 'IRL', keys: ['9535'] }, // four digits
      { type: 'carrier_route', listType: 'IRL', keys: ['95350'] }, // missing route
      { type: 'zip', listType: 'IRL', keys: [] }, // nothing chosen
      { type: 'radius', listType: 'IRL' }, // no centre
    ]) {
      const res = await request(app)
        .post(`/api/v1/postcards/business/${v.businessId}/audiences`)
        .set(...bearer(v.token))
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

// ─── pricing ────────────────────────────────────────────────────────────────────────────────
describe('pricing: margin, and the arithmetic that has to add up (PC-9)', () => {
  it('applies the margin on the retail basis, matching the brief’s worked example', () => {
    // "if a postcard order costs $500 … 10% = $50 profit" — $450 wholesale becomes a $500 order.
    expect(POSTCARD_MARGIN_BASIS).toBe('retail');
    const price = priceOrder({ quantity: 450, vendorUnitCostCents: 100, marginBps: 1_000 });
    expect(price.vendorCostCents).toBe(45_000);
    expect(price.totalCents).toBe(50_000);
    expect(price.marginCents).toBe(5_000);
  });

  it('always has the three numbers add up, whatever the rounding', () => {
    // Margin is derived by subtraction precisely so a stray cent cannot go missing on the invoice.
    for (const quantity of [1, 7, 333, 1_001, 49_999]) {
      for (const unit of [1, 37, 103, 1_546]) {
        const p = priceOrder({ quantity, vendorUnitCostCents: unit, marginBps: 1_000 });
        expect(p.vendorCostCents + p.marginCents).toBe(p.totalCents);
        expect(Number.isInteger(p.totalCents)).toBe(true);
      }
    }
  });

  it('refuses a rate that would make the retail basis nonsensical', () => {
    // At 100% the gross-up divides by zero; above it the price goes negative.
    expect(() => priceOrder({ quantity: 10, vendorUnitCostCents: 100, marginBps: 10_000 })).toThrow();
    expect(() => priceOrder({ quantity: 10, vendorUnitCostCents: 0, marginBps: 1_000 })).toThrow();
  });

  it('treats a missing expiry as expired, not as valid forever', () => {
    // Failing closed on money. A quote with no stated life is one nobody promised to honour.
    expect(isQuoteExpired(null)).toBe(true);
    expect(isQuoteExpired(undefined)).toBe(true);
    expect(isQuoteExpired(new Date(Date.now() + 60_000))).toBe(false);
  });
});

// ─── the order lifecycle ────────────────────────────────────────────────────────────────────
describe('building and quoting an order (PC-8/PC-10)', () => {
  it('declares only the statuses the service can actually write', () => {
    /**
     * `enumReachability.test.ts` forbids a schema that promises states the code cannot reach — the
     * F-3 defect, caught as a test. The boundary moves as phases land, and moving it deliberately
     * is the point: Phase 5 added the money states, Phase 6 the submission ones.
     */
    expect(POSTCARD_ORDER_STATUSES).toEqual([
      'draft',
      'quoted',
      'paid',
      'payment_failed',
      'submitted',
      'submission_failed',
      'refunded',
      'cancelled',
    ]);

    /**
     * `printing` and `mailed` are still absent, and permanently so — they are not order statuses.
     *
     * The order's lifecycle WITH US ends at `submitted`; the physical run then keeps moving inside
     * the vendor's factory, tracked separately on `fulfilment_stage`. Folding the two together
     * would make every new print stage a new order status, and would leave `refunded` and `mailed`
     * competing to describe the same row.
     */
    for (const notAnOrderStatus of ['printing', 'mailed']) {
      expect(POSTCARD_ORDER_STATUSES).not.toContain(notAnOrderStatus);
    }
    expect(FULFILMENT_PIPELINE).toEqual(['preparing', 'printing', 'mailed']);
  });

  it('walks draft → audience → quoted, and itemises what the buyer is paying for', async () => {
    const { quoted } = await quotedOrder('pc-flow');

    expect(quoted.status).toBe(200);
    expect(quoted.body.data.status).toBe('quoted');

    const { price, quantity } = quoted.body.data;
    // Quantity defaults to the whole resolved area rather than leaving the order unquotable.
    expect(quantity).toBe(1_000);
    expect(price.vendorCostCents + price.marginCents).toBe(price.totalCents);
    expect(price.isExpired).toBe(false);
    expect(new Date(price.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to quote before an area and a quantity are chosen', async () => {
    const v = await vendorAccount('pc-noaud');
    const order = await makeOrder(v.token, v.businessId);
    const res = await request(app)
      .post(`/api/v1/postcards/orders/${order.body.data.id}/quote`)
      .set(...bearer(v.token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('throws the price away when what is being bought changes', async () => {
    /**
     * The most important rule in the phase. A quote for 1,000 pieces is not a quote for 400, and
     * carrying it forward is how somebody gets charged for an order they never agreed to.
     */
    const { token, orderId } = await quotedOrder('pc-requote');

    const changed = await request(app)
      .patch(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(token))
      .send({ quantity: 400 });

    expect(changed.status).toBe(200);
    expect(changed.body.data.status).toBe('draft');
    expect(changed.body.data.price).toBeNull();
  });

  it('will not mail to more addresses than the area actually has', async () => {
    const { token, orderId } = await quotedOrder('pc-overshoot');
    const res = await request(app)
      .patch(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(token))
      .send({ quantity: 5_000 }); // the fake area has 1,000
    expect(res.status).toBe(400);
  });

  it('rejects a mail date in the past', async () => {
    const { token, orderId } = await quotedOrder('pc-date');
    const res = await request(app)
      .patch(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(token))
      .send({ mailDate: '2020-01-01' });
    expect(res.status).toBe(400);
  });

  it('marks a lapsed quote as expired instead of quietly honouring it', async () => {
    // The vendor publishes prices but does not reserve them (audit F-8).
    const { token, orderId } = await quotedOrder('pc-expiry');
    await PostcardOrderModel.updateOne(
      { _id: orderId },
      { $set: { quote_expires_at: new Date(Date.now() - 1_000) } },
    );

    const res = await request(app)
      .get(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(token));
    expect(res.body.data.price.isExpired).toBe(true);
    // Still visible, not hidden: the buyer should see what they were quoted AND that it needs redoing.
    expect(res.body.data.price.totalCents).toBeGreaterThan(0);
    expect(POSTCARD_QUOTE_TTL_MINUTES).toBeGreaterThan(0);
  });

  it('lists a business’s orders', async () => {
    const { token, businessId } = await quotedOrder('pc-list');
    const res = await request(app)
      .get(`/api/v1/postcards/business/${businessId}/orders`)
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('exposes the vendor’s list types', async () => {
    const v = await vendorAccount('pc-types');
    const res = await request(app)
      .get('/api/v1/postcards/list-types')
      .set(...bearer(v.token));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ─── cancellation ───────────────────────────────────────────────────────────────────────────
describe('cancelling', () => {
  it('cancels a quoted order, and refuses a second cancellation', async () => {
    const { token, orderId } = await quotedOrder('pc-cancel');

    const first = await request(app)
      .post(`/api/v1/postcards/orders/${orderId}/cancel`)
      .set(...bearer(token))
      .send({ reason: 'changed my mind' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('cancelled');

    // Guarded atomically, so two tabs cannot both "succeed".
    const second = await request(app)
      .post(`/api/v1/postcards/orders/${orderId}/cancel`)
      .set(...bearer(token))
      .send({});
    expect(second.status).toBe(409);
  });

  it('will not quote a cancelled order back to life', async () => {
    const { token, orderId } = await quotedOrder('pc-cancel2');
    await request(app)
      .post(`/api/v1/postcards/orders/${orderId}/cancel`)
      .set(...bearer(token))
      .send({});

    const res = await request(app)
      .post(`/api/v1/postcards/orders/${orderId}/quote`)
      .set(...bearer(token))
      .send({});
    expect(res.status).toBe(409);
  });
});

// ─── authorization ──────────────────────────────────────────────────────────────────────────
describe('an order belongs to one business, and nobody else can see it', () => {
  it('refuses another vendor’s order and another vendor’s audience', async () => {
    /**
     * Not merely wrong — a mailing plan is commercial information. Which areas a competitor is
     * targeting and what they are spending is exactly what should not leak.
     */
    const mine = await quotedOrder('pc-own');
    const theirs = await vendorAccount('pc-other');

    const read = await request(app)
      .get(`/api/v1/postcards/orders/${mine.orderId}`)
      .set(...bearer(theirs.token));
    expect(read.status).toBe(403);

    const cancel = await request(app)
      .post(`/api/v1/postcards/orders/${mine.orderId}/cancel`)
      .set(...bearer(theirs.token))
      .send({});
    expect(cancel.status).toBe(403);

    // And an audience cannot be borrowed across businesses onto someone else's order.
    const theirOrder = await makeOrder(theirs.token, theirs.businessId);
    const crossed = await request(app)
      .patch(`/api/v1/postcards/orders/${theirOrder.body.data.id}`)
      .set(...bearer(theirs.token))
      .send({ audienceId: mine.audience.id });
    expect(crossed.status).toBe(403);
  });

  it('requires authentication to order at all', async () => {
    const v = await vendorAccount('pc-anon');
    const res = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/orders`)
      .send({ sku: '68', mailClass: 'standard' });
    expect(res.status).toBe(401);
  });
});
