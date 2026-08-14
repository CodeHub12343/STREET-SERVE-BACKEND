import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import {
  FEATURED_LABEL,
  SELLER_AGREEMENT_VERSION,
  WAIVER_COVER_CAP_CENTS,
} from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { COURSES, findCourse } from '../src/modules/academy/academy.catalog';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { SubscriptionModel } from '../src/modules/subscriptions/subscriptions.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase F — monetization breadth.
 *
 * Two claims are load-bearing here and both are tested directly:
 *
 *  1. **Paid placement is disclosed and additive.** It never removes or buries an organic result,
 *     and it always carries its label. Discovery that can be bought outright stops being a signal.
 *  2. **Stock Protection is a WAIVER, not insurance.** It suppresses a debt the platform is owed;
 *     it never pays money out. That distinction is what keeps it out of insurance regulation.
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

/** Activate a plan directly — Stripe checkout isn't what these tests are about. */
async function grantPlan(subscriberId: string, plan: string, createdDaysAgo = 7) {
  await SubscriptionModel.create({
    subscriber_id: subscriberId,
    subscriber_type: 'user',
    plan,
    status: 'active',
    stripe_subscription_id: `sub_test_${plan}_${subscriberId}`,
    // Back-dated so the waiver's waiting period has elapsed. `activated_at` is the field the
    // waiver reads — see the model comment on why it isn't `created_at`.
    activated_at: new Date(Date.now() - createdDaysAgo * 86_400_000),
  });
}

async function makeHub(prefix: string, unitValue = 1000) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'], tier: 'gold' });
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
    .send({ businessId });
  const hubId = hub.body.data.id as string;
  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  const product = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: `${prefix} candle`,
      unitValueCents: unitValue,
      consignmentSplitPercent: 65,
      returnWindowHours: 72,
      quantityAvailable: 100,
    });

  return {
    hubToken,
    hubId,
    businessId,
    qrToken: hub.body.data.token as string,
    productId: product.body.data.id as string,
  };
}

async function makeSeller(prefix: string) {
  const id = await seedUser({ authProviderId: `${prefix}|s`, roles: ['seller'], tier: 'gold' });
  const token = await mintToken(`${prefix}|s`);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return { id, token };
}

/**
 * A placement is created UNPAID and does not deliver until its charge settles — the same solvency
 * rule the ping budget and the settlement rail follow. Every fixture that needs a live placement
 * therefore has to pay for it, exactly as a real buyer would.
 */
async function payForPlacement(placementId: string) {
  const { PlacementModel } = await import('../src/modules/ads/ads.model');
  const row = await PlacementModel.findById(placementId).lean();
  await stripeEvent('payment_intent.succeeded', { id: row!.payment_intent_ref });
}

// ─── F-1 ─────────────────────────────────────────────────────────────────────────────────────
describe('F-1: featured products and hubs', () => {
  it('lets an owner feature their own product, and refuses someone else’s', async () => {
    const hub = await makeHub('f1own');
    const other = await makeHub('f1other');

    const mine = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId, budgetCents: 5_000 });
    expect(mine.status).toBe(201);
    // Disclosure travels with the placement from the moment it's created.
    expect(mine.body.data.label).toBe(FEATURED_LABEL);

    const theirs = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(other.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId, budgetCents: 5_000 });
    expect(theirs.status).toBe(403);
  });

  it('reports real delivery numbers instead of a manual spreadsheet', async () => {
    const hub = await makeHub('f1report');
    await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_hub', subjectId: hub.hubId, budgetCents: 2_500 });

    // Featured placements are keyed to the buyer, so no businessId is needed here.
    const mine = await request(app).get('/api/v1/placements/mine').set(...bearer(hub.hubToken));
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data[0]).toHaveProperty('impressions');
    expect(mine.body.data[0]).toHaveProperty('clickThroughRate');
    expect(mine.body.data[0].spendLabel).toMatch(/of \$/);
  });
});

