import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ledgerController } from './ledger.controller';
import { ListAccountsQuery, ListEntriesQuery, ReconcileQuery } from './ledger.schema';

/**
 * Finance read surface (Phase 1). Read-only by design: the ledger is written only by services
 * posting through `ledgerService.post()`, never by an HTTP caller.
 */
export const financeRouter = Router();

financeRouter.get(
  '/accounts',
  rateLimit('read'),
  authenticate,
  requirePermission('finance:read_ledger'),
  validate({ query: ListAccountsQuery }),
  asyncHandler(ledgerController.listAccounts),
);

financeRouter.get(
  '/entries',
  rateLimit('read'),
  authenticate,
  requirePermission('finance:read_ledger'),
  validate({ query: ListEntriesQuery }),
  asyncHandler(ledgerController.listEntries),
);

financeRouter.get(
  '/reconciliation',
  rateLimit('read'),
  authenticate,
  requirePermission('finance:read_reconciliation'),
  validate({ query: ReconcileQuery }),
  asyncHandler(ledgerController.reconciliation),
);
