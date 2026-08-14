import type { LedgerReconcileResult, PlatformBalanceCheck } from './integrityAlerts.types';

/**
 * 8.3 — the decision that turns a detected problem into a page.
 *
 * ## Why this is its own module
 *
 * The financial integrity jobs already *detected* failures correctly. What was not verifiable was
 * the step after: whether a detected failure actually reaches a human. That decision lived inline
 * in the BullMQ worker — `if (drifted.length > 0) throw` — so confirming it required reading the
 * worker rather than running anything, and the worker needs a live Redis to instantiate.
 *
 * A production-readiness item that reads *"confirm the jobs alert correctly on a seeded failure"*
 * cannot be satisfied by code you can only inspect. These are the same rules, as pure functions,
 * called by the worker and exercised by tests.
 *
 * ## The convention: throwing IS the alert
 *
 * These jobs run under `FINANCIAL_JOB_OPTIONS`, where a throw on the final attempt dead-letters the
 * job and pages on-call. So "alert" and "throw" are the same act, and the only question each
 * function answers is *does this state warrant waking someone up?*
 *
 * ## Why drift pages even though the job repairs it
 *
 * `ledger-reconciliation` runs with `repair: true`: the cached balance is rewritten from the
 * entries, which are the source of truth. It would be easy to treat that as "handled" and stay
 * quiet. It is not handled — a balance that drifted did so because something wrote wrongly, and a
 * silent self-heal hides the bug that caused it while making the symptom disappear. The repair
 * keeps the platform usable; the page is what gets the cause fixed.
 */

/**
 * Should a ledger reconciliation result page on-call?
 *
 * Drifted cached balances OR transactions whose entries do not net to zero. The second is the more
 * serious: a cached balance can be recomputed, but an unbalanced transaction means double-entry
 * itself was violated and there is money in the books that came from nowhere or went nowhere.
 */
export function ledgerIntegrityAlert(result: LedgerReconcileResult): string | null {
  const drifted = result.drifted.length;
  const unbalanced = result.unbalancedTransactions.length;
  if (drifted === 0 && unbalanced === 0) return null;

  const parts: string[] = [];
  if (drifted > 0) {
    // The largest single discrepancy, because "12 accounts drifted" and "12 accounts drifted, one
    // by $40,000" are very different pages to receive at 3am.
    const worst = result.drifted.reduce((a, b) =>
      Math.abs(b.deltaCents) > Math.abs(a.deltaCents) ? b : a,
    );
    parts.push(
      `${drifted} drifted account(s), worst ${worst.accountId} off by ${worst.deltaCents} cents`,
    );
  }
  if (unbalanced > 0) {
    parts.push(
      `${unbalanced} unbalanced transaction(s): ${result.unbalancedTransactions.slice(0, 5).join(', ')}`,
    );
  }
  if (result.repaired > 0) {
    // Stated so the responder knows the cached balances are already corrected and the remaining
    // work is finding the writer that caused it — not re-running the repair.
    parts.push(`${result.repaired} cached balance(s) repaired — the CAUSE is still unfixed`);
  }
  return `ledger integrity failure: ${parts.join('; ')}`;
}

/**
 * Should a platform balance check page on-call?
 *
 * The check already composes its own alert strings (insolvency, low balance, unremitted tax, Stripe
 * drift); this decides whether any of them warrant a page. Every one does: each means the platform
 * either cannot fund a payout, is about to be unable to, or disagrees with Stripe about how much
 * money exists.
 */
export function platformBalanceAlert(result: PlatformBalanceCheck): string | null {
  if (result.alerts.length === 0) return null;
  return `platform balance alert: ${result.alerts.join(' | ')}`;
}
