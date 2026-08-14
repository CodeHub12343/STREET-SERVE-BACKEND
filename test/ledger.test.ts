import { beforeEach, describe, expect, it } from 'vitest';

import {
  LedgerAccountModel,
  LedgerEntryModel,
  signedDelta,
} from '../src/modules/ledger/ledger.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';

/**
 * Phase 1 ledger invariants (docs/consignment/DATABASE_CHANGES.md "Invariants worth testing").
 *
 * These are the financial safety net. They exist BEFORE any money is routed through the ledger,
 * because a marketplace that cannot prove its own books cannot be audited, financed, or sold.
 */

const PLATFORM = { ownerType: 'platform' as const, ownerId: null };
const SELLER = { ownerType: 'user' as const, ownerId: 'seller_test_1' };
const HUB = { ownerType: 'business' as const, ownerId: 'hub_biz_test_1' };

/** A $903 cash sale: seller owes hub share + platform fee; nothing enters platform cash. */
function cashSaleEntries(hubShare: number, fee: number) {
  return [
    { ...SELLER, accountType: 'receivable' as const, direction: 'debit' as const, amountCents: hubShare + fee, entryType: 'cash_receivable' as const },
    { ...HUB, accountType: 'payable' as const, direction: 'credit' as const, amountCents: hubShare, entryType: 'hub_share' as const },
    { ...PLATFORM, accountType: 'fee_revenue' as const, direction: 'credit' as const, amountCents: fee, entryType: 'platform_fee' as const },
  ];
}

beforeEach(async () => {
  await LedgerEntryModel.deleteMany({});
  await LedgerAccountModel.deleteMany({});
});

