import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Generalized agreements (R28 / DEBT7): versioned, hashed bodies; tamper-evident clickwrap
 * acceptance; each transaction type gated on its agreement. Here: the vendor Terms of Sale gating
 * go-live, plus the tamper-evidence guard.
 */
const app = createApp();

async function openBusiness(prefix: string): Promise<{ token: string; businessId: string }> {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'services',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Biz`, categoryId: String(cat._id) });
  return { token, businessId: biz.body.data.id as string };
}

function goLive(token: string, businessId: string) {
  return request(app)
    .post('/api/v1/live-sessions/start')
    .set(...bearer(token))
    .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });
}

describe('agreements framework (R28)', () => {
  it('serves a versioned, hashed body for the clickwrap', async () => {
    const res = await request(app).get('/api/v1/agreements/regular_sale');
    expect(res.status).toBe(200);
    expect(res.body.data.version).toEqual(expect.any(String));
    expect(res.body.data.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.data.body.length).toBeGreaterThan(0);
  });

  it('gates go-live on the Terms of Sale, then unblocks once accepted', async () => {
    const { token, businessId } = await openBusiness('agr-gate');

    // No agreement yet → go-live is blocked (license is fine; the agreement is the wall).
    const blocked = await goLive(token, businessId);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('AGREEMENT_REQUIRED');

    // Accept the current version + hash.
    const body = await request(app).get('/api/v1/agreements/regular_sale');
    const accept = await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(token))
      .send({ version: body.body.data.version, contentHash: body.body.data.contentHash });
    expect(accept.status).toBe(201);
    expect(accept.body.data.accepted).toBe(true);

    // Now go-live is allowed.
    const allowed = await goLive(token, businessId);
    expect(allowed.status).toBe(201);

    // Re-accepting is idempotent — no error.
    const again = await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(token))
      .send({});
    expect(again.status).toBe(201);
  });

  it('rejects acceptance whose attested content hash is stale (tamper-evident, S5)', async () => {
    const { token } = await openBusiness('agr-tamper');
    const bad = await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(token))
      .send({ contentHash: 'f'.repeat(64) }); // not the current body's hash
    expect(bad.status).toBe(422);
  });
});
