import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { isFinalAttempt } from '../src/jobs/financial';
import { CityModel } from '../src/modules/catalog/catalog.model';
import { SponsorModel } from '../src/modules/sponsors/sponsors.model';
import { sponsorsService } from '../src/modules/sponsors/sponsors.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/** Sponsorship is bought with a card, so this suite needs a gateway that can take one. */
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

/** Deliver a Stripe event, exactly as the webhook would receive it. */
function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

/**
 * Phase 8 — Launch hardening: observability metrics exposed, financial retry/DLQ policy, sponsor
 * integration + UTM attribution, city-scoped feature gating, and security-header hardening.
 */
const app = createApp();

describe('observability: business/SLA metrics exposed', () => {
  it('exposes the financial + fraud + realtime SLA metrics on /metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    for (const name of [
      'oversell_reject_total',
      'settlements_total',
      'reconciliation_drift_cents',
      'payouts_total',
      'fraud_flags_total',
      'disputes_resolved_total',
      'ping_tips_paid_total',
      'financial_jobs_dead_lettered_total',
    ]) {
      expect(res.text).toContain(name);
    }
  });
});

describe('financial retry / dead-letter policy', () => {
  it('dead-letters only after retries are exhausted', () => {
    expect(isFinalAttempt(1, 3)).toBe(false);
    expect(isFinalAttempt(2, 3)).toBe(false);
    expect(isFinalAttempt(3, 3)).toBe(true);
    expect(isFinalAttempt(4, 3)).toBe(true);
  });
});

