import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { can } from '../src/shared/permissions';
import type { Principal } from '../src/shared/types/principal';
import { bearer, mintToken, seedUser } from './helpers';

/**
 * Authorization test harness — the merge-gate suite for the product's highest-risk area
 * (broken access control). It proves, at both the unit (matrix) and integration (route) level,
 * that the wrong actor is denied. See SECURITY_GUIDELINES.md §5, AUTHENTICATION_AND_AUTHORIZATION.md §3.
 */
const app = createApp();

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    authProviderId: 'auth|u1',
    roles: ['customer'],
    verificationTier: 'tier0',
    status: 'active',
    ...overrides,
  };
}

describe('permission matrix (unit)', () => {
  it('allows an action when the role matches', () => {
    expect(can(principal({ roles: ['admin'] }), 'admin:read_audit')).toEqual({ ok: true });
  });

  it('denies with reason "role" when the role is wrong', () => {
    expect(can(principal({ roles: ['customer'] }), 'admin:read_audit')).toEqual({
      ok: false,
      reason: 'role',
    });
  });

  it('denies with reason "tier" when the role matches but the tier is too low', () => {
    const seller = principal({ roles: ['seller'], verificationTier: 'tier0' });
    expect(can(seller, 'checkout:create')).toEqual({ ok: false, reason: 'tier' });
  });

  it('allows a tier-gated action once the tier is high enough', () => {
    const seller = principal({ roles: ['seller'], verificationTier: 'bronze' });
    expect(can(seller, 'checkout:create')).toEqual({ ok: true });
  });

  it('enforces separation of duties: admin cannot access finance-only actions', () => {
    expect(can(principal({ roles: ['admin'] }), 'finance:hold_payout')).toEqual({
      ok: false,
      reason: 'role',
    });
  });
});

describe('route authorization (integration)', () => {
  it('rejects an unauthenticated request to a protected route with 401', async () => {
    const res = await request(app).get('/api/v1/admin/audit-logs');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a customer from an admin route with 403 ROLE_REQUIRED', async () => {
    await seedUser({ authProviderId: 'authz|customer', roles: ['customer'] });
    const token = await mintToken('authz|customer');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set(...bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_REQUIRED');
  });

  it('rejects a customer from suspending another user with 403', async () => {
    await seedUser({ authProviderId: 'authz|customer2', roles: ['customer'] });
    const target = await seedUser({ authProviderId: 'authz|victim', roles: ['customer'] });
    const token = await mintToken('authz|customer2');
    const res = await request(app)
      .post(`/api/v1/admin/users/${target}/suspend`)
      .set(...bearer(token))
      .send({ reason: 'no reason' });
    expect(res.status).toBe(403);
  });

  it('allows an admin to read the audit log', async () => {
    await seedUser({ authProviderId: 'authz|admin', roles: ['admin'] });
    const token = await mintToken('authz|admin');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set(...bearer(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
