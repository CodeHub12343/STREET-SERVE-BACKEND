import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { OrderModel } from '../src/modules/orders/orders.model';
import { communityFundLedger } from '../src/modules/ledger/communityFund';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import {
  CommunityContributionModel,
  CommunityFundModel,
  CommunityRedemptionModel,
} from '../src/modules/payforward/payforward.model';
import { payforwardService } from '../src/modules/payforward/payforward.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 3 — Pay It Forward (ADR-005).
 *
 * The money is CUSTODIAL: real customer money, held by the platform, owed to nobody in particular.
 * So what these tests pin is not the happy path — it is the set of properties that make holding
 * other people's money defensible:
 *
 *  • a pool balance can never rise without a settled payment (the `PingBudgetTopup` lesson);
 *  • a pool can never go negative, under any amount of concurrency;
 *  • the caps and the one-per-day rule hold when two requests race, because a unique index decides
 *    them rather than a read-then-write;
 *  • a declined card gives the money back rather than leaving the vendor short;
 *  • the ledger reconciles across the whole lifecycle;
 *  • nothing anywhere claims a contribution is tax-deductible.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

async function vendorWithMenu(prefix: string, opts: { payForward?: boolean } = {}) {
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
  const businessId = biz.body.data.id as string;

  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  if (acct) {
    fakeStripe.enableAccount(acct.stripe_account_id);
    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'test')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          id: `evt_${Math.random()}`,
          type: 'account.updated',
          data: { object: { id: acct.stripe_account_id } },
        }),
      );
  }

  const terms = await request(app).get('/api/v1/agreements/regular_sale');
  await request(app)
    .post('/api/v1/agreements/regular_sale/accept')
    .set(...bearer(token))
    .send({ version: terms.body.data.version, contentHash: terms.body.data.contentHash });
  await request(app)
    .post('/api/v1/live-sessions/start')
    .set(...bearer(token))
    .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });

  const item = await request(app)
    .post(`/api/v1/businesses/${businessId}/menu`)
    .set(...bearer(token))
    .send({ name: 'Taco plate', priceCents: 2000 });

  if (opts.payForward !== false) {
    // `pay_it_forward` is available to every archetype but off by default — a vendor opts in.
    const current = await request(app)
      .get(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token));
    await request(app)
      .put(`/api/v1/businesses/${businessId}/modules`)
      .set(...bearer(token))
      .send({ enabled: [...(current.body.data.enabled as string[]), 'pay_it_forward'] });
  }

  return { token, businessId, menuItemId: item.body.data.id as string };
}

async function customer(prefix: string, tier: 'tier0' | 'bronze' = 'bronze') {
  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'], tier });
  return mintToken(`${prefix}|cust`);
}

/** Give, and settle the charge — i.e. do what the Stripe webhook does. */
async function contributeAndSettle(
  token: string,
  businessId: string,
  amountCents: number,
  key: string,
  body: Record<string, unknown> = {},
) {
  const res = await request(app)
    .post(`/api/v1/pay-it-forward/${businessId}/contributions`)
    .set(...bearer(token))
    .set('Idempotency-Key', key)
    .send({ amountCents, ...body });
  if (res.status !== 201) return res;

  const row = await CommunityContributionModel.findById(res.body.data.contributionId).lean();
  await request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(
      JSON.stringify({
        id: `evt_${Math.random()}`,
        type: 'payment_intent.succeeded',
        data: { object: { id: row?.stripe_payment_intent_id } },
      }),
    );
  return res;
}

