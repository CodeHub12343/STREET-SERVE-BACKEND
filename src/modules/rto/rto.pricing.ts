import { applyBps, assertReconciles, deductInOrder } from '../../shared/money';
import {
  RTO_FREQUENCY_DAYS,
  RTO_GRACE_DAYS,
  type RtoFrequency,
} from '../../config/constants';

/**
 * Rent-to-Own pricing (R20/R21/R23/R26). Pure, deterministic math shared by the disclosure quote
 * and the agreement that gets accepted, so the numbers the customer sees are exactly the numbers
 * that get charged. Every payment splits into an ownership-credit portion (builds equity toward the
 * cash price) and a rental portion; the platform fee is on top per payment. Integer cents throughout.
 */
export interface RtoQuoteInput {
  cashPriceCents: number;
  initialPaymentCents: number;
  installmentCount: number;
  frequency: RtoFrequency;
  /** Only for `custom` frequency: days between installments. */
  customIntervalDays?: number;
  /** Markup over the cash price that RTO costs (the rental premium), in basis points. Disclosed. */
  markupBps: number;
  setupFeeCents?: number;
  lateFeeCents?: number;
  feeBps: number; // platform fee per payment (rto_installment, ~1000 = 10%)
}

export interface RtoScheduleRow {
  installmentNumber: number;
  dueOffsetDays: number;
  amountCents: number;
  ownershipCreditCents: number;
  rentalCents: number;
  feeCents: number;
}

export interface RtoQuote {
  cashPriceCents: number;
  initialPaymentCents: number;
  installmentCount: number;
  installmentAmountCents: number;
  frequency: RtoFrequency;
  intervalDays: number;
  graceDays: number;
  /** cash price + rental markup = the most a customer pays to own it via RTO. */
  totalToOwnCents: number;
  /** How much MORE than buying outright (U8 "may cost more than buying outright"). */
  costOverCashCents: number;
  setupFeeCents: number;
  lateFeeCents: number;
  /** Ownership credit built by the initial payment (initial goes fully to equity). */
  initialOwnershipCreditCents: number;
  schedule: RtoScheduleRow[];
}

function intervalDaysFor(frequency: RtoFrequency, customIntervalDays?: number): number {
  if (frequency === 'custom') return Math.max(1, customIntervalDays ?? 30);
  return RTO_FREQUENCY_DAYS[frequency];
}

export function graceDaysFor(frequency: RtoFrequency): number {
  if (frequency === 'custom') return 5;
  return RTO_GRACE_DAYS[frequency];
}

/**
 * Build the full disclosed quote + immutable schedule. Ownership credit is distributed so the sum of
 * (initial + per-installment ownership credit) exactly equals the cash price — i.e. paying every
 * installment leaves the customer owning the item outright, with the rental markup as the RTO cost.
 */
export function computeRtoQuote(input: RtoQuoteInput): RtoQuote {
  const cash = input.cashPriceCents;
  const initial = Math.max(0, Math.min(input.initialPaymentCents, cash));
  const n = input.installmentCount;
  const intervalDays = intervalDaysFor(input.frequency, input.customIntervalDays);

  const markup = applyBps(cash, input.markupBps);
  const totalToOwn = cash + markup;
  // What the installments must collect after the initial payment.
  const financed = totalToOwn - initial;
  const installmentAmount = n > 0 ? Math.ceil(financed / n) : 0;

  // Ownership credit each installment must build so equity reaches the cash price by the end.
  const equityToBuild = cash - initial; // initial is 100% equity
  const ownershipPerInstallment = n > 0 ? Math.floor(equityToBuild / n) : 0;

  const schedule: RtoScheduleRow[] = [];
  let equityAllocated = 0;
  for (let i = 1; i <= n; i++) {
    // The final installment absorbs rounding so the schedule reconciles exactly to the cash price.
    const isLast = i === n;
    const amount = isLast ? financed - installmentAmount * (n - 1) : installmentAmount;
    const ownership = isLast ? equityToBuild - equityAllocated : ownershipPerInstallment;
    equityAllocated += ownership;
    schedule.push({
      installmentNumber: i,
      dueOffsetDays: i * intervalDays,
      amountCents: amount,
      ownershipCreditCents: ownership,
      rentalCents: amount - ownership,
      feeCents: applyBps(amount, input.feeBps),
    });
  }

  return {
    cashPriceCents: cash,
    initialPaymentCents: initial,
    installmentCount: n,
    installmentAmountCents: installmentAmount,
    frequency: input.frequency,
    intervalDays,
    graceDays: graceDaysFor(input.frequency),
    totalToOwnCents: totalToOwn,
    costOverCashCents: markup,
    setupFeeCents: input.setupFeeCents ?? 0,
    lateFeeCents: input.lateFeeCents ?? 0,
    initialOwnershipCreditCents: initial,
    schedule,
  };
}

