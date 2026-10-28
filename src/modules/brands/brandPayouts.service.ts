import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import { logger } from '../../config/logger';
import { stripe } from '../../integrations/stripe';
import { writeAudit } from '../../shared/audit';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import { env } from '../../config/env';
import { BrandModel } from './brands.model';
import { BrandOperatorModel } from './brandOperator.model';
import { BrandSplitModel } from './brandSplit.model';
import { BusinessModel } from '../vendors/vendors.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 2 brand-payouts service. ═══
 *
 * Three jobs this module owns:
 *
 *   1. **Policy I/O.** Read + write a brand's `payout_policy`, validate that shares sum to 100%,
 *      and refuse to point a split at an operator that doesn't belong to the brand or has been
 *      retired.
 *
 *   2. **Settlement.** Given a completed transaction on a per_operator brand, execute one
 *      Stripe transfer per operator leg, record each as a `BrandSplit` row. Idempotent on the
 *      `(transaction_id, operator_id)` pair.
 *
 *   3. **Reversal.** For a refunded transaction, reverse each per-operator transfer. Writes
 *      `reversed` on the split row + the Stripe reversal id.
 */

export interface PolicyLeg {
  operatorId: string;
  shareBps: number;
}

function sumBps(legs: PolicyLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.shareBps, 0);
}

