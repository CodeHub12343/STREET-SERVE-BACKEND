import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { communityFundLedger } from '../src/modules/ledger/communityFund';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { BoostCampaignModel, BoostContributionModel } from '../src/modules/boost/boost.model';
import { boostService } from '../src/modules/boost/boost.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 4 — Boost My Marketing (ADR-006).
 *
 * The design premise is that **missing the goal is the likely outcome**, so that is what most of
 * these tests are about:
 *
 *  • an unmet campaign refunds everybody automatically, in full, without being asked;
 *  • the refund is the whole amount — the platform eats the processor's cost, because refunding a
 *    generous person 97% of their money would be the most damaging thing this product could do;
 *  • the ledger balances to zero on that campaign afterwards;
 *  • roll-forward is opt-in AND itself time-boxed, so "put it toward the next one" cannot become the
 *    indefinite hold the deadline exists to prevent;
 *  • `raised` is summed from rows, never read off a counter.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

async function vendor(prefix: string) {
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
  return { token, businessId: biz.body.data.id as string };
}

async function backer(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|backer`, roles: ['customer'] });
  return mintToken(`${prefix}|backer`);
}

async function createCampaign(
  token: string,
  businessId: string,
  goalCents = 100_000,
  deadlineDays = 30,
) {
  return request(app)
    .post(`/api/v1/boost/business/${businessId}/campaigns`)
    .set(...bearer(token))
    .send({ title: 'Postcards for the neighbourhood', goalCents, deadlineDays });
}

/** Chip in, and settle the charge — i.e. do what the Stripe webhook does. */
async function contributeAndSettle(
  token: string,
  campaignId: string,
  amountCents: number,
  key: string,
  body: Record<string, unknown> = {},
) {
  const res = await request(app)
    .post(`/api/v1/boost/campaigns/${campaignId}/contributions`)
    .set(...bearer(token))
    .set('Idempotency-Key', key)
    .send({ amountCents, ...body });
  if (res.status !== 201) return res;

  const row = await BoostContributionModel.findById(res.body.data.contributionId).lean();
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

// ─── 4.2 · the campaign ─────────────────────────────────────────────────────────────────────
describe('4.2 · campaigns are a sibling of placements, not a variant', () => {
  it('creates a campaign with a hard deadline and derives raised from rows', async () => {
    const v = await vendor('bo-create');
    const res = await createCampaign(v.token, v.businessId);

    expect(res.status).toBe(201);
    expect(res.body.data.goalCents).toBe(100_000);
    expect(res.body.data.raisedCents).toBe(0);
    expect(res.body.data.remainingCents).toBe(100_000);
    // ADR-006 §2: no open-ended campaigns. One that can never fail can never resolve either.
    expect(new Date(res.body.data.deadlineAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a window longer than 60 days', async () => {
    const v = await vendor('bo-long');
    const res = await createCampaign(v.token, v.businessId, 100_000, 90);
    expect(res.status).toBe(400);
  });

  it('allows only one open campaign per business', async () => {
    const v = await vendor('bo-one');
    expect((await createCampaign(v.token, v.businessId)).status).toBe(201);
    const second = await createCampaign(v.token, v.businessId);
    // Two campaigns split the same goodwill and leave a contributor guessing which one they helped.
    expect(second.status).toBe(409);
  });

  it('is not creatable by someone who does not own the business', async () => {
    const v = await vendor('bo-owner');
    const stranger = await backer('bo-owner-x');
    const res = await request(app)
      .post(`/api/v1/boost/business/${v.businessId}/campaigns`)
      .set(...bearer(stranger))
      .send({ title: 'Not mine', goalCents: 100_000, deadlineDays: 30 });
    expect(res.status).toBe(403);
  });

  it('sums raised from contribution rows rather than a counter', async () => {
    const v = await vendor('bo-sum');
    const b1 = await backer('bo-sum-1');
    const b2 = await backer('bo-sum-2');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;

    await contributeAndSettle(b1, id, 20_000, 'bo_sum_1');
    await contributeAndSettle(b2, id, 5_000, 'bo_sum_2');

    // Corrupt the cache on purpose. The API must not believe it.
    await BoostCampaignModel.updateOne({ _id: id }, { $set: { raised_cents_cached: 999_999 } });

    const res = await request(app).get(`/api/v1/boost/campaigns/${id}`);
    expect(res.body.data.raisedCents).toBe(25_000);
    expect(res.body.data.remainingCents).toBe(75_000);
    expect(res.body.data.percentFunded).toBe(25);
  });

  it('serves the business’s current campaign publicly — one nobody can see raises nothing', async () => {
    const v = await vendor('bo-public');
    await createCampaign(v.token, v.businessId);
    const res = await request(app).get(`/api/v1/boost/business/${v.businessId}/current`);
    expect(res.status).toBe(200);
    expect(res.body.data.goalCents).toBe(100_000);
  });
});

// ─── 4.3 · contributions ────────────────────────────────────────────────────────────────────
describe('4.3 · money in, captured into the campaign’s own escrow', () => {
  it('does not count a contribution until the charge settles', async () => {
    const v = await vendor('bo-pending');
    const b = await backer('bo-pending');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;

    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/contributions`)
      .set(...bearer(b))
      .set('Idempotency-Key', 'bo_pending_1')
      .send({ amountCents: 10_000 });

    expect(res.status).toBe(201);
    // The goal must never look closer than the money actually is.
    expect(res.body.data.raisedCents).toBe(0);
  });

  it('credits a campaign-scoped escrow, kept apart from the business’s Pay It Forward pool', async () => {
    const v = await vendor('bo-scope');
    const b = await backer('bo-scope');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 30_000, 'bo_scope_1');

    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      30_000,
    );
    // Refunding a failed campaign must never reach into money given to feed people.
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId })).toBe(0);
  });

  it('takes no platform fee from a contribution', async () => {
    const v = await vendor('bo-nofee');
    const b = await backer('bo-nofee');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;
    const before = await ledgerService.balanceOf({
      ownerType: 'platform',
      ownerId: null,
      accountType: 'fee_revenue',
    });
    await contributeAndSettle(b, id, 10_000, 'bo_nofee_1');
    expect(
      await ledgerService.balanceOf({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'fee_revenue',
      }),
    ).toBe(before);
  });

  it('records a failed charge instead of leaving it pending forever', async () => {
    const v = await vendor('bo-fail');
    const b = await backer('bo-fail');
    const c = await createCampaign(v.token, v.businessId);
    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${c.body.data.id}/contributions`)
      .set(...bearer(b))
      .set('Idempotency-Key', 'bo_fail_1')
      .send({ amountCents: 10_000 });

    const row = await BoostContributionModel.findById(res.body.data.contributionId).lean();
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

    const after = await BoostContributionModel.findById(res.body.data.contributionId).lean();
    expect(after?.status).toBe('failed');
    expect(after?.failure_reason).toBe('card_declined');
  });

  it('is anonymous by default and refuses to name you without a name', async () => {
    const v = await vendor('bo-anon');
    const shy = await backer('bo-anon-shy');
    const proud = await backer('bo-anon-proud');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;

    await contributeAndSettle(shy, id, 5_000, 'bo_anon_1');
    await contributeAndSettle(proud, id, 5_000, 'bo_anon_2', {
      anonymous: false,
      displayName: 'Dana',
    });

    const list = await request(app).get(`/api/v1/boost/campaigns/${id}/contributions`);
    const names = (list.body.data as { givenBy: string | null }[]).map((x) => x.givenBy);
    expect(names).toContain('Dana');
    expect(names).toContain(null);
    expect(JSON.stringify(list.body.data)).not.toContain('contributor');

    const noName = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/contributions`)
      .set(...bearer(shy))
      .set('Idempotency-Key', 'bo_anon_3')
      .send({ amountCents: 5_000, anonymous: false });
    expect(noName.status).toBe(400);
  });

  it('refuses a contribution once the campaign has closed', async () => {
    const v = await vendor('bo-closed');
    const b = await backer('bo-closed');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;
    await BoostCampaignModel.updateOne(
      { _id: id },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );

    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/contributions`)
      .set(...bearer(b))
      .set('Idempotency-Key', 'bo_closed_1')
      .send({ amountCents: 5_000 });
    expect(res.status).toBe(422);
  });
});

// ─── goal reached ───────────────────────────────────────────────────────────────────────────
describe('4.5 · reaching the goal', () => {
  it('funds only when captured money reaches the goal, and takes the service fee from the total', async () => {
    const v = await vendor('bo-goal');
    const b = await backer('bo-goal');
    const c = await createCampaign(v.token, v.businessId, 20_000, 30);
    const id = c.body.data.id as string;

    await contributeAndSettle(b, id, 10_000, 'bo_goal_1');
    expect((await request(app).get(`/api/v1/boost/campaigns/${id}`)).body.data.status).toBe('open');

    const b2 = await backer('bo-goal-2');
    await contributeAndSettle(b2, id, 10_000, 'bo_goal_2');

    const after = await request(app).get(`/api/v1/boost/campaigns/${id}`);
    expect(after.body.data.status).toBe('funded');
    expect(after.body.data.raisedCents).toBe(20_000);
    /**
     * `campaign_service` is priced at 10% now that a print vendor is integrated (ADR-007 §4).
     * What matters is unchanged: it is taken from the RAISED TOTAL, once, on funding — never from
     * an individual contribution.
     */
    expect(after.body.data.serviceFeeCents).toBe(2_000); // 10% of $200
  });

  it('lets the owner cover a shortfall before the deadline, and refuses after it', async () => {
    const v = await vendor('bo-topup');
    const b = await backer('bo-topup');
    const c = await createCampaign(v.token, v.businessId, 20_000, 30);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 5_000, 'bo_topup_1');

    const top = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/top-up`)
      .set(...bearer(v.token))
      .set('Idempotency-Key', 'bo_topup_owner')
      .send({});
    expect(top.status).toBe(201);
    expect(top.body.data.amountCents).toBe(15_000); // exactly the shortfall

    // After the deadline the money has already gone back — reopening would mean re-charging people.
    await BoostCampaignModel.updateOne(
      { _id: id },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );
    const late = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/top-up`)
      .set(...bearer(v.token))
      .set('Idempotency-Key', 'bo_topup_late')
      .send({});
    expect(late.status).toBe(422);
  });
});

// ─── 4.3 / MB-10 · the likely outcome ───────────────────────────────────────────────────────
describe('MB-10 · a missed goal refunds everybody, automatically and in full', () => {
  it('expires the campaign, refunds every contributor in full, and leaves the ledger at zero', async () => {
    const v = await vendor('bo-unmet');
    const b1 = await backer('bo-unmet-1');
    const b2 = await backer('bo-unmet-2');
    const c = await createCampaign(v.token, v.businessId, 100_000, 30);
    const id = c.body.data.id as string;

    await contributeAndSettle(b1, id, 20_000, 'bo_unmet_1');
    await contributeAndSettle(b2, id, 5_000, 'bo_unmet_2');
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      25_000,
    );

    await BoostCampaignModel.updateOne(
      { _id: id },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );
    // The sweep is global and other cases in this file leave due campaigns behind, so assert on THIS
    // campaign rather than on the aggregate counters.
    const swept = await boostService.sweepDeadlines();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await BoostCampaignModel.findById(id).lean())?.status).toBe('expired');

    // The exit criterion: the campaign's escrow balances to zero afterwards.
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      0,
    );

    // In FULL. Nobody is refunded 97% of what they gave.
    const rows = await BoostContributionModel.find({ campaign_id: id }).lean();
    expect(rows.every((r) => r.status === 'refunded')).toBe(true);
    const refundedAmounts = fakeStripe.refundCalls
      .filter((r) => rows.some((row) => row.stripe_payment_intent_id === r.paymentIntentId))
      .map((r) => r.amountCents);
    expect(refundedAmounts.sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([5_000, 20_000]);
  });

  it('funds instead of expiring if the goal was quietly met before the sweep ran', async () => {
    const v = await vendor('bo-late');
    const b = await backer('bo-late');
    const c = await createCampaign(v.token, v.businessId, 10_000, 30);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 10_000, 'bo_late_1');
    await BoostCampaignModel.updateOne(
      { _id: id },
      { $set: { deadline_at: new Date(Date.now() - 1000), status: 'open' } },
    );

    await boostService.sweepDeadlines();
    expect((await BoostCampaignModel.findById(id).lean())?.status).toBe('funded');
  });

  it('cancelling refunds everyone, whatever they chose for the unmet case', async () => {
    const v = await vendor('bo-cancel');
    const b = await backer('bo-cancel');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;
    // Even a contributor who asked to roll forward: there is nothing left to roll into.
    await contributeAndSettle(b, id, 10_000, 'bo_cancel_1', { onUnmet: 'roll_forward' });

    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/cancel`)
      .set(...bearer(v.token))
      .send({ reason: 'changed my mind' });

    expect(res.status).toBe(200);
    expect(res.body.data.refunded).toBe(1);
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      0,
    );
  });
});

