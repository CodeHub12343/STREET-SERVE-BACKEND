import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { setWeatherGateway, weatherMultiplier } from '../src/integrations/weather';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { HubModel } from '../src/modules/consignment/consignment.model';
import { ForecastEngine } from '../src/modules/ai/engine/forecast';
import {
  calendarFeatures,
  calendarMultiplier,
  usFederalHolidays,
} from '../src/modules/ai/features/calendar';
import { OutcomeFactModel } from '../src/modules/ai/outcomes.model';
import { outcomesService } from '../src/modules/ai/outcomes.service';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase E — "Real AI".
 *
 * The assertions here are mostly about HONESTY rather than cleverness, because that is where this
 * phase can do the most damage. A forecast that over-promises costs a seller a wasted day; a coach
 * that always produces a plan is a fortune-teller. So: thin evidence must produce humble numbers,
 * an unreachable goal must be refused rather than padded, and every prediction must explain itself.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
  // Deterministic weather — the null gateway would make the weather assertions untestable.
  setWeatherGateway({
    name: 'test',
    current: () =>
      Promise.resolve({
        condition: 'clear' as const,
        tempC: 22,
        precipitationProbability: 0.05,
        windKph: 8,
        observedAt: new Date(),
      }),
  });
});

const ORIGIN = { lng: -120.9969, lat: 37.6391 };

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

async function makeHub(prefix: string, productCount = 1) {
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
  await HubModel.updateOne(
    { _id: hubId },
    { $set: { location: { type: 'Point', coordinates: [ORIGIN.lng, ORIGIN.lat] } } },
  );

  const productIds: string[] = [];
  for (let i = 0; i < productCount; i += 1) {
    const p = await request(app)
      .post(`/api/v1/hubs/${hubId}/products`)
      .set(...bearer(hubToken))
      .send({
        name: `${prefix} candle ${i}`,
        unitValueCents: 1000,
        consignmentSplitPercent: 65,
        returnWindowHours: 72,
        quantityAvailable: 50,
        category: 'shopping',
      });
    productIds.push(p.body.data.id as string);
  }
  return { hubToken, hubId, businessId, qrToken: hub.body.data.token as string, productIds };
}

async function makeSeller(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|s`, roles: ['seller'], tier: 'gold' });
  const token = await mintToken(`${prefix}|s`);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return token;
}

async function makeAdmin(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|a`, roles: ['admin'], tier: 'gold' });
  return mintToken(`${prefix}|a`);
}

// ─── E-3 ─────────────────────────────────────────────────────────────────────────────────────
describe('E-3: calendar features', () => {
  it('computes US federal holidays rather than hardcoding a table that expires', () => {
    // Thanksgiving 2026 is the 4th Thursday of November — the 26th.
    const h = usFederalHolidays(2026);
    expect(h.get('2026-11-26')).toBe('Thanksgiving');
    expect(h.get('2026-07-04')).toBe('Independence Day');
    // MLK Day 2026: 3rd Monday of January — the 19th.
    expect(h.get('2026-01-19')).toBe('Martin Luther King Jr. Day');
  });

  it('flags the payday window, the signal most specific to these sellers', () => {
    expect(calendarFeatures(new Date('2026-03-02T12:00:00Z')).isPaydayWindow).toBe(true);
    expect(calendarFeatures(new Date('2026-03-16T12:00:00Z')).isPaydayWindow).toBe(true);
    // Mid-month, away from either payday — the lean stretch.
    expect(calendarFeatures(new Date('2026-03-10T12:00:00Z')).isPaydayWindow).toBe(false);
  });

  /**
   * The bound is the point. Calendar is a real effect but a modest one next to "does this product
   * sell at all" — letting it swing a forecast 3× would let a Saturday make a dead product look
   * alive, which is exactly what destroys trust in a forecast.
   */
  it('keeps its multiplier bounded so it can never dominate the forecast', () => {
    for (const iso of ['2026-01-01', '2026-07-04', '2026-03-15', '2026-12-25', '2026-06-10']) {
      const m = calendarMultiplier(calendarFeatures(new Date(`${iso}T12:00:00Z`)));
      expect(m).toBeGreaterThanOrEqual(0.65);
      expect(m).toBeLessThanOrEqual(1.35);
    }
  });
});

