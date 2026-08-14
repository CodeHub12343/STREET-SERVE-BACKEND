import {
  POSTCARD_PAYABLE_ALERT_CENTS,
  POSTCARD_VENDOR_ACCOUNT_ID,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { printVendor } from '../../integrations/print';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { ledgerService } from '../ledger/ledger.service';
import {
  PostcardPayableModel,
  PostcardSettlementModel,
  type PostcardSettlementDoc,
} from './postcards.model';

/**
 * ═══ SETTLING WITH THE PRINT VENDOR (ADR-007 §4, Topology B) ═══
 *
 * Under wholesale resale we collect the buyer's whole payment and owe the printer their share. This
 * is how that debt gets discharged.
 *
 * ## Where the automation honestly stops
 *
 * Closing a period, totalling what is owed, and naming the exact orders it covers — all automatic.
 * **Moving the money is not**, and the reason is not laziness: the vendor's API has no endpoint that
 * accepts payment, they bill against a prepaid retainer topped up out of band, and a service that
 * wires funds to an external account on a cron with nobody watching is a bad idea regardless of who
 * the counterparty is.
 *
 * So a settlement closes on a schedule and an authorised person confirms it with an external
 * reference. That is still "no manual accounting" in the sense the spec meant — nobody totals
 * invoices or keys figures — but it is not "money leaves unattended", and the difference is worth
 * stating rather than describing the job as fully automatic.
 *
 * ## Why the ledger discharge happens at CONFIRMATION, not at close
 *
 * Closing a settlement rearranges our own records; it does not pay anyone. If the discharge were
 * posted at close, the books would show the debt gone while the vendor was still owed — which is
 * exactly the misstatement the payable exists to prevent.
 */

const log = logger.child({ module: 'postcards.settlement' });

function shape(s: PostcardSettlementDoc & { _id: unknown }) {
  return {
    id: String(s._id),
    status: s.status,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    payableCount: s.payable_count,
    totalCents: s.total_cents,
    externalReference: s.external_reference,
    paidAt: s.paid_at,
  };
}

export const settlementService = {
  /**
   * Closes everything accrued before `asOf` into one settlement.
   *
   * Two-phase claim: payables are marked `settling` with the settlement's id BEFORE the total is
   * fixed, so a payable accrued mid-run cannot be counted by this settlement and the next one, or
   * by neither. The total is then computed from what was actually claimed rather than from a
   * separate query that may have moved.
   */
  async closePeriod(asOf: Date = new Date()) {
    const open = await PostcardSettlementModel.findOne({ status: 'open' }).lean().exec();
    if (open) {
      /**
       * One open settlement at a time. A second would race the first for the same payables, and
       * "which statement is this invoice against?" must have one answer.
       */
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        'A settlement is already open. Confirm or void it before closing another period.',
      );
    }

    const candidates = await PostcardPayableModel.find({
      status: 'accrued',
      accrued_at: { $lt: asOf },
    })
      .select({ _id: 1, amount_cents: 1, accrued_at: 1 })
      .lean()
      .exec();

    if (candidates.length === 0) {
      log.info('no postcard payables to settle');
      return null;
    }

    const periodStart = candidates.reduce<Date>(
      (min, p) => (p.accrued_at < min ? p.accrued_at : min),
      candidates[0]!.accrued_at,
    );

    const settlement = await PostcardSettlementModel.create({
      status: 'open',
      period_start: periodStart,
      period_end: asOf,
      payable_count: 0,
      total_cents: 0,
    });
    const settlementId = String(settlement._id);

    const claim = await PostcardPayableModel.updateMany(
      { _id: { $in: candidates.map((c) => c._id) }, status: 'accrued' },
      { $set: { status: 'settling', settlement_id: settlementId } },
    );

    // Total from what was CLAIMED, not from the candidate list — a refund may have landed between.
    const claimed = await PostcardPayableModel.find({ settlement_id: settlementId })
      .select({ amount_cents: 1 })
      .lean()
      .exec();
    const totalCents = claimed.reduce((sum, p) => sum + p.amount_cents, 0);

    settlement.set({ payable_count: claimed.length, total_cents: totalCents });
    await settlement.save();

    log.info(
      { settlementId, claimed: claim.modifiedCount, totalCents },
      'postcard settlement period closed',
    );
    return shape(settlement.toObject() as PostcardSettlementDoc & { _id: unknown });
  },

  /**
   * Records that the vendor was actually paid, and discharges the debt.
   *
   * The external reference is required rather than optional: it is the only evidence that money
   * left, and a settlement that can be marked paid by clicking a button is a settlement that will
   * eventually be marked paid by mistake.
   */
  async confirmPaid(principal: Principal, settlementId: string, externalReference: string) {
    const reference = externalReference.trim();
    if (!reference) {
      throw ValidationError('Record the bank or retainer reference for this payment.');
    }

    const settlement = await PostcardSettlementModel.findOneAndUpdate(
      { _id: settlementId, status: 'open' },
      {
        $set: {
          status: 'paid',
          external_reference: reference,
          paid_by: principal.userId,
          paid_at: new Date(),
        },
      },
      { new: true },
    ).exec();

    if (!settlement) {
      const exists = await PostcardSettlementModel.exists({ _id: settlementId });
      if (!exists) throw NotFoundError('Settlement not found');
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This settlement is no longer open.');
    }

    if (settlement.total_cents > 0) {
      /**
       * The debt is discharged and cash leaves. Idempotent on the settlement id, so a retried
       * confirmation cannot double-post — the same protection the capture path relies on.
       */
      await ledgerService.post({
        transactionId: `postcard_settlement_${settlementId}`,
        refType: 'postcard_settlement',
        refId: settlementId,
        memo: `Paid print vendor (${reference})`,
        entries: [
          {
            ownerType: 'platform',
            ownerId: POSTCARD_VENDOR_ACCOUNT_ID,
            accountType: 'vendor_payable',
            direction: 'debit',
            amountCents: settlement.total_cents,
            entryType: 'postcard_vendor_settlement',
          },
          {
            ownerType: 'platform',
            ownerId: null,
            accountType: 'cash',
            direction: 'credit',
            amountCents: settlement.total_cents,
            entryType: 'postcard_vendor_settlement',
          },
        ],
      });
    }

    await PostcardPayableModel.updateMany(
      { settlement_id: settlementId, status: 'settling' },
      { $set: { status: 'settled', settled_at: new Date() } },
    );

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.settlement_paid',
      entityType: 'postcard_settlement',
      entityId: settlementId,
      metadata: { totalCents: settlement.total_cents, externalReference: reference },
    });

    return shape(settlement.toObject() as PostcardSettlementDoc & { _id: unknown });
  },

  /**
   * Abandons an open settlement and releases its payables.
   *
   * Needed because a settlement can be closed against the wrong period or superseded by a
   * renegotiation, and the alternative — confirming one that was never paid — corrupts the books
   * permanently. Releasing back to `accrued` means the debt is simply picked up next time.
   */
  async voidSettlement(principal: Principal, settlementId: string, reason: string) {
    const settlement = await PostcardSettlementModel.findOneAndUpdate(
      { _id: settlementId, status: 'open' },
      { $set: { status: 'void', void_reason: reason } },
      { new: true },
    ).exec();
    if (!settlement) {
      const exists = await PostcardSettlementModel.exists({ _id: settlementId });
      if (!exists) throw NotFoundError('Settlement not found');
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Only an open settlement can be voided.');
    }

    await PostcardPayableModel.updateMany(
      { settlement_id: settlementId, status: 'settling' },
      { $set: { status: 'accrued', settlement_id: null } },
    );

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.settlement_voided',
      entityType: 'postcard_settlement',
      entityId: settlementId,
      metadata: { reason },
    });

    return shape(settlement.toObject() as PostcardSettlementDoc & { _id: unknown });
  },

  async list(limit: number) {
    const rows = await PostcardSettlementModel.find({})
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((r) => shape(r as PostcardSettlementDoc & { _id: unknown }));
  },

  /**
   * What we owe, what the vendor thinks we have, and whether either is alarming.
   *
   * The retainer read is best-effort: the vendor being unreachable is not a reason to fail an ops
   * screen, and a null there says "unknown" rather than "zero" — the distinction matters when the
   * number is about whether orders are about to stall.
   */
  async exposure(): Promise<{
    outstandingCents: number;
    unsettledCount: number;
    overAlertThreshold: boolean;
    vendorRetainerCents: number | null;
  }> {
    const rows = await PostcardPayableModel.find({ status: { $in: ['accrued', 'settling'] } })
      .select({ amount_cents: 1 })
      .lean()
      .exec();
    const outstandingCents = rows.reduce((sum, p) => sum + p.amount_cents, 0);

    let vendorRetainerCents: number | null = null;
    try {
      vendorRetainerCents = (await printVendor().getBalance()).moneyOnAccountCents;
    } catch (err) {
      log.warn({ err }, 'could not read vendor retainer balance');
    }

    const overAlertThreshold = outstandingCents > POSTCARD_PAYABLE_ALERT_CENTS;
    if (overAlertThreshold) {
      /**
       * The credit exposure Topology B accepted, become visible. Under wholesale resale we hold the
       * buyer's money and owe the vendor, so an unbounded payable balance is real risk rather than
       * a bookkeeping curiosity.
       */
      log.error(
        { outstandingCents, thresholdCents: POSTCARD_PAYABLE_ALERT_CENTS },
        'postcard vendor payable exceeds the alert threshold — settle before accruing more',
      );
    }

    return {
      outstandingCents,
      unsettledCount: rows.length,
      overAlertThreshold,
      vendorRetainerCents,
    };
  },
};