describe('security headers', () => {
  it('sets hardened headers and hides the framework', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

/**
 * ═══ The admin roster, which did not exist. ═══
 *
 * The sponsor screen called `GET /admin/sponsors`, got a 404, and rendered its loading skeleton for
 * ever — a page that could only ever be blank. And `active` sat in the model reachable by nothing,
 * so a sponsorship could be created and never ended: the logo would stay on the landing page after
 * the term expired, and the UTM code would keep attributing signups to a partner who had stopped
 * paying.
 */
describe('sponsors: the admin roster and ending a sponsorship', () => {
  it('lists every sponsor with real counters, and never invents a spend figure', async () => {
    await seedUser({ authProviderId: 'p8roster|admin', roles: ['admin'] });
    const admin = await mintToken('p8roster|admin');

    await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(admin))
      .send({
        name: 'Valley Credit Union',
        utmCode: 'p8-vcu',
        tier: 'silver',
        // Recorded by hand — the column used to render a number from a demo fixture.
        contractedCents: 250_000,
        note: '6-month launch term',
      })
      .expect(201);

    const list = await request(app).get('/api/v1/admin/sponsors').set(...bearer(admin));
    expect(list.status).toBe(200);

    const row = (list.body.data as { utmCode: string }[]).find((s) => s.utmCode === 'p8-vcu');
    expect(row).toMatchObject({
      name: 'Valley Credit Union',
      tier: 'silver',
      active: true,
      contractedCents: 250_000,
      // Real stored counters, starting where they genuinely start.
      impressions: 0,
      attributedSignups: 0,
    });
  });

  it('ends a sponsorship: the logo comes down and the UTM stops attributing', async () => {
    await seedUser({ authProviderId: 'p8end|admin', roles: ['admin'] });
    const admin = await mintToken('p8end|admin');

    const create = await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(admin))
      .send({ name: 'Expired Co', utmCode: 'p8-expired' });
    const sponsorId = create.body.data.id as string;

    await request(app).post('/api/v1/sponsors/impression').send({ utmCode: 'p8-expired' });

    const ended = await request(app)
      .patch(`/api/v1/admin/sponsors/${sponsorId}`)
      .set(...bearer(admin))
      .send({ active: false });
    expect(ended.status).toBe(200);
    expect(ended.body.data.active).toBe(false);
    // What they finished with, reported rather than left to vanish from the screen.
    expect(ended.body.data.impressions).toBe(1);

    // The logo is off the public list…
    const publicList = await request(app).get('/api/v1/sponsors');
    expect(
      (publicList.body.data as { name: string }[]).some((s) => s.name === 'Expired Co'),
    ).toBe(false);

    // …the UTM no longer attributes a signup to them…
    const prereg = await request(app).post('/api/v1/preregistrations').send({
      fullName: 'Late Arrival',
      email: 'late-arrival@example.com',
      utmCode: 'p8-expired',
    });
    expect(prereg.status).toBe(201);
    expect(prereg.body.data.attributedToSponsor).toBe(false);

    // …and no further impressions are counted against them.
    await request(app).post('/api/v1/sponsors/impression').send({ utmCode: 'p8-expired' });
    const report = await request(app)
      .get(`/api/v1/admin/sponsors/${sponsorId}/report`)
      .set(...bearer(admin));
    expect(report.body.data.impressions).toBe(1);

    // But the record survives on the admin roster — a finished term is what an operator looks for.
    const list = await request(app).get('/api/v1/admin/sponsors').set(...bearer(admin));
    const row = (list.body.data as { name: string; active: boolean }[]).find(
      (s) => s.name === 'Expired Co',
    );
    expect(row!.active).toBe(false);
  });

  it('keeps the roster and edits admin-only', async () => {
    await seedUser({ authProviderId: 'p8auth|vendor', roles: ['vendor'] });
    const vendor = await mintToken('p8auth|vendor');
    const list = await request(app).get('/api/v1/admin/sponsors').set(...bearer(vendor));
    expect([401, 403]).toContain(list.status);
  });
});

/**
 * SELF-SERVE SPONSORSHIP.
 *
 * A sponsor could not sponsor StreetServe at all: the whole feature was admin record-keeping for a
 * deal closed by email, and the landing page's "Partner with us" link was a `mailto:`.
 *
 * The rule that shapes every test here: **paying does not publish a logo.** Anyone with a card
 * could otherwise put an arbitrary image on the landing page, so the money is taken first and a
 * person approves the image before it appears.
 */
describe('sponsors: buying a placement', () => {
  async function buyer(prefix: string) {
    await seedUser({ authProviderId: `${prefix}|sponsor`, roles: ['customer'] });
    return mintToken(`${prefix}|sponsor`);
  }

  function purchase(token: string, key: string, over: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/sponsors/purchase')
      .set(...bearer(token))
      .set('Idempotency-Key', key)
      .send({
        name: 'Valley Credit Union',
        tier: 'launch',
        termMonths: 3,
        contactEmail: 'ops@vcu.test',
        logoUrl: 'https://cdn.test/vcu.png',
        ...over,
      });
  }

  it('publishes the rate card, and prices the term server-side', async () => {
    const tiers = await request(app).get('/api/v1/sponsors/tiers');
    expect(tiers.status).toBe(200);
    expect(tiers.body.data.tiers.length).toBeGreaterThan(0);

    const token = await buyer('sp-price');
    const res = await purchase(token, 'sp-price-1');
    expect(res.status).toBe(201);
    // launch = $299/mo x 3 months. The client never names a price.
    expect(res.body.data.amountCents).toBe(89_700);
    expect(res.body.data.clientSecret).toEqual(expect.any(String));
    expect(res.body.data.status).toBe('pending_payment');
  });

  it('does not put a logo on the landing page until the money arrives AND a person approves', async () => {
    const token = await buyer('sp-flow');
    const res = await purchase(token, 'sp-flow-1', { name: 'Unapproved Co' });
    const sponsorId = res.body.data.id as string;

    // ── Paid for, not yet reviewed. Still not public. ──
    const notLiveYet = await request(app).get('/api/v1/sponsors');
    expect((notLiveYet.body.data as { name: string }[]).some((x) => x.name === 'Unapproved Co')).toBe(
      false,
    );

    const row = await SponsorModel.findById(sponsorId).lean();
    expect(row!.status).toBe('pending_payment');
    expect(row!.active).toBe(false);

    // ── The card clears. Moves to REVIEW — still not live. ──
    await stripeEvent('payment_intent.succeeded', { id: row!.pending_intent_ref });
    const paid = await SponsorModel.findById(sponsorId).lean();
    expect(paid!.status).toBe('pending_review');
    expect(paid!.active).toBe(false);
    expect(paid!.paid_cents).toBe(89_700);

    const stillNotLive = await request(app).get('/api/v1/sponsors');
    expect(
      (stillNotLive.body.data as { name: string }[]).some((x) => x.name === 'Unapproved Co'),
    ).toBe(false);

    // ── A person approves. NOW the logo is live. ──
    await seedUser({ authProviderId: 'sp-flow|admin', roles: ['admin'] });
    const admin = await mintToken('sp-flow|admin');
    const approve = await request(app)
      .post(`/api/v1/admin/sponsors/${sponsorId}/approve`)
      .set(...bearer(admin));
    expect(approve.status).toBe(200);
    expect(approve.body.data.active).toBe(true);
    // The term starts at approval, not at payment — otherwise a slow review silently eats days.
    expect(new Date(approve.body.data.endsAt).getTime()).toBeGreaterThan(Date.now());

    const live = await request(app).get('/api/v1/sponsors');
    expect((live.body.data as { name: string }[]).some((x) => x.name === 'Unapproved Co')).toBe(true);
  });

  it('cannot approve a placement that was never paid for', async () => {
    const token = await buyer('sp-unpaid');
    const res = await purchase(token, 'sp-unpaid-1', { name: 'Never Paid Co' });

    await seedUser({ authProviderId: 'sp-unpaid|admin', roles: ['admin'] });
    const admin = await mintToken('sp-unpaid|admin');
    const approve = await request(app)
      .post(`/api/v1/admin/sponsors/${res.body.data.id}/approve`)
      .set(...bearer(admin));
    expect(approve.status).toBe(409);
    expect(approve.body.error.message).toMatch(/not been paid for/i);
  });

  it('refunds when a logo is refused, and never publishes it', async () => {
    const token = await buyer('sp-reject');
    const res = await purchase(token, 'sp-reject-1', { name: 'Rejected Co' });
    const sponsorId = res.body.data.id as string;
    const row = await SponsorModel.findById(sponsorId).lean();
    await stripeEvent('payment_intent.succeeded', { id: row!.pending_intent_ref });

    await seedUser({ authProviderId: 'sp-reject|admin', roles: ['admin'] });
    const admin = await mintToken('sp-reject|admin');
    const reject = await request(app)
      .post(`/api/v1/admin/sponsors/${sponsorId}/reject`)
      .set(...bearer(admin))
      .send({ reason: 'The logo is not yours to use' });
    expect(reject.status).toBe(200);
    // Refusing a logo while keeping the money would be indefensible.
    expect(reject.body.data.refunded).toBe(true);

    const after = await SponsorModel.findById(sponsorId).lean();
    expect(after!.status).toBe('rejected');
    expect(after!.active).toBe(false);
  });

  it('takes the placement down when the term runs out', async () => {
    const token = await buyer('sp-expire');
    const res = await purchase(token, 'sp-expire-1', { name: 'Expiring Co', termMonths: 1 });
    const sponsorId = res.body.data.id as string;
    const row = await SponsorModel.findById(sponsorId).lean();
    await stripeEvent('payment_intent.succeeded', { id: row!.pending_intent_ref });

    await seedUser({ authProviderId: 'sp-expire|admin', roles: ['admin'] });
    const admin = await mintToken('sp-expire|admin');
    await request(app)
      .post(`/api/v1/admin/sponsors/${sponsorId}/approve`)
      .set(...bearer(admin))
      .expect(200);

    // Wind the term back past its end.
    await SponsorModel.updateOne({ _id: sponsorId }, { $set: { ends_at: new Date(Date.now() - 1000) } });
    expect(await sponsorsService.expireFinishedSponsorships()).toBeGreaterThanOrEqual(1);

    const after = await SponsorModel.findById(sponsorId).lean();
    expect(after!.status).toBe('expired');
    // The logo is down AND the UTM stops attributing — the defect `active` had when nothing set it.
    expect(after!.active).toBe(false);
  });

  it('rejects a tier or term the rate card does not offer', async () => {
    const token = await buyer('sp-bad');
    const badTier = await purchase(token, 'sp-bad-1', { tier: 'free-forever' });
    expect(badTier.status).toBe(404);
    const badTerm = await purchase(token, 'sp-bad-2', { termMonths: 7 });
    expect([400, 409, 422]).toContain(badTerm.status);
  });
});

/**
 * The waitlist was writable by the public and readable by nothing — the only endpoint was a bare
 * count — so every lead the landing page collected, including would-be sponsors, landed in a
 * collection no screen exposed.
 */
describe('sponsors: the waitlist an operator can finally read', () => {
  it('lists pre-registrations, filters by intended role, and names the referring sponsor', async () => {
    await seedUser({ authProviderId: 'leads|admin', roles: ['admin'] });
    const admin = await mintToken('leads|admin');

    const create = await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(admin))
      .send({ name: 'Referrer Co', utmCode: 'leads-ref' });
    expect(create.status).toBe(201);

    await request(app)
      .post('/api/v1/preregistrations')
      .send({ fullName: 'Would Be Sponsor', email: 'lead-sponsor@example.com', intendedRole: 'sponsor', utmCode: 'leads-ref' })
      .expect(201);
    await request(app)
      .post('/api/v1/preregistrations')
      .send({ fullName: 'Just A Customer', email: 'lead-customer@example.com', intendedRole: 'customer' })
      .expect(201);

    const all = await request(app).get('/api/v1/admin/preregistrations').set(...bearer(admin));
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);

    const sponsors = await request(app)
      .get('/api/v1/admin/preregistrations?intendedRole=sponsor')
      .set(...bearer(admin));
    const lead = (sponsors.body.data as { email: string; sponsorName: string | null }[]).find(
      (r) => r.email === 'lead-sponsor@example.com',
    );
    expect(lead).toBeTruthy();
    // Resolved to a NAME — a raw sponsor id tells an operator nothing.
    expect(lead!.sponsorName).toBe('Referrer Co');
    expect(
      (sponsors.body.data as { email: string }[]).some((r) => r.email === 'lead-customer@example.com'),
    ).toBe(false);
  });

  it('keeps the waitlist admin-only — it is a list of names and emails', async () => {
    await seedUser({ authProviderId: 'leads|vendor', roles: ['vendor'] });
    const vendor = await mintToken('leads|vendor');
    const res = await request(app).get('/api/v1/admin/preregistrations').set(...bearer(vendor));
    expect([401, 403]).toContain(res.status);

    const anon = await request(app).get('/api/v1/admin/preregistrations');
    expect(anon.status).toBe(401);
  });
});

