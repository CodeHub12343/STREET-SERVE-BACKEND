import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * PHASE 3 — THE CASH RAIL. Exit criteria: a cash sale creates a visible debt, the next digital
 * payout nets it automatically, and credit limits block over-exposure.
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

async function scenario(
  prefix: string,
  opts: { unitValue: number; split: number; qty: number; tier?: 'bronze' | 'silver' | 'gold' },
) {
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
  const productId = product.body.data.id as string;

  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier: opts.tier ?? 'gold',
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
    qrToken,
    checkoutStatus: checkout.status,
    checkoutBody: checkout.body,
    checkoutId: checkout.body.data?.id as string,
  };
}

describe('cash rail and debt (Phase 3 exit)', () => {
  it('turns a cash sale into a visible debt instead of silently losing the money', async () => {
    const s = await scenario('p3cash', { unitValue: 1000, split: 65, qty: 10 });

    // The customer paid $50 in CASH — straight into the seller's pocket.
    const sale = await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/sales`)
      .set(...bearer(s.sellerToken))
      .send({ quantitySold: 5, saleAmountCents: 5000, paymentRail: 'cash' });
    expect(sale.status).toBe(201);

    // $50 gross − 10% cash fee ($5) = $45 distributable → seller 65% = $29.25, hub = $15.75.
    // The seller keeps the $50 cash but now OWES the hub share + platform fee.
    expect(sale.body.data.debtCents).toBe(1575 + 500);

    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    expect(debts.status).toBe(200);
    expect(debts.body.data.totalOutstandingCents).toBe(2075);
    expect(debts.body.data.debts[0].originType).toBe('cash_sale');

    // The books show it as a receivable owed by the seller — no platform cash moved.
    expect(
      await ledgerService.balanceOf({ ownerType: 'user', ownerId: s.sellerId, accountType: 'receivable' }),
    ).toBe(2075);
    expect(
      await ledgerService.balanceOf({ ownerType: 'business', ownerId: s.businessId, accountType: 'payable' }),
    ).toBe(1575);
    expect(await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'cash' })).toBe(0);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('nets the debt out of the next digital payout automatically', async () => {
    const s = await scenario('p3net', { unitValue: 1000, split: 65, qty: 20 });

    // A cash sale first: $20 gross → 10% fee $2 → seller $11.70, owed $8.30.
    await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/sales`)
      .set(...bearer(s.sellerToken))
      .send({ quantitySold: 2, saleAmountCents: 2000, paymentRail: 'cash' });
    const owedBefore = (await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken)))
      .body.data.totalOutstandingCents as number;
    expect(owedBefore).toBe(830);

    // Now a CARD sale of $100 → 8% digital fee $8 → distributable $92 → seller 65% = $59.80.
    await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p3_net')
      .send({ checkoutId: s.checkoutId, quantity: 10 });
    const charge = fakeStripe.platformCharges.at(-1)!;

    const transfersBefore = fakeStripe.transfers.length;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    // The seller is paid $59.80 − $8.30 debt = $51.50. The hub still gets its full $32.20.
    const legs = fakeStripe.transfers.slice(transfersBefore).map((t) => t.amountCents).sort((a, b) => a - b);
    expect(legs).toEqual([3220, 5150]);

    // The balance is cleared without any collections process.
    const after = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    expect(after.body.data.totalOutstandingCents).toBe(0);
    expect(after.body.data.debts[0].status).toBe('repaid');

    // Receivable and payable cancelled each other — nothing left owed either way.
    expect(
      await ledgerService.balanceOf({ ownerType: 'user', ownerId: s.sellerId, accountType: 'receivable' }),
    ).toBe(0);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('blocks a checkout that would exceed the tier credit limit', async () => {
    // Bronze may hold $200 of stock. 30 × $10 = $300 is over.
    const s = await scenario('p3limit', { unitValue: 1000, split: 65, qty: 30, tier: 'bronze' });
    expect(s.checkoutStatus).toBe(403);
    // Asserts the INTENT: the refusal names the ceiling and how to lift it. The literal wording has
    // been reworded twice (tier label, then the A-3 Trust band) — match the promise, not the prose.
    expect(s.checkoutBody.error.message).toMatch(/over your .*limit/i);
    expect(s.checkoutBody.error.message).toMatch(/raise your limit/i);
  });

  it('reports credit headroom so a seller knows what they can take', async () => {
    const s = await scenario('p3credit', { unitValue: 1000, split: 65, qty: 10, tier: 'bronze' });
    expect(s.checkoutStatus).toBe(201); // 10 × $10 = $100, inside the $200 Bronze cap

    const credit = await request(app).get('/api/v1/debts/credit').set(...bearer(s.sellerToken));
    expect(credit.status).toBe(200);
    expect(credit.body.data.tier).toBe('bronze');
    expect(credit.body.data.maxInventoryValueCents).toBe(20_000);
    expect(credit.body.data.currentInventoryValueCents).toBe(10_000);
    expect(credit.body.data.availableInventoryCents).toBe(10_000);
    expect(credit.body.data.maxCashDebtCents).toBe(10_000);
    expect(credit.body.data.overDebtLimit).toBe(false);
  });

  it('lets a seller clear a balance directly by card', async () => {
    const s = await scenario('p3repay', { unitValue: 1000, split: 65, qty: 10 });
    await request(app)
      .post(`/api/v1/checkouts/${s.checkoutId}/sales`)
      .set(...bearer(s.sellerToken))
      .send({ quantitySold: 4, saleAmountCents: 4000, paymentRail: 'cash' });

    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(s.sellerToken));
    const debtId = debts.body.data.debts[0].id as string;
    const owed = debts.body.data.totalOutstandingCents as number;

    // Measured as a delta: the ledger is shared across every test in this file.
    const cashBefore = await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'cash' });

    const repay = await request(app)
      .post(`/api/v1/debts/${debtId}/repay`)
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p3_repay')
      .send({ amountCents: owed });
    expect(repay.status).toBe(200);
    expect(repay.body.data.outstandingCents).toBe(0);

    // Real money arrived this time, so platform cash rises and the receivable clears.
    const cashAfter = await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'cash' });
    expect(cashAfter - cashBefore).toBe(owed);
    expect(
      await ledgerService.balanceOf({ ownerType: 'user', ownerId: s.sellerId, accountType: 'receivable' }),
    ).toBe(0);
  });

  it('starts new sellers at low trust and only raises it with completed consignments', async () => {
    const sellerId = await seedUser({
      authProviderId: 'p3trust|seller',
      roles: ['seller'],
      tier: 'bronze',
    });
    // No history at all → the floor, not the ceiling. Under v1 this was 100/100.
    const fresh = await request(app).get(`/api/v1/trust-scores/seller/${sellerId}`);
    expect(fresh.body.data.score).toBe(40);
  });
});
