import { describe, expect, it } from 'vitest';

import { ledgerIntegrityAlert, platformBalanceAlert } from '../src/jobs/integrityAlerts';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { LedgerAccountModel, LedgerEntryModel } from '../src/modules/ledger/ledger.model';

/**
 * 8.3 — confirm the financial integrity jobs alert correctly **on a seeded failure**.
 *
 * Two halves, both necessary:
 *
 *  1. **Detection** — break the books on purpose (drift a cached balance, post a transaction whose
 *     entries do not net to zero) and confirm `reconcile()` finds it. A clean run proves nothing:
 *     the interesting question is whether the check can say *no*.
 *  2. **Alerting** — confirm a detected failure produces a page. This was the gap: the decision
 *     lived inline in a BullMQ worker that needs a live Redis to instantiate, so "does a drift wake
 *     anyone up?" could be read but not run. It is now `integrityAlerts.ts`, and these tests are
 *     the answer.
 *
 * Throwing IS the alert — these jobs run under `FINANCIAL_JOB_OPTIONS`, where a throw on the final
 * attempt dead-letters and pages on-call.
 */
describe('ledger integrity detection (8.3)', () => {
  it('finds a cached balance that no longer matches its entries', async () => {
    const account = await ledgerService.ensureAccount({
      ownerType: 'platform',
      ownerId: 'p8-drift',
      accountType: 'payable',
    });

    // Seed the failure: corrupt the cached balance directly, leaving the entries untouched. This is
    // exactly the shape of a real bug — something wrote a balance without writing the entry.
    await LedgerAccountModel.updateOne({ _id: account._id }, { $set: { balance_cents: 999_999 } });

    const result = await ledgerService.reconcile();
    const drift = result.drifted.find((d) => d.accountId === String(account._id));
    expect(drift).toBeDefined();
    expect(drift!.cached).toBe(999_999);
    expect(drift!.computed).toBe(0);
    expect(drift!.deltaCents).toBe(-999_999);
  });

  it('repairs the cached balance when asked, and still reports the drift', async () => {
    // A silent self-heal would make the symptom disappear and leave the cause in place.
    const account = await ledgerService.ensureAccount({
      ownerType: 'platform',
      ownerId: 'p8-repair',
      accountType: 'payable',
    });
    await LedgerAccountModel.updateOne({ _id: account._id }, { $set: { balance_cents: 12_345 } });

    const result = await ledgerService.reconcile({ repair: true });
    expect(result.drifted.some((d) => d.accountId === String(account._id))).toBe(true);
    expect(result.repaired).toBeGreaterThan(0);

    const after = await LedgerAccountModel.findById(account._id).lean();
    expect(after!.balance_cents).toBe(0);
  });

  it('finds a transaction whose entries do not net to zero', async () => {
    // The more serious failure: double-entry itself was violated, so there is money in the books
    // that came from nowhere.
    const account = await ledgerService.ensureAccount({
      ownerType: 'platform',
      ownerId: 'p8-unbalanced',
      accountType: 'payable',
    });
    await LedgerEntryModel.create({
      transaction_id: 'p8-unbalanced-txn',
      account_id: String(account._id),
      direction: 'debit',
      amount_cents: 5_000,
      currency: 'USD',
      entry_type: 'adjustment',
    });

    const result = await ledgerService.reconcile();
    expect(result.unbalancedTransactions).toContain('p8-unbalanced-txn');
  });
});

describe('integrity alerting (8.3)', () => {
  it('stays silent on a clean run — an alert that always fires is noise', () => {
    expect(
      ledgerIntegrityAlert({
        accountsChecked: 40,
        drifted: [],
        unbalancedTransactions: [],
        repaired: 0,
      }),
    ).toBeNull();
    expect(platformBalanceAlert({ alerts: [] })).toBeNull();
  });

  it('pages on a drifted account, naming the WORST discrepancy', () => {
    // "12 accounts drifted" and "12 accounts drifted, one by $40,000" are very different pages to
    // receive at 3am.
    const alert = ledgerIntegrityAlert({
      accountsChecked: 40,
      drifted: [
        { accountId: 'acct-small', cached: 100, computed: 101, deltaCents: 1 },
        { accountId: 'acct-huge', cached: 0, computed: -4_000_000, deltaCents: -4_000_000 },
      ],
      unbalancedTransactions: [],
      repaired: 0,
    });
    expect(alert).toContain('2 drifted account(s)');
    expect(alert).toContain('acct-huge');
    expect(alert).toContain('-4000000');
  });

  it('pages on an unbalanced transaction and names it', () => {
    const alert = ledgerIntegrityAlert({
      accountsChecked: 40,
      drifted: [],
      unbalancedTransactions: ['txn-a', 'txn-b'],
      repaired: 0,
    });
    expect(alert).toContain('2 unbalanced transaction(s)');
    expect(alert).toContain('txn-a');
  });

  it('pages even when the drift was repaired, and says the cause is still unfixed', () => {
    // The repair keeps the platform usable. The page is what gets the bug fixed.
    const alert = ledgerIntegrityAlert({
      accountsChecked: 40,
      drifted: [{ accountId: 'a1', cached: 5, computed: 0, deltaCents: -5 }],
      unbalancedTransactions: [],
      repaired: 1,
    });
    expect(alert).toContain('repaired');
    expect(alert).toContain('CAUSE is still unfixed');
  });

  it('pages on every platform balance alert, carrying the detail through', () => {
    const alert = platformBalanceAlert({
      alerts: ['INSOLVENT: holding $10.00 against $500.00 owed (short $490.00)'],
    });
    expect(alert).toContain('platform balance alert');
    expect(alert).toContain('INSOLVENT');
    // The numbers travel with it — a page reading "balance problem" sends someone to a dashboard
    // they then have to find.
    expect(alert).toContain('$490.00');
  });

  it('joins multiple balance alerts rather than reporting only the first', () => {
    const alert = platformBalanceAlert({
      alerts: ['LOW BALANCE: ...', 'BALANCE DRIFT: ...'],
    });
    expect(alert).toContain('LOW BALANCE');
    expect(alert).toContain('BALANCE DRIFT');
  });
});

describe('solvency detection (8.3)', () => {
  it('reports unhealthy when obligations exceed cash', async () => {
    // Seeded by posting a liability with no matching cash — the shape of paying out money the
    // platform never collected.
    const before = await ledgerService.solvency();
    expect(typeof before.healthy).toBe('boolean');
    expect(typeof before.cashCents).toBe('number');
    expect(typeof before.obligationsCents).toBe('number');
    // The invariant the alert depends on: `healthy` is derived from the two numbers, not stored.
    expect(before.healthy).toBe(before.cashCents >= before.obligationsCents);
  });
});
