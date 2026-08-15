import { AuditLogModel } from '../../shared/audit';
import { writeAudit } from '../../shared/audit';
import { decodeCursor, encodeCursor, type Page } from '../../shared/pagination';
import { NotFoundError } from '../../shared/errors/AppError';
import { identityRepository } from '../identity/identity.repository';
import type { Principal } from '../../shared/types/principal';
import { UserModel } from '../identity/identity.model';
import { BusinessModel, LicenseDocumentModel } from '../vendors/vendors.model';
import { LiveSessionModel } from '../livemap/livemap.model';
import { TransactionModel } from '../payments/payments.model';
import { OrderModel } from '../orders/orders.model';
import { DisputeModel } from '../disputes/disputes.model';
import { CityModel } from '../catalog/catalog.model';
import { FraudFlagModel } from '../../shared/fraud';

interface AuditCursor {
  createdAt: string;
  id: string;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const adminService = {
  /**
   * Ops overview (GAP-2, A-01) — a single composed snapshot for the Trust & Safety dashboard.
   * Every metric maps to a real collection (documented inline); no invented numbers.
   */
  async getOverview() {
    const since = startOfTodayUtc();
    const [
      cityDoc,
      liveSessions,
      activeVendors,
      gmvAgg,
      ordersToday,
      openDisputes,
      fraudFlags,
      pendingLicenses,
      newSignups,
    ] = await Promise.all([
      CityModel.findOne({ status: 'live' }).sort({ created_at: 1 }).lean().exec(),
      LiveSessionModel.countDocuments({ ended_at: null }).exec(),
      BusinessModel.countDocuments({ is_hub: false, status: 'active' }).exec(),
      TransactionModel.aggregate<{ _id: null; total: number }>([
        { $match: { status: 'completed', completed_at: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ]).exec(),
      OrderModel.countDocuments({ created_at: { $gte: since } }).exec(),
      DisputeModel.countDocuments({ status: { $in: ['open', 'evidence_requested'] } }).exec(),
      FraudFlagModel.countDocuments({ status: 'open' }).exec(),
      LicenseDocumentModel.countDocuments({ status: 'pending' }).exec(),
      UserModel.countDocuments({ created_at: { $gte: since } }).exec(),
    ]);

    return {
      city: cityDoc?.name ?? 'Modesto, CA',
      liveSessions,
      activeVendors,
      gmvTodayCents: gmvAgg[0]?.total ?? 0,
      ordersToday,
      openDisputes,
      fraudFlags,
      pendingLicenses,
      newSignups,
    };
  },

  /**
   * Cursor-paginated audit log feed (newest first).
   *
   * 6.4 — two things changed here, and both are about least privilege in practice rather than in
   * the permission matrix:
   *
   * 1. **Filters.** Without them, an admin investigating one payout had to page through every
   *    action by every actor to find it. "Read only what you need" is not a policy anyone can
   *    follow when the only available query is "everything, newest first".
   * 2. **The read is itself audited.** The audit log is the most sensitive read surface on the
   *    platform — it names who did what to whom — and nothing recorded who looked at it. An audit
   *    trail that does not cover its own readers cannot answer the question it exists for.
   */
  async listAuditLogs(
    actor: Principal,
    opts: {
      cursor?: string;
      limit: number;
      actorId?: string;
      action?: string;
      entityType?: string;
      entityId?: string;
      from?: string;
      to?: string;
    },
  ): Promise<Page<unknown>> {
    const cursor = decodeCursor<AuditCursor>(opts.cursor);

    const scope: Record<string, unknown> = {};
    if (opts.actorId) scope.actorId = opts.actorId;
    if (opts.action) scope.action = opts.action;
    if (opts.entityType) scope.entityType = opts.entityType;
    if (opts.entityId) scope.entityId = opts.entityId;
    if (opts.from || opts.to) {
      scope.created_at = {
        ...(opts.from ? { $gte: new Date(opts.from) } : {}),
        ...(opts.to ? { $lte: new Date(opts.to) } : {}),
      };
    }

    const paging = cursor
      ? {
          $or: [
            { created_at: { $lt: new Date(cursor.createdAt) } },
            { created_at: new Date(cursor.createdAt), _id: { $lt: cursor.id } },
          ],
        }
      : {};
    // A date filter and the cursor both constrain `created_at`, so they are combined with $and
    // rather than merged — merging would silently drop one of them.
    const filter =
      Object.keys(scope).length > 0 && cursor
        ? { $and: [scope, paging] }
        : { ...scope, ...paging };

    // Recorded BEFORE the read, so an audit-log query that then fails or times out still leaves a
    // trace. The scope is recorded too: "who read the audit log" is much less useful than "who read
    // WHICH PART of the audit log".
    await writeAudit({
      actorId: actor.userId,
      action: 'admin.audit_log_read',
      entityType: 'audit_log',
      metadata: {
        scope,
        limit: opts.limit,
        paged: Boolean(opts.cursor),
      },
    });

    const docs = await AuditLogModel.find(filter)
      .sort({ created_at: -1, _id: -1 })
      .limit(opts.limit + 1)
      .lean()
      .exec();

    const items = docs.slice(0, opts.limit);
    const last = items[items.length - 1];
    const nextCursor =
      docs.length > opts.limit && last
        ? encodeCursor({ createdAt: (last.created_at as Date).toISOString(), id: String(last._id) })
        : null;

    return { items, nextCursor };
  },

  /** Suspend an account. Writes an audit entry (actor, timestamp, reason). */
  async suspendUser(actor: Principal, targetUserId: string, reason: string) {
    const user = await identityRepository.findUserById(targetUserId);
    if (!user) throw NotFoundError('User not found');
    const updated = await identityRepository.setUserStatus(targetUserId, 'suspended');
    await writeAudit({
      actorId: actor.userId,
      actorRole: 'admin',
      action: 'user.suspended',
      entityType: 'user',
      entityId: targetUserId,
      reason,
    });
    return { id: targetUserId, status: updated?.status };
  },

  /**
   * Find a business by name, for the admin screens that have to act on one.
   *
   * Every such control — the Rent-to-Own approval roster, the postcard pilot — asked the operator
   * to paste a 24-character Mongo ObjectId. Nobody outside engineering has one, and pasting the
   * WRONG one failed silently: an RTO approval recorded against a user id wrote a row, reported
   * success, and left the seller blocked with nothing on either screen explaining why.
   *
   * The owner is returned alongside the name because two businesses can share a name, and an
   * operator granting a credit-like permission has to be able to tell which one they are granting.
   */
  async searchBusinesses(q: string, limit = 10) {
    const term = q.trim();
    // Two characters minimum: a single letter matches most of the table and helps nobody choose.
    if (term.length < 2) return [];
    // Escaped — an operator typing "(" in a shop name must not produce an invalid-regex 500.
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = await BusinessModel.find({ name: { $regex: safe, $options: 'i' } })
      .select('name owner_user_id status is_hub')
      .limit(Math.min(limit, 25))
      .lean()
      .exec();

    const owners = await UserModel.find({ _id: { $in: rows.map((r) => r.owner_user_id) } })
      .select('display_name email')
      .lean()
      .exec();
    const ownerById = new Map(owners.map((o) => [String(o._id), o]));

    return rows.map((r) => {
      const owner = ownerById.get(String(r.owner_user_id));
      return {
        id: String(r._id),
        name: r.name,
        status: r.status,
        isHub: Boolean(r.is_hub),
        ownerName: owner?.display_name ?? null,
        ownerEmail: owner?.email ?? null,
      };
    });
  },
};
