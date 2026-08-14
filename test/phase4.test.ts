import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { setStorageGateway } from '../src/integrations/storage';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { InventoryCheckoutModel } from '../src/modules/consignment/consignment.model';
import { consignmentService } from '../src/modules/consignment/consignment.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStorageGateway, FakeStripeGateway } from './fakes';

/**
 * Phase 4 exit criterion: "a seller checks out, cannot oversell, sells, returns, settles with an
 * itemized split payout, and a dispute correctly gates a Trust Score change."
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
  // Fake storage: deterministic presigned URLs, no R2 credentials.
  setStorageGateway(new FakeStorageGateway());
});

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

/** Enable a connected account (charges + payouts) via the account.updated webhook. */
async function enablePayouts(ownerType: 'user' | 'business', ownerId: string) {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: ownerType,
    owner_id: ownerId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
  return acct!.stripe_account_id;
}

async function openCategory(slug: string): Promise<string> {
  const c = await CategoryModel.create({
    slug,
    name: slug,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  return String(c._id);
}

/**
 * A hub (vendor+hub roles) with a payout-enabled connected account, and one product.
 *
 * By default the hub auto-approves everything. Since Phase 3, trust is EARNED — a brand-new seller
 * starts at 40 and only reaches the 85 auto-approve floor after ~4 clean consignments — so without
 * this every test would be implicitly testing the approval queue. Tests that are actually about
 * approvals set their own policy via `approvalPolicy`.
 */
async function makeHubWithProduct(
  prefix: string,
  opts: {
    quantity: number;
    split: number;
    unitValue: number;
    approvalPolicy?: { autoApproveMinTrust?: number; autoApproveMaxValueCents?: number | null };
  },
) {
  const categoryId = await openCategory(`${prefix}-cat`);
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
  const hubId = hub.body.data.id as string;
  const qrToken = hub.body.data.token as string;

  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send(opts.approvalPolicy ?? { autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  const product = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: 'Handmade Mug',
      unitValueCents: opts.unitValue,
      consignmentSplitPercent: opts.split,
      returnWindowHours: 72,
      quantityAvailable: opts.quantity,
    });
  return { hubToken, businessId, hubId, qrToken, productId: product.body.data.id as string };
}

/**
 * A verified seller with a payout-enabled connected account.
 *
 * Defaults to GOLD because Phase 3 credit limits cap Bronze at $200 of held stock — most tests here
 * are about lifecycle mechanics, not credit, so they need headroom. Credit-limit tests pass an
 * explicit lower tier.
 */
async function makeSeller(prefix: string, tier: 'bronze' | 'silver' | 'gold' = 'gold') {
  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier,
  });
  const token = await mintToken(`${prefix}|seller`);
  await request(app)
    .post('/api/v1/payments/connect/onboard')
    .set(...bearer(token));
  await enablePayouts('user', sellerId);
  // Accept the bailment Seller Agreement.
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return { sellerId, token };
}