// ─── ADR-006 §5 · roll-forward ──────────────────────────────────────────────────────────────
describe('roll-forward is opt-in, and time-boxed', () => {
  it('defaults to refund — money is never moved to a campaign nobody chose', async () => {
    const v = await vendor('bo-default');
    const b = await backer('bo-default');
    const c = await createCampaign(v.token, v.businessId);
    const res = await contributeAndSettle(b, c.body.data.id as string, 10_000, 'bo_default_1');
    const row = await BoostContributionModel.findById(res.body.data.contributionId).lean();
    expect(row?.on_unmet).toBe('refund');
  });

  it('holds opted-in money at expiry, then moves it to the next campaign', async () => {
    const v = await vendor('bo-roll');
    const b = await backer('bo-roll');
    const first = await createCampaign(v.token, v.businessId, 100_000, 30);
    const firstId = first.body.data.id as string;
    await contributeAndSettle(b, firstId, 10_000, 'bo_roll_1', { onUnmet: 'roll_forward' });

    await BoostCampaignModel.updateOne(
      { _id: firstId },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );
    const swept = await boostService.sweepDeadlines();
    // Not refunded — the contributor asked for it to wait.
    expect(swept.refunded).toBe(0);
    expect(
      await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: firstId }),
    ).toBe(10_000);

    const second = await createCampaign(v.token, v.businessId, 50_000, 30);
    const secondId = second.body.data.id as string;

    // The money followed, and counts toward the new goal from day one.
    expect(
      await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: firstId }),
    ).toBe(0);
    expect(
      await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: secondId }),
    ).toBe(10_000);
    expect(
      (await request(app).get(`/api/v1/boost/campaigns/${secondId}`)).body.data.raisedCents,
    ).toBe(10_000);
  });

  it('refunds rolled-forward money if no next campaign ever comes', async () => {
    const v = await vendor('bo-stale');
    const b = await backer('bo-stale');
    const c = await createCampaign(v.token, v.businessId, 100_000, 30);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 10_000, 'bo_stale_1', { onUnmet: 'roll_forward' });
    await BoostCampaignModel.updateOne(
      { _id: id },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );
    await boostService.sweepDeadlines();

    // Wind the grace period past.
    await BoostContributionModel.updateMany(
      { campaign_id: id },
      { $set: { rollover_expires_at: new Date(Date.now() - 1000) } },
    );
    expect(await boostService.sweepRollovers()).toBe(1);

    // "The next campaign" that never arrives is the indefinite hold the deadline exists to prevent.
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      0,
    );
  });
});

