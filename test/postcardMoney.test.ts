import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { POSTCARD_VENDOR_ACCOUNT_ID } from '../src/config/constants';
import { createFakePrintVendor, resetPrintVendor, setPrintVendor } from '../src/integrations/print';
import { setStorageGateway } from '../src/integrations/storage';
import { setStripeGateway } from '../src/integrations/stripe';
import { LedgerAccountModel, LedgerEntryModel } from '../src/modules/ledger/ledger.model';
import {
  PostcardAssetModel,
  PostcardOrderModel,
  PostcardPayableModel,
  PostcardSettlementModel,
} from '../src/modules/postcards/postcards.model';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { FakeStorageGateway, FakeStripeGateway } from './fakes';
import { PostcardPilotParticipantModel } from '../src/modules/postcards/pilot.service';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Phase 5 — Money (ADR-007 §4, Topology B: wholesale resale).
 *
 * The shape here is unlike every other money path in this codebase, and the tests are mostly about
 * that difference. We are the merchant: the buyer's WHOLE payment lands in our cash, only the
 * margin is income, and the rest is a debt to the printer that has to be recorded the moment the
 * money arrives. A correct Stripe charge on its own does not give "no manual accounting" — money
 * that moves without a double-entry record is just accounting deferred to whoever closes the
 * quarter (audit F-10).
 */

const app = createApp();
let storage: FakeStorageGateway;
let stripeFake: FakeStripeGateway;