// ─── F-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('F-3: ad inventory', () => {
  it('serves a labelled ad and never fills more than its share of a feed', async () => {
    const hub = await makeHub('f3serve');

    // Five campaigns competing for the same slot.
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/v1/placements/campaigns')
        .set(...bearer(hub.hubToken))
        .send({
          placement: 'discovery_card',
          headline: `Campaign ${i}`,
          budgetCents: 50_000,
          businessId: hub.businessId,
        });
      expect(res.status).toBe(201);
      await payForPlacement(res.body.data.id as string);
    }

    const served = await request(app).get(
      '/api/v1/placements/serve?placement=discovery_card&feedSize=10',
    );
    expect(served.status).toBe(200);
    /**
     * AD_MAX_SHARE_OF_FEED is 20% — a 10-item feed takes at most 2 ads no matter how many
     * advertisers want in. Paid placement that could crowd out organic results makes discovery
     * untrustworthy, which destroys the value of the inventory itself.
     */
    expect(served.body.data.length).toBeLessThanOrEqual(2);
    for (const ad of served.body.data) {
      // There is no configuration that turns disclosure off.
      expect(ad.label).toBe(FEATURED_LABEL);
      expect(ad.headline).toBeTruthy();
    }
  });

  it('bills impressions in batches and retires an exhausted campaign', async () => {
    const hub = await makeHub('f3bill');
    const campaign = await request(app)
      .post('/api/v1/placements/campaigns')
      .set(...bearer(hub.hubToken))
      .send({
        placement: 'earn_slot',
        headline: 'Tiny budget',
        // 700 CPM: this is exhausted well inside 100 impressions.
        budgetCents: 10,
        businessId: hub.businessId,
      });
    expect(campaign.status).toBe(201);
    await payForPlacement(campaign.body.data.id as string);

    for (let i = 0; i < 30; i += 1) {
      await request(app).get('/api/v1/placements/serve?placement=earn_slot&feedSize=10');
    }

    const { adsService } = await import('../src/modules/ads/ads.service');
    const settled = await adsService.settleImpressions();
    expect(settled.billed).toBeGreaterThan(0);

    const mine = await request(app)
      .get(`/api/v1/placements/mine?businessId=${hub.businessId}`)
      .set(...bearer(hub.hubToken));
    const row = mine.body.data.find(
      (p: { headline: string | null }) => p.headline === 'Tiny budget',
    );
    // Budget is prepaid and spent down — never over-delivered past what we can bill for.
    expect(row.spentCents).toBeLessThanOrEqual(row.budgetCents);
    expect(row.status).toBe('exhausted');
  });
});

/**
 * The gap this closes: the module always claimed budgets were "prepaid and spent down", but nothing
 * ever charged for a placement. Every placement on the platform was free and the serving path
 * happily delivered it — the ad product generated impressions and no revenue at all.
 */
describe('paid placement is actually paid for', () => {
  it('does not serve a placement whose charge has not settled, and serves it once it has', async () => {
    const hub = await makeHub('f3unpaid');
    const created = await request(app)
      .post('/api/v1/placements/campaigns')
      .set(...bearer(hub.hubToken))
      .send({
        placement: 'map_banner',
        headline: 'Unpaid banner',
        budgetCents: 50_000,
        businessId: hub.businessId,
      });
    expect(created.status).toBe(201);
    // The buyer is handed a client secret to complete, and the row is explicitly not live yet.
    expect(created.body.data.clientSecret).toBeTruthy();
    expect(created.body.data.status).toBe('pending_payment');
    expect(created.body.data.awaitingPayment).toBe(true);

    const before = await request(app).get(
      '/api/v1/placements/serve?placement=map_banner&feedSize=10',
    );
    expect(
      before.body.data.some((a: { headline: string }) => a.headline === 'Unpaid banner'),
    ).toBe(false);

    await payForPlacement(created.body.data.id as string);

    const after = await request(app).get(
      '/api/v1/placements/serve?placement=map_banner&feedSize=10',
    );
    const served = after.body.data.find((a: { headline: string }) => a.headline === 'Unpaid banner');
    expect(served).toBeTruthy();
    expect(served.label).toBe(FEATURED_LABEL);
  });

  it('an unpaid featured placement gives no ranking boost', async () => {
    const hub = await makeHub('f1unpaid');
    const created = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId, budgetCents: 5_000 });
    expect(created.status).toBe(201);

    const { adsService } = await import('../src/modules/ads/ads.service');
    expect((await adsService.featuredBoosts('featured_product')).has(hub.productId)).toBe(false);

    await payForPlacement(created.body.data.id as string);
    expect((await adsService.featuredBoosts('featured_product')).has(hub.productId)).toBe(true);
  });

  it('releases a city slot held by a checkout that was never completed', async () => {
    const hub = await makeHub('f1abandon');
    const created = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({
        kind: 'featured_hub',
        subjectId: hub.hubId,
        citySlug: 'modesto-ca',
        tierDays: 7,
      });
    expect(created.status).toBe(201);

    const { PlacementModel } = await import('../src/modules/ads/ads.model');
    const { adsService } = await import('../src/modules/ads/ads.service');
    // Age it past the hold window; the sweep must free the slot rather than hold it forever for a
    // buyer who never paid. Written through the raw collection because Mongoose marks `createdAt`
    // immutable, so a normal update would be silently dropped and the test would pass vacuously.
    await PlacementModel.collection.updateOne(
      { _id: PlacementModel.base.Types.ObjectId.createFromHexString(created.body.data.id as string) },
      { $set: { created_at: new Date(Date.now() - 2 * 3_600_000) } },
    );
    const swept = await adsService.settleImpressions();
    expect(swept.abandoned).toBeGreaterThanOrEqual(1);

    const row = await PlacementModel.findById(created.body.data.id).lean();
    expect(row!.status).toBe('ended');
  });
});

