import {
  DEFAULT_CONSIGNMENT_FEE_BPS,
  DEFAULT_FEE_RULES,
  type FeeRule,
  type FeeType,
} from '../../config/constants';
import { env } from '../../config/env';
import { FeeScheduleModel } from '../catalog/catalog.model';
import type { OrderFeeRates } from '../orders/pricing';
import { applyBps } from '../../shared/money';
import { publishInvalidation, readSharedSchedule, writeSharedSchedule } from './feeCache';

/**
 * Fee-type registry resolver (DEBT1). The single source of truth for "how much fee does a charge of
 * this type incur?" — read server-side from the versioned `fee_schedule.fees` map, so pricing and
 * new fee types are configuration, not code. Replaces the two duplicate `platformFeeBps()` helpers
 * that hard-read `consignment_fee_bps`. See PHASE_1_IMPLEMENTATION_PLAN.md §2.
 *
 * Resolution order for a fee-type:
 *   1. DB `fee_schedule.fees[type]` (latest version) — the config surface.
 *   2. Back-compat: `marketplace`/`consignment` → the legacy `consignment_fee_bps` (or its default).
 *   3. `DEFAULT_FEE_RULES[type]` code fallback.
 *   4. Otherwise no fee (0) — an unpriced type charges nothing rather than throwing on the money path.
 */

interface ScheduleCache {
  at: number;
  fees: Map<string, FeeRule>;
  consignmentBps: number;
}

// L1: in-process cache. The fee schedule is versioned and changes rarely, but `charge()` is on the
// money hot-path, so the common case must not touch the network.
//
// A-3: L2 (Redis) and pub/sub invalidation now sit underneath — see `feeCache.ts`. The TTL survives
// as a BACKSTOP for an invalidation message lost while a subscriber was reconnecting, not as the
// primary propagation mechanism. It is longer than the old 30s precisely because it is no longer
// doing that job; when Redis is absent (tests, single-process dev) it falls back to being the only
// mechanism, which is the behaviour this had before.
const CACHE_TTL_MS = 30_000;
let cache: ScheduleCache | null = null;

function normalizeFees(raw: unknown): Map<string, FeeRule> {
  const out = new Map<string, FeeRule>();
  if (!raw) return out;
  // Hydrated docs give a Map; `.lean()` gives a plain object — support both.
  const entries: [string, FeeRule][] =
    raw instanceof Map
      ? Array.from(raw as Map<unknown, unknown>, ([key, value]) => [String(key), value as FeeRule])
      : Object.entries(raw as Record<string, FeeRule>);
  for (const [key, value] of entries) {
    if (value && typeof value === 'object') out.set(key, value);
  }
  return out;
}

/**
 * Resolve the schedule through L1 → L2 (Redis) → Mongo.
 *
 * Every layer below L1 is best-effort: a Redis miss, a Redis outage, or a corrupt payload all fall
 * through to the database rather than failing. A cache is not allowed to stop the platform pricing
 * a charge.
 */
async function loadSchedule(): Promise<ScheduleCache> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const shared = await readSharedSchedule();
  if (shared) {
    cache = {
      at: Date.now(),
      fees: normalizeFees(shared.fees),
      consignmentBps: shared.consignmentBps,
    };
    return cache;
  }

  const latest = await FeeScheduleModel.findOne().sort({ version: -1 }).lean().exec();
  const consignmentBps = latest?.consignment_fee_bps ?? DEFAULT_CONSIGNMENT_FEE_BPS;
  const fees = normalizeFees(latest?.fees);
  cache = { at: Date.now(), fees, consignmentBps };

  // Populate L2 so the next instance to miss does not repeat this query. Fire-and-forget: the
  // charge that triggered the load must not wait on a cache write.
  void writeSharedSchedule({ fees: Object.fromEntries(fees), consignmentBps });
  return cache;
}

/** Pure fee math: flat + rate·base, floored at min, capped at max, never negative. */
export function computeFee(rule: FeeRule, baseCents: number): number {
  let fee = (rule.flat_cents ?? 0) + applyBps(baseCents, rule.rate_bps ?? 0);
  if (rule.min_cents != null) fee = Math.max(fee, rule.min_cents);
  if (rule.max_cents != null) fee = Math.min(fee, rule.max_cents);
  return Math.max(0, fee);
}

