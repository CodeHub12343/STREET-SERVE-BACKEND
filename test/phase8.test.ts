import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { isFinalAttempt } from '../src/jobs/financial';
import { CityModel } from '../src/modules/catalog/catalog.model';
import { bearer, mintToken, seedUser } from './helpers';

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
