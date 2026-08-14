import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel, CityModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { HubModel } from '../src/modules/consignment/consignment.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * PHASE 5 — TAX AND COMPLIANCE. Exit criteria: tax is calculated, collected and reportable, and
 * sellers can retrieve their tax documents.
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

/** A hub in a jurisdiction with a configured sales-tax rate. */
async function scenario(
  prefix: string,
  opts: { unitValue: number; split: number; qty: number; taxBps?: number | null },
) {
  const citySlug = `${prefix}-city`;
  await CityModel.create({
    slug: citySlug,
    name: prefix,
    // Unique per scenario — otherwise two fixtures share a filing jurisdiction and the
    // remittance report (correctly) aggregates both.
    state: prefix.toUpperCase().slice(0, 8),
    status: 'live',
    sales_tax_bps: opts.taxBps ?? null,
    tax_registration_id: opts.taxBps ? `REG-${prefix}` : null,
  });

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
  // The hub's city decides the tax jurisdiction — that's where the sale happens.
  await HubModel.updateOne({ _id: hubId }, { $set: { city_slug: citySlug } });
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
      qrToken: hub.body.data.token,
    });

  return {
    hubToken,
    sellerToken,
    sellerId,
    businessId,
    hubId,
    citySlug,
    checkoutId: checkout.body.data.id as string,
  };
}

describe('marketplace facilitator sales tax (Phase 5 exit)', () => {
  it('charges tax on top of the sale, holds it as a liability, and never splits it', async () => {
    // 8.5% sales tax.
    const s = await scenario('p5tax', { unitValue: 1000, split: 65, qty: 10, taxBps: 850 });

    const intent = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p5tax')
      .send({ checkoutId: s.checkoutId, quantity: 3 });
    expect(intent.status).toBe(201);

    // $30 sale + 8.5% = $2.55 tax → the customer is charged $32.55.
    const charge = fakeStripe.platformCharges.at(-1)!;
    expect(charge.amountCents).toBe(3255);

    // The customer sees tax itemised, not folded into the price.
    const pay = await request(app).get(`/api/v1/pay/${intent.body.data.payToken}`);
    expect(pay.body.data.amountCents).toBe(3000);
    expect(pay.body.data.taxCents).toBe(255);
    expect(pay.body.data.totalCents).toBe(3255);

    const transfersBefore = fakeStripe.transfers.length;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    // CRITICAL: the split applies to the PRE-TAX amount. Tax is not distributable.
    // $30 − 8% fee ($2.40) = $27.60 → seller $17.94, hub $9.66. Unchanged by tax.
    const legs = fakeStripe.transfers
      .slice(transfersBefore)
      .map((t) => t.amountCents)
      .sort((a, b) => a - b);
    expect(legs).toEqual([966, 1794]);

    // Tax sits as a liability — the state's money, not revenue.
    expect(
      await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'tax_payable' }),
    ).toBe(255);
    expect(
      await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'fee_revenue' }),
    ).toBe(240);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('collects nothing in a jurisdiction we are not registered in', async () => {
    // Fail-closed: collecting tax you are not registered to collect is its own violation.
    const s = await scenario('p5notax', { unitValue: 1000, split: 65, qty: 5, taxBps: null });

    const intent = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p5notax')
      .send({ checkoutId: s.checkoutId, quantity: 2 });

    const charge = fakeStripe.platformCharges.at(-1)!;
    expect(charge.amountCents).toBe(2000); // no tax added
    expect(intent.body.data.amountCents).toBe(2000);
  });

  it('reports the open liability per jurisdiction and discharges it on remittance', async () => {
    const s = await scenario('p5rem', { unitValue: 1000, split: 65, qty: 10, taxBps: 1000 });
    await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p5rem')
      .send({ checkoutId: s.checkoutId, quantity: 4 });
    const charge = fakeStripe.platformCharges.at(-1)!;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    const financeId = await seedUser({ authProviderId: 'p5rem|fin', roles: ['ops_finance'] });
    const finToken = await mintToken('p5rem|fin');
    void financeId;

    const report = await request(app)
      .get('/api/v1/tax/remittance')
      .set(...bearer(finToken));
    expect(report.status).toBe(200);
    const jur = report.body.data.jurisdictions.find((j: { jurisdiction: string }) => j.jurisdiction === 'P5REM');
    expect(jur.taxCents).toBe(400); // 10% of $40
    expect(jur.registrationId).toBe('REG-p5rem');

    // Filing discharges the liability and moves the state's money out.
    const remit = await request(app)
      .post('/api/v1/tax/remittance')
      .set(...bearer(finToken))
      .send({ jurisdiction: 'P5REM', reference: 'FILING-2026-Q1' });
    expect(remit.status).toBe(200);
    expect(remit.body.data.totalCents).toBe(400);

    // Nothing left open for that jurisdiction.
    const after = await request(app).get('/api/v1/tax/remittance').set(...bearer(finToken));
    const stillOpen = after.body.data.jurisdictions.find(
      (j: { jurisdiction: string }) => j.jurisdiction === 'P5REM',
    );
    expect(stillOpen).toBeUndefined();

    const recon = await ledgerService.reconcile();
    expect(recon.drifted).toHaveLength(0);
    expect(recon.unbalancedTransactions).toHaveLength(0);
  });
});

