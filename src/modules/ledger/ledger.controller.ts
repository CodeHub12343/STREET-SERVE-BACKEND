import type { Request, Response } from 'express';
import type { z } from 'zod';

import { query } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, UnauthenticatedError } from '../../shared/errors/AppError';
import { can } from '../../shared/permissions';
import { ListAccountsQuery, ListEntriesQuery, ReconcileQuery } from './ledger.schema';
import { ledgerService } from './ledger.service';

export const ledgerController = {
  listAccounts: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof ListAccountsQuery>>(req);
    ok(res, await ledgerService.listAccounts(q));
  },

  listEntries: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof ListEntriesQuery>>(req);
    ok(res, await ledgerService.listEntries(q));
  },

  /**
   * The operational early-warning system: does every account still equal the sum of its entries,
   * and does every transaction still net to zero? Anything non-zero here is a financial bug.
   */
  reconciliation: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof ReconcileQuery>>(req);

    /**
     * Reading the report and rewriting balances are different powers, and this endpoint offers both
     * through one query flag. The route only proves the caller may READ, so the write is gated here
     * — otherwise an admin could repair the books by appending `?repair=true` to a report they were
     * merely allowed to look at.
     */
    if (q.repair) {
      if (!req.principal) throw UnauthenticatedError();
      const allowed = can(req.principal, 'finance:repair_reconciliation');
      if (!allowed.ok) {
        throw ForbiddenError(
          'Repairing ledger balances is restricted to finance ops',
          ERROR_CODES.ROLE_REQUIRED,
        );
      }
    }

    const result = await ledgerService.reconcile({ repair: q.repair });
    ok(res, {
      ...result,
      healthy: result.drifted.length === 0 && result.unbalancedTransactions.length === 0,
    });
  },
};