/** Resolve the rule for a fee-type (config → back-compat → code default → null). */
export async function resolveFeeRule(feeType: FeeType): Promise<FeeRule | null> {
  const sched = await loadSchedule();
  const configured = sched.fees.get(feeType);
  if (configured) return configured;
  if (feeType === 'marketplace' || feeType === 'consignment') {
    return { rate_bps: sched.consignmentBps };
  }
  return DEFAULT_FEE_RULES[feeType] ?? null;
}

/** Resolve the fee (in cents) charged for a `baseCents` amount of the given fee-type. */
export async function resolveFee(feeType: FeeType, baseCents: number): Promise<number> {
  const rule = await resolveFeeRule(feeType);
  return rule ? computeFee(rule, baseCents) : 0;
}

/**
 * Drop the cached schedule so the next resolve re-reads (writes + tests).
 *
 * Local-first and synchronous: **this instance is correct the moment the call returns**, whatever
 * Redis does next. The cross-instance half (delete L2, publish) is fired without awaiting, because
 * a caller that has just changed a fee should not block on cache plumbing — and if the publish
 * fails, peers still converge on the TTL. Use `invalidateFeeCacheEverywhere` when you need to know
 * the fan-out completed.
 */
export function invalidateFeeCache(): void {
  cache = null;
  void publishInvalidation();
}

/** Awaitable variant: clears locally, then waits for L2 deletion + the broadcast. */
export async function invalidateFeeCacheEverywhere(): Promise<void> {
  cache = null;
  await publishInvalidation();
}

// ─── Customer-facing fee flags (R8/R10) ────────────────────────────────────────────────────────
// Whether the customer is actually charged the service / processing fee. Seeded from env (OFF at
// launch) but mutable so ops can flip without a redeploy and tests can exercise both states.
let orderFeeFlags = {
  customerService: env.CUSTOMER_SERVICE_FEE_ENABLED,
  processing: env.PROCESSING_FEE_ENABLED,
  waveConvenience: env.WAVE_CONVENIENCE_FEE_ENABLED,
};

/** Override the customer-facing fee flags (ops toggle / tests). Returns the effective flags. */
export function setOrderFeeFlags(patch: Partial<typeof orderFeeFlags>): typeof orderFeeFlags {
  orderFeeFlags = { ...orderFeeFlags, ...patch };
  return orderFeeFlags;
}

/**
 * Build the customer-facing `OrderFeeRates` for checkout — resolved SERVER-SIDE from the registry
 * (never client-supplied, S7) and gated by the launch flags. When a flag is off, that fee's rate is
 * 0 so it contributes nothing and no line renders. Bounds (customer-service min/max) flow through
 * from the resolved rule so the checkout math can clamp correctly.
 */
export async function resolveOrderFeeRates(): Promise<OrderFeeRates> {
  const [service, processing] = await Promise.all([
    resolveFeeRule('customer_service'),
    resolveFeeRule('processing'),
  ]);
  return {
    taxBps: 0, // sales tax handled by Stripe Tax at charge when enabled; itemized separately later
    deliveryCents: 0,
    serviceFeeBps: orderFeeFlags.customerService ? (service?.rate_bps ?? 0) : 0,
    serviceFeeMinCents: service?.min_cents ?? 0,
    serviceFeeMaxCents: service?.max_cents ?? 0,
    processingBps: orderFeeFlags.processing ? (processing?.rate_bps ?? 0) : 0,
    processingFlatCents: orderFeeFlags.processing ? (processing?.flat_cents ?? 0) : 0,
  };
}

export const feeService = {
  resolveFee,
  resolveWaveConvenienceFee,
  resolveFeeRule,
  computeFee,
  invalidateFeeCache,
  invalidateFeeCacheEverywhere,
  resolveOrderFeeRates,
  setOrderFeeFlags,
};

/**
 * §32.4 — the Waved Down convenience fee actually charged, or 0 while the flag is off. Gated like
 * the other customer-facing fees so launch checkout stays as simple as the spec suggests.
 */
export async function resolveWaveConvenienceFee(): Promise<number> {
  if (!orderFeeFlags.waveConvenience) return 0;
  return resolveFee('wave_convenience', 0);
}