// ─── 3a · contribution ──────────────────────────────────────────────────────────────────────
describe('3a · a pool rises only when money actually arrives', () => {
  it('does not credit the pool when the contribution is merely requested', async () => {
    const v = await vendorWithMenu('pf-pending');
    const cust = await customer('pf-pending');

    const res = await request(app)
      .post(`/api/v1/pay-it-forward/${v.businessId}/contributions`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'pf_pending_1')
      .send({ amountCents: 2000 });

    expect(res.status).toBe(201);
    // THE invariant. `PingBudgetTopup` exists because this was once got wrong, with platform money.
    expect(res.body.data.balanceCents).toBe(0);
    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents ?? 0).toBe(0);
  });

  it('credits the pool once the payment settles, and posts the ledger', async () => {
    const v = await vendorWithMenu('pf-settle');
    const cust = await customer('pf-settle');
    await contributeAndSettle(cust, v.businessId, 2500, 'pf_settle_1');

    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents).toBe(2500);
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId })).toBe(2500);
  });

  it('does not double-credit a redelivered webhook', async () => {
    const v = await vendorWithMenu('pf-dup');
    const cust = await customer('pf-dup');
    const res = await contributeAndSettle(cust, v.businessId, 1000, 'pf_dup_1');

    const row = await CommunityContributionModel.findById(res.body.data.contributionId).lean();
    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'test')
        .set('content-type', 'application/json')
        .send(
          JSON.stringify({
            id: `evt_${Math.random()}`,
            type: 'payment_intent.succeeded',
            data: { object: { id: row?.stripe_payment_intent_id } },
          }),
        );
    }

    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents).toBe(1000);
  });

  it('records a failed charge instead of leaving it pending forever', async () => {
    const v = await vendorWithMenu('pf-fail');
    const cust = await customer('pf-fail');
    const res = await request(app)
      .post(`/api/v1/pay-it-forward/${v.businessId}/contributions`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'pf_fail_1')
      .send({ amountCents: 1500 });

    const row = await CommunityContributionModel.findById(res.body.data.contributionId).lean();
    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'test')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          id: `evt_${Math.random()}`,
          type: 'payment_intent.payment_failed',
          data: {
            object: {
              id: row?.stripe_payment_intent_id,
              last_payment_error: { message: 'card_declined' },
            },
          },
        }),
      );

    // A giver whose card bounced must be able to tell. `pending` forever looks like "still working".
    const after = await CommunityContributionModel.findById(res.body.data.contributionId).lean();
    expect(after?.status).toBe('failed');
    expect(after?.failure_reason).toBe('card_declined');
  });

  it('is anonymous unless the giver opts out, and never leaks the contributor id', async () => {
    const v = await vendorWithMenu('pf-anon');
    const shy = await customer('pf-anon-shy');
    const proud = await customer('pf-anon-proud');

    await contributeAndSettle(shy, v.businessId, 1000, 'pf_anon_1');
    await contributeAndSettle(proud, v.businessId, 1000, 'pf_anon_2', {
      anonymous: false,
      displayName: 'James',
    });

    const list = await request(app).get(`/api/v1/pay-it-forward/${v.businessId}/contributions`);
    const names = (list.body.data as { givenBy: string | null }[]).map((c) => c.givenBy);
    expect(names).toContain('James');
    expect(names).toContain(null);
    // No user ids on a public surface, ever.
    expect(JSON.stringify(list.body.data)).not.toContain('contributor');
  });

  it('refuses to be named without a name', async () => {
    const v = await vendorWithMenu('pf-noname');
    const cust = await customer('pf-noname');
    const res = await request(app)
      .post(`/api/v1/pay-it-forward/${v.businessId}/contributions`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'pf_noname_1')
      .send({ amountCents: 1000, anonymous: false });
    expect(res.status).toBe(400);
  });

  it('refuses contributions to a business that has not switched the module on', async () => {
    const v = await vendorWithMenu('pf-nomod', { payForward: false });
    const cust = await customer('pf-nomod');
    const res = await request(app)
      .post(`/api/v1/pay-it-forward/${v.businessId}/contributions`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'pf_nomod_1')
      .send({ amountCents: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('bounds a contribution so one stray keystroke is not a custodial problem', async () => {
    const v = await vendorWithMenu('pf-bounds');
    const cust = await customer('pf-bounds');
    for (const amountCents of [50, 5_000_000]) {
      const res = await request(app)
        .post(`/api/v1/pay-it-forward/${v.businessId}/contributions`)
        .set(...bearer(cust))
        .set('Idempotency-Key', `pf_bounds_${amountCents}`)
        .send({ amountCents });
      expect(res.status).toBe(400);
    }
  });
});

// ─── 3b · redemption ────────────────────────────────────────────────────────────────────────
describe('3b · redemption, caps and the daily limit', () => {
  function placeOrder(token: string, body: object, key: string) {
    return request(app)
      .post('/api/v1/orders')
      .set(...bearer(token))
      .set('Idempotency-Key', key)
      .send(body);
  }

  it('offers the fund at quote time without reserving anything', async () => {
    const v = await vendorWithMenu('pf-quote');
    const giver = await customer('pf-quote-give');
    const buyer = await customer('pf-quote-buy');
    await contributeAndSettle(giver, v.businessId, 5000, 'pf_quote_1');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(buyer))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    expect(quote.status).toBe(200);
    expect(quote.body.data.payItForward.availableCents).toBe(2000);
    // Browsing must not hold money out of the pool.
    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents).toBe(5000);
  });

  it('covers an order in full and takes no card at all', async () => {
    const v = await vendorWithMenu('pf-full');
    const giver = await customer('pf-full-give');
    const buyer = await customer('pf-full-buy');
    await contributeAndSettle(giver, v.businessId, 5000, 'pf_full_1');

    const res = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      },
      'pf_full_order',
    );

    expect(res.status).toBe(201);
    const order = await OrderModel.findById(res.body.data.id).lean();
    // The meal still cost $20 — the receipt must say so, and the vendor is paid for a $20 sale.
    expect(order?.total_cents).toBe(2000);
    expect(order?.pay_it_forward_cents).toBe(2000);
    // Nothing was charged, so there is no transaction. This is the moment the feature exists for.
    expect(order?.transaction_id ?? null).toBeNull();

    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents).toBe(3000);
  });

  it('covers part of an order and charges the customer the rest', async () => {
    const v = await vendorWithMenu('pf-part');
    const giver = await customer('pf-part-give');
    const buyer = await customer('pf-part-buy');
    await contributeAndSettle(giver, v.businessId, 500, 'pf_part_1');

    const res = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      },
      'pf_part_order',
    );

    expect(res.status).toBe(201);
    const order = await OrderModel.findById(res.body.data.id).lean();
    // PIF-6 needs no code of its own: partial payment is what the cap arithmetic already returns.
    expect(order?.pay_it_forward_cents).toBe(500);
    expect(order?.total_cents).toBe(2000);
    expect(order?.transaction_id).toBeTruthy();
  });

  it('never covers the tip or the round-up', async () => {
    const v = await vendorWithMenu('pf-tip');
    const giver = await customer('pf-tip-give');
    const buyer = await customer('pf-tip-buy');
    await contributeAndSettle(giver, v.businessId, 10_000, 'pf_tip_1');

    const res = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        tipCents: 300,
        roundUpCents: 55,
        usePayItForward: true,
      },
      'pf_tip_order',
    );

    const order = await OrderModel.findById(res.body.data.id).lean();
    // The community bought the meal. The tip is the customer's own gesture to make.
    expect(order?.pay_it_forward_cents).toBe(2000);
    expect(order?.total_cents).toBe(2355);
  });

  it('honours the vendor’s per-redemption and percentage caps', async () => {
    const v = await vendorWithMenu('pf-caps');
    const giver = await customer('pf-caps-give');
    const buyer = await customer('pf-caps-buy');
    await contributeAndSettle(giver, v.businessId, 10_000, 'pf_caps_1');

    await request(app)
      .patch(`/api/v1/pay-it-forward/${v.businessId}/settings`)
      .set(...bearer(v.token))
      .send({ maxPerRedemptionCents: 800, maxPercentOfOrder: 50 });

    const res = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      },
      'pf_caps_order',
    );

    // min(balance 10000, order 2000, per-redemption 800, 50% of 2000 = 1000) → 800.
    const order = await OrderModel.findById(res.body.data.id).lean();
    expect(order?.pay_it_forward_cents).toBe(800);
  });

  it('helps a person once per business per day, and says so', async () => {
    const v = await vendorWithMenu('pf-daily');
    const giver = await customer('pf-daily-give');
    const buyer = await customer('pf-daily-buy');
    await contributeAndSettle(giver, v.businessId, 10_000, 'pf_daily_1');

    const first = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      },
      'pf_daily_o1',
    );
    expect(first.status).toBe(201);

    const second = await placeOrder(
      buyer,
      {
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      },
      'pf_daily_o2',
    );
    /**
     * The order still goes through — refusing to sell someone lunch because a gift was unavailable
     * would be a strange way to run a generosity feature — but it is charged in full and SAYS WHY.
     * Silently charging a customer who asked for help is the outcome to avoid.
     */
    expect(second.status).toBe(201);
    expect(second.body.data.payItForward).toEqual({ appliedCents: 0, reason: 'daily_limit' });

    // Not silently drained: the second attempt took nothing from the pool.
    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    expect(fund?.balance_cents).toBe(8000);
  });

  it('requires a verified identity to receive', async () => {
    const v = await vendorWithMenu('pf-tier');
    const giver = await customer('pf-tier-give');
    const unverified = await customer('pf-tier-buy', 'tier0');
    await contributeAndSettle(giver, v.businessId, 5000, 'pf_tier_1');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(unverified))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    expect(quote.body.data.payItForward.availableCents).toBe(0);
    expect(quote.body.data.payItForward.reason).toBe('verification_required');
  });

  it('cannot be driven negative by concurrent redemptions', async () => {
    const v = await vendorWithMenu('pf-race');
    const giver = await customer('pf-race-give');
    await contributeAndSettle(giver, v.businessId, 2500, 'pf_race_1');

    // Five different people, one $20 order each, against $25 in the pot.
    const buyers = await Promise.all([1, 2, 3, 4, 5].map((i) => customer(`pf-race-b${i}`)));
    const results = await Promise.all(
      buyers.map((t, i) =>
        placeOrder(
          t,
          {
            businessId: v.businessId,
            items: [{ menuItemId: v.menuItemId, quantity: 1 }],
            usePayItForward: true,
          },
          `pf_race_o${i}`,
        ).then((r) => r),
      ),
    );

    // Every order goes through; only the funding differs. The message carries any error body so a
    // future failure here says what actually went wrong rather than just "expected false to be true".
    expect(
      results.map((r) => r.status).join(','),
      JSON.stringify(results.map((r) => (r.body as { error?: unknown })?.error).filter(Boolean)),
    ).toBe('201,201,201,201,201');
    const fund = await CommunityFundModel.findOne({ business_id: v.businessId }).lean();
    // The load-bearing property: a custodial pool may never go negative, whatever the concurrency.
    expect(fund?.balance_cents ?? 0).toBeGreaterThanOrEqual(0);

    const applied = await CommunityRedemptionModel.find({
      business_id: v.businessId,
      status: 'applied',
    }).lean();
    const spent = applied.reduce((s, r) => s + r.amount_cents, 0);
    expect(spent).toBeLessThanOrEqual(2500);
    expect(spent + (fund?.balance_cents ?? 0)).toBe(2500);
  });

  it('gives the money back when the payment fails', async () => {
    const v = await vendorWithMenu('pf-decline');
    const giver = await customer('pf-decline-give');
    await contributeAndSettle(giver, v.businessId, 500, 'pf_decline_1');

    const reservation = await payforwardService.reserve({
      businessId: v.businessId,
      userId: 'someone_who_will_fail_0000',
      userTier: 'bronze',
      coverableCents: 2000,
    });
    expect(reservation.amountCents).toBe(500);
    expect(
      (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())?.balance_cents,
    ).toBe(0);

    await payforwardService.release(reservation.redemptionId!, 'payment_failed');

    // The vendor must not be left short because a card bounced — and the person's daily slot is free.
    expect(
      (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())?.balance_cents,
    ).toBe(500);
    const again = await payforwardService.reserve({
      businessId: v.businessId,
      userId: 'someone_who_will_fail_0000',
      userTier: 'bronze',
      coverableCents: 2000,
    });
    expect(again.amountCents).toBe(500);
  });

  it('is opt-in: an order that does not ask for help does not get any', async () => {
    const v = await vendorWithMenu('pf-optin');
    const giver = await customer('pf-optin-give');
    const buyer = await customer('pf-optin-buy');
    await contributeAndSettle(giver, v.businessId, 5000, 'pf_optin_1');

    const res = await placeOrder(
      buyer,
      { businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] },
      'pf_optin_order',
    );

    const order = await OrderModel.findById(res.body.data.id).lean();
    expect(order?.pay_it_forward_cents ?? 0).toBe(0);
    expect(
      (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())?.balance_cents,
    ).toBe(5000);
  });
});

