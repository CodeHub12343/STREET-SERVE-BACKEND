import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel, CityModel } from '../src/modules/catalog/catalog.model';
import { ProductModel } from '../src/modules/consignment/consignment.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { TrustScoreModel } from '../src/modules/trust/trust.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase A — "Correctness & honesty". These are the guards that stop the platform moving money on
 * terms nobody agreed to, and the surfaces that stop it claiming things that aren't true.
 *
 *   A-1  unsupported listing types can never reach settlement
 *   A-2  the payout hold explains itself instead of looking like a bug
 *   A-3  the Trust Score buys something real, funded by the platform's own fee
 *   A-4  the recommendation accept-signal changes what gets recommended
 *   A-5  gigs have a type, and it survives the un-migrated rows
 *   A-6  food listings are denied until the jurisdiction is explicitly cleared
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

/** A hub with payouts live and auto-approval wide open, so tests exercise one guard at a time. */
async function makeHub(prefix: string, citySlug?: string) {
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
  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(hubToken));
  await enablePayouts('business', businessId);

  const hub = await request(app)
    .post('/api/v1/hubs')
    .set(...bearer(hubToken))
    .send({ businessId, ...(citySlug ? { citySlug } : {}) });
  const hubId = hub.body.data.id as string;
  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  return { hubToken, hubId, businessId, qrToken: hub.body.data.token as string };
}

async function makeSeller(prefix: string, tier: 'bronze' | 'silver' | 'gold' = 'gold') {
  const sellerId = await seedUser({
    authProviderId: `${prefix}|seller`,
    roles: ['seller'],
    tier,
  });
  const sellerToken = await mintToken(`${prefix}|seller`);
  await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(sellerToken));
  await enablePayouts('user', sellerId);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(sellerToken))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return { sellerId, sellerToken };
}

function productBody(extra: Record<string, unknown> = {}) {
  return {
    name: 'Soy Candle',
    unitValueCents: 1000,
    consignmentSplitPercent: 65,
    returnWindowHours: 72,
    quantityAvailable: 100,
    ...extra,
  };
}

// ─── A-1 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-1: listing types with no settlement path never reach the money', () => {
  it('refuses to create a rental, wholesale or donation listing', async () => {
    const hub = await makeHub('a1create');

    for (const listingType of ['rental', 'wholesale', 'donation']) {
      const res = await request(app)
        .post(`/api/v1/hubs/${hub.hubId}/products`)
        .set(...bearer(hub.hubToken))
        .send(productBody({ listingType }));

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('LISTING_TYPE_UNSUPPORTED');
      // The refusal names the type rather than saying "invalid" — the hub owner needs to know
      // WHICH of their intentions isn't supported yet.
      expect(res.body.error.message.toLowerCase()).toContain(listingType);
    }
  });

  it('still creates a consignment listing, explicitly or by default', async () => {
    const hub = await makeHub('a1ok');

    const explicit = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ listingType: 'consignment' }));
    expect(explicit.status).toBe(201);

    const implicit = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody());
    expect(implicit.status).toBe(201);
    expect(implicit.body.data.listingType).toBe('consignment');
  });

  /**
   * The gate that actually protects the money. Creation is blocked, but rows written before the
   * gate — or imported, or migrated in — must not reach settle(), which would split a rental as if
   * it were a sale. Writing the bad value directly is the only honest way to reproduce that.
   */
  it('blocks checkout of a pre-existing product with an unsupported listing type', async () => {
    const hub = await makeHub('a1legacy');
    const seller = await makeSeller('a1legacy');

    const product = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody());
    const productId = product.body.data.id as string;

    // Simulate a legacy row: bypass the service and write the unsupported type straight to Mongo.
    await ProductModel.collection.updateOne(
      { _id: (await ProductModel.findById(productId).lean())!._id },
      { $set: { listing_type: 'rental' } },
    );

    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller.sellerToken))
      .send({
        productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LISTING_TYPE_UNSUPPORTED');
  });
});