/**
 * §32 flat tiers — $5/1 day, $15/7 days, $40/30 days. CPM is the more precise model and it stays,
 * but a vendor deciding whether to spend $5 today cannot price a CPM campaign, and pricing they
 * cannot reason about is pricing they do not buy.
 */
describe('§32: flat promotion tiers', () => {
  it('publishes the price list rather than making the client hardcode it', async () => {
    const res = await request(app).get('/api/v1/placements/pricing');
    expect(res.status).toBe(200);
    expect(res.body.data.tiers).toEqual([
      expect.objectContaining({ days: 1, priceCents: 500, priceLabel: '$5.00' }),
      expect.objectContaining({ days: 7, priceCents: 1500, priceLabel: '$15.00' }),
      expect.objectContaining({ days: 30, priceCents: 4000, priceLabel: '$40.00' }),
    ]);
    expect(res.body.data.label).toBe(FEATURED_LABEL);
    // The spec's own sentence, which a disappointed vendor will quote back at us.
    expect(res.body.data.disclosure).toMatch(/does not guarantee sales/i);
  });

  it('prices a tier as its flat fee and closes it when the window passes', async () => {
    const hub = await makeHub('f1tier');
    const created = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId, tierDays: 7 });
    expect(created.status).toBe(201);
    expect(created.body.data.budgetCents).toBe(1500); // $15 for a week
    expect(created.body.data.tierDays).toBe(7);
    expect(created.body.data.deliveryLabel).toBe('One week — $15.00');

    await payForPlacement(created.body.data.id as string);

    const { PlacementModel } = await import('../src/modules/ads/ads.model');
    const { adsService } = await import('../src/modules/ads/ads.service');
    const live = await PlacementModel.findById(created.body.data.id).lean();
    expect(live!.status).toBe('active');
    // The window starts when the money lands, not when the form was opened — a buyer who takes ten
    // minutes at checkout must not lose ten minutes of the day they paid for.
    const days = (live!.ends_at!.getTime() - live!.paid_at!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);

    // A flat tier is a promise about TIME as much as volume: it stops on the day it said it would,
    // even with budget left.
    await PlacementModel.updateOne(
      { _id: created.body.data.id },
      { $set: { ends_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await adsService.settleImpressions();
    expect(swept.ended).toBeGreaterThanOrEqual(1);
    const closed = await PlacementModel.findById(created.body.data.id).lean();
    expect(closed!.status).toBe('ended');
    expect((await adsService.featuredBoosts('featured_product')).has(hub.productId)).toBe(false);
  });

  /**
   * Two prices on one purchase is how a buyer ends up charged the one they did not read. Rejected
   * outright rather than resolved by precedence — silently picking one would be a guess about money.
   */
  it('refuses a purchase that names two prices, or none', async () => {
    const hub = await makeHub('f1bothprices');

    const both = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId, tierDays: 7, budgetCents: 5_000 });
    expect(both.status).toBe(400);

    const neither = await request(app)
      .post('/api/v1/placements/featured')
      .set(...bearer(hub.hubToken))
      .send({ kind: 'featured_product', subjectId: hub.productId });
    expect(neither.status).toBe(400);

    // And nothing was created for either attempt.
    const mine = await request(app).get('/api/v1/placements/mine').set(...bearer(hub.hubToken));
    expect(mine.body.data).toHaveLength(0);
  });
});