// ─── 3c · impact ────────────────────────────────────────────────────────────────────────────
describe('3c · the impact figures are derived, never counted', () => {
  it('reports contributions, redemptions and people helped from the rows themselves', async () => {
    const v = await vendorWithMenu('pf-impact');
    const g1 = await customer('pf-impact-g1');
    const g2 = await customer('pf-impact-g2');
    const buyer = await customer('pf-impact-b1');
    await contributeAndSettle(g1, v.businessId, 3000, 'pf_impact_1');
    await contributeAndSettle(g2, v.businessId, 1000, 'pf_impact_2');

    await request(app)
      .post('/api/v1/orders')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'pf_impact_order')
      .send({
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      });

    const res = await request(app).get(`/api/v1/pay-it-forward/${v.businessId}/impact`);
    expect(res.status).toBe(200);
    expect(res.body.data.contributedCents).toBe(4000);
    expect(res.body.data.contributionCount).toBe(2);
    expect(res.body.data.largestContributionCents).toBe(3000);
    expect(res.body.data.averageContributionCents).toBe(2000);
    expect(res.body.data.redeemedCents).toBe(2000);
    expect(res.body.data.peopleHelped).toBe(1);
    expect(res.body.data.availableCents).toBe(2000);
  });

  it('caches the aggregate without ever letting it become the source of truth', async () => {
    const v = await vendorWithMenu('pf-cache-agg');
    const g = await customer('pf-cache-agg-g');
    await contributeAndSettle(g, v.businessId, 2000, 'pf_cacheagg_1');

    const first = await request(app).get(`/api/v1/pay-it-forward/${v.businessId}/impact`);
    expect(first.body.data.contributedCents).toBe(2000);

    // A second contribution must be visible immediately — "it'll show up shortly" is a support
    // ticket, so the cache is dropped on every write rather than waiting out its TTL.
    await contributeAndSettle(g, v.businessId, 500, 'pf_cacheagg_2');
    const second = await request(app).get(`/api/v1/pay-it-forward/${v.businessId}/impact`);
    expect(second.body.data.contributedCents).toBe(2500);

    // And the cached answer always equals the freshly computed one — the cache shortens how often
    // the sum is recomputed, it never becomes the number of record (D-9).
    const computed = await payforwardService.computeImpact(v.businessId);
    expect(second.body.data.contributedCents).toBe(computed.contributedCents);
    expect(second.body.data.redeemedCents).toBe(computed.redeemedCents);
  });

  it('never publishes who was helped', async () => {
    const v = await vendorWithMenu('pf-privacy');
    const giver = await customer('pf-privacy-g');
    const buyer = await customer('pf-privacy-b');
    await contributeAndSettle(giver, v.businessId, 5000, 'pf_privacy_1');
    await request(app)
      .post('/api/v1/orders')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'pf_privacy_order')
      .send({
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      });

    const res = await request(app).get(`/api/v1/pay-it-forward/${v.businessId}/impact`);
    // A count, never a list. Accepting help is not something a vendor gets to publish.
    expect(typeof res.body.data.peopleHelped).toBe('number');
    expect(JSON.stringify(res.body.data)).not.toContain('user_id');
  });
});