// ─── A-6 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-6: food listings need an explicitly cleared jurisdiction', () => {
  it('refuses food when the hub has no city set', async () => {
    const hub = await makeHub('a6nocity');
    const res = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ category: 'food' }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CATEGORY_NOT_PERMITTED');
    // Actionable: says what to do, not just "no".
    expect(res.body.error.message).toMatch(/city/i);
  });

  /**
   * The critical case. An unreviewed city must NOT inherit the permissive default that
   * `isFeatureEnabled` gives ordinary features — a jurisdiction nobody has checked is not a
   * jurisdiction that said yes.
   */
  it('refuses food in a live city that has not been cleared for it', async () => {
    await CityModel.create({
      slug: 'a6-uncleared',
      name: 'Uncleared',
      state: 'CA',
      status: 'live',
      feature_flags: {},
    });
    const hub = await makeHub('a6uncleared', 'a6-uncleared');

    const res = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ category: 'food' }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CATEGORY_NOT_PERMITTED');
  });

  it('allows food once the city is explicitly cleared, and non-food regardless', async () => {
    await CityModel.create({
      slug: 'a6-cleared',
      name: 'Cleared',
      state: 'CA',
      status: 'live',
      feature_flags: { consignment_food: true },
    });
    const hub = await makeHub('a6cleared', 'a6-cleared');

    const food = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ category: 'food' }));
    expect(food.status).toBe(201);

    // Non-food was never gated — the guard must not have become a general category tax.
    const hub2 = await makeHub('a6shopping');
    const shopping = await request(app)
      .post(`/api/v1/hubs/${hub2.hubId}/products`)
      .set(...bearer(hub2.hubToken))
      .send(productBody({ category: 'shopping' }));
    expect(shopping.status).toBe(201);
  });
});

// ─── A-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-3: the Trust Score buys something real', () => {
  /** Force a subject's score — the formula itself is covered elsewhere. */
  async function setTrust(sellerId: string, score: number) {
    await TrustScoreModel.create({
      subject_type: 'seller',
      subject_id: sellerId,
      score,
      formula_version: 'test',
      inputs: {},
    });
  }

  it('reports the band, what it unlocks, and how far the next one is', async () => {
    const seller = await makeSeller('a3benefits');
    await setTrust(seller.sellerId, 70); // Trusted

    const res = await request(app)
      .get('/api/v1/trust-scores/me/benefits')
      .set(...bearer(seller.sellerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.band.key).toBe('trusted');
    expect(res.body.data.band.feeDiscountBps).toBeGreaterThan(0);
    expect(res.body.data.band.premiumEligible).toBe(true);
    expect(res.body.data.nextBand.key).toBe('elite');
    expect(res.body.data.nextBand.pointsAway).toBe(15);
    expect(res.body.data.howToImprove.length).toBeGreaterThan(0);
  });

  it('scales the inventory ceiling by band, and never below the tier cap', async () => {
    const low = await makeSeller('a3low', 'bronze');
    await setTrust(low.sellerId, 10); // Building
    const lowRes = await request(app)
      .get('/api/v1/debts/credit')
      .set(...bearer(low.sellerToken));

    const high = await makeSeller('a3high', 'bronze');
    await setTrust(high.sellerId, 90); // Elite
    const highRes = await request(app)
      .get('/api/v1/debts/credit')
      .set(...bearer(high.sellerToken));

    // Trust is upside only: a low score gets the plain Bronze cap, never a reduced one.
    expect(lowRes.body.data.maxInventoryValueCents).toBe(
      lowRes.body.data.tierMaxInventoryValueCents,
    );
    // Elite doubles it.
    expect(highRes.body.data.maxInventoryValueCents).toBe(
      highRes.body.data.tierMaxInventoryValueCents * 2,
    );
    // The debt ceiling deliberately does NOT scale — unsecured exposure isn't a reward.
    expect(highRes.body.data.maxCashDebtCents).toBe(lowRes.body.data.maxCashDebtCents);
  });

  it('gates premium inventory behind the required score, with a reason that says why', async () => {
    const hub = await makeHub('a3premium');
    const product = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ minSellerTrustScore: 80 }));
    expect(product.status).toBe(201);
    expect(product.body.data.minSellerTrustScore).toBe(80);
    const productId = product.body.data.id as string;

    const weak = await makeSeller('a3weak');
    await setTrust(weak.sellerId, 50);
    const denied = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(weak.sellerToken))
      .send({
        productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('TRUST_TOO_LOW');
    expect(denied.body.error.message).toContain('80');

    const strong = await makeSeller('a3strong');
    await setTrust(strong.sellerId, 85);
    const allowed = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(strong.sellerToken))
      .send({
        productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(allowed.status).toBe(201);
  });

  /**
   * The money property that matters: the Trust reward comes out of the PLATFORM's fee and goes
   * entirely to the seller. The hub is paid exactly what its authored split entitles it to, with or
   * without the discount — the platform must never fund its loyalty programme from someone else's
   * share.
   */
  it('funds the fee discount from the platform fee, leaving the hub share untouched', async () => {
    interface SettlementView {
      grossCents: number;
      platformFeeCents: number;
      hubShareCents: number;
      sellerNetCents: number;
      trustFeeDiscountCents: number;
    }

    async function settleOnce(prefix: string, score: number): Promise<SettlementView> {
      const hub = await makeHub(prefix);
      const seller = await makeSeller(prefix);
      await setTrust(seller.sellerId, score);

      const product = await request(app)
        .post(`/api/v1/hubs/${hub.hubId}/products`)
        .set(...bearer(hub.hubToken))
        .send(productBody());
      const checkout = await request(app)
        .post('/api/v1/checkouts')
        .set(...bearer(seller.sellerToken))
        .send({
          productId: product.body.data.id,
          quantity: 10,
          conditionPhotoUrl: 'https://cdn.test/c.jpg',
          qrToken: hub.qrToken,
        });
      expect(checkout.status).toBe(201);
      const checkoutId = checkout.body.data.id as string;

      await request(app)
        .post(`/api/v1/checkouts/${checkoutId}/sales`)
        .set(...bearer(seller.sellerToken))
        .send({ quantitySold: 10, saleAmountCents: 10_000, paymentRail: 'cash' });

      const settlement = await request(app)
        .get(`/api/v1/checkouts/${checkoutId}/settlement`)
        .set(...bearer(seller.sellerToken));
      return settlement.body.data as SettlementView;
    }

    const plain = await settleOnce('a3plain', 30); // Building — no discount
    const elite = await settleOnce('a3elite', 95); // Elite — 25% off the platform fee

    // Same gross, same split, so the hub is paid identically either way.
    expect(elite.grossCents).toBe(plain.grossCents);
    expect(elite.hubShareCents).toBe(plain.hubShareCents);

    // The platform charged itself less, and every cent of it went to the seller.
    const discount = plain.platformFeeCents - elite.platformFeeCents;
    expect(discount).toBeGreaterThan(0);
    expect(elite.sellerNetCents).toBe(plain.sellerNetCents + discount);

    // And the whole thing still balances against gross.
    expect(elite.platformFeeCents + elite.hubShareCents + elite.sellerNetCents).toBe(
      elite.grossCents,
    );
  });
});

