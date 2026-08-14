import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { paymentsService } from '../src/modules/payments/payments.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 1 exit criterion: "a customer can be charged, a connected account can receive a split
 * payout in test mode, reconciliation runs clean." Plus the KYC verification lifecycle, license
 * gating, and vendor CRUD + ownership. All money goes through an injected fake Stripe gateway.
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

async function accountIdFor(ownerId: string): Promise<string> {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'user',
    owner_id: ownerId,
  }).lean();
  return acct!.stripe_account_id;
}

describe('connected account onboarding', () => {
  it('a seller links a payout account (Stripe Connect hosted onboarding)', async () => {
    const sellerId = await seedUser({ authProviderId: 'p1|seller-onboard', roles: ['seller'] });
    const token = await mintToken('p1|seller-onboard');

    const onboard = await request(app)
      .post('/api/v1/payments/connect/onboard')
      .set(...bearer(token));
    expect(onboard.status).toBe(200);
    expect(onboard.body.data.url).toContain('connect.test');

    const acctId = await accountIdFor(sellerId);
    expect(acctId).toMatch(/^acct_/);
  });
});

describe('charge with split + reconciliation (Phase 1 exit)', () => {
  it('charges a customer, splits the platform fee, completes on webhook, and reconciles clean', async () => {
    const sellerId = await seedUser({ authProviderId: 'p1|seller-charge', roles: ['seller'] });
    const customerId = await seedUser({ authProviderId: 'p1|customer', roles: ['customer'] });
    const sellerToken = await mintToken('p1|seller-charge');
    const customerToken = await mintToken('p1|customer');

    // Seller onboards + account becomes enabled via account.updated webhook.
    await request(app)
      .post('/api/v1/payments/connect/onboard')
      .set(...bearer(sellerToken));
    const acctId = await accountIdFor(sellerId);
    fakeStripe.enableAccount(acctId);
    await stripeEvent('account.updated', { id: acctId });

    // Customer charges 1000c with a 100c tip; fee applies to the goods portion only.
    const charge = await request(app)
      .post('/api/v1/transactions')
      .set(...bearer(customerToken))
      .set('Idempotency-Key', 'idem-charge-1')
      .send({
        counterpartyType: 'seller',
        counterpartyId: sellerId,
        amountCents: 1000,
        tipCents: 100,
      });

    expect(charge.status).toBe(201);
    expect(charge.body.data.platformFeeCents).toBe(90); // floor((1000-100) * 0.10)
    expect(charge.body.data.counterpartyNetCents).toBe(910);

    const lastCharge = fakeStripe.lastCharge();
    expect(lastCharge?.applicationFeeCents).toBe(90);
    expect(lastCharge?.destinationAccountId).toBe(acctId);

    const paymentIntentRef = charge.body.data.paymentIntentRef as string;

    // Idempotent retry returns the cached response and does NOT create a second charge.
    const chargeCountBefore = fakeStripe.charges.length;
    const retry = await request(app)
      .post('/api/v1/transactions')
      .set(...bearer(customerToken))
      .set('Idempotency-Key', 'idem-charge-1')
      .send({
        counterpartyType: 'seller',
        counterpartyId: sellerId,
        amountCents: 1000,
        tipCents: 100,
      });
    expect(retry.status).toBe(201);
    expect(fakeStripe.charges.length).toBe(chargeCountBefore);

    // Webhook completes the transaction (pending → completed, then immutable).
    await stripeEvent('payment_intent.succeeded', { id: paymentIntentRef });
    const mine = await request(app)
      .get('/api/v1/transactions/mine')
      .set(...bearer(customerToken));
    expect(mine.status).toBe(200);
    expect(mine.body.data[0].status).toBe('completed');
    void customerId;

    // Reconciliation: feed Stripe balance matching our completed ledger → clean.
    fakeStripe.balance = [
      { id: 'txn_1', amountCents: 1000, type: 'charge', source: paymentIntentRef },
    ];
    const recon = await paymentsService.reconcile();
    expect(recon.ourTotal).toBe(1000);
    expect(recon.stripeTotal).toBe(1000);
    expect(recon.clean).toBe(true);
  });

  it('rejects a charge to a counterparty that cannot accept charges', async () => {
    const sellerId = await seedUser({ authProviderId: 'p1|seller-disabled', roles: ['seller'] });
    const sellerToken = await mintToken('p1|seller-disabled');
    const customerToken = await mintToken('p1|customer'); // existing customer

    await request(app)
      .post('/api/v1/payments/connect/onboard')
      .set(...bearer(sellerToken));
    // Account never enabled → charges_enabled stays false.
    const res = await request(app)
      .post('/api/v1/transactions')
      .set(...bearer(customerToken))
      .set('Idempotency-Key', 'idem-disabled-1')
      .send({ counterpartyType: 'seller', counterpartyId: sellerId, amountCents: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE');
  });
});

describe('KYC verification lifecycle', () => {
  it('starts an ID session (pending) and a verified webhook upgrades the tier to bronze', async () => {
    await seedUser({ authProviderId: 'p1|verify', roles: ['seller'] });
    const token = await mintToken('p1|verify');

    const start = await request(app)
      .post('/api/v1/verification/id-document')
      .set(...bearer(token));
    expect(start.status).toBe(200);
    const providerRef = start.body.data.providerReference as string;
    expect(providerRef).toMatch(/^vs_/);

    const before = await request(app)
      .get('/api/v1/verification/status')
      .set(...bearer(token));
    expect(before.body.data.currentTier).toBe('tier0');
    expect(before.body.data.pending.some((p: { type: string }) => p.type === 'id_document')).toBe(
      true,
    );

    await stripeEvent('identity.verification_session.verified', { id: providerRef });

    const after = await request(app)
      .get('/api/v1/verification/status')
      .set(...bearer(token));
    expect(after.body.data.currentTier).toBe('bronze');

    // The effective tier is reflected on the profile too.
    const me = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token));
    expect(me.body.data.verificationTier).toBe('bronze');
  });
});