/**
 * Locked early-payoff formula (R23), captured at acceptance and evaluated live: the remaining
 * equity to reach the cash price. Pay the outstanding principal and you own it — no further rental
 * premium on the un-elapsed term. Never negative.
 */
export function computePayoff(cashPriceCents: number, ownershipCreditedCents: number): number {
  return Math.max(0, cashPriceCents - ownershipCreditedCents);
}

/**
 * Consignment Rent-to-Own 3-party split (R19). One gross installment divides into: platform fee
 * (10%), payment processing (per-processor, 0 at launch), the managing business's commission on the
 * distributable, and the owner's share (the rest). Reconciles exactly to gross by construction —
 * the owner absorbs the rounding remainder (B4).
 */
export interface ConsignmentRtoSplit {
  grossCents: number;
  platformFeeCents: number;
  processingCents: number;
  /** §56.1 — sales tax, remitted, never distributable to any party. */
  taxCents: number;
  /** §56.1 — delivery, which reimburses whoever actually moved the goods. */
  deliveryCents: number;
  /** §56.1 — a refund netted off this payment, reducing what there is to divide. */
  refundCents: number;
  distributableCents: number;
  commissionCents: number; // managing business
  ownerCents: number; // consignment owner
  /** §56.1 — what the customer still owes to own it outright. */
  remainingBalanceCents: number;
}

/**
 * Consignment Rent-to-Own 3-party split (R19 / §56.1).
 *
 * Order of operations is the whole design, because each deduction has a different claimant:
 *   1. **Tax** comes off first and belongs to the state. Splitting it would divide money that was
 *      never the parties' to divide, and under-remit.
 *   2. **A refund** reduces the gross — you cannot distribute money handed back to the customer.
 *   3. **Delivery** reimburses whoever moved the goods, before anyone takes a percentage of it.
 *   4. **Platform fee and processing** come off what remains.
 *   5. What is left is distributable: commission to the managing business, the rest to the owner.
 *
 * The owner absorbs the rounding remainder (B4), so the legs always reconcile exactly to gross.
 */
export function splitConsignmentRto(
  grossCents: number,
  rates: {
    platformBps: number;
    processingBps: number;
    commissionBps: number;
    taxBps?: number;
    deliveryCents?: number;
    refundCents?: number;
  },
  context: { cashPriceCents?: number; ownershipCreditedCents?: number } = {},
): ConsignmentRtoSplit {
  // The waterfall (A-5): `deductInOrder` clamps every leg to what the previous ones left, so a gross
  // too small to cover its own deductions yields short legs and nothing distributable — never a
  // negative payout to a party.
  const preFee = deductInOrder(grossCents, [
    { label: 'tax', bps: rates.taxBps ?? 0 },
    { label: 'refund', cents: rates.refundCents ?? 0 },
    { label: 'delivery', cents: rates.deliveryCents ?? 0 },
  ]);
  const feeBase = preFee.remainingCents;

  // Platform fee and processing are both rated against the SAME base — they are two independent
  // claims on the post-deduction amount, not a sequence, so neither is computed net of the other.
  const platformFee = applyBps(feeBase, rates.platformBps);
  const processing = applyBps(feeBase, rates.processingBps);
  const distributable = Math.max(0, feeBase - platformFee - processing);
  const commission = applyBps(distributable, rates.commissionBps);
  const owner = distributable - commission; // B4: the owner is the residual claimant, so they absorb
  //                                           the rounding remainder by design, not by accident.

  assertReconciles(
    grossCents,
    [preFee.amountOf('tax'), preFee.amountOf('refund'), preFee.amountOf('delivery'), platformFee, processing, commission, owner],
    'consignment RTO split',
  );

  return {
    grossCents,
    platformFeeCents: platformFee,
    processingCents: processing,
    taxCents: preFee.amountOf('tax'),
    deliveryCents: preFee.amountOf('delivery'),
    refundCents: preFee.amountOf('refund'),
    distributableCents: distributable,
    commissionCents: commission,
    ownerCents: owner,
    remainingBalanceCents: computePayoff(
      context.cashPriceCents ?? 0,
      context.ownershipCreditedCents ?? 0,
    ),
  };
}