// ─── A-2 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-2: the payout hold explains itself', () => {
  it('names the tier hold and the next step instead of leaving money silently pending', async () => {
    const seller = await makeSeller('a2hold', 'bronze');

    const res = await request(app)
      .get('/api/v1/payments/funds-availability')
      .set(...bearer(seller.sellerToken));

    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('bronze');
    expect(res.body.data.holdDays).toBeGreaterThan(0);
    // A Bronze seller with payouts live should be told verification shortens the wait.
    expect(res.body.data.nextStep.action).toBe('verify_identity');
    expect(res.body.data.nextStep.detail).toMatch(/held/i);
  });

  it('explains cash proceeds as uncollected rather than as a delay', async () => {
    const hub = await makeHub('a2cash');
    const seller = await makeSeller('a2cash');

    const product = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody());
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller.sellerToken))
      .send({
        productId: product.body.data.id,
        quantity: 10,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    await request(app)
      .post(`/api/v1/checkouts/${checkout.body.data.id}/sales`)
      .set(...bearer(seller.sellerToken))
      .send({ quantitySold: 10, saleAmountCents: 10_000, paymentRail: 'cash' });

    const res = await request(app)
      .get('/api/v1/payments/funds-availability')
      .set(...bearer(seller.sellerToken));

    const cash = res.body.data.buckets.find(
      (b: { key: string }) => b.key === 'cash_sales',
    );
    expect(cash).toBeDefined();
    expect(cash.blocked).toBe(true);
    // The honest reason: we never collected it, so we can't pay it out.
    expect(cash.reason).toMatch(/never came through|cash/i);
    expect(res.body.data.totals.blockedCents).toBeGreaterThan(0);
  });
});

