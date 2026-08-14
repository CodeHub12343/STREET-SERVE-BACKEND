import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { SalePaymentModel } from '../src/modules/salepayments/salepayments.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * PHASE 4 — REFUNDS AND DISPUTES. Exit criteria: a customer can be refunded before AND after
 * settlement with the ledger balanced in both cases, and disputes hold money instead of letting it
 * escape.
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

/** Hub + gold seller holding stock, with auto-approval so the focus stays on refunds. */
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
      quantityAvailable: 100,
    });

  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier: 'gold',
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
    .send({
      productId: product.body.data.id,
      quantity: opts.qty,
      conditionPhotoUrl: 'https://cdn.test/c.jpg',
      qrToken,
    });

  return {
    hubToken,
    sellerToken,
    sellerId,
    businessId,
    hubId,
    qrToken,
    productId: product.body.data.id as string,
    checkoutId: checkout.body.data.id as string,
  };
}

/** Run a full card sale and return its identifiers. */
async function paidSale(s: { sellerToken: string; checkoutId: string }, quantity: number, key: string) {
  await request(app)
    .post('/api/v1/sales/payment-intent')
    .set(...bearer(s.sellerToken))
    .set('Idempotency-Key', key)
    .send({ checkoutId: s.checkoutId, quantity });
  const charge = fakeStripe.platformCharges.at(-1)!;
  await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });
  const payment = await SalePaymentModel.findOne({ stripe_payment_intent_id: charge.paymentIntentId }).lean();
  return { salePaymentId: String(payment!._id), paymentIntentId: charge.paymentIntentId };
}

describe('refunds (Phase 4 exit)', () => {
  it('refunds in full, pulling every share back, and leaves the ledger balanced', async () => {
    const s = await scenario('p4ref', { unitValue: 1000, split: 65, qty: 10 });
    const { salePaymentId } = await paidSale(s, 3, 'idem_p4ref');
    // $30 gross − 8% ($2.40) = $27.60 → seller $17.94, hub $9.66.

    const feeBefore = await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'fee_revenue' });

    const refund = await request(app)
      .post(`/api/v1/sales/${salePaymentId}/refund`)
      .set(...bearer(s.hubToken))
      .set('Idempotency-Key', 'idem_p4ref_r')
      .send({ reason: 'defective', restock: true });

    expect(refund.status).toBe(201);
    expect(refund.body.data.amountCents).toBe(3000);
    // Proportional reversal across all three parties, summing exactly to the refund.
    const rev = refund.body.data.reversals;
    expect(rev.sellerCents + rev.hubCents + rev.feeCents).toBe(3000);
    expect(rev.feeCents).toBe(240);
    expect(rev.sellerCents).toBe(1794);
    expect(rev.hubCents).toBe(966);
    expect(refund.body.data.sellerReversed).toBe(true);
    expect(refund.body.data.hubReversed).toBe(true);
    // No clawback needed — the money was still there to pull back.
    expect(refund.body.data.clawbackDebtId).toBeNull();

    // The platform gave its fee back.
    const feeAfter = await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'fee_revenue' });
    expect(feeBefore - feeAfter).toBe(240);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('splits a partial refund proportionally across all three parties', async () => {
    const s = await scenario('p4part', { unitValue: 1000, split: 65, qty: 10 });
    const { salePaymentId } = await paidSale(s, 5, 'idem_p4part');
    // $50 gross → fee $4, seller $29.90, hub $16.10.

    // Refund $20 = 40% of the sale.
    const refund = await request(app)
      .post(`/api/v1/sales/${salePaymentId}/refund`)
      .set(...bearer(s.hubToken))
      .set('Idempotency-Key', 'idem_p4part_r')
      .send({ amountCents: 2000, reason: 'customer_request' });

    expect(refund.status).toBe(201);
    const rev = refund.body.data.reversals;
    expect(rev.feeCents).toBe(160); // 40% of $4
    expect(rev.sellerCents).toBe(1196); // 40% of $29.90
    expect(rev.hubCents).toBe(644); // remainder — absorbs the rounding
    expect(rev.sellerCents + rev.hubCents + rev.feeCents).toBe(2000);

    // The rest of the sale is still refundable, and no more.
    const tooMuch = await request(app)
      .post(`/api/v1/sales/${salePaymentId}/refund`)
      .set(...bearer(s.hubToken))
      .set('Idempotency-Key', 'idem_p4part_r2')
      .send({ amountCents: 4000, reason: 'customer_request' });
    expect(tooMuch.status).toBe(422);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
  });

  it('turns an unrecoverable share into a clawback debt instead of a silent loss', async () => {
    const s = await scenario('p4claw', { unitValue: 1000, split: 65, qty: 10 });
    const { salePaymentId } = await paidSale(s, 4, 'idem_p4claw');

    // The seller has already spent their share — the transfer can't be reversed.
    const sellerTransfer = fakeStripe.transfers.at(-2) ?? fakeStripe.transfers.at(-1)!;
    const payment = await SalePaymentModel.findById(salePaymentId).lean();
    fakeStripe.unreversibleTransfers.add(payment!.split!.seller_transfer_id as string);
    void sellerTransfer;

    const refund = await request(app)
      .post(`/api/v1/sales/${salePaymentId}/refund`)
      .set(...bearer(s.hubToken))
      .set('Idempotency-Key', 'idem_p4claw_r')
      .send({ reason: 'not_received' });

    expect(refund.status).toBe(201);
    expect(refund.body.data.sellerReversed).toBe(false);
    expect(refund.body.data.clawbackDebtId).toBeTruthy();

    // The shortfall is now a visible, repayable balance — and it is on the books as a receivable.
    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    const clawback = debts.body.data.debts.find((d: { originType: string }) => d.originType === 'refund_clawback');
    expect(clawback).toBeTruthy();
    expect(clawback.outstandingCents).toBe(refund.body.data.reversals.sellerCents);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('lets a customer request a refund from their receipt without an account', async () => {
    const s = await scenario('p4req', { unitValue: 1000, split: 65, qty: 5 });
    const intent = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p4req')
      .send({ checkoutId: s.checkoutId, quantity: 2 });
    const charge = fakeStripe.platformCharges.at(-1)!;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    // No auth header at all — this is a public receipt link.
    const res = await request(app)
      .post(`/api/v1/pay/${intent.body.data.payToken}/refund-request`)
      .send({ reason: 'defective' });
    expect(res.status).toBe(200);
    expect(res.body.data.requested).toBe(true);
    // It is a REQUEST, not a refund — a stranger with the link cannot drain the seller.
    expect(res.body.data.amountCents).toBe(2000);
  });
});

