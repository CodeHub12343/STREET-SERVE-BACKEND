import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';

/**
 * Double-entry ledger (Phase 1 — docs/consignment/DATABASE_CHANGES.md §1–2).
 *
 * The single source of financial truth. Every movement of money in the platform is expressed as a
 * balanced set of entries, so the system can always answer "what does each party hold or owe?" —
 * a question nothing could answer before this existed.
 *
 * Two rules make the whole thing work:
 *   1. Entries are written in sets that sum to zero. An unbalanced set is rejected outright.
 *   2. Entries are append-only. Corrections are new reversing entries, never edits.
 */

// ─── account types ──────────────────────────────────────────────────────────────────────────
export const ACCOUNT_TYPES = [
  'cash', // funds the platform actually holds
  'payable', // what we owe a seller/hub
  'receivable', // what a seller owes us (cash sales, losses, clawbacks)
  'fee_revenue', // platform earnings
  'reserve', // withheld against refunds/chargebacks
  'write_off', // uncollectable, recognised as a loss
  /**
   * Sales tax collected as marketplace facilitator. NEVER revenue and never distributable — it is
   * the state's money held on their behalf until it is remitted.
   */
  'tax_payable',
  /**
   * Community money held on behalf of nobody in particular (ADR-005): a business's Pay It Forward
   * pool, and a Boost campaign's contributions before it funds.
   *
   * Modelled on `tax_payable` directly above, and for the same reason — **it is held, not earned.**
   * It is never revenue, never the vendor's, and never withdrawable: the only ways out are a
   * redemption against a real order at that business, expiry to the platform's city fund, or a
   * refund to the contributor. That no-withdrawal rule is what keeps the feature from being a
   * money-movement service rather than a marketplace feature.
   *
   * `payable` would have been the tempting choice and is wrong: it means *owed to a seller*, it is
   * consumed by payout logic, and pool money booked there would be paid out to a vendor who has not
   * earned it.
   */
  'community_fund_payable',
  /**
   * Owed to an outside SUPPLIER we bought from — currently the print vendor (ADR-007 §4).
   *
   * Under wholesale resale the buyer's whole payment lands in platform cash, but only the margin is
   * ours: the rest is a debt to the printer, discharged later when we settle. Booking that debt at
   * capture is what makes "no manual accounting" true rather than aspirational — otherwise every
   * postcard order silently overstates revenue until someone reconciles an invoice by hand.
   *
   * Separate from `payable` for the same reason `community_fund_payable` is: `payable` means *owed
   * to a seller or hub* and is consumed by payout logic. A supplier debt booked there would be paid
   * out to a vendor who never earned it. It is likewise not `reserve`, which is our own money held
   * back — this is somebody else's money that we owe.
   */
  'vendor_payable',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Normal balance side, in the accounting sense. `balance_cents` is stored as the account's NATURAL
 * balance so it reads positive in normal operation: platform cash rises when debited, while money
 * owed to a seller rises when credited.
 *
 * This is a TOTAL record rather than a set of debit-normal exceptions, and deliberately so. As a
 * set, adding an account type without also touching the set silently made it credit-normal — the
 * new type would keep books that balance and read backwards, which is the kind of error that is
 * found at an audit rather than in a test. Exhaustiveness means a new `AccountType` fails to
 * compile until somebody has decided which way its balance runs.
 */
const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  cash: 'debit', // an asset: the platform holds more when it is debited
  receivable: 'debit', // an asset: what others owe us
  write_off: 'debit', // an expense: a recognised loss
  payable: 'credit', // a liability: what we owe a seller/hub
  fee_revenue: 'credit', // income
  reserve: 'credit', // a liability: withheld against refunds/chargebacks
  tax_payable: 'credit', // a liability: the state's money, held
  community_fund_payable: 'credit', // a liability: the community's money, held
  vendor_payable: 'credit', // a liability: what we owe a supplier we bought from
};

/** Signed effect of one entry on its account's natural balance. */
export function signedDelta(
  accountType: AccountType,
  direction: 'debit' | 'credit',
  amountCents: number,
): number {
  return (NORMAL_BALANCE[accountType] === direction ? 1 : -1) * amountCents;
}