describe('sponsors: admin CRUD + public logo list + UTM attribution', () => {
  it('creates a sponsor, lists it publicly, attributes a pre-registration, and reports', async () => {
    await seedUser({ authProviderId: 'p8|admin', roles: ['admin'] });
    const admin = await mintToken('p8|admin');

    const create = await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(admin))
      .send({ name: 'Wonder Ice', utmCode: 'wonder-ice', logoUrl: 'https://cdn.test/logo.png' });
    expect(create.status).toBe(201);
    const sponsorId = create.body.data.id as string;

    // Duplicate UTM code is rejected.
    const dup = await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(admin))
      .send({ name: 'Copycat', utmCode: 'wonder-ice' });
    expect(dup.status).toBe(409);

    // Public logo list exposes no internal counters.
    const list = await request(app).get('/api/v1/sponsors');
    const found = list.body.data.find((s: { name: string }) => s.name === 'Wonder Ice');
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('attributedSignups');

    // Public impression + attributed pre-registration.
    await request(app).post('/api/v1/sponsors/impression').send({ utmCode: 'wonder-ice' });
    const prereg = await request(app).post('/api/v1/preregistrations').send({
      fullName: 'Maria C',
      email: 'maria@example.com',
      intendedRole: 'customer',
      utmCode: 'wonder-ice',
    });
    expect(prereg.status).toBe(201);
    expect(prereg.body.data.attributedToSponsor).toBe(true);

    // Public waitlist count (landing page metrics strip) — bare number, no PII.
    const count = await request(app).get('/api/v1/preregistrations/count');
    expect(count.status).toBe(200);
    expect(typeof count.body.data.count).toBe('number');
    expect(count.body.data.count).toBeGreaterThanOrEqual(1);
    expect(count.body.data).not.toHaveProperty('email');

    // Admin report reflects the attribution + impression.
    const report = await request(app)
      .get(`/api/v1/admin/sponsors/${sponsorId}/report`)
      .set(...bearer(admin));
    expect(report.status).toBe(200);
    expect(report.body.data.attributedSignups).toBe(1);
    expect(report.body.data.impressions).toBe(1);

    // A non-admin cannot create sponsors.
    await seedUser({ authProviderId: 'p8|vendor', roles: ['vendor'] });
    const vendor = await mintToken('p8|vendor');
    const denied = await request(app)
      .post('/api/v1/admin/sponsors')
      .set(...bearer(vendor))
      .send({ name: 'X', utmCode: 'x' });
    expect(denied.status).toBe(403);
  });
});

describe('city-scoped feature gating (consignment)', () => {
  it('gates consignment to launch cities where the feature is enabled', async () => {
    // Public launch status.
    const launch0 = await request(app).get('/api/v1/config/launch');
    expect(launch0.status).toBe(200);
    expect(launch0.body.data.defaultCity).toBe('modesto-ca');

    // Configure the pilot city with consignment DISABLED → hub registration is blocked.
    await CityModel.updateOne(
      { slug: 'modesto-ca' },
      {
        $set: {
          name: 'Modesto',
          state: 'CA',
          status: 'live',
          feature_flags: { consignment: false },
        },
      },
      { upsert: true },
    );
    try {
      const blocked = await request(app)
        .post('/api/v1/hubs')
        .send({ businessId: '507f1f77bcf86cd799439011' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('FEATURE_DISABLED');

      const launch = await request(app).get('/api/v1/config/launch');
      expect(
        launch.body.data.liveCities.some((c: { slug: string }) => c.slug === 'modesto-ca'),
      ).toBe(true);
    } finally {
      // Restore the default (absent → enabled) so other suites are unaffected.
      await CityModel.deleteOne({ slug: 'modesto-ca' });
    }
  });
});