// ─── 3d · lifecycle ─────────────────────────────────────────────────────────────────────────
describe('3d · expiry, the ledger, and what the product may not claim', () => {
  it('expires unused money to the city fund — never to the vendor', async () => {
    const v = await vendorWithMenu('pf-expiry');
    const giver = await customer('pf-expiry-g');
    const res = await contributeAndSettle(giver, v.businessId, 3000, 'pf_expiry_1');

    await CommunityContributionModel.updateOne(
      { _id: res.body.data.contributionId },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    const payableBefore = await ledgerService.balanceOf({
      ownerType: 'business',
      ownerId: v.businessId,
      accountType: 'payable',
    });

    expect(await payforwardService.expireStale()).toBe(1);

    expect(
      (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())?.balance_cents,
    ).toBe(0);
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId })).toBe(0);
    // The decision this protects: a vendor who kept stale money would profit from suppressing
    // redemption, and the vendor controls the caps, the settings, and the prompt.
    expect(
      await ledgerService.balanceOf({
        ownerType: 'business',
        ownerId: v.businessId,
        accountType: 'payable',
      }),
    ).toBe(payableBefore);
  });

  it('does not expire money that is still in date', async () => {
    const v = await vendorWithMenu('pf-notyet');
    const giver = await customer('pf-notyet-g');
    await contributeAndSettle(giver, v.businessId, 1000, 'pf_notyet_1');

    await payforwardService.expireStale();
    expect(
      (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())?.balance_cents,
    ).toBe(1000);
  });

  it('reconciles across contribute → redeem → expire', async () => {
    const v = await vendorWithMenu('pf-recon');
    const giver = await customer('pf-recon-g');
    const buyer = await customer('pf-recon-b');
    const c = await contributeAndSettle(giver, v.businessId, 6000, 'pf_recon_1');
    await request(app)
      .post('/api/v1/orders')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'pf_recon_order')
      .send({
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      });
    await CommunityContributionModel.updateOne(
      { _id: c.body.data.contributionId },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    await payforwardService.expireStale();

    const report = await ledgerService.reconcile();
    expect(report.drifted).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  it('keeps the cached balance in step with the ledger', async () => {
    const v = await vendorWithMenu('pf-cache');
    const giver = await customer('pf-cache-g');
    const buyer = await customer('pf-cache-b');
    await contributeAndSettle(giver, v.businessId, 4000, 'pf_cache_1');
    await request(app)
      .post('/api/v1/orders')
      .set(...bearer(buyer))
      .set('Idempotency-Key', 'pf_cache_order')
      .send({
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 1 }],
        usePayItForward: true,
      });

    const cached = (await CommunityFundModel.findOne({ business_id: v.businessId }).lean())
      ?.balance_cents;
    expect(cached).toBe(await communityFundLedger.balanceOf({ businessId: v.businessId }));
  });

  it('rejects "never" as an expiry setting (ADR-005 §6)', async () => {
    const v = await vendorWithMenu('pf-never');
    const res = await request(app)
      .patch(`/api/v1/pay-it-forward/${v.businessId}/settings`)
      .set(...bearer(v.token))
      .send({ expiryDays: 0 });
    expect(res.status).toBe(400);
  });

  it('never claims a contribution is tax-deductible (CR-6)', async () => {
    /**
     * The copy rule from ADR-005, asserted the way the `stock_waiver` prohibition is. A vendor is
     * not a charity, and a contribution to a for-profit business's pool is generally not deductible
     * — "tax-friendly donation reports" was exactly the phrasing that would have implied otherwise.
     */
    const v = await vendorWithMenu('pf-copy');
    const giver = await customer('pf-copy-g');
    await contributeAndSettle(giver, v.businessId, 1000, 'pf_copy_1');

    const surfaces = await Promise.all([
      request(app).get(`/api/v1/pay-it-forward/${v.businessId}`),
      request(app).get(`/api/v1/pay-it-forward/${v.businessId}/impact`),
      request(app).get(`/api/v1/pay-it-forward/${v.businessId}/contributions`),
    ]);
    const copy = surfaces
      .map((r) => JSON.stringify(r.body.data))
      .join(' ')
      .toLowerCase();

    for (const forbidden of [
      'tax-deductible',
      'tax deductible',
      'tax deduction',
      'write-off',
      'charitable donation',
      '501(c)(3)',
      'nonprofit',
    ]) {
      expect(copy, `forbidden phrase "${forbidden}"`).not.toContain(forbidden);
    }
  });

  /**
   * The agreement is the ONE place the phrase must appear, negated. A blanket substring ban would
   * forbid the disclosure itself — the rule is against *claiming* deductibility, not against saying
   * plainly that there is none. CR-6 in the copy-rule register carries this carve-out.
   */
  it('says plainly in the agreement that a contribution is NOT tax-deductible', async () => {
    const res = await request(app).get('/api/v1/agreements/community_contribution');
    const body = (res.body.data.body as string).toLowerCase();
    expect(body).toContain('not tax-deductible');
    expect(body).not.toMatch(/\bis tax-deductible\b/);
  });
});