beforeAll(() => setPrintVendor(createFakePrintVendor()));
beforeEach(() => {
  storage = new FakeStorageGateway();
  setStorageGateway(storage);
  stripeFake = new FakeStripeGateway();
  setStripeGateway(stripeFake);
});
afterEach(() => {
  resetPrintVendor();
  setPrintVendor(createFakePrintVendor());
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────

function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([sig, ihdr, Buffer.alloc(80 * 1024)]);
}

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

async function financeUser(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|fin`, roles: ['admin'] });
  return mintToken(`${prefix}|fin`);
}

/** draft → audience → artwork → quoted. Everything short of paying. */
async function readyOrder(prefix: string, quantity = 500) {
  const v = await vendorAccount(prefix);

  await request(app)
    .post('/api/v1/agreements/postcard_artwork/accept')
    .set(...bearer(v.token))
    .send({});

  const audience = await request(app)
    .post(`/api/v1/postcards/business/${v.businessId}/audiences`)
    .set(...bearer(v.token))
    .send({ type: 'zip', listType: 'IRL', keys: ['95350'] });

  const up = await request(app)
    .post(`/api/v1/postcards/business/${v.businessId}/artwork`)
    .set(...bearer(v.token))
    .send({ contentType: 'image/png' });
  const assetRow = await PostcardAssetModel.findById(up.body.data.assetId).lean().exec();
  storage.put(assetRow!.storage_key, png(1875, 2625), 'image/png');
  await request(app)
    .post(`/api/v1/postcards/artwork/${up.body.data.assetId}/validate`)
    .set(...bearer(v.token))
    .send({ sku: '68' });

  const order = await request(app)
    .post(`/api/v1/postcards/business/${v.businessId}/orders`)
    .set(...bearer(v.token))
    .send({ sku: '68', mailClass: 'standard' });
  const orderId = order.body.data.id as string;

  await request(app)
    .patch(`/api/v1/postcards/orders/${orderId}`)
    .set(...bearer(v.token))
    .send({
      audienceId: audience.body.data.id,
      assetId: up.body.data.assetId,
      quantity,
      mailDate: new Date(Date.now() + 10 * 864e5).toISOString(),
    });

  const quoted = await request(app)
    .post(`/api/v1/postcards/orders/${orderId}/quote`)
    .set(...bearer(v.token))
    .send({});

  return { ...v, orderId, quote: quoted.body.data };
}

const pay = (token: string, orderId: string, key = `k_${Math.random()}`) =>
  request(app)
    .post(`/api/v1/postcards/orders/${orderId}/pay`)
    .set(...bearer(token))
    .set('Idempotency-Key', key)
    .send({});

/** Plays Stripe's part: the money actually arrived. */
async function deliverWebhook(orderId: string, type = 'payment_intent.succeeded', extra = {}) {
  const row = await PostcardOrderModel.findById(orderId).lean().exec();
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(
      JSON.stringify({
        id: `evt_${Math.random()}`,
        type,
        data: { object: { id: row?.stripe_payment_intent_id, ...extra } },
      }),
    );
}

async function paidOrder(prefix: string, quantity = 500) {
  const o = await readyOrder(prefix, quantity);
  await pay(o.token, o.orderId);
  await deliverWebhook(o.orderId);
  return o;
}

/**
 * Platform ledger accounts are shared by every test in the file — `cash` is one row, not one per
 * order. So balances are asserted as DELTAS around an action rather than as absolutes, which is
 * both correct here and a better test: it says what the action did, not what the database happened
 * to contain beforehand.
 */
const balanceOf = async (accountType: string, ownerId: string | null = null) => {
  const acct = await LedgerAccountModel.findOne({ account_type: accountType, owner_id: ownerId })
    .lean()
    .exec();
  return acct?.balance_cents ?? 0;
};

async function balances() {
  return {
    cash: await balanceOf('cash'),
    vendorPayable: await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID),
    feeRevenue: await balanceOf('fee_revenue'),
    taxPayable: await balanceOf('tax_payable'),
  };
}

// ─── Checkout gates ─────────────────────────────────────────────────────────────────────────

describe('checkout — everything that could block a print run is checked before the card', () => {
  it('charges the quoted total and does NOT mark the order paid', async () => {
    /**
     * The load-bearing rule. A client cannot be trusted to report that money arrived, so checkout
     * creates an intent and stops; only the webhook advances the order.
     */
    const o = await readyOrder('pm-pay');
    const res = await pay(o.token, o.orderId);

    expect(res.status).toBe(200);
    expect(res.body.data.clientSecret).toBeTruthy();
    expect(stripeFake.platformCharges).toHaveLength(1);
    expect(stripeFake.platformCharges[0]!.amountCents).toBe(o.quote.price.totalCents);
    // A platform charge, NOT a destination charge: the vendor is a supplier, not a marketplace seller.
    expect(stripeFake.charges).toHaveLength(0);

    const after = await request(app)
      .get(`/api/v1/postcards/orders/${o.orderId}`)
      .set(...bearer(o.token));
    expect(after.body.data.status).toBe('quoted');
  });

  it('refuses to charge without artwork that passed for this size', async () => {
    const v = await vendorAccount('pm-noart');
    const audience = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/audiences`)
      .set(...bearer(v.token))
      .send({ type: 'zip', listType: 'IRL', keys: ['95350'] });
    const order = await request(app)
      .post(`/api/v1/postcards/business/${v.businessId}/orders`)
      .set(...bearer(v.token))
      .send({ sku: '68', mailClass: 'standard' });
    const orderId = order.body.data.id as string;
    await request(app)
      .patch(`/api/v1/postcards/orders/${orderId}`)
      .set(...bearer(v.token))
      .send({ audienceId: audience.body.data.id, quantity: 500 });
    await request(app)
      .post(`/api/v1/postcards/orders/${orderId}/quote`)
      .set(...bearer(v.token))
      .send({});

    const res = await pay(v.token, orderId);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/artwork/i);
    expect(stripeFake.platformCharges).toHaveLength(0);
  });

  it('refuses an expired quote instead of absorbing the difference', async () => {
    // The vendor publishes prices but does not reserve them, so a stale quote is a loss (F-8).
    const o = await readyOrder('pm-stale');
    await PostcardOrderModel.updateOne(
      { _id: o.orderId },
      { $set: { quote_expires_at: new Date(Date.now() - 60_000) } },
    );

    const res = await pay(o.token, o.orderId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/expired/i);
    expect(stripeFake.platformCharges).toHaveLength(0);
  });

  it('charges once even when checkout is retried', async () => {
    /**
     * The Stripe idempotency key is derived from the ORDER, not from the caller's header: two
     * attempts on one order must reach Stripe as one charge whatever the client sends.
     */
    const o = await readyOrder('pm-idem');
    await pay(o.token, o.orderId, 'key-one');
    await pay(o.token, o.orderId, 'key-two');

    const keys = new Set(stripeFake.platformCharges.map((c) => c.metadata.order_id));
    expect(keys.size).toBe(1);
  });

  it('will not let another business pay for an order', async () => {
    const mine = await readyOrder('pm-own-a');
    const other = await vendorAccount('pm-own-b');
    const res = await pay(other.token, mine.orderId);
    expect(res.status).toBe(403);
  });
});

