import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { NonNegativeCents, PositiveCents } from '../../shared/money';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { EXPENSE_CATEGORIES } from './backoffice.model';
import { backofficeService } from './backoffice.service';

/**
 * 7.10 — back office: crew, expenses, invoices.
 *
 * Business-scoped surfaces sit behind `business:manage_own`; the crew invitee's own actions
 * (accept, decline, leave) are authenticated only, because the whole point of ADR-002's mutual
 * consent is that the invited person's answer is theirs to give.
 */
export const backofficeRouter = Router();

const objectId = z.string().length(24);
const BusinessIdParam = z.object({ id: objectId }).strict();
const IdParam = z.object({ id: objectId }).strict();

const InviteCrewBody = z
  .object({
    userId: z.string().min(1).max(64),
    note: z.string().max(120).optional(),
    /** A rate for work offered. Never a wage — ADR-002. */
    defaultRateCents: PositiveCents.optional(),
  })
  .strict();
const RespondBody = z.object({ accept: z.boolean() }).strict();

const AddExpenseBody = z
  .object({
    category: z.enum(EXPENSE_CATEGORIES),
    amountCents: PositiveCents,
    incurredOn: z.string().datetime(),
    description: z.string().max(500).optional(),
    receiptUrl: z.string().url().max(2000).optional(),
    vendorName: z.string().max(160).optional(),
  })
  .strict();
const ExpenseQuery = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
const SummaryQuery = z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict();

const CreateInvoiceBody = z
  .object({
    customerName: z.string().min(1).max(160),
    customerEmail: z.string().email().optional(),
    lineItems: z
      .array(
        z
          .object({
            description: z.string().min(1).max(300),
            quantity: z.number().int().min(1).max(10_000),
            unitPriceCents: NonNegativeCents,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    taxCents: NonNegativeCents.optional(),
    notes: z.string().max(1000).optional(),
    dueOn: z.string().datetime().optional(),
  })
  .strict();
const InvoiceStatusBody = z.object({ status: z.enum(['sent', 'paid', 'void']) }).strict();

function principalOf(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

// ─── Crew ──────────────────────────────────────────────────────────────────────────────────

backofficeRouter.get(
  '/businesses/:id/crew',
  rateLimit('read'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await backofficeService.listCrew(principalOf(req), id));
  }),
);

backofficeRouter.post(
  '/businesses/:id/crew',
  rateLimit('write'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam, body: InviteCrewBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof InviteCrewBody>>(req);
    created(res, await backofficeService.inviteCrew(principalOf(req), id, input));
  }),
);

/** The invitee's own answer — authenticated only, because it is theirs to give. */
backofficeRouter.post(
  '/crew/:id/respond',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam, body: RespondBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { accept } = body<z.infer<typeof RespondBody>>(req);
    ok(res, await backofficeService.respondToCrewInvite(principalOf(req), id, accept));
  }),
);

/** Either side can end it. A list only one party can leave is not a mutual arrangement. */
backofficeRouter.delete(
  '/crew/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    ok(res, await backofficeService.removeFromCrew(principalOf(req), id));
  }),
);

backofficeRouter.get(
  '/me/crews',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await backofficeService.myCrews(principalOf(req)));
  }),
);

// ─── Expenses ──────────────────────────────────────────────────────────────────────────────

backofficeRouter.get(
  '/businesses/:id/expenses',
  rateLimit('read'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam, query: ExpenseQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const q = query<z.infer<typeof ExpenseQuery>>(req);
    ok(res, await backofficeService.listExpenses(principalOf(req), id, q));
  }),
);

backofficeRouter.post(
  '/businesses/:id/expenses',
  rateLimit('write'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam, body: AddExpenseBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof AddExpenseBody>>(req);
    created(res, await backofficeService.addExpense(principalOf(req), id, input));
  }),
);

backofficeRouter.delete(
  '/expenses/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    ok(res, await backofficeService.deleteExpense(principalOf(req), id));
  }),
);

/** The summary a tax preparer asks for. Carries its own limits in the payload. */
backofficeRouter.get(
  '/businesses/:id/expenses/summary',
  rateLimit('read'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam, query: SummaryQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const q = query<z.infer<typeof SummaryQuery>>(req);
    ok(res, await backofficeService.expenseSummary(principalOf(req), id, q));
  }),
);

// ─── Invoices ──────────────────────────────────────────────────────────────────────────────

backofficeRouter.get(
  '/businesses/:id/invoices',
  rateLimit('read'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await backofficeService.listInvoices(principalOf(req), id));
  }),
);

backofficeRouter.post(
  '/businesses/:id/invoices',
  rateLimit('write'),
  authenticate,
  requirePermission('business:manage_own'),
  validate({ params: BusinessIdParam, body: CreateInvoiceBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateInvoiceBody>>(req);
    created(res, await backofficeService.createInvoice(principalOf(req), id, input));
  }),
);

backofficeRouter.patch(
  '/invoices/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam, body: InvoiceStatusBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { status } = body<z.infer<typeof InvoiceStatusBody>>(req);
    ok(res, await backofficeService.setInvoiceStatus(principalOf(req), id, status));
  }),
);
