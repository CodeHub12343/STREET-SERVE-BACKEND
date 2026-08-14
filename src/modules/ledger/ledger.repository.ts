import type { ClientSession } from 'mongoose';

import {
  LedgerAccountModel,
  LedgerEntryModel,
  type AccountType,
  type LedgerAccountDoc,
} from './ledger.model';

export const ledgerRepository = {
  // ─── Accounts ─────────────────────────────────────────────────────────────────────────────
  findAccount(
    ownerType: string,
    ownerId: string | null,
    accountType: AccountType,
    currency: string,
  ) {
    return LedgerAccountModel.findOne({
      owner_type: ownerType,
      owner_id: ownerId,
      account_type: accountType,
      currency,
    })
      .lean()
      .exec();
  },

  /**
   * Get-or-create, race-safe: a concurrent post for the same party must not create two accounts.
   * The unique index makes the upsert authoritative.
   */
  async ensureAccount(
    ownerType: string,
    ownerId: string | null,
    accountType: AccountType,
    currency: string,
    session?: ClientSession,
  ): Promise<LedgerAccountDoc & { _id: unknown }> {
    const filter = {
      owner_type: ownerType,
      owner_id: ownerId,
      account_type: accountType,
      currency,
    };
    return LedgerAccountModel.findOneAndUpdate(
      filter,
      { $setOnInsert: { ...filter, balance_cents: 0, version: 0 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    ).exec() as Promise<LedgerAccountDoc & { _id: unknown }>;
  },

  findAccountById(id: string) {
    return LedgerAccountModel.findById(id).lean().exec();
  },

  listAccounts(filter: { ownerType?: string; ownerId?: string; accountType?: AccountType }) {
    return LedgerAccountModel.find({
      ...(filter.ownerType ? { owner_type: filter.ownerType } : {}),
      ...(filter.ownerId ? { owner_id: filter.ownerId } : {}),
      ...(filter.accountType ? { account_type: filter.accountType } : {}),
    })
      .sort({ owner_type: 1, account_type: 1 })
      .lean()
      .exec();
  },

  allAccounts() {
    return LedgerAccountModel.find().lean().exec();
  },

  applyBalanceDelta(accountId: unknown, deltaCents: number, session?: ClientSession) {
    return LedgerAccountModel.updateOne(
      { _id: accountId },
      { $inc: { balance_cents: deltaCents, version: 1 } },
      { session },
    ).exec();
  },

  /** Used only by reconciliation to repair a drifted cache — never on the money path. */
  setBalance(accountId: unknown, balanceCents: number) {
    return LedgerAccountModel.updateOne(
      { _id: accountId },
      { $set: { balance_cents: balanceCents }, $inc: { version: 1 } },
    ).exec();
  },

  // ─── Entries ──────────────────────────────────────────────────────────────────────────────
  insertEntries(
    docs: Array<Record<string, unknown>>,
    session?: ClientSession,
  ): Promise<unknown[]> {
    return LedgerEntryModel.insertMany(docs, { session, ordered: true }) as Promise<unknown[]>;
  },

  findByTransaction(transactionId: string) {
    return LedgerEntryModel.find({ transaction_id: transactionId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
  },

  transactionExists(transactionId: string) {
    return LedgerEntryModel.exists({ transaction_id: transactionId });
  },

  findByRef(refType: string, refId: string) {
    return LedgerEntryModel.find({ ref_type: refType, ref_id: refId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
  },

  listEntries(filter: {
    accountId?: string;
    transactionId?: string;
    refType?: string;
    refId?: string;
    before?: Date;
    limit: number;
  }) {
    return LedgerEntryModel.find({
      ...(filter.accountId ? { account_id: filter.accountId } : {}),
      ...(filter.transactionId ? { transaction_id: filter.transactionId } : {}),
      ...(filter.refType ? { ref_type: filter.refType } : {}),
      ...(filter.refId ? { ref_id: filter.refId } : {}),
      ...(filter.before ? { created_at: { $lt: filter.before } } : {}),
    })
      .sort({ created_at: -1, _id: -1 })
      .limit(filter.limit)
      .lean()
      .exec();
  },

  /** Authoritative balance: summed straight from the entries. */
  async sumEntriesByAccount(accountId: string): Promise<{ debits: number; credits: number }> {
    const rows = await LedgerEntryModel.aggregate<{ _id: string; total: number }>([
      { $match: { account_id: accountId } },
      { $group: { _id: '$direction', total: { $sum: '$amount_cents' } } },
    ]).exec();
    return {
      debits: rows.find((r) => r._id === 'debit')?.total ?? 0,
      credits: rows.find((r) => r._id === 'credit')?.total ?? 0,
    };
  },

  /** Every account's debit/credit totals in one pass — the nightly reconciliation query. */
  sumEntriesGroupedByAccount() {
    return LedgerEntryModel.aggregate<{
      _id: { account_id: string; direction: string };
      total: number;
    }>([
      {
        $group: {
          _id: { account_id: '$account_id', direction: '$direction' },
          total: { $sum: '$amount_cents' },
        },
      },
    ]).exec();
  },

  /**
   * Transaction groups whose entries don't net to zero. This should ALWAYS return nothing —
   * anything here means a balanced-set bug slipped through and the books can't be trusted.
   */
  findUnbalancedTransactions(limit = 50) {
    return LedgerEntryModel.aggregate<{ _id: string; net: number }>([
      {
        $group: {
          _id: '$transaction_id',
          net: {
            $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount_cents', { $multiply: ['$amount_cents', -1] }] },
          },
        },
      },
      { $match: { net: { $ne: 0 } } },
      { $limit: limit },
    ]).exec();
  },
};