// ─── Capture and the books ──────────────────────────────────────────────────────────────────

describe('capture — the webhook books three obligations, not one', () => {
  it('splits the payment into cash, vendor debt and margin', async () => {
    const before = await balances();
    const o = await paidOrder('pm-books');
    const after = await balances();
    const order = await PostcardOrderModel.findById(o.orderId).lean().exec();

    const charged = order!.charged_cents!;
    const vendorCost = order!.vendor_cost_cents!;
    const margin = order!.margin_cents!;

    // Cash rises by everything the buyer paid...
    expect(after.cash - before.cash).toBe(charged);
    // ...but only the margin is ours. The rest is a debt to the printer, recorded now.
    expect(after.vendorPayable - before.vendorPayable).toBe(vendorCost);
    expect(after.feeRevenue - before.feeRevenue).toBe(margin);
    expect(vendorCost + margin).toBe(charged);
  });

  it('marks the order paid and records when', async () => {
    const o = await paidOrder('pm-paid');
    const res = await request(app)
      .get(`/api/v1/postcards/orders/${o.orderId}`)
      .set(...bearer(o.token));
    expect(res.body.data.status).toBe('paid');
    expect(res.body.data.payment.paidAt).toBeTruthy();
  });

  it('accrues exactly one payable for the vendor', async () => {
    const o = await paidOrder('pm-accrue');
    const order = await PostcardOrderModel.findById(o.orderId).lean().exec();
    const payable = await PostcardPayableModel.findOne({ order_id: o.orderId }).lean().exec();

    expect(payable!.status).toBe('accrued');
    // The vendor's wholesale cost only — never our margin, never the buyer's tax.
    expect(payable!.amount_cents).toBe(order!.vendor_cost_cents);
  });

  it('is idempotent: a replayed webhook does not double the books or the debt', async () => {
    // Stripe delivers at least once. Twice must be indistinguishable from once.
    const o = await paidOrder('pm-replay');
    const cashAfterFirst = await balanceOf('cash');

    await deliverWebhook(o.orderId);
    await deliverWebhook(o.orderId);

    expect(await balanceOf('cash')).toBe(cashAfterFirst);
    // Unchanged: the second and third deliveries booked nothing at all.
    expect(await PostcardPayableModel.countDocuments({ order_id: o.orderId })).toBe(1);
    const entries = await LedgerEntryModel.countDocuments({
      transaction_id: `postcard_paid_${o.orderId}`,
    });
    expect(entries).toBe(3); // cash + vendor_payable + margin, posted once
  });

  it('charges no tax while the merchant-of-record question is open', async () => {
    /**
     * ADR-007 §5 is unanswered, so `POSTCARD_TAX_ENABLED` is off and a buyer is charged goods only.
     * The field is still recorded, so a paid order always states what tax treatment it received —
     * including "none".
     */
    const before = await balances();
    const o = await paidOrder('pm-tax');
    const after = await balances();
    const order = await PostcardOrderModel.findById(o.orderId).lean().exec();
    expect(order!.tax_cents).toBe(0);
    expect(order!.charged_cents).toBe(order!.total_cents);
    expect(after.taxPayable - before.taxPayable).toBe(0);
  });

  it('marks a declined card as failed rather than leaving it looking untouched', async () => {
    const o = await readyOrder('pm-decline');
    await pay(o.token, o.orderId);
    await deliverWebhook(o.orderId, 'payment_intent.payment_failed', {
      last_payment_error: { message: 'card_declined' },
    });

    const res = await request(app)
      .get(`/api/v1/postcards/orders/${o.orderId}`)
      .set(...bearer(o.token));
    expect(res.body.data.status).toBe('payment_failed');
    expect(res.body.data.payment.failureReason).toMatch(/declined/i);
  });
});

