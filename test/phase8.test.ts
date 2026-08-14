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