// ─── F-2 ─────────────────────────────────────────────────────────────────────────────────────
describe('F-2: Seller Plus', () => {
  it('raises the inventory ceiling for a subscriber', async () => {
    const plain = await makeSeller('f2plain');
    const plus = await makeSeller('f2plus');
    await grantPlan(plus.id, 'seller_plus');

    const plainCredit = await request(app)
      .get('/api/v1/debts/credit')
      .set(...bearer(plain.token));
    const plusCredit = await request(app).get('/api/v1/debts/credit').set(...bearer(plus.token));

    expect(plusCredit.body.data.sellerPlus).toBe(true);
    expect(plainCredit.body.data.sellerPlus).toBe(false);
    expect(plusCredit.body.data.maxInventoryValueCents).toBeGreaterThan(
      plainCredit.body.data.maxInventoryValueCents,
    );
  });

  /**
   * The money property, matching A-3's: the discount comes out of the PLATFORM's fee and goes
   * entirely to the seller. The hub is paid exactly what its split entitles it to either way.
   */
  it('discounts the platform fee without touching the hub’s share', async () => {
    async function settleOnce(prefix: string, withPlus: boolean) {
      const hub = await makeHub(prefix);
      const seller = await makeSeller(prefix);
      if (withPlus) await grantPlan(seller.id, 'seller_plus');

      const co = await request(app)
        .post('/api/v1/checkouts')
        .set(...bearer(seller.token))
        .send({
          productId: hub.productId,
          quantity: 10,
          conditionPhotoUrl: 'https://cdn.test/c.jpg',
          qrToken: hub.qrToken,
        });
      expect(co.status).toBe(201);
      await request(app)
        .post(`/api/v1/checkouts/${co.body.data.id}/sales`)
        .set(...bearer(seller.token))
        .send({ quantitySold: 10, saleAmountCents: 10_000, paymentRail: 'cash' });

      const s = await request(app)
        .get(`/api/v1/checkouts/${co.body.data.id}/settlement`)
        .set(...bearer(seller.token));
      return s.body.data as {
        grossCents: number;
        platformFeeCents: number;
        hubShareCents: number;
        sellerNetCents: number;
      };
    }

    const plain = await settleOnce('f2fee', false);
    const plus = await settleOnce('f2feeplus', true);

    expect(plus.grossCents).toBe(plain.grossCents);
    // The hub is untouched — the platform funds its own membership perk.
    expect(plus.hubShareCents).toBe(plain.hubShareCents);

    const discount = plain.platformFeeCents - plus.platformFeeCents;
    expect(discount).toBeGreaterThan(0);
    expect(plus.sellerNetCents).toBe(plain.sellerNetCents + discount);
    expect(plus.platformFeeCents + plus.hubShareCents + plus.sellerNetCents).toBe(plus.grossCents);
  });
});

// ─── F-4 ─────────────────────────────────────────────────────────────────────────────────────
describe('F-4: Stock Protection is a waiver, not insurance', () => {
  async function lossScenario(prefix: string, withWaiver: boolean, unitValue = 1000, waitDays = 7) {
    const hub = await makeHub(prefix, unitValue);
    const seller = await makeSeller(prefix);
    if (withWaiver) await grantPlan(seller.id, 'stock_waiver', waitDays);

    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller.token))
      .send({
        productId: hub.productId,
        quantity: 5,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(co.status).toBe(201);

    await request(app)
      .post(`/api/v1/checkouts/${co.body.data.id}/return`)
      .set(...bearer(seller.token))
      .send({ quantityReturned: 5, conditionAssessment: 'lost' });

    const debts = await request(app).get('/api/v1/debts/mine').set(...bearer(seller.token));
    return { seller, debts: debts.body.data, checkoutId: co.body.data.id as string };
  }

  it('charges a seller without cover, and writes off the debt for one with it', async () => {
    const without = await lossScenario('f4none', false);
    expect(without.debts.totalOutstandingCents).toBeGreaterThan(0);

    const covered = await lossScenario('f4covered', true);
    // The debt is suppressed at source — not refunded, and no money is paid to the seller.
    expect(covered.debts.totalOutstandingCents).toBe(0);
  });

  /**
   * The waiting period is what stops this becoming a way to convert an existing debt into $2.99 —
   * adverse selection in its purest form.
   */
  it('does not apply during the waiting period', async () => {
    // Subscribed "just now" — inside WAIVER_WAITING_PERIOD_HOURS.
    const fresh = await lossScenario('f4waiting', true, 1000, 0);
    expect(fresh.debts.totalOutstandingCents).toBeGreaterThan(0);
  });

  it('caps cover per incident, leaving the excess owed', async () => {
    // 5 × $400 = $2,000 of loss, far above the $150 per-incident cap.
    const big = await lossScenario('f4cap', true, 40_000);
    expect(big.debts.totalOutstandingCents).toBeGreaterThan(0);
    // Exactly the cap was written off, no more.
    const status = await request(app)
      .get('/api/v1/subscriptions/waiver/status')
      .set(...bearer(big.seller.token));
    expect(status.body.data.usedThisPeriodCents).toBe(WAIVER_COVER_CAP_CENTS);
  });

  it('reports cover status in the same terms the liability path enforces', async () => {
    const seller = await makeSeller('f4status');
    const before = await request(app)
      .get('/api/v1/subscriptions/waiver/status')
      .set(...bearer(seller.token));
    expect(before.body.data.active).toBe(false);
    expect(before.body.data.reason).toMatch(/No Stock Protection/);

    await grantPlan(seller.id, 'stock_waiver');
    const after = await request(app)
      .get('/api/v1/subscriptions/waiver/status')
      .set(...bearer(seller.token));
    expect(after.body.data.active).toBe(true);
    expect(after.body.data.perIncidentCapCents).toBe(WAIVER_COVER_CAP_CENTS);
  });

  /**
   * The legal guardrail, asserted in code. Insurance language would make this a regulated product;
   * the whole design depends on it being a contractual waiver of our own right to recover.
   */
  it('never uses insurance language in user-facing copy', async () => {
    const seller = await makeSeller('f4words');
    await grantPlan(seller.id, 'stock_waiver');

    const plans = await request(app)
      .get('/api/v1/subscriptions/plans')
      .set(...bearer(seller.token));
    const status = await request(app)
      .get('/api/v1/subscriptions/waiver/status')
      .set(...bearer(seller.token));

    const copy = `${JSON.stringify(plans.body.data)} ${JSON.stringify(status.body.data)}`.toLowerCase();
    for (const forbidden of ['insurance', 'insured', 'policy', 'premium', 'claim']) {
      expect(copy).not.toContain(forbidden);
    }
  });
});