// ─── Refunds ────────────────────────────────────────────────────────────────────────────────

describe('refunds — allowed while nothing has been printed (F-4)', () => {
  it('refunds in full and unwinds every ledger leg', async () => {
    const beforeAll_ = await balances();
    const o = await paidOrder('pm-refund');

    const res = await request(app)
      .post(`/api/v1/postcards/orders/${o.orderId}/refund`)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r1')
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('refunded');
    // Every leg the capture posted comes back to exactly where it started.
    const after = await balances();
    expect(after.cash).toBe(beforeAll_.cash);
    expect(after.vendorPayable).toBe(beforeAll_.vendorPayable);
    expect(after.feeRevenue).toBe(beforeAll_.feeRevenue);
  });

  it('reverses the payable rather than settling it', async () => {
    /**
     * The distinction matters: `settled` would claim we paid the vendor for this order. We did not,
     * and never will — the debt did not exist in substance.
     */
    const o = await paidOrder('pm-refund-payable');
    await request(app)
      .post(`/api/v1/postcards/orders/${o.orderId}/refund`)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r2')
      .send({ reason: 'Wrong area' });

    const payable = await PostcardPayableModel.findOne({ order_id: o.orderId }).lean().exec();
    expect(payable!.status).toBe('reversed');
    expect(payable!.settled_at).toBeNull();
  });

  it('does not reverse a transfer, because a platform charge made none', async () => {
    const o = await paidOrder('pm-refund-transfer');
    await request(app)
      .post(`/api/v1/postcards/orders/${o.orderId}/refund`)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r3')
      .send({ reason: 'test' });

    expect(stripeFake.refundCalls[0]!.reverseTransfer).toBe(false);
  });

  it('refuses to refund twice, or to refund something unpaid', async () => {
    const o = await paidOrder('pm-refund-twice');
    const url = `/api/v1/postcards/orders/${o.orderId}/refund`;
    await request(app)
      .post(url)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r4')
      .send({ reason: 'first' });

    const second = await request(app)
      .post(url)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r5')
      .send({ reason: 'second' });
    expect(second.status).toBe(409);

    const unpaid = await readyOrder('pm-refund-unpaid');
    const res = await request(app)
      .post(`/api/v1/postcards/orders/${unpaid.orderId}/refund`)
      .set(...bearer(unpaid.token))
      .set('Idempotency-Key', 'r6')
      .send({ reason: 'nope' });
    expect(res.status).toBe(409);
  });

  it('requires a reason — it explains a ledger reversal and is shown to the buyer', async () => {
    const o = await paidOrder('pm-refund-reason');
    const res = await request(app)
      .post(`/api/v1/postcards/orders/${o.orderId}/refund`)
      .set(...bearer(o.token))
      .set('Idempotency-Key', 'r7')
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Settlement ─────────────────────────────────────────────────────────────────────────────

describe('settling with the vendor', () => {
  it('closes accrued payables into one statement without paying anyone', async () => {
    /**
     * Closing rearranges our records; it does not move money. If the discharge were posted here the
     * books would show the debt gone while the printer was still owed.
     */
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    const a = await paidOrder('pm-set-a');
    const b = await paidOrder('pm-set-b');
    const owedBefore = await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID);
    const token = await financeUser('pm-set');

    const res = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.data.payableCount).toBe(2);
    expect(res.body.data.status).toBe('open');
    // Still owed: closing is a statement, not a payment.
    expect(await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID)).toBe(owedBefore);

    const payables = await PostcardPayableModel.find({
      order_id: { $in: [a.orderId, b.orderId] },
    })
      .lean()
      .exec();
    expect(payables.every((p) => p.status === 'settling')).toBe(true);
  });

  it('discharges the debt only when a human confirms payment', async () => {
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    await paidOrder('pm-set-confirm');
    const token = await financeUser('pm-confirm');
    const closed = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});
    const owed = closed.body.data.totalCents as number;
    expect(owed).toBeGreaterThan(0);
    const owedBefore = await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID);

    const res = await request(app)
      .post(`/api/v1/postcards/settlements/${closed.body.data.id}/confirm`)
      .set(...bearer(token))
      .set('Idempotency-Key', 's1')
      .send({ externalReference: 'ACH-2026-08-0001' });

    expect(res.status).toBe(200);
    // The debt falls by exactly what was settled — and only now, not when the period closed.
    const owedAfter = await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID);
    expect(owedBefore - owedAfter).toBe(owed);
    const payable = await PostcardPayableModel.findOne({ status: 'settled' }).lean().exec();
    expect(payable).not.toBeNull();
  });

  it('requires an external reference — the only evidence money left', async () => {
    // A settlement markable by clicking a button is one that eventually gets marked by mistake.
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    await paidOrder('pm-set-ref');
    const token = await financeUser('pm-ref');
    const closed = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});

    const res = await request(app)
      .post(`/api/v1/postcards/settlements/${closed.body.data.id}/confirm`)
      .set(...bearer(token))
      .set('Idempotency-Key', 's2')
      .send({ externalReference: '' });
    expect(res.status).toBe(400);
  });

  it('refuses a second open settlement', async () => {
    // Two would race for the same payables, and "which statement is this invoice against?" needs
    // exactly one answer.
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    await paidOrder('pm-set-race');
    const token = await financeUser('pm-race');
    await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});

    await paidOrder('pm-set-race2');
    const second = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});
    expect(second.status).toBe(409);
  });

  it('voiding releases the payables to be picked up next time', async () => {
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    const o = await paidOrder('pm-set-void');
    const token = await financeUser('pm-void');
    const owedBefore = await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID);
    const closed = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});

    await request(app)
      .post(`/api/v1/postcards/settlements/${closed.body.data.id}/void`)
      .set(...bearer(token))
      .send({ reason: 'Closed against the wrong period' });

    const payable = await PostcardPayableModel.findOne({ order_id: o.orderId }).lean().exec();
    expect(payable!.status).toBe('accrued');
    expect(payable!.settlement_id).toBeNull();
    // And the debt is untouched, because voiding pays nobody.
    expect(await balanceOf('vendor_payable', POSTCARD_VENDOR_ACCOUNT_ID)).toBe(owedBefore);
  });

  it('reports the credit exposure Topology B accepted', async () => {
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    const o = await paidOrder('pm-exposure');
    const order = await PostcardOrderModel.findById(o.orderId).lean().exec();
    const token = await financeUser('pm-exp');

    const res = await request(app)
      .get('/api/v1/postcards/settlements/exposure')
      .set(...bearer(token));

    expect(res.body.data.outstandingCents).toBe(order!.vendor_cost_cents);
    expect(res.body.data.unsettledCount).toBe(1);
    expect(res.body.data.overAlertThreshold).toBe(false);
    // Best-effort: the vendor being unreachable reports "unknown", never a misleading zero.
    expect(res.body.data).toHaveProperty('vendorRetainerCents');
  });

  it('is finance-only — a vendor cannot see or settle the books', async () => {
    const o = await paidOrder('pm-set-authz');
    for (const path of ['/settlements', '/settlements/exposure']) {
      const res = await request(app)
        .get(`/api/v1/postcards${path}`)
        .set(...bearer(o.token));
      expect(res.status).toBe(403);
    }
    const close = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(o.token))
      .send({});
    expect(close.status).toBe(403);
  });

  it('leaves nothing to settle when there is nothing accrued', async () => {
    const token = await financeUser('pm-set-empty');
    await PostcardPayableModel.deleteMany({});
    await PostcardSettlementModel.deleteMany({});
    const res = await request(app)
      .post('/api/v1/postcards/settlements/close')
      .set(...bearer(token))
      .send({});
    expect(res.body.data).toBeNull();
  });
});
