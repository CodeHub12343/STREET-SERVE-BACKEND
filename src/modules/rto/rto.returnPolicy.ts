import type { RtoListingTerms } from './rto.terms';

/**
 * §51 — VOLUNTARY RETURN.
 *
 * One pure function that turns an agreement's own terms into the exact outcome of handing the goods
 * back, plus a plain-language disclosure. Used by both the preview (what the customer is shown
 * before they decide) and the actual return, so the two can never disagree — the same discipline
 * `computeRefund` follows on the orders rail.
 *
 * ── The sentence this exists to protect ────────────────────────────────────────────────────────
 * §51 is explicit: the customer must NOT be told previous payments create ownership unless the
 * agreement specifically provides ownership credit. That is the one claim a rent-to-own product is
 * most tempted to blur, so the disclosure states the outcome in the negative when it is negative —
 * "your payments are not refunded", not "refunds may be available" — and the arithmetic never
 * silently returns money the terms did not promise.
 *
 * Nothing here is a judgement call at the counter: every branch reads a field the seller set on the
 * listing and the customer saw before accepting.
 */
export interface RtoReturnInput {
  /** Everything paid so far — initial payment plus every settled instalment. */
  paidToOwnCents: number;
  /** Equity accrued under the schedule (the ownership-credit portion of what was paid). */
  ownershipCreditedCents: number;
  terms: Pick<
    RtoListingTerms,
    | 'returnAllowed'
    | 'returnTransportResponsibility'
    | 'restockingFeeCents'
    | 'paymentsRefundableOnReturn'
    | 'ownershipCreditPreservedOnReturn'
    | 'reinstatementAllowed'
  >;
}

export interface RtoReturnQuote {
  allowed: boolean;
  /** Cash back to the customer, after any restocking fee. Never negative. */
  refundCents: number;
  restockingFeeCents: number;
  /** Equity kept against a future agreement, when the terms preserve it. Otherwise 0. */
  creditPreservedCents: number;
  /** Who pays to move the goods back. */
  transportResponsibility: RtoListingTerms['returnTransportResponsibility'];
  reinstatementAllowed: boolean;
  /** Plain language, in the customer's terms. Shown before they confirm and stored on the return. */
  disclosure: string;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function computeRtoReturn(input: RtoReturnInput): RtoReturnQuote {
  const { terms } = input;

  if (!terms.returnAllowed) {
    return {
      allowed: false,
      refundCents: 0,
      restockingFeeCents: 0,
      creditPreservedCents: 0,
      transportResponsibility: terms.returnTransportResponsibility,
      reinstatementAllowed: terms.reinstatementAllowed,
      disclosure:
        'This agreement does not offer a voluntary return before the term ends. ' +
        'You can pay it off early at any time instead.',
    };
  }

  /**
   * Refundable payments are the exception, not the rule — a rent-to-own payment is rent for the
   * time the customer had the goods unless the seller agreed otherwise. When they DID agree, the
   * restocking fee comes out of the refund rather than being billed separately: a "refund" that
   * arrives with an invoice attached is not one.
   */
  const restocking = terms.restockingFeeCents;
  const refundBase = terms.paymentsRefundableOnReturn ? input.paidToOwnCents : 0;
  const refund = Math.max(0, refundBase - restocking);
  const creditPreserved = terms.ownershipCreditPreservedOnReturn
    ? input.ownershipCreditedCents
    : 0;

  const lines: string[] = [];
  lines.push(
    terms.paymentsRefundableOnReturn
      ? `You'll get ${usd(refund)} back` +
          (restocking > 0 ? ` — your ${usd(input.paidToOwnCents)} in payments less a ${usd(restocking)} restocking fee.` : '.')
      : `Your ${usd(input.paidToOwnCents)} in payments are NOT refunded — they were rent for the time you had it.` +
          (restocking > 0 ? ` A ${usd(restocking)} restocking fee also applies.` : ''),
  );
  lines.push(
    terms.ownershipCreditPreservedOnReturn
      ? `The ${usd(creditPreserved)} of ownership credit you've built is kept if you take this on again later.`
      : 'Returning it ends the ownership credit you have built. It does not carry over.',
  );
  lines.push(
    terms.returnTransportResponsibility === 'customer'
      ? 'You arrange and pay for getting it back.'
      : 'The seller arranges collection.',
  );
  lines.push(
    terms.reinstatementAllowed
      ? 'You can start a new agreement for this later.'
      : 'This agreement cannot be reinstated once the item is returned.',
  );

  return {
    allowed: true,
    refundCents: refund,
    restockingFeeCents: restocking,
    creditPreservedCents: creditPreserved,
    transportResponsibility: terms.returnTransportResponsibility,
    reinstatementAllowed: terms.reinstatementAllowed,
    disclosure: lines.join(' '),
  };
}
