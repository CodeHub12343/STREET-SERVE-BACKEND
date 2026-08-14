/**
 * 8.3 — the shapes `integrityAlerts.ts` reasons about.
 *
 * Declared separately, and structurally rather than by importing the services, so the alert rules
 * can be tested without booting Mongo or Stripe. The services' real return types are assignable to
 * these; a compile error here means a detector changed shape and its alert rule needs re-reading,
 * which is exactly when someone should look.
 */

export interface LedgerDrift {
  accountId: string;
  cached: number;
  computed: number;
  deltaCents: number;
}

export interface LedgerReconcileResult {
  accountsChecked: number;
  drifted: LedgerDrift[];
  unbalancedTransactions: string[];
  repaired: number;
}

export interface PlatformBalanceCheck {
  alerts: string[];
}
