import {
  CREDIT_LIMITS_BY_TIER,
  DEBT_DUE_DAYS,
  SELLER_PLUS_INVENTORY_MULTIPLIER,
  trustBandFor,
  type Tier,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { formatCents } from '../../shared/money';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { ledgerService } from '../ledger/ledger.service';
import { notificationsService } from '../notifications/notifications.service';
import { debtRepository as repo } from './debt.repository';
import type { DebtOrigin } from './debt.model';

/**
 * Seller debt (Phase 3). A cash sale hands the customer's money straight to the seller, so the
 * hub's share and the platform's fee become an obligation the seller owes.
 *
 * The recovery order is deliberate:
 *   1. net automatically from the seller's next DIGITAL payout  (preferred — no collections)
 *   2. the seller clears it in-app by card
 *   3. block new inventory once debt exceeds their trust-tier ceiling
 *
 * Netting is what makes this humane: rather than chasing someone for money they don't have, their
 * next card sale simply pays out less until the balance clears — which also nudges them toward the
 * digital rail without any policing.
 */
export const debtService = {
  /**
   * Record what a seller owes. Posts the balanced ledger entries too: the platform gains a
   * receivable, the hub gains a payable, and the platform recognises its fee — all without any
   * cash moving, because none did.
   */
  async createDebt(input: {
    sellerId: string;
    originType: DebtOrigin;
    originRefId?: string;
    hubId?: string | null;
    hubBusinessId?: string | null;
    hubShareCents: number;
    platformFeeCents: number;
    memo?: string;
  }) {
    const principalCents = input.hubShareCents + input.platformFeeCents;
    if (principalCents <= 0) return null;

    const debt = await repo.create({
      seller_id: input.sellerId,
      origin_type: input.originType,
      origin_ref_id: input.originRefId ?? null,
      hub_id: input.hubId ?? null,
      hub_share_cents: input.hubShareCents,
      platform_fee_cents: input.platformFeeCents,
      principal_cents: principalCents,
      outstanding_cents: principalCents,
      due_at: new Date(Date.now() + DEBT_DUE_DAYS * 86_400_000),
    });

    await ledgerService.post({
      transactionId: `debt_${String(debt._id)}`,
      refType: 'debt',
      refId: String(debt._id),
      memo: input.memo ?? `Cash sale — ${formatCents(principalCents)} owed`,
      entries: [
        {
          ownerType: 'user',
          ownerId: input.sellerId,
          accountType: 'receivable',
          direction: 'debit',
          amountCents: principalCents,
          entryType: 'cash_receivable',
        },
        ...(input.hubBusinessId && input.hubShareCents > 0
          ? [
              {
                ownerType: 'business' as const,
                ownerId: input.hubBusinessId,
                accountType: 'payable' as const,
                direction: 'credit' as const,
                amountCents: input.hubShareCents,
                entryType: 'hub_share' as const,
              },
            ]
          : []),
        ...(input.platformFeeCents > 0
          ? [
              {
                ownerType: 'platform' as const,
                accountType: 'fee_revenue' as const,
                direction: 'credit' as const,
                amountCents: input.platformFeeCents,
                entryType: 'platform_fee' as const,
              },
            ]
          : []),
      ],
    });

    await publish('debt.created', {
      sellerId: input.sellerId,
      debtId: String(debt._id),
      amountCents: principalCents,
      origin: input.originType,
    });

    return debt;
  },

  /**
   * A refund the platform funded because the seller had already spent their share. The ledger
   * receivable is written by the refund itself; this makes it a visible, repayable balance rather
   * than an invisible loss.
   */
  async recordClawback(input: { sellerId: string; refundId: string; amountCents: number }) {
    if (input.amountCents <= 0) return null;
    return repo.create({
      seller_id: input.sellerId,
      origin_type: 'refund_clawback',
      origin_ref_id: input.refundId,
      hub_id: null,
      hub_share_cents: 0,
      platform_fee_cents: 0,
      principal_cents: input.amountCents,
      outstanding_cents: input.amountCents,
      due_at: new Date(Date.now() + DEBT_DUE_DAYS * 86_400_000),
    });
  },

  /**
   * Inventory the seller reported lost or damaged (Phase 4). The hub loses real property, so the
   * seller carries the liability — otherwise "lost" is a free-inventory exploit. Capped at their
   * tier's credit ceiling so a single incident can't create an unpayable debt.
   */
  async chargeInventoryLiability(input: {
    sellerId: string;
    checkoutId: string;
    hubId: string;
    hubBusinessId: string | null;
    valueCents: number;
    kind: 'lost_inventory' | 'damaged_inventory';
  }) {
    if (input.valueCents <= 0) return null;

    /**
     * F-4 STOCK PROTECTION. A waiver is the platform declining to collect a debt it is owed — so it
     * applies HERE, at the moment the debt would be written, rather than as a later refund.
     *
     * The hub is unaffected: it is still owed and still paid the full value below. The platform
     * absorbs the waived portion, which is precisely the cost of the product.
     */
    const { waiverService } = await import('../subscriptions/waiver.service');
    const { waivedCents, remainingCents } = await waiverService.applyTo({
      userId: input.sellerId,
      checkoutId: input.checkoutId,
      liabilityCents: input.valueCents,
      kind: input.kind,
    });

    // Fully waived — no debt row at all, and the seller has already been told by the waiver service.
    if (remainingCents <= 0) return null;

    const debt = await this.createDebt({
      sellerId: input.sellerId,
      originType: input.kind,
      originRefId: input.checkoutId,
      hubId: input.hubId,
      hubBusinessId: input.hubBusinessId,
      // The whole value is owed to the hub — the platform takes no fee on a loss.
      hubShareCents: remainingCents,
      platformFeeCents: 0,
      memo: `${input.kind === 'lost_inventory' ? 'Lost' : 'Damaged'} stock — ${formatCents(remainingCents)}`,
    });

    // A partially-waived charge is announced by the waiver service, which knows both numbers.
    if (waivedCents === 0) {
      notificationsService.notify(input.sellerId, {
        category: 'payments',
        title: input.kind === 'lost_inventory' ? 'Lost stock charged' : 'Damaged stock charged',
        body: `${formatCents(remainingCents)} for stock that didn't come back. It comes out of your next card sale.`,
        data: { checkoutId: input.checkoutId, valueCents: remainingCents },
      });
    }
    return debt;
  },

  /**
   * Net a seller's outstanding debt against money about to be paid to them. Returns how much was
   * withheld; the caller transfers only the remainder.
   */
  async netAgainstPayout(
    sellerId: string,
    availableCents: number,
    ref: string,
  ): Promise<{ nettedCents: number; remainingCents: number }> {
    if (availableCents <= 0) return { nettedCents: 0, remainingCents: 0 };
    const debts = await repo.listOpen(sellerId);
    if (debts.length === 0) return { nettedCents: 0, remainingCents: availableCents };

    let budget = availableCents;
    let netted = 0;

    for (const debt of debts) {
      if (budget <= 0) break;
      const take = Math.min(budget, debt.outstanding_cents);
      if (take <= 0) continue;

      const updated = await repo.applyRepayment(debt._id, take, 'netted', ref);
      if (!updated) continue; // lost a race; the next sweep will pick it up

      await repo.setStatus(debt._id, updated.outstanding_cents === 0 ? 'repaid' : 'partially_repaid');

      // The seller's payable is reduced and their receivable is cleared by the same amount —
      // no cash moves, the two obligations cancel.
      await ledgerService.post({
        transactionId: `debtnet_${String(debt._id)}_${ref}`,
        refType: 'debt',
        refId: String(debt._id),
        memo: 'Debt netted from payout',
        entries: [
          { ownerType: 'user', ownerId: sellerId, accountType: 'payable', direction: 'debit', amountCents: take, entryType: 'debt_repayment' },
          { ownerType: 'user', ownerId: sellerId, accountType: 'receivable', direction: 'credit', amountCents: take, entryType: 'debt_repayment' },
        ],
      });

      budget -= take;
      netted += take;

      await publish('debt.repaid', { sellerId, debtId: String(debt._id), amountCents: take });
    }

    if (netted > 0) {
      notificationsService.notify(sellerId, {
        category: 'payments',
        title: 'Balance cleared from your payout',
        body: `${formatCents(netted)} went toward what you owed from cash sales.`,
        data: { nettedCents: netted, ref },
      });
    }

    return { nettedCents: netted, remainingCents: budget };
  },

  /** Seller clears a balance directly (card). Recorded as real cash arriving. */
  async repay(principal: Principal, debtId: string, amountCents: number, ref: string) {
    const debt = await repo.findById(debtId);
    if (!debt) throw NotFoundError('Debt not found');
    if (debt.seller_id !== principal.userId) {
      throw ForbiddenError('Not your balance', ERROR_CODES.NOT_OWNER);
    }
    const take = Math.min(amountCents, debt.outstanding_cents);
    const updated = await repo.applyRepayment(debt._id, take, 'card', ref);
    if (!updated) throw NotFoundError('Debt could not be updated');
    await repo.setStatus(debt._id, updated.outstanding_cents === 0 ? 'repaid' : 'partially_repaid');

    await ledgerService.post({
      transactionId: `debtpay_${debtId}_${ref}`,
      refType: 'debt',
      refId: debtId,
      memo: 'Debt repaid by card',
      entries: [
        { ownerType: 'platform', accountType: 'cash', direction: 'debit', amountCents: take, entryType: 'debt_repayment' },
        { ownerType: 'user', ownerId: debt.seller_id, accountType: 'receivable', direction: 'credit', amountCents: take, entryType: 'debt_repayment' },
      ],
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'debt.repaid',
      entityType: 'debt',
      entityId: debtId,
      metadata: { amountCents: take },
    });
    return { debtId, repaidCents: take, outstandingCents: updated.outstanding_cents };
  },

  /**
   * Can this seller take on more? Returns their ceilings alongside current exposure, so both the
   * checkout guard and the seller's own screen read from one source of truth.
   *
   * A-3: two levers now set the ceiling. The TIER (identity assurance) sets the base, and the TRUST
   * BAND (demonstrated behaviour) scales it — that is what makes "higher scores unlock larger
   * inventory limits" true rather than a claim on a marketing page.
   *
   * The DEBT ceiling deliberately does NOT scale. Inventory is recoverable property with a return
   * window; cash debt is an unsecured balance that is already hard to collect. Rewarding trust with
   * more of the recoverable exposure is sound, with more of the unrecoverable kind is not.
   *
   * `trustScore` is optional so existing callers (and any caller that has no reason to load a score)
   * keep the plain tier ceiling — the neutral `established` band, never a boosted one.
   */
  async creditStatus(
    sellerId: string,
    tier: Tier,
    currentInventoryValueCents: number,
    trustScore?: number,
    /**
     * B-2: a shelter-cosigned resident's ceilings. Applied as a MINIMUM against the ordinary
     * result — never as a replacement — so a resident can only ever be narrowed by their cosign,
     * never widened past what their tier and Trust band already allow.
     */
    residentCaps?: { maxInventoryValueCents: number; maxCashDebtCents: number },
    /** F-2: Seller Plus raises the ceiling. Resolved by the caller so this stays a pure computation. */
    sellerPlus = false,
  ) {
    const limits = CREDIT_LIMITS_BY_TIER[tier];
    const band = trustScore === undefined ? null : trustBandFor(trustScore);
    const multiplier =
      (band?.inventoryMultiplier ?? 1) * (sellerPlus ? SELLER_PLUS_INVENTORY_MULTIPLIER : 1);
    const tierAndTrustMax = Math.floor(limits.maxInventoryValueCents * multiplier);
    const maxInventoryValueCents = residentCaps
      ? Math.min(tierAndTrustMax, residentCaps.maxInventoryValueCents)
      : tierAndTrustMax;
    const maxCashDebtCents = residentCaps
      ? Math.min(limits.maxCashDebtCents, residentCaps.maxCashDebtCents)
      : limits.maxCashDebtCents;
    const outstandingDebtCents = await repo.totalOutstanding(sellerId);
    return {
      tier,
      /** B-2: true when a shelter cosign is narrowing these numbers. */
      residentCapped: Boolean(residentCaps),
      /** F-2: true when Seller Plus is raising them. */
      sellerPlus,
      trustScore: trustScore ?? null,
      trustBand: band?.key ?? null,
      trustBandLabel: band?.label ?? null,
      inventoryMultiplier: multiplier,
      /** The tier's unscaled ceiling, so the UI can show what the band added. */
      tierMaxInventoryValueCents: limits.maxInventoryValueCents,
      maxInventoryValueCents,
      currentInventoryValueCents,
      availableInventoryCents: Math.max(0, maxInventoryValueCents - currentInventoryValueCents),
      maxCashDebtCents,
      outstandingDebtCents,
      availableDebtCents: Math.max(0, maxCashDebtCents - outstandingDebtCents),
      overDebtLimit: outstandingDebtCents > maxCashDebtCents,
    };
  },

  async totalOutstanding(sellerId: string) {
    return repo.totalOutstanding(sellerId);
  },

  async listMine(principal: Principal) {
    const debts = await repo.listForSeller(principal.userId);
    return {
      totalOutstandingCents: await repo.totalOutstanding(principal.userId),
      debts: debts.map((d) => ({
        id: String(d._id),
        originType: d.origin_type,
        originRefId: d.origin_ref_id ?? null,
        principalCents: d.principal_cents,
        outstandingCents: d.outstanding_cents,
        hubShareCents: d.hub_share_cents,
        platformFeeCents: d.platform_fee_cents,
        status: d.status,
        dueAt: d.due_at,
        createdAt: d.created_at,
      })),
    };
  },

  // ─── Sweeps ───────────────────────────────────────────────────────────────────────────────
  /** Remind sellers of overdue balances — informational, never threatening. */
  async sendDueReminders(): Promise<number> {
    const due = await repo.findDueForReminder(new Date());
    for (const d of due) {
      notificationsService.notify(d.seller_id, {
        category: 'payments',
        title: 'Balance from a cash sale',
        body: `${formatCents(d.outstanding_cents)} is still owed. It comes out of your next card sale automatically, or you can clear it now.`,
        data: { debtId: String(d._id), outstandingCents: d.outstanding_cents },
      });
      await repo.markReminded(d._id);
    }
    if (due.length > 0) logger.info({ reminded: due.length }, 'debt reminder sweep');
    return due.length;
  },

  /** Flag badly overdue balances; the checkout guard then blocks new inventory. */
  async escalateOverdue(): Promise<number> {
    const cutoff = new Date(Date.now() - DEBT_DUE_DAYS * 86_400_000);
    const overdue = await repo.findForEscalation(cutoff);
    for (const d of overdue) {
      await repo.markEscalated(d._id);
      await publish('debt.limit_reached', {
        sellerId: d.seller_id,
        outstandingCents: d.outstanding_cents,
      });
      notificationsService.notify(d.seller_id, {
        category: 'payments',
        title: 'Clear your balance to take more stock',
        body: `${formatCents(d.outstanding_cents)} has been outstanding a while. New checkouts are paused until it's cleared.`,
        data: { debtId: String(d._id) },
      });
    }
    if (overdue.length > 0) logger.info({ escalated: overdue.length }, 'debt escalation sweep');
    return overdue.length;
  },
};