describe('disputes hold money (Phase 4 exit)', () => {
  it('freezes the seller payouts when a chargeback opens, and resumes when it closes', async () => {
    const s = await scenario('p4dis', { unitValue: 1000, split: 65, qty: 10 });
    const { paymentIntentId } = await paidSale(s, 2, 'idem_p4dis');

    await stripeEvent('charge.dispute.created', {
      payment_intent: paymentIntentId,
      reason: 'fraudulent',
    });

    const frozen = await ConnectedAccountModel.findOne({
      owner_type: 'user',
      owner_id: s.sellerId,
    }).lean();
    expect(frozen!.payouts_frozen).toBe(true);

    // A further sale still records what is owed, but no money reaches the frozen seller.
    const transfersBefore = fakeStripe.transfers.length;
    await paidSale(s, 2, 'idem_p4dis2');
    const sellerLegs = fakeStripe.transfers
      .slice(transfersBefore)
      .filter((t) => t.destination === frozen!.stripe_account_id);
    expect(sellerLegs).toHaveLength(0);

    // The obligation is still on the books — held, not lost.
    expect(
      await ledgerService.balanceOf({ ownerType: 'user', ownerId: s.sellerId, accountType: 'payable' }),
    ).toBeGreaterThan(0);

    await stripeEvent('charge.dispute.closed', { payment_intent: paymentIntentId, status: 'won' });
    const thawed = await ConnectedAccountModel.findOne({
      owner_type: 'user',
      owner_id: s.sellerId,
    }).lean();
    expect(thawed!.payouts_frozen).toBe(false);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('blocks settlement while a checkout is disputed', async () => {
    const s = await scenario('p4hold', { unitValue: 1000, split: 65, qty: 4 });
    await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/sales`)
      .set(...bearer(s.sellerToken))
      .send({ quantitySold: 2, saleAmountCents: 2000, paymentRail: 'cash' });

    // A customer opens a dispute over this checkout.
    const dispute = await request(app)
      .post('/api/v1/disputes')
      .set(...bearer(s.sellerToken))
      .send({
        subjectType: 'seller',
        subjectId: s.sellerId,
        refType: 'checkout',
        refId: s.checkoutId,
        note: 'Item not as described',
      });
    expect([200, 201]).toContain(dispute.status);

    // Returning the rest would normally settle — it must be held instead.
    const ret = await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/return`)
      .set(...bearer(s.sellerToken))
      .send({ quantityReturned: 2, conditionAssessment: 'good' });
    expect(ret.status).toBe(409);
    expect(ret.body.error.message).toMatch(/disputed/i);
  });
});

describe('inventory liability (Phase 4)', () => {
  it('charges a seller for stock reported lost, instead of letting it be free', async () => {
    const s = await scenario('p4lost', { unitValue: 1000, split: 65, qty: 5 });

    const ret = await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/return`)
      .set(...bearer(s.sellerToken))
      .send({ quantityReturned: 5, conditionAssessment: 'lost' });
    expect(ret.status).toBe(200);

    // 5 × $10 lost → the hub is owed the full value, charged to the seller.
    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    const lost = debts.body.data.debts.find((d: { originType: string }) => d.originType === 'lost_inventory');
    expect(lost).toBeTruthy();
    expect(lost.outstandingCents).toBe(5000);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('charges half value for damaged stock', async () => {
    const s = await scenario('p4dmg', { unitValue: 1000, split: 65, qty: 4 });
    await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/return`)
      .set(...bearer(s.sellerToken))
      .send({ quantityReturned: 4, conditionAssessment: 'damaged' });

    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    const dmg = debts.body.data.debts.find((d: { originType: string }) => d.originType === 'damaged_inventory');
    expect(dmg.outstandingCents).toBe(2000); // 4 × $10 × 50%
  });
});