/** The side an account's balance grows on. Exported so tests and tooling can assert against it. */
export function normalBalanceOf(accountType: AccountType): 'debit' | 'credit' {
  return NORMAL_BALANCE[accountType];
}

export const ENTRY_TYPES = [
  'sale_capture', // customer money arrived
  'platform_fee',
  'seller_share',
  'hub_share',
  'payout', // money left to a connected account
  'cash_receivable', // a cash sale created a debt
  'debt_repayment',
  'refund',
  'reversal',
  'write_off',
  'adjustment', // manual correction (audited)
  'opening_balance',
  'tax_collected', // customer paid sales tax we hold for the state
  'tax_remitted', // paid over to the state
  // ── Community funds (ADR-005). The four ways money enters or leaves a pool. ──
  'community_contribution', // someone gave: platform cash rises, the pool liability rises with it
  'community_redemption', // the pool discharged an order: liability falls, seller is owed, fee earned
  'community_expiry', // unredeemed after 12 months: moves to the platform's city fund
  'community_refund', // returned to the contributor (24h window, or a failed Boost campaign)
  // ── Postcard marketing (ADR-007 §4). Wholesale resale: we collect all of it, we owe most of it. ──
  'postcard_order_payment', // buyer paid: platform cash rises by the full amount
  'postcard_vendor_cost', // the printer's share of that payment, booked as a debt we now owe
  'postcard_margin', // the only part that is ours
  'postcard_tax', // sales tax, held for the state (inert while the tax flag is off)
  'postcard_order_refund', // the whole capture unwound, before anything was printed
  'postcard_vendor_cost_reversed', // a debt that never existed in substance
  'postcard_margin_reversed',
  'postcard_tax_reversed',
  'postcard_vendor_settlement', // the printer was actually paid: debt discharged, cash leaves
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// ─── ledger_accounts ────────────────────────────────────────────────────────────────────────
const LedgerAccountSchema = new Schema(
  {
    owner_type: { type: String, enum: ['platform', 'user', 'business'], required: true },
    owner_id: { type: String, default: null }, // null for the platform's own accounts
    account_type: { type: String, enum: ACCOUNT_TYPES, required: true },
    currency: { type: String, required: true, default: 'USD' },
    /**
     * CACHED PROJECTION — never authoritative. The truth is always SUM(ledger_entries); this exists
     * so balances can be read without aggregating. `reconcile()` recomputes it nightly and any
     * drift is a bug worth paging on.
     */
    balance_cents: { type: Number, default: 0 },
    version: { type: Number, default: 0 }, // optimistic concurrency
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'ledger_accounts',
  },
);
LedgerAccountSchema.index(
  { owner_type: 1, owner_id: 1, account_type: 1, currency: 1 },
  { unique: true },
);

export type LedgerAccountDoc = InferSchemaType<typeof LedgerAccountSchema>;
export const LedgerAccountModel = defineModel('LedgerAccount', LedgerAccountSchema);

// ─── ledger_entries (immutable, append-only) ────────────────────────────────────────────────
const LedgerEntrySchema = new Schema(
  {
    /** Groups the entries of one event. Every group MUST sum to zero. */
    transaction_id: { type: String, required: true, index: true },
    account_id: { type: String, required: true, index: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    /** Always positive — `direction` carries the sign. */
    amount_cents: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'USD' },
    entry_type: { type: String, enum: ENTRY_TYPES, required: true },
    ref_type: { type: String, default: null }, // checkout | sale | settlement | refund | debt
    ref_id: { type: String, default: null },
    reverses_entry_id: { type: String, default: null }, // set only on reversals
    memo: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'ledger_entries' },
);
LedgerEntrySchema.index({ account_id: 1, created_at: -1 });
LedgerEntrySchema.index({ ref_type: 1, ref_id: 1 });
LedgerEntrySchema.plugin(immutablePlugin);

export type LedgerEntryDoc = InferSchemaType<typeof LedgerEntrySchema>;
export const LedgerEntryModel = defineModel('LedgerEntry', LedgerEntrySchema);