describe('storage presigned upload', () => {
  it('issues a presigned upload URL for a condition photo', async () => {
    await seedUser({ authProviderId: 'p4|uploader', roles: ['seller'] });
    const token = await mintToken('p4|uploader');
    const res = await request(app)
      .post('/api/v1/storage/upload-url')
      .set(...bearer(token))
      .send({ purpose: 'condition_photo', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.data.uploadUrl).toContain('r2.test');
    expect(res.body.data.publicUrl).toContain('cdn.test');
  });

  it('rejects an unsupported content type', async () => {
    const token = await mintToken('p4|uploader');
    const res = await request(app)
      .post('/api/v1/storage/upload-url')
      .set(...bearer(token))
      .send({ purpose: 'condition_photo', contentType: 'application/pdf' });
    expect(res.status).toBe(422);
  });
});

describe('consignment lifecycle (Phase 4 exit)', () => {
  it('checks out, blocks oversell, sells, returns, and settles with an itemized split payout', async () => {
    const { businessId, qrToken, productId } = await makeHubWithProduct('p4c', {
      quantity: 10,
      split: 70,
      unitValue: 1000,
    });
    const { sellerId, token: sellerToken } = await makeSeller('p4c');

    // Checkout 5 units (requires QR token + accepted agreement + Bronze tier).
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 5, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    expect(checkout.status).toBe(201);
    const checkoutId = checkout.body.data.id as string;
    expect(checkout.body.data.quantity).toBe(5);

    // Oversell guard: reporting 6 sold against 5 checked out is rejected.
    const oversell = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 6, saleAmountCents: 6000 });
    expect(oversell.status).toBe(409);
    expect(oversell.body.error.code).toBe('OVERSELL');

    // Sell 4 units for 5000c total.
    const sale = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 4, saleAmountCents: 5000, loggedVia: 'manual' });
    expect(sale.status).toBe(201);
    expect(sale.body.data.remaining).toBe(1);

    // A second sale of 2 would exceed the remaining 1 → blocked.
    const oversell2 = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 2, saleAmountCents: 2000 });
    expect(oversell2.status).toBe(409);

    // Return the unsold unit → triggers settlement.
    const transfersBefore = fakeStripe.transfers.length;
    const ret = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/return`)
      .set(...bearer(sellerToken))
      .send({
        quantityReturned: 1,
        conditionPhotoUrl: 'https://cdn.test/r/1.jpg',
        conditionAssessment: 'good',
      });
    expect(ret.status).toBe(200);

    // Itemized split: gross 5000, platform fee 10% = 500, distributable 4500,
    // seller 70% = 3150, hub = 1350.
    expect(ret.body.data.grossSalesCents).toBe(5000);
    expect(ret.body.data.platformFeeCents).toBe(500);
    expect(ret.body.data.sellerNetCents).toBe(3150);
    expect(ret.body.data.hubShareCents).toBe(1350);

    // Phase 0 solvency guard: these sales were CASH, so the platform never collected the $50 it
    // would be splitting. It therefore records the amounts as owed and transfers NOTHING —
    // previously it disbursed both legs out of platform capital. (Before the guard this asserted
    // `transfersBefore + 2`; the digital rail will restore real transfers with collected funds.)
    expect(fakeStripe.transfers.length).toBe(transfersBefore);

    // Settlement is retrievable, the checkout is settled, and the record is explicit that the
    // money is owed rather than paid.
    const settlement = await request(app)
      .get(`/api/v1/checkouts/${checkoutId}/settlement`)
      .set(...bearer(sellerToken));
    expect(settlement.status).toBe(200);
    expect(settlement.body.data.sellerNetCents).toBe(3150);
    expect(settlement.body.data.fundingSource).toBe('unfunded');
    expect(settlement.body.data.sellerPayoutStatus).toBe('awaiting_funds');
    expect(settlement.body.data.hubPayoutStatus).toBe('awaiting_funds');

    // Trust after ONE on-time settlement with no disputes. Under the v2 confidence ramp (Phase 3)
    // this is 54, not 100: the behaviour is perfect, but one completion is not yet evidence of a
    // reliable seller. Full trust is reached after ~5 clean consignments.
    const trust = await request(app).get(`/api/v1/trust-scores/seller/${sellerId}`);
    expect(trust.body.data.score).toBe(54);
    void businessId;
  });

  it('blocks checkout without an accepted Seller Agreement and with a bad QR token', async () => {
    const { qrToken, productId } = await makeHubWithProduct('p4g', {
      quantity: 5,
      split: 60,
      unitValue: 500,
    });
    // Seller who has NOT accepted the agreement.
    const sellerId = await seedUser({
      authProviderId: 'p4g|seller',
      roles: ['seller'],
      tier: 'bronze',
    });
    const token = await mintToken('p4g|seller');
    void sellerId;

    const noAgreement = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    expect(noAgreement.status).toBe(422);
    expect(noAgreement.body.error.code).toBe('AGREEMENT_REQUIRED');

    await request(app)
      .post('/api/v1/seller-agreement/accept')
      .set(...bearer(token))
      .send({ version: SELLER_AGREEMENT_VERSION });
    const badQr = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({
        productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: 'wrong-token',
      });
    expect(badQr.status).toBe(403);
  });

  it('blocks checkout for a seller below the Bronze tier', async () => {
    const { qrToken, productId } = await makeHubWithProduct('p4t', {
      quantity: 5,
      split: 60,
      unitValue: 500,
    });
    await seedUser({ authProviderId: 'p4t|seller', roles: ['seller'] }); // tier0
    const token = await mintToken('p4t|seller');
    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TIER_TOO_LOW');
  });
});

describe('dispute gates a Trust Score change (FR-10.3)', () => {
  it('leaves the score unchanged on open, and only changes it after resolution', async () => {
    const { qrToken, productId } = await makeHubWithProduct('p4d', {
      quantity: 10,
      split: 70,
      unitValue: 1000,
    });
    const { sellerId, token: sellerToken } = await makeSeller('p4d');

    // Seller checks out, sells all, returns 0 → on-time settlement → score 100.
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = checkout.body.data.id as string;
    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 2, saleAmountCents: 2000 });
    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/return`)
      .set(...bearer(sellerToken))
      .send({ quantityReturned: 0 });

    // v2 ramp: one clean completion earns 54, not full trust.
    const before = await request(app).get(`/api/v1/trust-scores/seller/${sellerId}`);
    expect(before.body.data.score).toBe(54);

    // A customer opens a dispute against the seller.
    await seedUser({ authProviderId: 'p4d|complainant', roles: ['customer'] });
    const complainant = await mintToken('p4d|complainant');
    const dispute = await request(app)
      .post('/api/v1/disputes')
      .set(...bearer(complainant))
      .send({
        subjectType: 'seller',
        subjectId: sellerId,
        refType: 'checkout',
        refId: checkoutId,
        note: 'item not as described',
      });
    expect(dispute.status).toBe(201);
    const disputeId = dispute.body.data.id as string;

    // Score is NOT changed pre-emptively on open (FR-10.3).
    const during = await request(app).get(`/api/v1/trust-scores/seller/${sellerId}`);
    expect(during.body.data.score).toBe(54);

    // Admin resolves upheld → the score change is applied only now.
    await seedUser({ authProviderId: 'p4d|admin', roles: ['admin'] });
    const admin = await mintToken('p4d|admin');
    const resolve = await request(app)
      .post(`/api/v1/disputes/${disputeId}/resolve`)
      .set(...bearer(admin))
      .send({ outcome: 'upheld', resolution: 'refund issued' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.status).toBe('resolved');

    const after = await request(app).get(`/api/v1/trust-scores/seller/${sellerId}`);
    // Behavioural: 100 − 25·(1 upheld / 1 checkout) + 10·onTimeRate(1) = 85.
    // v2 ramp with 1 completion (confidence 0.2): 40 + (85 − 40)·0.2 = 49.
    // The point of the test still holds — the upheld dispute drops the score (54 → 49).
    expect(after.body.data.score).toBe(49);
    expect(after.body.data.score).toBeLessThan(before.body.data.score);
  });
});