describe('ledger invariants (Phase 1)', () => {
  // ── Invariant 1: every transaction group sums to zero ──
  it('1. rejects an unbalanced entry set outright, writing nothing', async () => {
    await expect(
      ledgerService.post({
        entries: [
          { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 90300, entryType: 'sale_capture' },
          { ...SELLER, accountType: 'payable', direction: 'credit', amountCents: 52825, entryType: 'seller_share' },
          // hub share + fee deliberately omitted → does not balance
        ],
      }),
    ).rejects.toThrow(/does not balance/i);

    // Nothing partially written.
    expect(await LedgerEntryModel.countDocuments({})).toBe(0);
  });

  it('1b. accepts a balanced set and records every entry', async () => {
    const { transactionId, entryCount } = await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 90300, entryType: 'sale_capture' },
        { ...SELLER, accountType: 'payable', direction: 'credit', amountCents: 52825, entryType: 'seller_share' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 28445, entryType: 'hub_share' },
        { ...PLATFORM, accountType: 'fee_revenue', direction: 'credit', amountCents: 9030, entryType: 'platform_fee' },
      ],
      refType: 'settlement',
      refId: 'stl_1',
    });
    expect(entryCount).toBe(4);

    const rows = await ledgerService.entriesForRef('settlement', 'stl_1');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.transactionId === transactionId)).toBe(true);
  });

  // ── Invariant 2: cached balance equals the sum of entries ──
  it('2. keeps cached balances equal to the entries that produced them', async () => {
    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 90300, entryType: 'sale_capture' },
        { ...SELLER, accountType: 'payable', direction: 'credit', amountCents: 52825, entryType: 'seller_share' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 28445, entryType: 'hub_share' },
        { ...PLATFORM, accountType: 'fee_revenue', direction: 'credit', amountCents: 9030, entryType: 'platform_fee' },
      ],
    });

    // Natural balances read positive: platform holds cash, and owes both parties.
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(90300);
    expect(await ledgerService.balanceOf({ ...SELLER, accountType: 'payable' })).toBe(52825);
    expect(await ledgerService.balanceOf({ ...HUB, accountType: 'payable' })).toBe(28445);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'fee_revenue' })).toBe(9030);

    // Cache agrees with the recomputed truth for every account.
    for (const ref of [
      { ...PLATFORM, accountType: 'cash' as const },
      { ...SELLER, accountType: 'payable' as const },
      { ...HUB, accountType: 'payable' as const },
      { ...PLATFORM, accountType: 'fee_revenue' as const },
    ]) {
      expect(await ledgerService.balanceOf(ref)).toBe(await ledgerService.computedBalanceOf(ref));
    }

    const report = await ledgerService.reconcile();
    expect(report.drifted).toHaveLength(0);
    expect(report.unbalancedTransactions).toHaveLength(0);
  });

  it('2b. detects and repairs a drifted cached balance', async () => {
    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 5000, entryType: 'sale_capture' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 5000, entryType: 'hub_share' },
      ],
    });

    // Corrupt the cache the way a bug would: entries stay correct, balance does not.
    await LedgerAccountModel.updateOne(
      { owner_type: 'platform', account_type: 'cash' },
      { $set: { balance_cents: 999999 } },
    );

    const detected = await ledgerService.reconcile();
    expect(detected.drifted).toHaveLength(1);
    expect(detected.drifted[0]!.cached).toBe(999999);
    expect(detected.drifted[0]!.computed).toBe(5000);

    const repaired = await ledgerService.reconcile({ repair: true });
    expect(repaired.repaired).toBe(1);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(5000);
    expect((await ledgerService.reconcile()).drifted).toHaveLength(0);
  });

  // ── Invariant 3: the three shares reconcile exactly to gross ──
  it('3. represents the full settlement split with no cent created or destroyed', async () => {
    const gross = 90300;
    const fee = 9030;
    const sellerNet = 52825;
    const hubShare = 28445;
    expect(fee + sellerNet + hubShare).toBe(gross);

    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: gross, entryType: 'sale_capture' },
        { ...SELLER, accountType: 'payable', direction: 'credit', amountCents: sellerNet, entryType: 'seller_share' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: hubShare, entryType: 'hub_share' },
        { ...PLATFORM, accountType: 'fee_revenue', direction: 'credit', amountCents: fee, entryType: 'platform_fee' },
      ],
    });

    const owed =
      (await ledgerService.balanceOf({ ...SELLER, accountType: 'payable' })) +
      (await ledgerService.balanceOf({ ...HUB, accountType: 'payable' })) +
      (await ledgerService.balanceOf({ ...PLATFORM, accountType: 'fee_revenue' }));
    expect(owed).toBe(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' }));
  });

  // ── Invariant 4: a receivable never goes negative through normal repayment ──
  it('4. tracks a cash-sale receivable down to exactly zero on repayment', async () => {
    const hubShare = 28445;
    const fee = 9030;
    const owed = hubShare + fee;

    await ledgerService.post({ entries: cashSaleEntries(hubShare, fee), refType: 'sale', refId: 'sale_cash_1' });
    expect(await ledgerService.balanceOf({ ...SELLER, accountType: 'receivable' })).toBe(owed);

    // The seller repays in full: their debt clears and the platform now holds the cash.
    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: owed, entryType: 'debt_repayment' },
        { ...SELLER, accountType: 'receivable', direction: 'credit', amountCents: owed, entryType: 'debt_repayment' },
      ],
    });

    expect(await ledgerService.balanceOf({ ...SELLER, accountType: 'receivable' })).toBe(0);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(owed);
  });

  // ── Invariant 5: no payout without a matching payable ──
  it('5. leaves a payable at zero after it is paid out, and never below', async () => {
    const hubShare = 28445;
    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: hubShare, entryType: 'sale_capture' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: hubShare, entryType: 'hub_share' },
      ],
    });

    const owedBefore = await ledgerService.balanceOf({ ...HUB, accountType: 'payable' });
    expect(owedBefore).toBe(hubShare);

    await ledgerService.post({
      entries: [
        { ...HUB, accountType: 'payable', direction: 'debit', amountCents: owedBefore, entryType: 'payout' },
        { ...PLATFORM, accountType: 'cash', direction: 'credit', amountCents: owedBefore, entryType: 'payout' },
      ],
    });

    expect(await ledgerService.balanceOf({ ...HUB, accountType: 'payable' })).toBe(0);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(0);
  });

  // ── Invariant 6: a reversal is the exact negative of the original ──
  it('6. reverses a transaction back to the starting balances without editing it', async () => {
    const { transactionId } = await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 10000, entryType: 'sale_capture' },
        { ...SELLER, accountType: 'payable', direction: 'credit', amountCents: 6500, entryType: 'seller_share' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 2500, entryType: 'hub_share' },
        { ...PLATFORM, accountType: 'fee_revenue', direction: 'credit', amountCents: 1000, entryType: 'platform_fee' },
      ],
      refType: 'sale',
      refId: 'sale_refund_me',
    });

    await ledgerService.reverse(transactionId, 'customer refund');

    // Every balance is back to zero…
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(0);
    expect(await ledgerService.balanceOf({ ...SELLER, accountType: 'payable' })).toBe(0);
    expect(await ledgerService.balanceOf({ ...HUB, accountType: 'payable' })).toBe(0);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'fee_revenue' })).toBe(0);

    // …and the original entries still exist untouched: history is preserved, not rewritten.
    const original = await LedgerEntryModel.find({ transaction_id: transactionId }).lean();
    expect(original).toHaveLength(4);
    const reversal = await LedgerEntryModel.find({ transaction_id: `rev_${transactionId}` }).lean();
    expect(reversal).toHaveLength(4);
    expect(reversal.every((r) => r.reverses_entry_id)).toBe(true);

    // Double-reversal is refused.
    await expect(ledgerService.reverse(transactionId, 'again')).rejects.toThrow(/already reversed/i);
  });

  // ── Invariant 7: ledger entries are immutable ──
  it('7. refuses in-place edits of a written entry', async () => {
    await ledgerService.post({
      entries: [
        { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 1000, entryType: 'sale_capture' },
        { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 1000, entryType: 'hub_share' },
      ],
    });
    const entry = await LedgerEntryModel.findOne({}).exec();
    expect(entry).toBeTruthy();

    await expect(
      LedgerEntryModel.updateOne({ _id: entry!._id }, { $set: { amount_cents: 1 } }).exec(),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('ledger mechanics', () => {
  it('is idempotent — replaying the same transaction id posts once', async () => {
    const entries = [
      { ...PLATFORM, accountType: 'cash' as const, direction: 'debit' as const, amountCents: 2500, entryType: 'sale_capture' as const },
      { ...HUB, accountType: 'payable' as const, direction: 'credit' as const, amountCents: 2500, entryType: 'hub_share' as const },
    ];
    await ledgerService.post({ transactionId: 'txn_fixed', entries });
    await ledgerService.post({ transactionId: 'txn_fixed', entries }); // webhook retry

    expect(await LedgerEntryModel.countDocuments({ transaction_id: 'txn_fixed' })).toBe(2);
    expect(await ledgerService.balanceOf({ ...PLATFORM, accountType: 'cash' })).toBe(2500);
  });

  it('rejects mixed currencies and negative amounts', async () => {
    await expect(
      ledgerService.post({
        entries: [
          { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: 100, currency: 'USD', entryType: 'sale_capture' },
          { ...HUB, accountType: 'payable', direction: 'credit', amountCents: 100, currency: 'EUR', entryType: 'hub_share' },
        ],
      }),
    ).rejects.toThrow(/currencies/i);

    await expect(
      ledgerService.post({
        entries: [
          { ...PLATFORM, accountType: 'cash', direction: 'debit', amountCents: -100, entryType: 'sale_capture' },
          { ...HUB, accountType: 'payable', direction: 'credit', amountCents: -100, entryType: 'hub_share' },
        ],
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it('applies the correct sign per account type', () => {
    // Debit-normal: platform cash rises when debited.
    expect(signedDelta('cash', 'debit', 100)).toBe(100);
    expect(signedDelta('cash', 'credit', 100)).toBe(-100);
    // Credit-normal: money owed rises when credited.
    expect(signedDelta('payable', 'credit', 100)).toBe(100);
    expect(signedDelta('payable', 'debit', 100)).toBe(-100);
    // Debt owed TO us behaves like an asset.
    expect(signedDelta('receivable', 'debit', 100)).toBe(100);
    expect(signedDelta('fee_revenue', 'credit', 100)).toBe(100);
  });
});