describe('vendors: business CRUD, license gating, ownership', () => {
  it('gates going-live for a regulated category until a license is approved', async () => {
    const regulated = await CategoryModel.create({
      slug: 'p1-regulated',
      name: 'Regulated Food',
      top_level_tab: 'food',
      requires_license: true,
    });
    await seedUser({ authProviderId: 'p1|vendor-lic', roles: ['vendor'] });
    const token = await mintToken('p1|vendor-lic');

    const create = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Taco Truck', categoryId: String(regulated._id) });
    expect(create.status).toBe(201);
    const businessId = create.body.data.id as string;
    expect(create.body.data.canGoLive).toBe(false);

    const submit = await request(app)
      .post(`/api/v1/businesses/${businessId}/license-documents`)
      .set(...bearer(token))
      .send({ categoryId: String(regulated._id), documentUrl: 'https://docs.test/permit.pdf' });
    expect(submit.status).toBe(201);
    const licenseId = submit.body.data.id as string;

    // Still gated pre-approval.
    const midway = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(midway.body.data.canGoLive).toBe(false);

    await seedUser({ authProviderId: 'p1|admin-lic', roles: ['admin'] });
    const adminToken = await mintToken('p1|admin-lic');
    const review = await request(app)
      .post(`/api/v1/admin/license-documents/${licenseId}/review`)
      .set(...bearer(adminToken))
      .send({ approve: true });
    expect(review.status).toBe(200);

    const after = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(after.body.data.canGoLive).toBe(true);
  });

  it('prevents a vendor from editing another vendor’s business (403)', async () => {
    const category = await CategoryModel.create({
      slug: 'p1-open',
      name: 'Open',
      top_level_tab: 'services',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'p1|vendorA', roles: ['vendor'] });
    await seedUser({ authProviderId: 'p1|vendorB', roles: ['vendor'] });
    const tokenA = await mintToken('p1|vendorA');
    const tokenB = await mintToken('p1|vendorB');

    const create = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(tokenA))
      .send({ name: 'A Detailing', categoryId: String(category._id) });
    const businessId = create.body.data.id as string;

    const attempt = await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(tokenB))
      .send({ name: 'Hijacked' });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe('NOT_OWNER');
  });

  it('routes a category suggestion through admin approval, creating a category', async () => {
    const category = await CategoryModel.create({
      slug: 'p1-suggest-base',
      name: 'Base',
      top_level_tab: 'services',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'p1|vendor-suggest', roles: ['vendor'] });
    const token = await mintToken('p1|vendor-suggest');

    const create = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Suggester', categoryId: String(category._id) });
    const businessId = create.body.data.id as string;

    const suggestion = await request(app)
      .post('/api/v1/category-suggestions')
      .set(...bearer(token))
      .send({ businessId, proposedName: 'Mobile Knife Sharpening', justification: 'demand' });
    expect(suggestion.status).toBe(201);
    const suggestionId = suggestion.body.data.id as string;

    await seedUser({ authProviderId: 'p1|admin-suggest', roles: ['admin'] });
    const adminToken = await mintToken('p1|admin-suggest');
    const review = await request(app)
      .post(`/api/v1/admin/category-suggestions/${suggestionId}/review`)
      .set(...bearer(adminToken))
      .send({ approve: true, topLevelTab: 'services', requiresLicense: false });
    expect(review.status).toBe(200);
    expect(review.body.data.createdCategoryId).toBeTruthy();

    const cats = await request(app).get('/api/v1/catalog/categories');
    expect(cats.body.data.some((c: { slug: string }) => c.slug === 'mobile-knife-sharpening')).toBe(
      true,
    );
  });
});