describe('tax statements (Phase 5 exit)', () => {
  it('gives a seller a retrievable annual statement', async () => {
    const s = await scenario('p5stmt', { unitValue: 1000, split: 65, qty: 10, taxBps: 500 });
    await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p5stmt')
      .send({ checkoutId: s.checkoutId, quantity: 5 });
    const charge = fakeStripe.platformCharges.at(-1)!;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    const year = new Date().getUTCFullYear();
    const stmt = await request(app)
      .get(`/api/v1/tax/statements/seller?year=${year}`)
      .set(...bearer(s.sellerToken));

    expect(stmt.status).toBe(200);
    expect(stmt.body.data.year).toBe(year);
    expect(stmt.body.data.digitalGrossCents).toBe(5000);
    // Tax was collected BY THE PLATFORM — reported so the seller's books reconcile, but it is
    // explicitly not their income.
    expect(stmt.body.data.salesTaxCollectedByPlatformCents).toBe(250);
    expect(stmt.body.data.note).toMatch(/marketplace facilitator/i);
  });

  it('gives a hub its own annual statement, and refuses someone else’s', async () => {
    const s = await scenario('p5hstmt', { unitValue: 1000, split: 65, qty: 6, taxBps: null });
    const year = new Date().getUTCFullYear();

    const mine = await request(app)
      .get(`/api/v1/tax/statements/hub/${s.hubId}?year=${year}`)
      .set(...bearer(s.hubToken));
    expect(mine.status).toBe(200);
    expect(mine.body.data.subjectId).toBe(s.hubId);

    const other = await scenario('p5hstmt2', { unitValue: 500, split: 60, qty: 2, taxBps: null });
    const stolen = await request(app)
      .get(`/api/v1/tax/statements/hub/${s.hubId}?year=${year}`)
      .set(...bearer(other.hubToken));
    expect(stolen.status).toBe(403);
  });
});

describe('KYC scaled to value at risk (Phase 5)', () => {
  it('requires a higher tier before a seller may hold high-value stock', async () => {
    const citySlug = 'p5kyc-city';
    await CityModel.create({
      slug: citySlug, name: 'p5kyc', state: 'KY', status: 'live', sales_tax_bps: null,
    });
    const cat = await CategoryModel.create({
      slug: 'p5kyc-cat', name: 'p5kyc', top_level_tab: 'shopping', requires_license: false,
    });
    await seedUser({ authProviderId: 'p5kyc|hub', roles: ['vendor', 'hub'] });
    const hubToken = await mintToken('p5kyc|hub');
    const biz = await request(app).post('/api/v1/businesses').set(...bearer(hubToken))
      .send({ name: 'KYC Hub', categoryId: String(cat._id), isHub: true });
    const hub = await request(app).post('/api/v1/hubs').set(...bearer(hubToken))
      .send({ businessId: biz.body.data.id });
    await request(app).patch(`/api/v1/hubs/${hub.body.data.id}/approval-policy`)
      .set(...bearer(hubToken)).send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });
    const product = await request(app).post(`/api/v1/hubs/${hub.body.data.id}/products`)
      .set(...bearer(hubToken))
      .send({ name: 'Pricey', unitValueCents: 5000, consignmentSplitPercent: 65,
        returnWindowHours: 72, quantityAvailable: 100 });

    // Silver caps at $1,000 of stock, and over $1,000 requires Gold.
    await seedUser({ authProviderId: 'p5kyc|seller', roles: ['seller'], tier: 'silver' });
    const sellerToken = await mintToken('p5kyc|seller');
    await request(app).post('/api/v1/seller-agreement/accept').set(...bearer(sellerToken))
      .send({ version: SELLER_AGREEMENT_VERSION });

    // 30 × $50 = $1,500 — beyond what Silver identity supports.
    const res = await request(app).post('/api/v1/checkouts').set(...bearer(sellerToken))
      .send({ productId: product.body.data.id, quantity: 30,
        conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken: hub.body.data.token });
    expect(res.status).toBe(403);
    // The seller is told how to unlock more, not just refused. Matches the promise rather than the
    // exact prose, which has been reworded (tier label, then the A-3 Trust band).
    expect(res.body.error.message).toMatch(/verify your identity|trust score|raise your limit/i);
  });
});