// ─── F-5 ─────────────────────────────────────────────────────────────────────────────────────
describe('F-5: paid certifications', () => {
  function answersFor(slug: string) {
    const course = findCourse(slug)!;
    return course.modules.flatMap((m) =>
      m.questions.map((q) => ({
        moduleSlug: m.slug,
        questionId: q.id,
        answerIndex: q.answerIndex,
      })),
    );
  }

  /**
   * The constraint that makes charging defensible at all: nothing a seller NEEDS is behind a
   * paywall. A required course, or one that unlocks gated stock, must stay free — otherwise the
   * platform is selling the right to earn to people defined by having no money.
   */
  it('keeps every required or access-granting course free', () => {
    for (const c of COURSES) {
      if (c.requiredFor !== null) expect(c.priceCents).toBeNull();
      if (c.slug === 'inventory-handling') expect(c.priceCents).toBeNull();
    }
    // And at least one paid course exists, or F-5 shipped nothing.
    expect(COURSES.some((c) => c.priceCents !== null)).toBe(true);
  });

  it('leaves the MATERIAL readable but gates the assessment behind purchase', async () => {
    const seller = await makeSeller('f5gate');
    await request(app)
      .post('/api/v1/academy/courses/selling-basics/submit')
      .set(...bearer(seller.token))
      .send({ answers: answersFor('selling-basics') });

    // Reading is free — someone who can't afford it can still learn everything in it.
    const read = await request(app)
      .get('/api/v1/academy/courses/pro-seller')
      .set(...bearer(seller.token));
    expect(read.status).toBe(200);
    expect(read.body.data.modules.length).toBeGreaterThan(0);
    expect(read.body.data.priceCents).toBeGreaterThan(0);

    const blocked = await request(app)
      .post('/api/v1/academy/courses/pro-seller/submit')
      .set(...bearer(seller.token))
      .send({ answers: answersFor('pro-seller') });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('PAYMENT_REQUIRED');

    await request(app)
      .post('/api/v1/academy/courses/pro-seller/purchase')
      .set(...bearer(seller.token));

    const allowed = await request(app)
      .post('/api/v1/academy/courses/pro-seller/submit')
      .set(...bearer(seller.token))
      .send({ answers: answersFor('pro-seller') });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.passed).toBe(true);
    expect(allowed.body.data.certificationAwarded.key).toBe('pro-seller');
  });

  it('never charges twice — a retake is free once bought', async () => {
    const seller = await makeSeller('f5once');
    const first = await request(app)
      .post('/api/v1/academy/courses/pro-seller/purchase')
      .set(...bearer(seller.token));
    expect(first.body.data.alreadyOwned).toBe(false);

    const second = await request(app)
      .post('/api/v1/academy/courses/pro-seller/purchase')
      .set(...bearer(seller.token));
    expect(second.body.data.alreadyOwned).toBe(true);
  });
});
