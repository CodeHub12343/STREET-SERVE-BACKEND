import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app';
import { bearer, mintToken, seedUser } from './helpers';
import { AuditLogModel } from '../src/shared/audit';
import { NotificationModel } from '../src/modules/notifications/notifications.model';
import { NOTIFICATION_RETENTION_DAYS, runRetentionPurge } from '../src/jobs/retention';

const app = createApp();

async function tokenFor(sub: string, role: 'admin' | 'customer'): Promise<string> {
  await seedUser({ authProviderId: sub, roles: [role] });
  return mintToken(sub);
}

/**
 * 6.4 — audit-log retention and access.
 *
 * Two findings drive these tests. Retention was **documented and not implemented**: the scheduler
 * described `daily-maintenance` as "retention purge, index health" and the worker logged a
 * heartbeat. And the audit log — the platform's most sensitive read surface, since it names who did
 * what to whom — recorded nothing about who read it.
 */
describe('retention purge (6.4)', () => {
  it('deletes READ notifications past the retention window', async () => {
    const old = new Date(Date.now() - (NOTIFICATION_RETENTION_DAYS + 10) * 86_400_000);
    const doc = await NotificationModel.create({
      user_id: 'u-retention-1',
      category: 'system',
      title: 'Old and read',
      body: 'x',
    });
    await NotificationModel.collection.updateOne(
      { _id: doc._id },
      { $set: { created_at: old, read_at: old } },
    );

    await runRetentionPurge();
    expect(await NotificationModel.findById(doc._id).lean()).toBeNull();
  });

  it('never deletes an UNREAD notification, however old', async () => {
    // An unread notification is a message the user has not seen. Deleting it deletes communication —
    // and several of these are §38/§49 contractual notices.
    const old = new Date(Date.now() - (NOTIFICATION_RETENTION_DAYS + 500) * 86_400_000);
    const doc = await NotificationModel.create({
      user_id: 'u-retention-2',
      category: 'rto',
      title: 'Old and unread',
      body: 'x',
    });
    await NotificationModel.collection.updateOne(
      { _id: doc._id },
      { $set: { created_at: old, read_at: null } },
    );

    await runRetentionPurge();
    expect(await NotificationModel.findById(doc._id).lean()).not.toBeNull();
  });

  it('never deletes an audit log, however old — it counts them instead', async () => {
    // The retention job must not be able to reach the record of what happened. A purge that can
    // touch audit logs is a purge that can destroy the evidence in a dispute.
    const old = new Date(Date.now() - 5 * 365 * 86_400_000);
    const entry = await AuditLogModel.create({
      action: 'test.ancient',
      entityType: 'test',
      entityId: 'ancient-1',
    });
    await AuditLogModel.collection.updateOne({ _id: entry._id }, { $set: { created_at: old } });

    const result = await runRetentionPurge();
    expect(await AuditLogModel.findById(entry._id).lean()).not.toBeNull();
    expect(result.auditLogsRetained).toBeGreaterThan(0);
  });
});

describe('audit-log access (6.4)', () => {
  it('records WHO read the audit log and WHAT SCOPE they used', async () => {
    const token = await tokenFor('audit|reader', 'admin');

    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ action: 'rto.late', limit: 10 })
      .set(...bearer(token));
    expect(res.status).toBe(200);

    const reads = await AuditLogModel.find({ action: 'admin.audit_log_read' })
      .sort({ created_at: -1 })
      .lean();
    expect(reads.length).toBeGreaterThan(0);
    const latest = reads[0]!;
    expect(latest.actorId).toBeTruthy();
    // "Who read the audit log" is much less useful than "who read WHICH PART of it".
    expect((latest.metadata as { scope?: Record<string, unknown> }).scope).toEqual({
      action: 'rto.late',
    });
  });

  it('filters by actor, action, and entity so an investigation need not read everything', async () => {
    await AuditLogModel.create({
      actorId: 'actor-needle',
      action: 'test.needle',
      entityType: 'needle',
      entityId: 'n1',
    });
    await AuditLogModel.create({
      actorId: 'actor-haystack',
      action: 'test.haystack',
      entityType: 'haystack',
      entityId: 'h1',
    });

    const token = await tokenFor('audit|filter', 'admin');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ action: 'test.needle', limit: 25 })
      .set(...bearer(token));

    expect(res.status).toBe(200);
    const actions = (res.body.data as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('test.needle');
    expect(actions).not.toContain('test.haystack');
  });

  it('refuses a non-admin, and the refusal leaves no audit read behind', async () => {
    const before = await AuditLogModel.countDocuments({ action: 'admin.audit_log_read' });
    const token = await tokenFor('audit|nosy', 'customer');

    const res = await request(app).get('/api/v1/admin/audit-logs').set(...bearer(token));
    expect(res.status).toBe(403);

    // The permission check runs before the service, so a rejected attempt does not write a read
    // entry — the log records reads that happened, not reads that were refused.
    expect(await AuditLogModel.countDocuments({ action: 'admin.audit_log_read' })).toBe(before);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    // A silently-ignored filter is worse than a rejected one: the reader believes their query was
    // scoped and it was not.
    const token = await tokenFor('audit|strict', 'admin');
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .query({ actorid: 'wrong-case' })
      .set(...bearer(token));
    expect(res.status).toBe(400); // the validation layer's code for a malformed query
  });
});