// ─── A-5 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-5: gigs have a type', () => {
  async function makeEmployer(prefix: string) {
    const cat = await CategoryModel.create({
      slug: `${prefix}-cat`,
      name: prefix,
      top_level_tab: 'services',
      requires_license: false,
    });
    await seedUser({ authProviderId: `${prefix}|emp`, roles: ['vendor'] });
    const token = await mintToken(`${prefix}|emp`);
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: `${prefix} Biz`, categoryId: String(cat._id) });
    return { token, businessId: biz.body.data.id as string };
  }

  it('serves the filter vocabulary rather than making clients hardcode it', async () => {
    const res = await request(app).get('/api/v1/jobs/types');
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { key: string }) => t.key)).toEqual([
      'sell',
      'signage',
      'delivery',
      'sampling',
      'promotion',
      'event_staffing',
    ]);
  });

  it('filters nearby gigs by type, and defaults an untyped post to selling work', async () => {
    const emp = await makeEmployer('a5jobs');
    const at = { lng: -120.9969, lat: 37.6391 };

    await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.token))
      .send({ ...at, title: 'Hold a sign', payCents: 8000, jobType: 'signage', businessId: emp.businessId });
    await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.token))
      .send({ ...at, title: 'Drop off orders', payCents: 9000, jobType: 'delivery', businessId: emp.businessId });
    // No jobType — must land on the default rather than becoming untyped.
    await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.token))
      .send({ ...at, title: 'Sell candles', payCents: 7000, businessId: emp.businessId });

    await seedUser({ authProviderId: 'a5jobs|worker', roles: ['seller'] });
    const worker = await mintToken('a5jobs|worker');

    const all = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}`)
      .set(...bearer(worker));
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data.every((j: { jobType?: string }) => Boolean(j.jobType))).toBe(true);

    const signage = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}&jobType=signage`)
      .set(...bearer(worker));
    expect(signage.body.data).toHaveLength(1);
    expect(signage.body.data[0].title).toBe('Hold a sign');
    expect(signage.body.data[0].jobTypeLabel).toBe('Sign holding');

    // Comma-separated and repeated params both work — neither should 400 a worker out of the board.
    const multi = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}&jobType=signage,delivery`)
      .set(...bearer(worker));
    expect(multi.body.data).toHaveLength(2);

    const repeated = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}&jobType=signage&jobType=delivery`)
      .set(...bearer(worker));
    expect(repeated.body.data).toHaveLength(2);

    const selling = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}&jobType=sell`)
      .set(...bearer(worker));
    expect(selling.body.data).toHaveLength(1);
    expect(selling.body.data[0].title).toBe('Sell candles');
  });

  /**
   * A schema default only applies to documents Mongoose creates. Postings written before the field
   * existed have no `job_type` at all until the backfill runs, and must not vanish from a filtered
   * search in the meantime.
   */
  it('still surfaces un-migrated postings that have no job_type field', async () => {
    const emp = await makeEmployer('a5legacy');
    const at = { lng: -121.9969, lat: 38.6391 };

    const posted = await request(app)
      .post('/api/v1/jobs')
      .set(...bearer(emp.token))
      .send({ ...at, title: 'Legacy gig', payCents: 5000, businessId: emp.businessId });

    const { JobPostingModel } = await import('../src/modules/jobs/jobs.model');
    await JobPostingModel.collection.updateOne(
      { _id: (await JobPostingModel.findById(posted.body.data.id).lean())!._id },
      { $unset: { job_type: '' } },
    );

    await seedUser({ authProviderId: 'a5legacy|worker', roles: ['seller'] });
    const worker = await mintToken('a5legacy|worker');

    const res = await request(app)
      .get(`/api/v1/jobs/nearby?lat=${at.lat}&lng=${at.lng}&jobType=sell`)
      .set(...bearer(worker));
    expect(res.body.data).toHaveLength(1);
    // Reported as the default rather than null — the client never renders "untyped work".
    expect(res.body.data[0].jobType).toBe('sell');
  });
});

// ─── A-4 ─────────────────────────────────────────────────────────────────────────────────────
describe('A-4: the accept-signal changes what gets recommended', () => {
  it('ranks a product the seller previously accepted above an identical one', async () => {
    const hub = await makeHub('a4rank');
    const seller = await makeSeller('a4rank');

    // Two products identical in every ranking input, so acceptance is the only differentiator.
    const a = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ name: 'Candle A' }));
    const b = await request(app)
      .post(`/api/v1/hubs/${hub.hubId}/products`)
      .set(...bearer(hub.hubToken))
      .send(productBody({ name: 'Candle B' }));
    expect(b.status).toBe(201);

    const first = await request(app)
      .get('/api/v1/ai/recommendations/products?limit=50')
      .set(...bearer(seller.sellerToken));
    expect(first.status).toBe(200);

    // Accept the recommendation for Candle A.
    const recForA = first.body.data.find(
      (r: { productId: string }) => r.productId === a.body.data.id,
    );
    expect(recForA).toBeDefined();
    const accepted = await request(app)
      .post(`/api/v1/ai/recommendations/${recForA.recommendationId}/accept`)
      .set(...bearer(seller.sellerToken));
    expect(accepted.status).toBe(200);

    const second = await request(app)
      .get('/api/v1/ai/recommendations/products?limit=50')
      .set(...bearer(seller.sellerToken));

    /**
     * Compare A against B rather than asserting absolute first place. Other suites in this file sell
     * real inventory, and sell-through carries the heaviest weight — a top-of-list assertion would
     * be testing those sales, not this signal. A and B are identical in every other input, so their
     * relative order isolates acceptance exactly.
     */
    const ids = second.body.data.map((r: { productId: string }) => r.productId);
    expect(ids.indexOf(a.body.data.id)).toBeLessThan(ids.indexOf(b.body.data.id));

    // A signal that moves the ranking must be able to explain itself, or the reason line is a lie.
    const recA = second.body.data.find(
      (r: { productId: string }) => r.productId === a.body.data.id,
    );
    expect(recA.factors).toContain('you picked this up before');
  });
});
