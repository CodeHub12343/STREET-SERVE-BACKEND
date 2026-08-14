import { z } from 'zod';

/**
 * Money is ALWAYS integer cents, never floats — prevents rounding-error classes of bugs in
 * settlement math (API_SPECIFICATION.md §18, VALIDATION_RULES.md §1).
 */
export const Cents = z.number().int();
export const PositiveCents = z.number().int().positive();
export const NonNegativeCents = z.number().int().nonnegative();

export function assertCents(value: number, label = 'amount'): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of cents, got ${value}`);
  }
}

export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => {
    assertCents(v);
    return acc + v;
  }, 0);
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

// ─── Shared money primitives (A-5) ──────────────────────────────────────────────────────────────
//
// Fee and split arithmetic used to be re-implemented per module — `orders/pricing.ts`,
// `payments/fees.ts`, `rto/rto.pricing.ts`, and the consignment settlement path each spelled out
// `Math.floor((base * bps) / 10000)` and each solved the penny-allocation problem locally. No
// inconsistency had actually shipped, but §56.1 kept adding split legs, and the divergence pressure
// was one-directional: every new leg was another chance for two modules to round the same number
// differently. These are the primitives all of them now call.
//
// Two conventions are fixed here, deliberately, once:
//
//   1. **Rate math rounds DOWN, toward the payer.** A fee of 2.5 cents is charged as 2. The platform
//      is the party that sets the rate, so it absorbs the sub-cent rather than the customer or the
//      seller. Rounding half-up would be defensible in isolation and indefensible applied
//      inconsistently — the point is that there is one answer.
//   2. **Split legs must reconcile EXACTLY to the total.** Not "within a cent". A settlement whose
//      legs sum to $99.99 of a $100.00 charge has a cent that belongs to someone and is recorded as
//      belonging to no one, and that is the kind of discrepancy that costs a day to find a year
//      later. `allocate` guarantees it by construction.

/**
 * Apply a basis-point rate to a base amount. THE house rounding convention (down, toward the payer)
 * — every rate·base computation on the money path goes through here so the convention lives in one
 * place instead of being re-typed per module.
 *
 * `10_000 bps = 100%`. Negative bases and rates are clamped to 0: a "negative fee" is always a
 * caller bug, and silently producing a credit on the money path is worse than producing nothing.
 */
export function applyBps(baseCents: number, bps: number): number {
  assertCents(baseCents, 'baseCents');
  if (baseCents <= 0 || bps <= 0) return 0;
  return Math.floor((baseCents * bps) / 10_000);
}

/** Apply a percentage (0–100) rather than basis points. Same convention; `applyBps` under the hood. */
export function applyPercent(baseCents: number, percent: number): number {
  return applyBps(baseCents, Math.round(percent * 100));
}

/**
 * Divide `totalCents` among `weights` so the parts sum EXACTLY to the total (the classic
 * penny-allocation problem). Largest-remainder method: floor every share, then hand the leftover
 * cents one at a time to the parts with the biggest discarded fraction, ties broken by original
 * order.
 *
 * Why largest-remainder rather than "the last leg absorbs the rounding": dumping the remainder on a
 * fixed leg is exactly right when that leg is a designated residual claimant (the consignment owner
 * under B4, who is defined as taking what's left) and quietly unfair when it isn't — a three-way
 * even split of 100¢ should be 34/33/33, not 33/33/34 only because of parameter order.
 *
 * Zero total, zero weights, or all-zero weights return all-zero parts rather than throwing; callers
 * on the money path should not have to guard the degenerate case.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  assertCents(totalCents, 'totalCents');
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (totalWeight <= 0 || totalCents === 0) return weights.map(() => 0);

  const sign = totalCents < 0 ? -1 : 1;
  const magnitude = Math.abs(totalCents);

  const floors = weights.map((w) => Math.floor((magnitude * Math.max(0, w)) / totalWeight));
  let remainder = magnitude - floors.reduce((a, v) => a + v, 0);

  const order = weights
    .map((w, index) => ({
      index,
      fraction: (magnitude * Math.max(0, w)) % totalWeight,
      weight: Math.max(0, w),
    }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const entry of order) {
    if (remainder <= 0) break;
    if (entry.weight <= 0) continue; // a zero-weight party is owed nothing, not a stray cent
    floors[entry.index] = (floors[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  // Every weight was zero except ones already exhausted — park the rest on the first nonzero leg so
  // the invariant (parts sum to total) holds unconditionally.
  if (remainder > 0) {
    const target = weights.findIndex((w) => w > 0);
    const index = target >= 0 ? target : 0;
    floors[index] = (floors[index] ?? 0) + remainder;
  }
  return floors.map((v) => v * sign);
}

/** Split `totalCents` into `parts` equal shares that sum exactly to the total. */
export function splitEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  return allocate(totalCents, new Array<number>(parts).fill(1));
}

export interface Deduction {
  label: string;
  /** Fixed amount, OR a rate applied to the amount remaining at this step. Supply exactly one. */
  cents?: number;
  bps?: number;
}

export interface DeductionResult {
  /** What each deduction actually took — never more than was left when its turn came. */
  legs: { label: string; cents: number }[];
  /** What remains after every deduction. Never negative. */
  remainingCents: number;
  /** Convenience lookup by label. Unknown labels read as 0 — an absent deduction took nothing. */
  amountOf: (label: string) => number;
}

/**
 * Apply deductions to a gross amount **in order**, each taking from what the previous ones left.
 *
 * Order is not a formatting detail — it decides who gets paid when the money runs out, and each
 * deduction on this platform has a different claimant (sales tax belongs to the state; a refund has
 * already gone back to the customer; delivery reimburses whoever moved the goods; the platform fee
 * and processing come off what remains). Every deduction is clamped to what is actually left, so a
 * gross that cannot cover its own deductions produces short legs and a zero remainder rather than a
 * negative payout to someone.
 */
export function deductInOrder(grossCents: number, deductions: Deduction[]): DeductionResult {
  assertCents(grossCents, 'grossCents');
  let remaining = Math.max(0, grossCents);
  const legs: { label: string; cents: number }[] = [];
  const byLabel: Record<string, number> = {};

  for (const deduction of deductions) {
    const wanted =
      deduction.bps != null ? applyBps(remaining, deduction.bps) : Math.max(0, deduction.cents ?? 0);
    const taken = Math.min(wanted, remaining);
    remaining -= taken;
    legs.push({ label: deduction.label, cents: taken });
    byLabel[deduction.label] = (byLabel[deduction.label] ?? 0) + taken;
  }

  return { legs, remainingCents: remaining, amountOf: (label) => byLabel[label] ?? 0 };
}

/**
 * Assert that a set of split legs reconciles exactly to the total it came from. Call it at the end
 * of any settlement computation: it turns "the legs are off by a cent" from a slow reconciliation
 * mystery into a loud failure at the site that caused it.
 *
 * Throws rather than logging — a settlement that does not reconcile must not be written.
 */
export function assertReconciles(totalCents: number, legs: number[], label = 'split'): void {
  const sum = legs.reduce((a, v) => a + v, 0);
  if (sum !== totalCents) {
    throw new Error(
      `${label} does not reconcile: legs sum to ${sum} but total is ${totalCents} (off by ${sum - totalCents})`,
    );
  }
}
