import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { salePaymentsService } from '../src/modules/salepayments/salepayments.service';
import { SalePaymentModel } from '../src/modules/salepayments/salepayments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * PHASE 2 — THE DIGITAL RAIL. Exit criteria: a customer pays by card, the money lands on the
 * platform balance, splits reach the seller and hub, the ledger balances, and the platform earns a
 * real fee for the first time.
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

/** A payout-enabled hub with a product, and a Bronze seller already holding stock. */
async function scenario(
  prefix: string,
  opts: { unitValue: number; split: number; qty: number; minPrice?: number; payoutsForSeller?: boolean },
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

  // These tests are about the payment rail, not the approval queue. Since Phase 3 trust is earned,
  // a brand-new seller (40) sits below the default 85 auto-approve floor, so the hub is configured
  // to auto-approve — otherwise every checkout here would be stuck pending.
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
      ...(opts.minPrice ? { minimumAuthorizedPriceCents: opts.minPrice } : {}),
    });
  const productId = product.body.data.id as string;

  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier: 'bronze',
  });
  const sellerToken = await mintToken(`${prefix}|seller`);
  if (opts.payoutsForSeller !== false) {
    await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(sellerToken));
    await enablePayouts('user', sellerId);
  }
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

describe('digital rail (Phase 2 exit)', () => {
  it('collects a card payment to the platform, splits it three ways, and balances the ledger', async () => {
    const s = await scenario('p2rail', { unitValue: 1000, split: 65, qty: 10 });

    // The seller starts a sale: 3 units at $10 = $30.
    const intent = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_1')
      .send({ checkoutId: s.checkoutId, quantity: 3, customerEmail: 'buyer@test.dev' });
    expect(intent.status).toBe(201);
    expect(intent.body.data.amountCents).toBe(3000);
    expect(intent.body.data.payUrl).toContain('/pay/');

    // Separate charges: the money must land on the PLATFORM balance, not a connected account.
    const charge = fakeStripe.platformCharges.at(-1)!;
    expect(charge.amountCents).toBe(3000);

    // The customer's page needs no account and shows what they are buying.
    const pay = await request(app).get(`/api/v1/pay/${intent.body.data.payToken}`);
    expect(pay.status).toBe(200);
    expect(pay.body.data.amountCents).toBe(3000);
    expect(pay.body.data.productName).toBe('Soy Candle');

    const transfersBefore = fakeStripe.transfers.length;

    // The customer pays. ONLY the webhook may confirm that money arrived.
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    // Two split transfers left the platform in one transfer group.
    // $30 gross − 8% digital fee ($2.40) = $27.60 → seller 65% = $17.94, hub = $9.66.
    const legs = fakeStripe.transfers
      .slice(transfersBefore)
      .map((t) => t.amountCents)
      .sort((a, b) => a - b);
    expect(legs).toEqual([966, 1794]);

    // The platform earned a REAL fee, and retains exactly that after both payouts.
    expect(await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'fee_revenue' })).toBe(240);
    expect(await ledgerService.balanceOf({ ownerType: 'platform', accountType: 'cash' })).toBe(240);

    // Nothing is still owed to either party.
    expect(
      await ledgerService.balanceOf({ ownerType: 'user', ownerId: s.sellerId, accountType: 'payable' }),
    ).toBe(0);
    expect(
      await ledgerService.balanceOf({ ownerType: 'business', ownerId: s.businessId, accountType: 'payable' }),
    ).toBe(0);

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('is idempotent — a redelivered webhook cannot pay twice', async () => {
    const s = await scenario('p2dup', { unitValue: 500, split: 60, qty: 4 });
    await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_dup')
      .send({ checkoutId: s.checkoutId, quantity: 2 });
    const charge = fakeStripe.platformCharges.at(-1)!;

    const before = fakeStripe.transfers.length;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });
    const afterFirst = fakeStripe.transfers.length;
    expect(afterFirst).toBe(before + 2);

    // Stripe delivers webhooks more than once.
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });
    expect(fakeStripe.transfers.length).toBe(afterFirst);
  });

  it('reserves units at intent creation so the last item cannot be sold twice', async () => {
    const s = await scenario('p2resv', { unitValue: 1000, split: 65, qty: 2 });

    const first = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_r1')
      .send({ checkoutId: s.checkoutId, quantity: 2 });
    expect(first.status).toBe(201);

    // Every unit is held by the pending payment — a second sale is refused, not oversold.
    const second = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_r2')
      .send({ checkoutId: s.checkoutId, quantity: 1 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('OVERSELL');
  });

  it('releases held units when the customer never pays', async () => {
    const s = await scenario('p2exp', { unitValue: 1000, split: 65, qty: 3 });
    const intent = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_exp')
      .send({ checkoutId: s.checkoutId, quantity: 3 });

    await SalePaymentModel.updateOne(
      { _id: intent.body.data.id },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    expect(await salePaymentsService.expireStalePayments()).toBe(1);

    // The units are sellable again.
    const retry = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_exp2')
      .send({ checkoutId: s.checkoutId, quantity: 3 });
    expect(retry.status).toBe(201);
  });

  it('refuses a price below the owner-set minimum', async () => {
    const s = await scenario('p2min', { unitValue: 1000, split: 65, qty: 2, minPrice: 800 });
    const res = await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_min')
      .send({ checkoutId: s.checkoutId, quantity: 1, unitPriceCents: 500 });
    expect(res.status).toBe(422);
  });

  it('leaves an unpaid leg as a payable, then discharges it on retry', async () => {
    // The seller has NO payout account, so their split cannot be delivered at sale time.
    const s = await scenario('p2retry', { unitValue: 1000, split: 65, qty: 5, payoutsForSeller: false });
    await request(app)
      .post('/api/v1/sales/payment-intent')
      .set(...bearer(s.sellerToken))
      .set('Idempotency-Key', 'idem_p2_retry')
      .send({ checkoutId: s.checkoutId, quantity: 2 });
    const charge = fakeStripe.platformCharges.at(-1)!;
    await stripeEvent('payment_intent.succeeded', { id: charge.paymentIntentId });

    // $20 gross − 8% ($1.60) = $18.40 → seller 65% = $11.96 still owed, hub $6.44 paid.
    const owed = await ledgerService.balanceOf({
      ownerType: 'user',
      ownerId: s.sellerId,
      accountType: 'payable',
    });
    expect(owed).toBe(1196);

    // Money is never lost: the obligation is visible in the books and survives until settled.
    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });
});