// ─── 4.4 / 4.6 · the mailing ────────────────────────────────────────────────────────────────
describe('4.4 / 4.6 · the estimate and the mailing pipeline', () => {
  it('estimates postcards from the live vendor rate, net of the disclosed service fee', async () => {
    /**
     * The feature this whole phase existed to switch on: MB-8 is resolved, the rate comes from the
     * print vendor, and a contributor is finally told what their money buys.
     *
     * The arithmetic is the point. $50 raised, minus the disclosed 10% service fee (ADR-006 §6),
     * leaves $45 to mail with — NOT $50. Dividing the gross would overstate the count by ~11%, and
     * an estimate that quietly ignores a fee it knows about is the same credibility problem as a
     * wrong "raised so far" (D-9).
     */
    const res = await request(app).get('/api/v1/boost/estimate?amountCents=5000');
    expect(res.status).toBe(200);

    const { postcards, unitCostCents, serviceFeeCents, mailableCents } = res.body.data;
    expect(serviceFeeCents).toBe(500); // 10% of $50
    expect(mailableCents).toBe(4_500);
    expect(unitCostCents).toBeGreaterThan(0);
    expect(postcards).toBe(Math.floor(4_500 / unitCostCents));
    expect(res.body.data.isEstimate).toBe(true);
  });

  it('still declines to invent a number when the rate cannot be established', async () => {
    /**
     * The honesty property that made this endpoint trustworthy while it was inert, preserved
     * through the change that made it easy to lose: no rate, no number. The client renders nothing
     * rather than a figure that would be read as a quote somebody had obtained.
     */
    const { setPrintVendor, resetPrintVendor } = await import('../src/integrations/print');
    const { invalidateMailingRate } = await import('../src/modules/boost/mailingRate');

    // A vendor that cannot price anything — an outage, or a size they no longer carry.
    setPrintVendor({
      ...(await import('../src/integrations/print')).createFakePrintVendor(),
      priceRun: () => Promise.reject(new Error('vendor unavailable')),
    });
    await invalidateMailingRate();

    try {
      const res = await request(app).get('/api/v1/boost/estimate?amountCents=5000');
      expect(res.status).toBe(200); // a campaign page must not fail because a printer is down
      expect(res.body.data.postcards).toBeNull();
      expect(res.body.data.unitCostCents).toBe(0);
      // The fee is still knowable and still disclosed, even when the count is not.
      expect(res.body.data.serviceFeeCents).toBe(500);
    } finally {
      resetPrintVendor();
      await invalidateMailingRate();
    }
  });

  it('never offers a “delivered” status the platform cannot observe', async () => {
    const v = await vendor('bo-mail');
    const b = await backer('bo-mail');
    const admin = await (async () => {
      await seedUser({ authProviderId: 'bo-mail|admin', roles: ['admin'] });
      return mintToken('bo-mail|admin');
    })();
    const c = await createCampaign(v.token, v.businessId, 10_000, 30);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 10_000, 'bo_mail_1');

    const scheduled = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/mail-date`)
      .set(...bearer(v.token))
      .send({ mailDate: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.data.mailingStatus).toBe('preparing');

    for (const status of ['printing', 'mailed']) {
      const res = await request(app)
        .post(`/api/v1/boost/campaigns/${id}/mailing-status`)
        .set(...bearer(admin))
        .send({ status });
      expect(res.status, status).toBe(200);
      expect(res.body.data.mailingStatus).toBe(status);
    }

    // D-12: most saturation-mail vendors confirm handover and nothing after it.
    const delivered = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/mailing-status`)
      .set(...bearer(admin))
      .send({ status: 'delivered' });
    expect(delivered.status).toBe(400);
  });

  it('will not schedule a mailing for a campaign that has not funded', async () => {
    const v = await vendor('bo-unfunded');
    const c = await createCampaign(v.token, v.businessId);
    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${c.body.data.id}/mail-date`)
      .set(...bearer(v.token))
      .send({ mailDate: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(res.status).toBe(422);
  });

  it('does not let a vendor move their own mailing status', async () => {
    const v = await vendor('bo-selfmail');
    const b = await backer('bo-selfmail');
    const c = await createCampaign(v.token, v.businessId, 10_000, 30);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 10_000, 'bo_selfmail_1');

    const res = await request(app)
      .post(`/api/v1/boost/campaigns/${id}/mailing-status`)
      .set(...bearer(v.token))
      .send({ status: 'mailed' });
    expect(res.status).toBe(403);
  });
});

// ─── the books ──────────────────────────────────────────────────────────────────────────────
describe('the ledger holds across the whole lifecycle', () => {
  it('reconciles after fund → and after refund', async () => {
    const v = await vendor('bo-recon');
    const b1 = await backer('bo-recon-1');
    const b2 = await backer('bo-recon-2');

    const funded = await createCampaign(v.token, v.businessId, 10_000, 30);
    await contributeAndSettle(b1, funded.body.data.id as string, 10_000, 'bo_recon_1');

    const failed = await createCampaign(v.token, v.businessId, 100_000, 30);
    const failedId = failed.body.data.id as string;
    await contributeAndSettle(b2, failedId, 20_000, 'bo_recon_2');
    await BoostCampaignModel.updateOne(
      { _id: failedId },
      { $set: { deadline_at: new Date(Date.now() - 1000) } },
    );
    await boostService.sweepDeadlines();

    const report = await ledgerService.reconcile();
    expect(report.drifted).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
  });

  it('never moves community money between businesses', async () => {
    const a = await vendor('bo-x1');
    const b = await vendor('bo-x2');
    await expect(
      communityFundLedger.transferBetweenFunds({
        from: { businessId: a.businessId, campaignId: 'c1' },
        to: { businessId: b.businessId, campaignId: 'c2' },
        amountCents: 1000,
        transferId: 'x1',
      }),
    ).rejects.toThrow(/between businesses/i);
  });
});

// ─── Phase 8.4 · ops tooling ────────────────────────────────────────────────────────────────
describe('8.4 · support tooling cannot move money to a person', () => {
  async function admin(prefix: string) {
    await seedUser({ authProviderId: `${prefix}|admin`, roles: ['admin', 'ops_finance'] });
    return mintToken(`${prefix}|admin`);
  }

  it('reconciles a drifted pool cache to the LEDGER, not to a number an operator chose', async () => {
    const { CommunityFundModel } = await import('../src/modules/payforward/payforward.model');
    const { communityFundLedger } = await import('../src/modules/ledger/communityFund');
    const at = await admin('ops-recon');
    const businessId = 'opsrecon00000000000000aa';

    await communityFundLedger.contribute({
      fund: { businessId },
      amountCents: 4000,
      contributionId: 'ops_recon_1',
    });
    await CommunityFundModel.findOneAndUpdate(
      { business_id: businessId },
      { $set: { business_id: businessId, balance_cents: 999 } },
      { upsert: true },
    );

    const res = await request(app)
      .post(`/api/v1/admin/community-funds/${businessId}/reconcile`)
      .set(...bearer(at))
      .send({ reason: 'cache drifted after a crash' });

    expect(res.status).toBe(200);
    expect(res.body.data.ledgerCents).toBe(4000);
    // The worst a compromised admin account achieves here is telling the truth.
    expect(
      (await CommunityFundModel.findOne({ business_id: businessId }).lean())?.balance_cents,
    ).toBe(4000);
  });

  it('offers no way to set an arbitrary pool balance', async () => {
    const at = await admin('ops-arb');
    const businessId = 'opsarb0000000000000000aa';
    // An ops action that can raise a custodial balance is an ops action that can create money.
    const res = await request(app)
      .post(`/api/v1/admin/community-funds/${businessId}/reconcile`)
      .set(...bearer(at))
      .send({ reason: 'trying it on', balanceCents: 1_000_000 });
    expect(res.status).toBe(400); // strict schema — the extra field is refused outright
  });

  it('requires a reason for every ops action', async () => {
    const at = await admin('ops-reason');
    const res = await request(app)
      .post('/api/v1/admin/community-funds/opsreason000000000000aa/reconcile')
      .set(...bearer(at))
      .send({});
    expect(res.status).toBe(400);
  });

  it('cancels a campaign through the vendor’s own refund path, and audits it', async () => {
    const { AuditLogModel } = await import('../src/shared/audit');
    const at = await admin('ops-cancel');
    const v = await vendor('ops-cancel-v');
    const b = await backer('ops-cancel-b');
    const c = await createCampaign(v.token, v.businessId);
    const id = c.body.data.id as string;
    await contributeAndSettle(b, id, 10_000, 'ops_cancel_1');

    const res = await request(app)
      .post(`/api/v1/admin/boost-campaigns/${id}/cancel`)
      .set(...bearer(at))
      .send({ reason: 'vendor unreachable' });

    expect(res.status).toBe(200);
    expect(res.body.data.refunded).toBe(1);
    expect(await communityFundLedger.balanceOf({ businessId: v.businessId, campaignId: id })).toBe(
      0,
    );

    const audited = await AuditLogModel.countDocuments({
      action: 'ops.boost_campaign_cancelled',
      entityId: id,
    });
    expect(audited).toBe(1);
  });

  it('is refused for a plain customer', async () => {
    const b = await backer('ops-nope');
    const res = await request(app)
      .post('/api/v1/admin/community-funds/opsnope00000000000000aa/reconcile')
      .set(...bearer(b))
      .send({ reason: 'let me in' });
    expect(res.status).toBe(403);
  });
});
