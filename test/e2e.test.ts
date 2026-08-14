import { createHmac } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Phase 0 exit criterion: "an authenticated request flows end-to-end with RBAC, validation,
 * logging, and a passing authz test." This exercises the full chain — verify token → JIT
 * provision → RBAC → validation → controller → service → Mongo → response envelope — plus the
 * suspension interlock, the additive-role flow, catalog reads, and a signed webhook.
 */
const app = createApp();

describe('health', () => {
  it('GET /healthz is 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /readyz reports mongo ready', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.mongo).toBe(true);
  });
});

describe('authenticated identity flow', () => {
  it('rejects a request with no token (401)', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('JIT-provisions a new user with the default customer role on first authenticated request', async () => {
    const token = await mintToken('e2e|newuser', { email: 'new@example.com' });
    const res = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['customer']);
    expect(res.body.data.verificationTier).toBe('tier0');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('adds a self-grantable role (customer → seller)', async () => {
    const token = await mintToken('e2e|becomeseller');
    await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token)); // provision
    const res = await request(app)
      .post('/api/v1/auth/roles')
      .set(...bearer(token))
      .send({ role: 'seller' });
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toContain('seller');
  });

  it('re-granting a held role is an idempotent no-op success (not an error)', async () => {
    const token = await mintToken('e2e|dupseller');
    await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token)); // provision
    const add = () =>
      request(app)
        .post('/api/v1/auth/roles')
        .set(...bearer(token))
        .send({ role: 'seller' });
    expect((await add()).status).toBe(200);
    const second = await add();
    expect(second.status).toBe(200);
    // Still exactly one active grant — no duplicate, no error.
    expect(second.body.data.roles.filter((r: string) => r === 'seller')).toHaveLength(1);
  });

  it('forbids self-granting admin (403 CANNOT_SELF_GRANT_ROLE)', async () => {
    const token = await mintToken('e2e|wantsadmin');
    await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token));
    const res = await request(app)
      .post('/api/v1/auth/roles')
      .set(...bearer(token))
      .send({ role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_SELF_GRANT_ROLE');
  });

  it('rejects an unknown field in the request body (validation, 400)', async () => {
    const token = await mintToken('e2e|validate');
    await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token));
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(...bearer(token))
      .send({ displayName: 'Ok', notAField: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('suspension interlock', () => {
  it('an admin can suspend a user, after which that user is rejected even with a valid token', async () => {
    const target = await seedUser({ authProviderId: 'e2e|tosuspend', roles: ['customer'] });
    const targetToken = await mintToken('e2e|tosuspend');

    // Works before suspension.
    const before = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(targetToken));
    expect(before.status).toBe(200);

    await seedUser({ authProviderId: 'e2e|adminactor', roles: ['admin'] });
    const adminToken = await mintToken('e2e|adminactor');
    const suspend = await request(app)
      .post(`/api/v1/admin/users/${target}/suspend`)
      .set(...bearer(adminToken))
      .send({ reason: 'policy violation' });
    expect(suspend.status).toBe(200);

    // Rejected after suspension.
    const after = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(targetToken));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('catalog reference data', () => {
  it('returns active categories', async () => {
    await CategoryModel.create({
      slug: 'food-truck',
      name: 'Food Truck',
      top_level_tab: 'food',
      requires_license: true,
    });
    const res = await request(app).get('/api/v1/catalog/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: { slug: string }) => c.slug === 'food-truck')).toBe(true);
  });
});

describe('operational endpoints', () => {
  it('exposes Prometheus metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

  it('serves the generated OpenAPI document', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/api/v1/users/me']).toBeDefined();
  });
});

describe('auth webhook (user sync)', () => {
  it('rejects an unsigned webhook (403)', async () => {
    const res = await request(app).post('/webhooks/clerk').send({ type: 'user.created' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('accepts a correctly-signed user.created event and provisions the user', async () => {
    const payload = JSON.stringify({
      type: 'user.created',
      data: {
        id: 'webhook|synced',
        email_addresses: [{ email_address: 'synced@example.com' }],
      },
    });
    const signature = createHmac('sha256', 'test-webhook-secret').update(payload).digest('hex');
    const res = await request(app)
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .set('x-signature', signature)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);

    // The synced user can now authenticate.
    const token = await mintToken('webhook|synced');
    const me = await request(app)
      .get('/api/v1/users/me')
      .set(...bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toContain('customer');
  });
});