describe('consignment agreement lifecycle (R14/R15/R17/R18)', () => {
  // A hub that lists a product WITH an owner-set term + minimum authorized price.
  async function makeTermedProduct(
    prefix: string,
    extra: Record<string, unknown>,
  ): Promise<{ hubToken: string; hubId: string; qrToken: string; productId: string }> {
    const categoryId = await openCategory(`${prefix}-cat`);
    await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'] });
    const hubToken = await mintToken(`${prefix}|hub`);
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(hubToken))
      .send({ name: `${prefix} Hub`, categoryId, isHub: true });
    const businessId = biz.body.data.id as string;
    await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(hubToken));
    await enablePayouts('business', businessId);
    const hub = await request(app).post('/api/v1/hubs').set(...bearer(hubToken)).send({ businessId });
    // These tests are about term/price lifecycle, not the approval queue (Phase 3 earned trust
    // would otherwise park every new seller's checkout in it).
    await request(app)
      .patch(`/api/v1/hubs/${hub.body.data.id}/approval-policy`)
      .set(...bearer(hubToken))
      .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });
    const product = await request(app)
      .post(`/api/v1/hubs/${hub.body.data.id}/products`)
      .set(...bearer(hubToken))
      .send({
        name: 'Termed Mug',
        unitValueCents: 2000,
        consignmentSplitPercent: 70,
        returnWindowHours: 72,
        quantityAvailable: 5,
        ...extra,
      });
    return {
      hubToken,
      hubId: hub.body.data.id as string,
      qrToken: hub.body.data.token as string,
      productId: product.body.data.id as string,
    };
  }

  it('R14/R18: owner sets a 30-day term + min price; checkout snapshots them with a derived expiry', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4life-a', {
      termDays: 30,
      minimumAuthorizedPriceCents: 1500,
    });
    const { token } = await makeSeller('p4life-a');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-a-1')
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    expect(co.status).toBe(201);
    expect(co.body.data.termDays).toBe(30);
    expect(co.body.data.minimumAuthorizedPriceCents).toBe(1500);
    expect(co.body.data.currentUnitPriceCents).toBe(2000);
    // expires_at ≈ 30 days out.
    const daysOut = (new Date(co.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
    expect(co.body.data.returnTerms.returnWindowDays).toBe(14);
  });

  it('R18: a sale below the minimum authorized price is blocked (needs owner approval)', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4life-b', {
      minimumAuthorizedPriceCents: 1500,
    });
    const { token } = await makeSeller('p4life-b');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-b-1')
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    // Selling one unit for 1000 (< 1500 floor) → blocked.
    const below = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-b-sale-lo')
      .send({ quantitySold: 1, saleAmountCents: 1000 });
    expect(below.status).toBe(422);

    // At/above the floor → allowed.
    const ok = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-b-sale-ok')
      .send({ quantitySold: 1, saleAmountCents: 1600 });
    expect(ok.status).toBe(201);
  });

  it('R18: reduce-price is floored at the minimum; an allowed reduction updates the price', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4life-c', {
      minimumAuthorizedPriceCents: 1500,
    });
    const { token } = await makeSeller('p4life-c');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-c-1')
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    const below = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/reduce-price`)
      .set(...bearer(token))
      .send({ unitPriceCents: 1000 });
    expect(below.status).toBe(422);

    const ok = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/reduce-price`)
      .set(...bearer(token))
      .send({ unitPriceCents: 1700 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.currentUnitPriceCents).toBe(1700);
  });

  it('R15/R17: the sweep sends 14/7/3 notices, then on expiry moves unsold units to Return-Pending', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4life-d', { termDays: 30 });
    const { token } = await makeSeller('p4life-d');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-d-1')
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    // Approaching expiry (3 days out) → the seller is noticed; the crossed thresholds are recorded.
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { expires_at: new Date(Date.now() + 3 * 86_400_000) } },
    );
    const r1 = await consignmentService.sweepExpiryNotices();
    expect(r1.noticed).toBeGreaterThanOrEqual(1);
    const afterNotice = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(afterNotice!.notices_sent).toEqual(expect.arrayContaining([14, 7, 3]));

    // On expiry with unsold units → Return-Pending (never auto-kept).
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { expires_at: new Date(Date.now() - 60_000) } },
    );
    const r2 = await consignmentService.sweepExpiryNotices();
    expect(r2.returnPending).toBeGreaterThanOrEqual(1);
    const afterExpiry = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(afterExpiry!.status).toBe('return_pending');
    expect(afterExpiry!.return_pending_at).toBeTruthy();
  });

  it('R15: Extend resets the expiry and re-arms notices; End moves to Return-Pending', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4life-e', { termDays: 30 });
    const { token } = await makeSeller('p4life-e');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-e-1')
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { notices_sent: [14, 7], expires_at: new Date(Date.now() + 3 * 86_400_000) } },
    );

    const extend = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/extend`)
      .set(...bearer(token))
      .send({ termDays: 60 });
    expect(extend.status).toBe(200);
    const daysOut = (new Date(extend.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(59);
    const extended = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(extended!.notices_sent).toEqual([]); // re-armed

    // §37: ending gives notice; the status stays active until the period elapses.
    const end = await request(app).post(`/api/v1/checkouts/${checkoutId}/end`).set(...bearer(token));
    expect(end.status).toBe(200);
    const noticed = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(noticed!.termination_effective_at).toBeTruthy();
  });

  /**
   * §37 — ending is a NOTICE, not a repossession. The other side has stock on a shelf or goods in a
   * van; the agreed period is what stops either party stranding the other.
   */
  it('§37: gives notice with an effective date, and the sweep completes it when it elapses', async () => {
    // $20 × 3 = $60 total → the low-value band, 3 days' notice.
    const { qrToken, productId } = await makeTermedProduct('p4term', { termDays: 30 });
    const { token } = await makeSeller('p4term');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4term-1')
      .send({ productId, quantity: 3, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    const ended = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/end`)
      .set(...bearer(token));
    expect(ended.status).toBe(200);

    // Still ACTIVE — notice given, not yet effective. Ending on the spot would strand the hub.
    const noticed = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(noticed!.status).toBe('active');
    expect(noticed!.termination_notice_days).toBe(3);
    expect(noticed!.terminated_by).toBe('seller');
    const days =
      (noticed!.termination_effective_at!.getTime() - noticed!.termination_notice_at!.getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(3);

    // A second notice is refused — one agreement cannot have two end dates.
    const again = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/end`)
      .set(...bearer(token));
    expect(again.status).toBe(409);

    // Once the period elapses, the sweep completes it.
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { termination_effective_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await consignmentService.sweepExpiryNotices();
    expect(swept.terminated).toBeGreaterThanOrEqual(1);
    const done = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(done!.status).toBe('return_pending');
  });

  it('§37: scales the notice period to what is being recalled', async () => {
    // $200 × 5 = $1,000 → above the standard band, so 14 days rather than 3.
    const { qrToken, productId } = await makeTermedProduct('p4term-hi', {
      termDays: 30,
      unitValueCents: 20_000,
    });
    const { token } = await makeSeller('p4term-hi');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4term-hi-1')
      .send({ productId, quantity: 5, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });

    await request(app)
      .post(`/api/v1/checkouts/${co.body.data.id as string}/end`)
      .set(...bearer(token))
      .expect(200);
    const row = await InventoryCheckoutModel.findById(co.body.data.id).lean();
    expect(row!.termination_notice_days).toBe(14);
  });

  /**
   * §39 — renewal is announced before it happens AND can still be stopped after the announcement.
   * That second half is the difference between a notice and a formality.
   */
  it('§39: warns before an automatic renewal, then renews in place', async () => {
    const { qrToken, productId } = await makeTermedProduct('p4renew', {
      termDays: 30,
      autoRenew: true,
      autoRenewTerm: 30,
    });
    const { token } = await makeSeller('p4renew');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4renew-1')
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;
    expect((await InventoryCheckoutModel.findById(checkoutId).lean())!.auto_renew).toBe(true);

    // Two days out → the pre-renewal warning fires, once.
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { expires_at: new Date(Date.now() + 2 * 86_400_000) } },
    );
    await consignmentService.sweepExpiryNotices();
    const warned = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(warned!.renewal_notice_sent_for).toBeTruthy();

    // On expiry with stock left → renewed, never Return-Pending.
    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { expires_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await consignmentService.sweepExpiryNotices();
    expect(swept.renewed).toBeGreaterThanOrEqual(1);
    const renewed = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(renewed!.status).toBe('active');
    expect(renewed!.renewal_count).toBe(1);
    expect(renewed!.expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it('§39: either party can switch renewal off, and then it expires normally', async () => {
    const { qrToken, productId, hubToken } = await makeTermedProduct('p4renew-off', {
      termDays: 30,
      autoRenew: true,
      autoRenewTerm: 30,
    });
    const { token } = await makeSeller('p4renew-off');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4renew-off-1')
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    // The HUB turns it off — either party may, which is the §39 requirement.
    const off = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/auto-renew`)
      .set(...bearer(hubToken))
      .send({ enabled: false });
    expect(off.status).toBe(200);
    const row = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(row!.auto_renew).toBe(false);
    expect(row!.auto_renew_cancelled_by).toBe('hub');

    await InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { expires_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await consignmentService.sweepExpiryNotices();
    expect(swept.renewed).toBe(0);
    expect((await InventoryCheckoutModel.findById(checkoutId).lean())!.status).toBe('return_pending');
  });

  /** §36 — changing the commission at term end, the one end-of-term option with no path before. */
  it('§36: the hub changes the split going forward, but never after units have sold', async () => {
    const { qrToken, productId, hubToken } = await makeTermedProduct('p4comm', { termDays: 30 });
    const { token } = await makeSeller('p4comm');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4comm-1')
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    // The seller cannot set their own split.
    const bySeller = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/commission`)
      .set(...bearer(token))
      .send({ splitPercent: 95 });
    expect(bySeller.status).toBe(403);

    const byHub = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/commission`)
      .set(...bearer(hubToken))
      .send({ splitPercent: 80 });
    expect(byHub.status).toBe(200);
    expect((await InventoryCheckoutModel.findById(checkoutId).lean())!.consignment_split_percent).toBe(80);

    // Once a unit has sold at the agreed split, changing it would rewrite money both sides counted.
    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(token))
      .send({ quantitySold: 1, saleAmountCents: 2000 })
      .expect(201);
    const tooLate = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/commission`)
      .set(...bearer(hubToken))
      .send({ splitPercent: 50 });
    expect(tooLate.status).toBe(422);
    expect(tooLate.body.error.message).toMatch(/already sold/i);
  });

  /**
   * §37: termination is MUTUAL. The hub owns the goods, so it must be able to recall them —
   * otherwise a no-limit consignment has no exit for the owner at all, and their stock can be held
   * indefinitely by a seller who simply never acts.
   */
  it('§37: the HUB owner can end a consignment, and a stranger cannot', async () => {
    const { qrToken, productId, hubToken } = await makeTermedProduct('p4life-f', {
      termDays: 30,
    });
    const { token } = await makeSeller('p4life-f');
    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(token))
      .set('Idempotency-Key', 'p4life-f-1')
      .send({ productId, quantity: 1, conditionPhotoUrl: 'https://cdn.test/c.jpg', qrToken });
    const checkoutId = co.body.data.id as string;

    // A third-party seller with no relationship to this checkout is refused.
    const { token: stranger } = await makeSeller('p4life-f-x');
    const denied = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/end`)
      .set(...bearer(stranger));
    expect(denied.status).toBe(403);

    // The hub owner — whose inventory it is — can.
    const ended = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/end`)
      .set(...bearer(hubToken));
    expect(ended.status).toBe(200);

    const row = await InventoryCheckoutModel.findById(checkoutId).lean();
    expect(row!.terminated_by).toBe('hub');
    expect(row!.termination_effective_at).toBeTruthy();
  });
});

/**
 * H-03 approval gate (FR-8.4). The hub is accepting real liability when goods leave the building,
 * so a reservation becomes a live checkout only via the auto-approve rule or an explicit decision.
 */
describe('hub checkout approval gate (H-03)', () => {
  it('auto-approves a trusted seller inside the value cap, and never queues it', async () => {
    const { hubToken, hubId, qrToken, productId } = await makeHubWithProduct('p4auto', {
      quantity: 10,
      split: 70,
      unitValue: 1000, // 2 × $10 = $20, well inside the $200 cap
      // Floor set to the newcomer's actual score so this isolates the VALUE-cap dimension.
      approvalPolicy: { autoApproveMinTrust: 40, autoApproveMaxValueCents: 20000 },
    });
    const { token: sellerToken } = await makeSeller('p4auto');

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 2, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.status).toBe('active');
    expect(checkout.body.data.autoApproved).toBe(true);

    const queue = await request(app)
      .get(`/api/v1/hubs/${hubId}/approvals`)
      .set(...bearer(hubToken));
    expect(queue.body.data).toHaveLength(0);
  });

  it('holds a reservation above the cap, blocks selling until approved, then releases it', async () => {
    const { hubToken, hubId, qrToken, productId } = await makeHubWithProduct('p4gate', {
      quantity: 10,
      split: 70,
      unitValue: 10_000, // 3 × $100 = $300, over the $200 auto-approve cap
      approvalPolicy: { autoApproveMinTrust: 85, autoApproveMaxValueCents: 20000 },
    });
    const { token: sellerToken } = await makeSeller('p4gate');

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 3, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.status).toBe('pending_approval');
    expect(checkout.body.data.autoApproved).toBe(false);
    const checkoutId = checkout.body.data.id as string;

    // Stock is held from the moment of request, so it can't be promised to someone else.
    const held = await request(app).get(`/api/v1/hubs/${hubId}/products`);
    expect(held.body.data[0].quantityAvailable).toBe(7);

    // It surfaces in the owner's queue with the signals the decision needs.
    const queue = await request(app)
      .get(`/api/v1/hubs/${hubId}/approvals`)
      .set(...bearer(hubToken));
    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].id).toBe(checkoutId);
    expect(queue.body.data[0].declaredValueCents).toBe(30_000);

    // Nothing can be sold from goods that never left the hub.
    const early = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 1, saleAmountCents: 10_000 });
    expect(early.status).toBe(409);

    const approved = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/approve`)
      .set(...bearer(hubToken));
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('active');

    const sale = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 1, saleAmountCents: 10_000 });
    expect(sale.status).toBe(201);

    // Already decided — a second approval is a no-op conflict, not a double release.
    const again = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/approve`)
      .set(...bearer(hubToken));
    expect(again.status).toBe(409);
  });

  it('returns held stock to the shelf on decline, and refuses a non-owner decision', async () => {
    const { hubToken, hubId, qrToken, productId } = await makeHubWithProduct('p4dec', {
      quantity: 10,
      split: 70,
      unitValue: 10_000,
      approvalPolicy: { autoApproveMinTrust: 85, autoApproveMaxValueCents: 20000 },
    });
    const { token: sellerToken } = await makeSeller('p4dec');

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 4, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    const checkoutId = checkout.body.data.id as string;
    expect(checkout.body.data.status).toBe('pending_approval');

    // A different hub owner cannot decide someone else's queue.
    const { hubToken: outsiderToken } = await makeHubWithProduct('p4out', {
      quantity: 1,
      split: 50,
      unitValue: 100,
    });
    const outsider = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/decline`)
      .set(...bearer(outsiderToken))
      .send({});
    expect(outsider.status).toBe(403);

    const declined = await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/decline`)
      .set(...bearer(hubToken))
      .send({ reason: 'Need to see ID first' });
    expect(declined.status).toBe(200);
    expect(declined.body.data.status).toBe('declined');

    // The hold is released — all 10 units are sellable again.
    const restocked = await request(app).get(`/api/v1/hubs/${hubId}/products`);
    expect(restocked.body.data[0].quantityAvailable).toBe(10);

    const queue = await request(app)
      .get(`/api/v1/hubs/${hubId}/approvals`)
      .set(...bearer(hubToken));
    expect(queue.body.data).toHaveLength(0);
  });
});

/**
 * PHASE 0 — SOLVENCY GUARD. A payout may only be funded by money the platform actually collected.
 * Cash sales go straight to the seller and never reach the platform balance, so settling them must
 * record the split as OWED without transferring platform capital. Regression cover for the bug that
 * silently disbursed real money on every consignment settlement.
 */
describe('settlement solvency guard (Phase 0)', () => {
  it('records the split but transfers nothing when the sale proceeds were never collected', async () => {
    const { qrToken, productId } = await makeHubWithProduct('p0guard', {
      quantity: 10,
      split: 65,
      unitValue: 1000,
    });
    const { token: sellerToken } = await makeSeller('p0guard');

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 4, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    const checkoutId = checkout.body.data.id as string;

    // Cash sale: money went to the seller on the street, never to the platform.
    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 4, saleAmountCents: 4000, loggedVia: 'manual' });

    const transfersBefore = fakeStripe.transfers.length;

    // Selling out auto-settles.
    const settlement = await request(app)
      .get(`/api/v1/checkouts/${checkoutId}/settlement`)
      .set(...bearer(sellerToken));
    expect(settlement.status).toBe(200);

    // THE GUARD: no platform money moved.
    expect(fakeStripe.transfers.length).toBe(transfersBefore);

    // The split is still calculated and recorded in full — it is owed, just not payable.
    // gross 4000 − 10% fee 400 = 3600 distributable → seller 65% = 2340, hub = 1260.
    expect(settlement.body.data.grossCents).toBe(4000);
    expect(settlement.body.data.platformFeeCents).toBe(400);
    expect(settlement.body.data.sellerNetCents).toBe(2340);
    expect(settlement.body.data.hubShareCents).toBe(1260);

    // And the record says plainly that nothing was disbursed.
    expect(settlement.body.data.fundingSource).toBe('unfunded');
    expect(settlement.body.data.collectedCents).toBe(0);
    expect(settlement.body.data.sellerPayoutStatus).toBe('awaiting_funds');
    expect(settlement.body.data.hubPayoutStatus).toBe('awaiting_funds');
    expect(settlement.body.data.payoutTiming).toContain('Not yet payable');
  });

  it('keeps the three shares reconciling exactly to gross even when unfunded', async () => {
    const { qrToken, productId } = await makeHubWithProduct('p0recon', {
      quantity: 10,
      split: 70,
      unitValue: 333, // deliberately awkward: forces rounding
    });
    const { token: sellerToken } = await makeSeller('p0recon');

    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(sellerToken))
      .send({ productId, quantity: 3, conditionPhotoUrl: 'https://cdn.test/c/1.jpg', qrToken });
    const checkoutId = checkout.body.data.id as string;

    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(sellerToken))
      .send({ quantitySold: 3, saleAmountCents: 999, loggedVia: 'manual' });

    const s = await request(app)
      .get(`/api/v1/checkouts/${checkoutId}/settlement`)
      .set(...bearer(sellerToken));
    const { grossCents, platformFeeCents, sellerNetCents, hubShareCents } = s.body.data;

    // No cent may be created or destroyed by the split, funded or not.
    expect(platformFeeCents + sellerNetCents + hubShareCents).toBe(grossCents);
  });
});
