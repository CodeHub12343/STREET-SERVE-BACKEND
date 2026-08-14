import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import { logger } from '../../config/logger';
import { ConflictError, ValidationError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import { writeAudit } from '../../shared/audit';
import { ledgerRepository as repo } from './ledger.repository';
import { signedDelta, type AccountType, type EntryType } from './ledger.model';

/**
 * Double-entry ledger service (Phase 1).
 *
 * THE central rule of the platform's finances: money never moves without a balanced ledger entry.
 * Every other service — payments, settlement, refunds, debt — posts through `post()` rather than
 * writing entries itself. That single chokepoint is what makes the books provable.
 */

export interface AccountRef {
  ownerType: 'platform' | 'user' | 'business';
  ownerId?: string | null;
  accountType: AccountType;
  currency?: string;
}

export interface EntryInput extends AccountRef {
  direction: 'debit' | 'credit';
  amountCents: number;
  entryType: EntryType;
  memo?: string;
  reversesEntryId?: string;
}

export interface PostInput {
  /** Supply for idempotency (e.g. `sale_<id>`); a repeated post is a no-op. */
  transactionId?: string;
  entries: EntryInput[];
  refType?: string;
  refId?: string;
  memo?: string;
}

const DEFAULT_CURRENCY = 'USD';

export const ledgerService = {
  /**
   * Post a balanced set of entries, atomically. Rejects the WHOLE set unless it sums to zero —
   * a half-written movement is worse than no movement at all.
   */
  async post(input: PostInput): Promise<{ transactionId: string; entryCount: number }> {
    const transactionId = input.transactionId ?? `txn_${randomUUID()}`;

    if (input.entries.length < 2) {
      throw ValidationError('A ledger transaction needs at least two entries');
    }

    // Idempotency: replaying a webhook or retrying a job must not double-post.
    if (await repo.transactionExists(transactionId)) {
      const existing = await repo.findByTransaction(transactionId);
      logger.debug({ transactionId }, 'ledger post skipped — transaction already recorded');
      return { transactionId, entryCount: existing.length };
    }

    const currencies = new Set(input.entries.map((e) => e.currency ?? DEFAULT_CURRENCY));
    if (currencies.size > 1) {
      throw ValidationError('A ledger transaction cannot mix currencies');
    }
    const currency = [...currencies][0] ?? DEFAULT_CURRENCY;

    for (const e of input.entries) {
      if (!Number.isInteger(e.amountCents) || e.amountCents < 0) {
        throw ValidationError('Ledger amounts must be non-negative integer cents');
      }
    }

    // THE INVARIANT.
    const debits = input.entries
      .filter((e) => e.direction === 'debit')
      .reduce((s, e) => s + e.amountCents, 0);
    const credits = input.entries
      .filter((e) => e.direction === 'credit')
      .reduce((s, e) => s + e.amountCents, 0);
    if (debits !== credits) {
      logger.error({ transactionId, debits, credits }, 'ledger imbalance rejected');
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        `Ledger transaction does not balance: debits ${debits} ≠ credits ${credits}`,
      );
    }

    // Resolve every account up-front so a missing account can't half-write the set.
    const accounts = await Promise.all(
      input.entries.map((e) =>
        repo.ensureAccount(e.ownerType, e.ownerId ?? null, e.accountType, e.currency ?? currency),
      ),
    );

    const docs = input.entries.map((e, i) => ({
      transaction_id: transactionId,
      account_id: String(accounts[i]!._id),
      direction: e.direction,
      amount_cents: e.amountCents,
      currency: e.currency ?? currency,
      entry_type: e.entryType,
      ref_type: input.refType ?? null,
      ref_id: input.refId ?? null,
      reverses_entry_id: e.reversesEntryId ?? null,
      memo: e.memo ?? input.memo ?? null,
    }));

    // Multi-document transaction where the replica set allows it (rs0 is configured); standalone
    // Mongo has no transactions, so fall back to sequential writes rather than failing outright.
    const session = await mongoose.startSession().catch(() => null);
    if (session) {
      try {
        await session.withTransaction(async () => {
          await repo.insertEntries(docs, session);
          for (let i = 0; i < input.entries.length; i++) {
            const e = input.entries[i]!;
            await repo.applyBalanceDelta(
              accounts[i]!._id,
              signedDelta(e.accountType, e.direction, e.amountCents),
              session,
            );
          }
        });
        return { transactionId, entryCount: docs.length };
      } catch (err) {
        logger.error({ err, transactionId }, 'ledger post failed inside transaction');
        throw err;
      } finally {
        await session.endSession();
      }
    }

    await repo.insertEntries(docs);
    for (let i = 0; i < input.entries.length; i++) {
      const e = input.entries[i]!;
      await repo.applyBalanceDelta(
        accounts[i]!._id,
        signedDelta(e.accountType, e.direction, e.amountCents),
      );
    }
    return { transactionId, entryCount: docs.length };
  },

  /** Natural balance of one account (0 when it has never been used). */
  async balanceOf(ref: AccountRef): Promise<number> {
    const account = await repo.findAccount(
      ref.ownerType,
      ref.ownerId ?? null,
      ref.accountType,
      ref.currency ?? DEFAULT_CURRENCY,
    );
    return account?.balance_cents ?? 0;
  },

  /** Authoritative balance, recomputed from entries — used to verify the cache. */
  async computedBalanceOf(ref: AccountRef): Promise<number> {
    const account = await repo.findAccount(
      ref.ownerType,
      ref.ownerId ?? null,
      ref.accountType,
      ref.currency ?? DEFAULT_CURRENCY,
    );
    if (!account) return 0;
    const { debits, credits } = await repo.sumEntriesByAccount(String(account._id));
    const asDebit = signedDelta(ref.accountType, 'debit', debits);
    const asCredit = signedDelta(ref.accountType, 'credit', credits);
    return asDebit + asCredit;
  },

  async ensureAccount(ref: AccountRef) {
    return repo.ensureAccount(
      ref.ownerType,
      ref.ownerId ?? null,
      ref.accountType,
      ref.currency ?? DEFAULT_CURRENCY,
    );
  },

  async listAccounts(filter: { ownerType?: string; ownerId?: string; accountType?: AccountType }) {
    const accounts = await repo.listAccounts(filter);
    return accounts.map((a) => ({
      id: String(a._id),
      ownerType: a.owner_type,
      ownerId: a.owner_id ?? null,
      accountType: a.account_type,
      currency: a.currency,
      balanceCents: a.balance_cents,
    }));
  },

  async listEntries(filter: {
    accountId?: string;
    transactionId?: string;
    refType?: string;
    refId?: string;
    cursor?: string;
    limit: number;
  }) {
    const before = filter.cursor ? new Date(filter.cursor) : undefined;
    const rows = await repo.listEntries({ ...filter, before });
    return {
      items: rows.map((e) => ({
        id: String(e._id),
        transactionId: e.transaction_id,
        accountId: e.account_id,
        direction: e.direction,
        amountCents: e.amount_cents,
        currency: e.currency,
        entryType: e.entry_type,
        refType: e.ref_type ?? null,
        refId: e.ref_id ?? null,
        memo: e.memo ?? null,
        createdAt: e.created_at,
      })),
      nextCursor:
        rows.length === filter.limit
          ? ((rows[rows.length - 1]?.created_at as Date | undefined)?.toISOString() ?? null)
          : null,
    };
  },

  /**
   * Reverse a prior transaction by posting its mirror image. Never edits the original — the
   * original stays true, and the correction is visible as its own event.
   */
  async reverse(
    transactionId: string,
    reason: string,
    actorId?: string,
  ): Promise<{ transactionId: string; entryCount: number }> {
    const original = await repo.findByTransaction(transactionId);
    if (original.length === 0) {
      throw ConflictError(ERROR_CODES.NOT_FOUND, `No ledger transaction ${transactionId}`);
    }
    const reversalId = `rev_${transactionId}`;
    if (await repo.transactionExists(reversalId)) {
      throw ConflictError(ERROR_CODES.DUPLICATE, `Transaction ${transactionId} already reversed`);
    }

    const accountCache = new Map<string, { ownerType: string; ownerId: string | null; accountType: AccountType }>();
    for (const e of original) {
      if (accountCache.has(e.account_id)) continue;
      const acct = await repo.findAccountById(e.account_id);
      if (!acct) throw ConflictError(ERROR_CODES.NOT_FOUND, `Missing ledger account ${e.account_id}`);
      accountCache.set(e.account_id, {
        ownerType: acct.owner_type,
        ownerId: acct.owner_id ?? null,
        accountType: acct.account_type,
      });
    }

    const entries: EntryInput[] = original.map((e) => {
      const acct = accountCache.get(e.account_id)!;
      return {
        ownerType: acct.ownerType as 'platform' | 'user' | 'business',
        ownerId: acct.ownerId,
        accountType: acct.accountType,
        currency: e.currency,
        direction: e.direction === 'debit' ? ('credit' as const) : ('debit' as const),
        amountCents: e.amount_cents,
        entryType: 'reversal' as EntryType,
        memo: reason,
        reversesEntryId: String(e._id),
      };
    });

    const result = await this.post({
      transactionId: reversalId,
      entries,
      refType: original[0]?.ref_type ?? undefined,
      refId: original[0]?.ref_id ?? undefined,
      memo: reason,
    });

    await writeAudit({
      actorId: actorId ?? 'system',
      action: 'ledger.reversed',
      entityType: 'ledger_transaction',
      entityId: transactionId,
      metadata: { reason, reversalId },
    });
    return result;
  },

  /**
   * Nightly reconciliation: recompute every account from its entries and compare against the
   * cached balance. Drift means a bug — the cache is repaired and the discrepancy reported, because
   * a marketplace that cannot prove its own books cannot be audited, financed, or sold.
   */
  async reconcile(options: { repair?: boolean } = {}): Promise<{
    accountsChecked: number;
    drifted: Array<{ accountId: string; cached: number; computed: number; deltaCents: number }>;
    unbalancedTransactions: string[];
    repaired: number;
  }> {
    const [accounts, sums, unbalanced] = await Promise.all([
      repo.allAccounts(),
      repo.sumEntriesGroupedByAccount(),
      repo.findUnbalancedTransactions(),
    ]);

    const totals = new Map<string, { debits: number; credits: number }>();
    for (const row of sums) {
      const key = row._id.account_id;
      const entry = totals.get(key) ?? { debits: 0, credits: 0 };
      if (row._id.direction === 'debit') entry.debits = row.total;
      else entry.credits = row.total;
      totals.set(key, entry);
    }

    const drifted: Array<{ accountId: string; cached: number; computed: number; deltaCents: number }> = [];
    let repaired = 0;

    for (const account of accounts) {
      const id = String(account._id);
      const { debits, credits } = totals.get(id) ?? { debits: 0, credits: 0 };
      const type = account.account_type;
      const computed = signedDelta(type, 'debit', debits) + signedDelta(type, 'credit', credits);
      const cached = account.balance_cents ?? 0;
      if (computed !== cached) {
        drifted.push({ accountId: id, cached, computed, deltaCents: computed - cached });
        if (options.repair) {
          await repo.setBalance(account._id, computed);
          repaired += 1;
        }
      }
    }

    const unbalancedTransactions = unbalanced.map((u) => u._id);

    if (drifted.length > 0 || unbalancedTransactions.length > 0) {
      logger.error(
        { drifted: drifted.length, unbalanced: unbalancedTransactions.length, repaired },
        'LEDGER RECONCILIATION FAILED — books do not agree with their entries',
      );
    } else {
      logger.info({ accountsChecked: accounts.length }, 'ledger reconciliation clean');
    }

    return {
      accountsChecked: accounts.length,
      drifted,
      unbalancedTransactions,
      repaired,
    };
  },

  /**
   * Solvency check (Phase 6). Can the platform actually meet what it owes?
   *
   * Compares held cash against outstanding obligations — money owed to sellers and hubs, plus
   * sales tax collected for the state. Tax is included deliberately: it is the state's money, so
   * spending it on payouts would be a far worse failure than being short.
   */
  async solvency(): Promise<{
    cashCents: number;
    payableCents: number;
    taxPayableCents: number;
    obligationsCents: number;
    surplusCents: number;
    healthy: boolean;
  }> {
    const accounts = await repo.allAccounts();
    const sum = (type: string) =>
      accounts.filter((a) => a.account_type === type).reduce((s, a) => s + (a.balance_cents ?? 0), 0);

    const cashCents = sum('cash');
    const payableCents = sum('payable');
    const taxPayableCents = sum('tax_payable');
    const obligationsCents = payableCents + taxPayableCents;

    return {
      cashCents,
      payableCents,
      taxPayableCents,
      obligationsCents,
      surplusCents: cashCents - obligationsCents,
      healthy: cashCents >= obligationsCents,
    };
  },

  /** Entries for one domain object — powers "show me the money trail for this settlement". */
  async entriesForRef(refType: string, refId: string) {
    const rows = await repo.findByRef(refType, refId);
    return rows.map((e) => ({
      id: String(e._id),
      transactionId: e.transaction_id,
      accountId: e.account_id,
      direction: e.direction,
      amountCents: e.amount_cents,
      entryType: e.entry_type,
      memo: e.memo ?? null,
      createdAt: e.created_at,
    }));
  },
};