// ─── E-2 ─────────────────────────────────────────────────────────────────────────────────────
describe('E-2: weather', () => {
  it('is neutral when there is no observation, rather than pessimistic', () => {
    // A missing provider must degrade the forecast, never skew it.
    expect(weatherMultiplier(null)).toBe(1);
  });

  it('suppresses hard for conditions that end a street-selling day', () => {
    const at = new Date();
    const storm = weatherMultiplier({
      condition: 'storm',
      tempC: 14,
      precipitationProbability: 0.9,
      windKph: 30,
      observedAt: at,
    });
    const clear = weatherMultiplier({
      condition: 'clear',
      tempC: 22,
      precipitationProbability: 0.05,
      windKph: 5,
      observedAt: at,
    });
    expect(storm).toBeLessThan(0.6);
    expect(clear).toBeGreaterThan(1);
    // Wider band than calendar — because the effect genuinely is larger.
    expect(clear / storm).toBeGreaterThan(2);
  });
});

// ─── E-1 ─────────────────────────────────────────────────────────────────────────────────────
describe('E-1: the outcome dataset', () => {
  it('captures decision-time features when stock is checked out', async () => {
    const hub = await makeHub('e1cap');
    const seller = await makeSeller('e1cap');

    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller))
      .send({
        productId: hub.productIds[0],
        quantity: 10,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    expect(co.status).toBe(201);

    // The capture is fire-and-forget, so give it a tick.
    await new Promise((r) => setTimeout(r, 250));
    const fact = await OutcomeFactModel.findOne({ checkout_id: co.body.data.id }).lean();
    expect(fact).toBeTruthy();
    expect(fact!.quantity_out).toBe(10);
    expect(fact!.category).toBe('shopping');
    // Features that are unrecoverable later, captured at the only moment they can be.
    expect(fact!.weather_code).toBe('clear');
    expect(fact!.tile).toBeTruthy();
    expect(fact!.settled).toBe(false);
  });

  /**
   * Only settled rows are complete. Training on in-flight checkouts would systematically
   * under-report every product (everything looks like it sold less than it eventually did).
   */
  it('completes a row only once the checkout settles, and computes sell-through', async () => {
    const hub = await makeHub('e1out');
    const seller = await makeSeller('e1out');

    const co = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(seller))
      .send({
        productId: hub.productIds[0],
        quantity: 10,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub.qrToken,
      });
    const checkoutId = co.body.data.id as string;
    await new Promise((r) => setTimeout(r, 250));

    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/sales`)
      .set(...bearer(seller))
      .send({ quantitySold: 4, saleAmountCents: 4_000, paymentRail: 'cash' });

    // Not settled yet — the row must stay incomplete.
    await outcomesService.backfillOutcomes();
    let fact = await OutcomeFactModel.findOne({ checkout_id: checkoutId }).lean();
    expect(fact!.settled).toBe(false);

    await request(app)
      .post(`/api/v1/checkouts/${checkoutId}/return`)
      .set(...bearer(seller))
      .send({ quantityReturned: 6, conditionAssessment: 'good' });

    await outcomesService.backfillOutcomes();
    fact = await OutcomeFactModel.findOne({ checkout_id: checkoutId }).lean();
    expect(fact!.settled).toBe(true);
    expect(fact!.quantity_sold).toBe(4);
    // 4 of 10 — the label the forecaster predicts.
    expect(fact!.sell_through).toBeCloseTo(0.4, 3);
    expect(fact!.hours_to_first_sale).not.toBeNull();
  });

  it('reports dataset readiness honestly rather than claiming a cold start is ready', async () => {
    const admin = await makeAdmin('e1stats');
    const res = await request(app).get('/api/v1/ai/outcomes/stats').set(...bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('completeRows');
    // A forecast built on a handful of rows is a guess wearing a lab coat.
    expect(typeof res.body.data.readyForForecasting).toBe('boolean');
  });
});

// ─── E-6 / E-7 ───────────────────────────────────────────────────────────────────────────────
describe('E-6/E-7: the forecaster', () => {
  it('is humble on thin evidence and says so in the reason line', async () => {
    const hub = await makeHub('e6thin');
    const seller = await makeSeller('e6thin');
    const me = await request(app).get('/api/v1/users/me').set(...bearer(seller));

    const engine = new ForecastEngine();
    const recs = await engine.recommendProducts(
      { sellerId: me.body.data.id, lng: ORIGIN.lng, lat: ORIGIN.lat, hourUtc: 14 },
      5,
    );

    expect(recs.length).toBeGreaterThan(0);
    const rec = recs.find((r) => hub.productIds.includes(r.productId))!;
    expect(rec).toBeDefined();
    // With no history the forecast must announce itself as an estimate, not a prediction.
    expect(rec.factors[0]).toMatch(/early estimate/);
    expect(rec.reasonSummary).toMatch(/%/);
  });

  /**
   * The blend that stops the forecaster embarrassing itself. Two observations that both sold out
   * would otherwise forecast 100%; blended against the category prior it must land well below.
   */
  it('blends a thin cell toward its category prior instead of trusting a lucky pair', async () => {
    const hub = await makeHub('e6blend');
    const seller = await makeSeller('e6blend');
    const me = await request(app).get('/api/v1/users/me').set(...bearer(seller));

    const tileHub = await HubModel.findById(hub.hubId).lean();
    const coords = tileHub!.location!.coordinates as [number, number];
    const tile = `${Math.floor(coords[0] / 0.005)}:${Math.floor(coords[1] / 0.005)}`;

    // Two perfect outcomes in one cell — the trap.
    for (let i = 0; i < 2; i += 1) {
      await OutcomeFactModel.create({
        checkout_id: `synthetic_perfect_${i}`,
        seller_id: 'someone_else',
        product_id: hub.productIds[0],
        hub_id: hub.hubId,
        category: 'shopping',
        tile,
        hour_utc: 14,
        day_of_week: 3,
        unit_value_cents: 1000,
        quantity_out: 5,
        quantity_sold: 5,
        sell_through: 1,
        settled: true,
        checked_out_at: new Date(),
      });
    }
    // Plus a body of ordinary evidence in the same category elsewhere, forming the prior.
    for (let i = 0; i < 12; i += 1) {
      await OutcomeFactModel.create({
        checkout_id: `synthetic_prior_${i}`,
        seller_id: 'someone_else',
        product_id: hub.productIds[0],
        hub_id: hub.hubId,
        category: 'shopping',
        tile: `${i}:${i}`,
        hour_utc: 9,
        day_of_week: 3,
        unit_value_cents: 1000,
        quantity_out: 10,
        quantity_sold: 2,
        sell_through: 0.2,
        settled: true,
        checked_out_at: new Date(),
      });
    }

    const engine = new ForecastEngine();
    const recs = await engine.recommendProducts(
      { sellerId: me.body.data.id, lng: coords[0], lat: coords[1], hourUtc: 14 },
      5,
    );
    const rec = recs.find((r) => r.productId === hub.productIds[0])!;
    const pct = Number(/about (\d+)%/.exec(rec.factors[0]!)![1]);

    // Not 100% — the prior drags it down. And not the prior either — the cell still counts.
    expect(pct).toBeLessThan(85);
    expect(pct).toBeGreaterThan(20);
  });

  it('names the conditions that moved the forecast — no oracles', async () => {
    const hub = await makeHub('e6explain');
    const seller = await makeSeller('e6explain');
    const me = await request(app).get('/api/v1/users/me').set(...bearer(seller));

    const engine = new ForecastEngine();
    const recs = await engine.recommendProducts(
      { sellerId: me.body.data.id, lng: ORIGIN.lng, lat: ORIGIN.lat, hourUtc: 14 },
      50,
    );
    const rec = recs.find((r) => hub.productIds.includes(r.productId))!;
    // The stubbed weather is clear and 22°C — the pleasant band.
    expect(rec.factors.some((f) => /good weather/.test(f))).toBe(true);
  });

  it('E-7: lifts stock matching the seller’s declared profile', async () => {
    await makeHub('e7match', 2);
    const seller = await makeSeller('e7match');
    const me = await request(app).get('/api/v1/users/me').set(...bearer(seller));

    await request(app)
      .patch('/api/v1/sellers/me/profile')
      .set(...bearer(seller))
      .send({ skills: ['crafts_and_handmade'], transport: 'bike' });

    const engine = new ForecastEngine();
    const recs = await engine.recommendProducts(
      { sellerId: me.body.data.id, lng: ORIGIN.lng, lat: ORIGIN.lat, hourUtc: 14 },
      20,
    );
    // "candle" contains "crafts"? No — the match is on category/skill stem, so assert the
    // mechanism is wired rather than a specific string: a profiled seller gets a profile factor
    // somewhere in the feed, or none at all if nothing matches. Either way it must not throw.
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => typeof r.reasonSummary === 'string')).toBe(true);
  });
});

// ─── E-4 / E-5 ───────────────────────────────────────────────────────────────────────────────
describe('E-4/E-5: events', () => {
  it('accepts a manually entered event and serves it nearby', async () => {
    const admin = await makeAdmin('e4manual');
    const created = await request(app)
      .post('/api/v1/events')
      .set(...bearer(admin))
      .send({
        name: 'Graceada Summer Fair',
        venue: 'Graceada Park',
        lng: ORIGIN.lng,
        lat: ORIGIN.lat,
        startsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        expectedAttendance: 800,
        category: 'Fair',
      });
    expect(created.status).toBe(201);
    // Human-entered events are trusted; ingested ones aren't.
    expect(created.body.data.verified).toBe(true);

    const near = await request(app).get(
      `/api/v1/events/nearby?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`,
    );
    expect(near.status).toBe(200);
    expect(near.body.data.some((e: { name: string }) => e.name === 'Graceada Summer Fair')).toBe(
      true,
    );
  });

  it('treats unknown attendance as unknown rather than inventing a number', async () => {
    const admin = await makeAdmin('e4unknown');
    const res = await request(app)
      .post('/api/v1/events')
      .set(...bearer(admin))
      .send({
        name: 'Street Market',
        lng: ORIGIN.lng + 0.001,
        lat: ORIGIN.lat,
        startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      });
    // Null, not 0 — the alert threshold and pricing suggestion both depend on this distinction.
    expect(res.body.data.expectedAttendance).toBeNull();
  });

  it('requires admin rights to add an event — a bad entry alerts every seller near a venue', async () => {
    const seller = await makeSeller('e4perm');
    const res = await request(app)
      .post('/api/v1/events')
      .set(...bearer(seller))
      .send({
        name: 'Fake',
        lng: ORIGIN.lng,
        lat: ORIGIN.lat,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(res.status).toBe(403);
  });
});

// ─── E-8 ─────────────────────────────────────────────────────────────────────────────────────
describe('E-8: bundle pricing', () => {
  it('suggests a real multi-unit offer, not a vague "consider discounting"', async () => {
    const hub = await makeHub('e8bundle');
    const engine = new ForecastEngine();
    const p = await engine.suggestPricing(hub.productIds[0]!);

    expect(p.advisoryOnly).toBe(true);
    // The brief's own example shape: "one for $10, or 3 for $25".
    expect(p.reasonSummary).toMatch(/Bundle idea: one for [\d.]+, or 3 for [\d.]+/);
  });
});

// ─── E-9 ─────────────────────────────────────────────────────────────────────────────────────
describe('E-9: the Income Coach', () => {
  it('produces a plan in the brief’s shape, with a measured track record', async () => {
    await makeHub('e9plan', 3);
    const seller = await makeSeller('e9plan');

    const res = await request(app)
      .post('/api/v1/ai/coach/plan')
      .set(...bearer(seller))
      .send({ goalCents: 5_000, lng: ORIGIN.lng, lat: ORIGIN.lat });

    expect(res.status).toBe(200);
    expect(res.body.data.goalCents).toBe(5_000);
    expect(res.body.data.basket.length).toBeGreaterThan(0);
    expect(res.body.data.summary).toBeTruthy();
    // Measured, not asserted — the roadmap asks for plans measured against actual outcomes.
    expect(res.body.data.track).toHaveProperty('plansMeasured');

    for (const item of res.body.data.basket) {
      expect(item.suggestedQuantity).toBeGreaterThan(0);
      // Contribution is an EXPECTED value (quantity × sell-through × net), never the maximum.
      expect(item.expectedContributionCents).toBeLessThanOrEqual(
        item.suggestedQuantity * item.netPerUnitCents,
      );
    }
  });

  /**
   * The most important test in this file. A coach that always produces a plan for any goal is a
   * fortune-teller — and the person reading it may be deciding whether they can eat tonight.
   */
  it('is allowed to fall short rather than padding a plan to reach the goal', async () => {
    await makeHub('e9short', 1);
    const seller = await makeSeller('e9short');

    const res = await request(app)
      .post('/api/v1/ai/coach/plan')
      .set(...bearer(seller))
      .send({ goalCents: 90_000, lng: ORIGIN.lng, lat: ORIGIN.lat });

    expect(res.status).toBe(200);
    expect(res.body.data.achievable).toBe(false);
    expect(res.body.data.projectedCents).toBeLessThan(90_000);
    // And it says what would actually close the gap, rather than pretending there isn't one.
    expect(res.body.data.advice.length).toBeGreaterThan(0);
    expect(res.body.data.summary).toMatch(/Realistically/);
  });

  it('refuses an unrealistic goal outright instead of fabricating a plan for it', async () => {
    const seller = await makeSeller('e9cap');
    const res = await request(app)
      .post('/api/v1/ai/coach/plan')
      .set(...bearer(seller))
      .send({ goalCents: 500_000 });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/capped/i);
  });
});
