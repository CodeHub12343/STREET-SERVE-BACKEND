import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError } from '../../shared/errors/AppError';

/**
 * ═══ THE PHYSICAL-MAIL PIPELINE, SHARED (TD-6) ═══
 *
 * Two features put paper in mailboxes — Boost My Marketing (ADR-006) and Postcard Marketing
 * (ADR-007) — and they were going to grow two copies of the same state machine. The audit called
 * that out as HIGH debt before either was written: *"Extract, do not copy. Two copies will drift,
 * and the drift will be discovered when one of them reports a status the other cannot."*
 *
 * So the vocabulary, the ordering rule, and the buyer-facing wording live here once.
 *
 * ## `delivered` is deliberately absent
 *
 * Boost's model recorded the reason and it still holds: *"a status the platform cannot observe is a
 * promise it cannot keep."* The print vendor DOES report a `Delivered` value, but defines it as
 * *scanned by the last postal facility* — real signal, and not arrival in anyone's mailbox. Showing
 * a buyer "delivered" on that basis would overclaim, so it maps to `mailed` at the adapter boundary
 * and the pipeline ends there.
 *
 * Adding an arriving-soon state later is a product decision, not a missing feature.
 */

export const FULFILMENT_PIPELINE = ['preparing', 'printing', 'mailed'] as const;
export type FulfilmentStage = (typeof FULFILMENT_PIPELINE)[number];

const ORDER: Record<FulfilmentStage, number> = { preparing: 0, printing: 1, mailed: 2 };

export function isFulfilmentStage(value: unknown): value is FulfilmentStage {
  return typeof value === 'string' && value in ORDER;
}

/**
 * Can the pipeline move from `from` to `to`?
 *
 * Forward or level only. Physical production does not run backwards: paper that has been printed
 * cannot become unprinted, and a status that moved back would tell a buyer their mailing had been
 * un-sent. Level is allowed so a repeated report — a webhook replayed, a poll returning what we
 * already knew — is a no-op rather than an error.
 *
 * `from === null` means nothing has been reported yet, so any stage is a legal first observation.
 */
export function canAdvance(from: FulfilmentStage | null | undefined, to: FulfilmentStage): boolean {
  if (from === null || from === undefined) return true;
  return ORDER[to] >= ORDER[from];
}

/** Throws a domain error rather than returning false, for the callers that treat it as a rule. */
export function assertAdvance(
  from: FulfilmentStage | null | undefined,
  to: FulfilmentStage,
): void {
  if (!canAdvance(from, to)) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      `A mailing cannot go back from ${String(from)} to ${to}.`,
    );
  }
}

/** True when this report actually moves things on, so callers know whether to notify. */
export function isProgress(
  from: FulfilmentStage | null | undefined,
  to: FulfilmentStage,
): boolean {
  if (from === null || from === undefined) return true;
  return ORDER[to] > ORDER[from];
}

export const isTerminalStage = (stage: FulfilmentStage): boolean => stage === 'mailed';

interface StageCopy {
  label: string;
  /** What the buyer is told. Plain language: they did not buy a print-industry glossary. */
  description: string;
}

/**
 * One wording for both features. Written to be honest about what each stage means — `mailed` in
 * particular says handed to the postal service, because that is what the vendor confirms and it is
 * the last thing we actually know.
 */
export const STAGE_COPY: Record<FulfilmentStage, StageCopy> = {
  preparing: {
    label: 'Preparing',
    description: 'Your order is with the printer and is being set up.',
  },
  printing: {
    label: 'Printing',
    description: 'Your postcards are being printed.',
  },
  mailed: {
    label: 'Mailed',
    description:
      'Your postcards have been handed to the postal service. Delivery usually takes a few days ' +
      'from here, and the postal service does not report the final step back to us.',
  },
};

export function describeStage(stage: FulfilmentStage): StageCopy {
  return STAGE_COPY[stage];
}