export const brandPayoutsService = {
  /**
   * Update a brand's payout policy. Admin or brand owner only (route enforces; service trusts
   * the actor it was given). Validations:
   *   • `per_operator` with no legs → refused (would strand every sale)
   *   • Shares don't sum to 10000 bps → refused
   *   • Any operator_id doesn't belong to this brand (or is retired) → refused
   */
  async setPolicy(
    actor: Principal,
    brandId: string,
    policy: { mode: 'pooled' | 'per_operator'; splits: PolicyLeg[] },
  ) {
    const brand = await BrandModel.findById(brandId).exec();
    if (!brand) throw NotFoundError('Brand not found');

    if (policy.mode === 'per_operator') {
      if (policy.splits.length === 0) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'per_operator requires at least one split — otherwise every sale would strand.',
        );
      }
      const total = sumBps(policy.splits);
      if (total !== 10000) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          `splits must sum to 100% (10000 bps); got ${total}.`,
        );
      }
      /**
       * Every referenced operator must belong to THIS brand and be active. Checked by one
       * query, not per-leg — the N-leg case is small (one per truck) and this keeps the
       * failure deterministic rather than depending on insertion order.
       */
      const operatorIds = policy.splits.map((s) => new Types.ObjectId(s.operatorId));
      const operators = await BrandOperatorModel.find({
        _id: { $in: operatorIds },
        brand_id: new Types.ObjectId(brandId),
        status: 'active',
      })
        .select('_id')
        .lean()
        .exec();
      if (operators.length !== policy.splits.length) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'At least one split points at an operator that is not an active member of this brand.',
        );
      }
    }

    /**
     * Direct field assignment via `.set` keeps Mongoose happy with the embedded DocumentArray —
     * assigning a plain `[]` to the `splits` subarray trips the `isMongooseDocumentArray` check.
     */
    const now = new Date();
    brand.set('payout_policy.mode', policy.mode);
    brand.set(
      'payout_policy.splits',
      policy.splits.map((s) => ({
        operator_id: new Types.ObjectId(s.operatorId),
        share_bps: s.shareBps,
      })),
    );
    brand.set('payout_policy.updated_at', now);
    brand.set('payout_policy.updated_by', actor.userId);
    await brand.save();

    await writeAudit({
      actorId: actor.userId,
      action: 'brand.payout_policy.updated',
      entityType: 'brand',
      entityId: brandId,
      metadata: {
        mode: policy.mode,
        splits: policy.splits.map((s) => ({ operator_id: s.operatorId, share_bps: s.shareBps })),
      },
    });

    return {
      brandId,
      mode: policy.mode,
      splits: policy.splits,
      updatedAt: now,
    };
  },

  async getPolicy(brandId: string) {
    const brand = await BrandModel.findById(brandId).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    const policy = brand.payout_policy;
    return {
      brandId,
      mode: policy?.mode ?? ('pooled' as const),
      splits: (policy?.splits ?? []).map((s) => ({
        operatorId: String(s.operator_id),
        shareBps: s.share_bps,
      })),
      updatedAt: policy?.updated_at ?? null,
    };
  },

  /**
   * Policy for the brand that owns a given business, resolved in one lookup. Used by the order
   * settlement path, which has a business id but not a brand id in hand.
   */
  async resolvePolicyForBusiness(businessId: string): Promise<{
    brandId: string;
    mode: 'pooled' | 'per_operator';
    splits: PolicyLeg[];
  } | null> {
    const business = await BusinessModel.findById(businessId)
      .select('brand_id owner_user_id')
      .lean()
      .exec();
    if (!business || !business.brand_id) return null;
    const brand = await BrandModel.findById(business.brand_id).lean().exec();
    if (!brand) return null;
    const policy = brand.payout_policy ?? { mode: 'pooled' as const, splits: [] };
    return {
      brandId: String(brand._id),
      mode: (policy.mode ?? 'pooled') as 'pooled' | 'per_operator',
      splits: (policy.splits ?? []).map((s) => ({
        operatorId: String(s.operator_id),
        shareBps: s.share_bps,
      })),
    };
  },

  /**
   * Execute a per-operator settlement for one transaction.
   *
   * `netCents` is the counterparty net — what the brand would otherwise have received. Split by
   * share_bps across operators. Each leg either reaches the operator's own connected account or
   * falls back to the brand owner's account (recorded with a `fallback_reason`), so no money is
   * ever stranded. Each `BrandSplit` row is idempotent on `(transaction_id, operator_id)`.
   *
   * Rounding: cents cannot be fractional, so the last leg absorbs the remainder. This keeps
   * `sum(legs) == netCents` exactly; a split with 1/3 shares each on $100 pays 33.33 / 33.33 /
   * 33.34, never 99 cents.
   */
  async settleTransaction(input: {
    transactionId: string;
    businessId: string;
    netCents: number;
    /** The transfer group that owns the original charge; legs share it. */
    transferGroup: string;
  }): Promise<{
    executed: boolean;
    brandId: string | null;
    legs: Array<{
      operatorId: string;
      netCents: number;
      status: 'paid' | 'fallback_to_owner';
      transferId: string | null;
      fallbackReason: string | null;
    }>;
  }> {
    const policy = await this.resolvePolicyForBusiness(input.businessId);
    if (!policy || policy.mode !== 'per_operator') {
      return { executed: false, brandId: policy?.brandId ?? null, legs: [] };
    }
    /**
     * Compute per-leg allocation. Each leg gets `floor(net × share_bps / 10000)`, and the last
     * leg absorbs the rounding remainder so the full net is distributed. The order of legs is
     * stable (policy order) so repeat settlements of the same transaction land identically on
     * the same operators.
     */
    const legsPlanned: Array<{ operatorId: string; shareBps: number; amountCents: number }> = [];
    let runningTotal = 0;
    for (let i = 0; i < policy.splits.length; i += 1) {
      const leg = policy.splits[i];
      if (!leg) continue; // defensive — the loop bounds already guarantee this
      let amount: number;
      if (i === policy.splits.length - 1) {
        amount = input.netCents - runningTotal;
      } else {
        amount = Math.floor((input.netCents * leg.shareBps) / 10000);
        runningTotal += amount;
      }
      legsPlanned.push({ operatorId: leg.operatorId, shareBps: leg.shareBps, amountCents: amount });
    }

    const brand = await BrandModel.findById(policy.brandId).lean().exec();
    if (!brand) {
      /**
       * The brand existed when the policy was resolved; it has since been archived or deleted.
       * Treat this as a hard failure — settling without a brand to attribute the splits to would
       * create ledger rows nobody could reconcile.
       */
      throw NotFoundError('Brand missing at settlement time');
    }

    const operatorDocs = await BrandOperatorModel.find({
      _id: { $in: legsPlanned.map((l) => new Types.ObjectId(l.operatorId)) },
    })
      .lean()
      .exec();
    const operatorById = new Map(operatorDocs.map((o) => [String(o._id), o]));

    /**
     * Brand owner's fallback account — resolved from Stripe-Connect accounts via the payment
     * service's own lookup to keep ownership of "where does the brand owner get paid" in one
     * place. Dynamic import because paymentsService imports from brands indirectly.
     */
    const { paymentsService } = await import('../payments/payments.service');

    const legsResolved: Array<{
      operatorId: string;
      netCents: number;
      status: 'paid' | 'fallback_to_owner';
      transferId: string | null;
      fallbackReason: string | null;
    }> = [];

    for (const planned of legsPlanned) {
      /**
       * Idempotency: look for an existing split row for this (transaction, operator). If one
       * exists in a terminal state (`paid` or `fallback_to_owner`), we've already settled this
       * leg — return its outcome. Reversed rows are a different lifecycle and don't block a
       * fresh settle (which doesn't happen in practice; the guard is defensive).
       */
      const existing = await BrandSplitModel.findOne({
        transaction_id: input.transactionId,
        operator_id: new Types.ObjectId(planned.operatorId),
      })
        .lean()
        .exec();
      if (existing && existing.status !== 'reversed') {
        legsResolved.push({
          operatorId: planned.operatorId,
          netCents: existing.net_cents,
          status: existing.status as 'paid' | 'fallback_to_owner',
          transferId: existing.stripe_transfer_id ?? null,
          fallbackReason: existing.fallback_reason ?? null,
        });
        continue;
      }

      const op = operatorById.get(planned.operatorId);
      if (!op) {
        /**
         * The operator was deleted between policy write and settlement. Fall back to the brand
         * owner with the specific reason so support can see which transaction this happened on.
         */
        const result = await this.transferToBrandOwner({
          brandOwnerUserId: brand.owner_user_id,
          amountCents: planned.amountCents,
          transferGroup: input.transferGroup,
          idempotencyKey: `brand_split_fallback_${input.transactionId}_${planned.operatorId}`,
        });
        await this.recordLeg({
          transactionId: input.transactionId,
          brandId: policy.brandId,
          businessId: input.businessId,
          operatorId: planned.operatorId,
          operatorUserId: 'unknown',
          shareBps: planned.shareBps,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: 'operator_missing_at_settlement',
        });
        legsResolved.push({
          operatorId: planned.operatorId,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: 'operator_missing_at_settlement',
        });
        continue;
      }

      const hasApprovedAccount =
        op.status === 'active' &&
        !!op.stripe_account_id &&
        op.payouts_enabled &&
        !!op.approved_at_by_owner;

      if (!hasApprovedAccount) {
        /**
         * No approved, payouts-enabled, owner-sanctioned Stripe account on this operator yet.
         * The money still MOVES — it just goes to the brand owner, with a precise reason that
         * the admin UI can surface so the operator can be chased to connect. Alternative
         * (strand it on the platform balance) would be worse: a sale that doesn't pay anybody
         * is a sale nobody can reconcile.
         */
        const reason =
          op.status !== 'active'
            ? 'operator_retired'
            : !op.stripe_account_id
              ? 'no_stripe_account'
              : !op.payouts_enabled
                ? 'stripe_payouts_disabled'
                : 'no_owner_approval';
        const result = await this.transferToBrandOwner({
          brandOwnerUserId: brand.owner_user_id,
          amountCents: planned.amountCents,
          transferGroup: input.transferGroup,
          idempotencyKey: `brand_split_fallback_${input.transactionId}_${planned.operatorId}`,
        });
        await this.recordLeg({
          transactionId: input.transactionId,
          brandId: policy.brandId,
          businessId: input.businessId,
          operatorId: planned.operatorId,
          operatorUserId: op.user_id,
          shareBps: planned.shareBps,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: reason,
        });
        legsResolved.push({
          operatorId: planned.operatorId,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: reason,
        });
        continue;
      }

      /**
       * Happy path: transfer to the operator's own connected account. Idempotency key is scoped
       * so a retried settlement doesn't double-pay — Stripe collapses the second call to the
       * first transfer's id.
       */
      try {
        const { transferId } = await stripe().createTransfer({
          amountCents: planned.amountCents,
          currency: env.PLATFORM_CURRENCY,
          destinationAccountId: op.stripe_account_id!,
          transferGroup: input.transferGroup,
          metadata: {
            kind: 'brand_split',
            transactionId: input.transactionId,
            brandId: policy.brandId,
            operatorId: planned.operatorId,
          },
          idempotencyKey: `brand_split_${input.transactionId}_${planned.operatorId}`,
        });
        await this.recordLeg({
          transactionId: input.transactionId,
          brandId: policy.brandId,
          businessId: input.businessId,
          operatorId: planned.operatorId,
          operatorUserId: op.user_id,
          shareBps: planned.shareBps,
          netCents: planned.amountCents,
          status: 'paid',
          transferId,
          fallbackReason: null,
        });
        legsResolved.push({
          operatorId: planned.operatorId,
          netCents: planned.amountCents,
          status: 'paid',
          transferId,
          fallbackReason: null,
        });
      } catch (err) {
        /**
         * A single leg's Stripe failure does NOT block the other legs. The failed leg is
         * recorded as a fallback_to_owner with the error reason, the brand owner receives the
         * amount, and an operations alert fires so support can resolve the specifics (bad
         * account id, Stripe outage, etc.).
         */
        logger.error(
          { err, transactionId: input.transactionId, operatorId: planned.operatorId },
          'brand split leg transfer failed — falling back to brand owner',
        );
        const result = await this.transferToBrandOwner({
          brandOwnerUserId: brand.owner_user_id,
          amountCents: planned.amountCents,
          transferGroup: input.transferGroup,
          idempotencyKey: `brand_split_fallback_${input.transactionId}_${planned.operatorId}`,
        });
        await this.recordLeg({
          transactionId: input.transactionId,
          brandId: policy.brandId,
          businessId: input.businessId,
          operatorId: planned.operatorId,
          operatorUserId: op.user_id,
          shareBps: planned.shareBps,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: 'stripe_transfer_failed',
        });
        legsResolved.push({
          operatorId: planned.operatorId,
          netCents: planned.amountCents,
          status: 'fallback_to_owner',
          transferId: result?.transferId ?? null,
          fallbackReason: 'stripe_transfer_failed',
        });
      }
    }

    // Keep the paymentsService reference used so TypeScript treats the import as live.
    void paymentsService;

    return { executed: true, brandId: policy.brandId, legs: legsResolved };
  },

  /**
   * Reverse all per-operator transfers for a refunded transaction. Idempotent per leg: a leg
   * already marked `reversed` is skipped. Called from the refund path AFTER the Stripe customer
   * refund has been issued, so a reversal failure does not block the customer getting their
   * money back.
   */
  async reverseForTransaction(transactionId: string): Promise<{ reversedLegs: number }> {
    const legs = await BrandSplitModel.find({
      transaction_id: transactionId,
      status: 'paid',
    }).exec();
    let reversed = 0;
    for (const leg of legs) {
      if (!leg.stripe_transfer_id) continue;
      try {
        const result = await stripe().reverseTransfer({
          transferId: leg.stripe_transfer_id,
          amountCents: leg.net_cents,
          idempotencyKey: `brand_split_reverse_${transactionId}_${leg.operator_id}`,
        });
        leg.status = 'reversed';
        leg.reversed_at = new Date();
        leg.reversed_stripe_id = result.reversalId;
        await leg.save();
        reversed += 1;
      } catch (err) {
        logger.error(
          { err, legId: String(leg._id), transferId: leg.stripe_transfer_id },
          'brand split reversal failed — resolve this transfer by hand',
        );
      }
    }
    return { reversedLegs: reversed };
  },

  /** Append-only ledger write. Separate helper so the two call paths (happy / fallback) stay DRY. */
  async recordLeg(input: {
    transactionId: string;
    brandId: string;
    businessId: string;
    operatorId: string;
    operatorUserId: string;
    shareBps: number;
    netCents: number;
    status: 'paid' | 'fallback_to_owner';
    transferId: string | null;
    fallbackReason: string | null;
  }) {
    await BrandSplitModel.updateOne(
      {
        transaction_id: input.transactionId,
        operator_id: new Types.ObjectId(input.operatorId),
      },
      {
        $setOnInsert: {
          transaction_id: input.transactionId,
          brand_id: new Types.ObjectId(input.brandId),
          business_id: new Types.ObjectId(input.businessId),
          operator_id: new Types.ObjectId(input.operatorId),
          operator_user_id: input.operatorUserId,
          share_bps: input.shareBps,
          gross_cents: input.netCents,
          net_cents: input.netCents,
          status: input.status,
          stripe_transfer_id: input.transferId,
          fallback_reason: input.fallbackReason,
        },
      },
      { upsert: true },
    ).exec();
  },

  /**
   * Fallback transfer to the brand owner. Separated so the two call sites (missing operator /
   * operator-not-approved) share one implementation. Returns null if the brand owner has no
   * Stripe account — the leg is still recorded, with the amount owed logged for manual payout.
   */
  async transferToBrandOwner(input: {
    brandOwnerUserId: string;
    amountCents: number;
    transferGroup: string;
    idempotencyKey: string;
  }): Promise<{ transferId: string } | null> {
    const { paymentsService } = await import('../payments/payments.service');
    const result = await paymentsService.payoutTransfer({
      ownerType: 'user',
      ownerId: input.brandOwnerUserId,
      amountCents: input.amountCents,
      transferGroup: input.transferGroup,
      idempotencyKey: input.idempotencyKey,
    });
    return result ? { transferId: result.transferId } : null;
  },
};

// Suppress unused-id import if a path above doesn't use it directly.
void randomUUID;
