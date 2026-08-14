import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { adminService } from './admin.service';
import { communityOpsService } from './community.ops';
import { noticesService } from '../notifications/notices.service';

export const adminRouter = Router();

const IdParam = z.object({ id: z.string().min(1) }).strict();
const SuspendBody = z.object({ reason: z.string().min(3).max(500) }).strict();

adminRouter.get(
  '/overview',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:read_overview'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await adminService.getOverview());
  }),
);

/**
 * 6.4 — scoped audit-log reads. Every filter is optional; supplying none reproduces the old
 * "everything, newest first" behaviour. The point is that an investigator no longer HAS to read
 * everything to find one action, and the scope they used is recorded alongside the read.
 */
const UndeliveredNoticesQuery = z
  .object({ days: z.coerce.number().int().min(1).max(365).optional() })
  .strict();

const AuditLogQuery = PaginationQuery.extend({
  actorId: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(120).optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();

adminRouter.get(
  '/audit-logs',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:read_audit'),
  validate({ query: AuditLogQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof AuditLogQuery>>(req);
    if (!req.principal) throw UnauthenticatedError();
    const page = await adminService.listAuditLogs(req.principal, {
      cursor: q.cursor,
      limit: q.limit,
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
    });
    ok(res, page.items, { nextCursor: page.nextCursor });
  }),
);

/**
 * 7.1 — contractual notices that reached nobody.
 *
 * The report that makes the notice record worth keeping. §38, §49, and §53 notices are obligations;
 * one that no channel accepted is a compliance problem, and without this it is a fact nobody learns
 * until a dispute. Admin-only, because it lists who could not be reached.
 */
adminRouter.get(
  '/notices/undelivered',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:read_audit'),
  validate({ query: UndeliveredNoticesQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof UndeliveredNoticesQuery>>(req);
    ok(res, await noticesService.listUndelivered(q.days ?? 30));
  }),
);

adminRouter.post(
  '/users/:id/suspend',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:suspend_user'),
  validate({ params: IdParam, body: SuspendBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { reason } = body<z.infer<typeof SuspendBody>>(req);
    const result = await adminService.suspendUser(req.principal, id, reason);
    ok(res, result);
  }),
);

// ─── Community network ops (Phase 8.4) ──────────────────────────────────────────────────────
/**
 * Support tooling for the three community features. Every action is audited, and **none of them can
 * move money to a person**: the fund action reconciles a cache to the ledger, the delivery action
 * closes a state machine through transitions that already exist, and the campaign action routes
 * through the vendor's own refund path. Ops tooling that can pay somebody is ops tooling that can be
 * socially engineered into paying somebody.
 */
const OpsReasonBody = z.object({ reason: z.string().min(3).max(280) }).strict();
const DeliveryResolveBody = z
  .object({
    outcome: z.enum(['delivered', 'cancelled']),
    reason: z.string().min(3).max(280),
  })
  .strict();

adminRouter.post(
  '/community-funds/:id/reconcile',
  rateLimit('write'),
  authenticate,
  requirePermission('finance:read_reconciliation'),
  validate({ params: IdParam, body: OpsReasonBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { reason } = body<z.infer<typeof OpsReasonBody>>(req);
    ok(res, await communityOpsService.reconcileFund(req.principal, id, reason));
  }),
);

adminRouter.post(
  '/deliveries/:id/resolve',
  rateLimit('write'),
  authenticate,
  requirePermission('driver:administer'),
  validate({ params: IdParam, body: DeliveryResolveBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof IdParam>>(req);
    const input = body<z.infer<typeof DeliveryResolveBody>>(req);
    ok(res, await communityOpsService.resolveStuckDelivery(req.principal, id, input));
  }),
);

adminRouter.post(
  '/boost-campaigns/:id/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('boost:administer'),
  validate({ params: IdParam, body: OpsReasonBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { reason } = body<z.infer<typeof OpsReasonBody>>(req);
    ok(res, await communityOpsService.cancelCampaign(req.principal, id, reason));
  }),
);

/** Read-only. Deliberately cannot answer "who else has been helped". */
adminRouter.get(
  '/community-redemptions/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:read_audit'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    ok(res, await communityOpsService.inspectRedemption(id));
  }),
);
