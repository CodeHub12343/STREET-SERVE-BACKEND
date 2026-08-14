/**
 * ═══ RTO OBLIGATION TERMS — the structured half of §44 and §54 ═══
 *
 * ── The boundary rule ──────────────────────────────────────────────────────────────────────────
 * An obligation is a STRUCTURED FIELD when it can differ between two listings on the platform.
 * It stays PROSE in the versioned agreement body when it is true of every agreement of that type.
 *
 * That distinction is not cosmetic. Anything living only in prose cannot be validated, defaulted,
 * diffed between listings, or rendered in a comparison view — so §44's requirement that "the
 * customer must see the full cost before accepting" is enforceable for the money fields (they are
 * typed) and unenforceable for everything else. Two RTO listings for the same fridge can allocate
 * maintenance differently; no amount of shared boilerplate can express that.
 *
 * Fields (vary per listing → here):
 *   §44 — maintenance responsibility, damage responsibility, return rights, cancellation notice,
 *         delivery fee, tax rate.
 *   §54 — all ten consignment-RTO allocations (who owns during the term, who delivers, who handles
 *         returns/support/damage/missed payments, who approves early payoff, what happens on a
 *         customer return, when ownership transfers).
 *
 * Prose (universal → agreements.registry.ts):
 *   what rent-to-own IS, that title stays with the seller until the conditions are met, the
 *   platform's role, dispute and governing-law clauses, the statutory consumer disclosures.
 *
 * This split is deliberately settled BEFORE the attorney engagement (spec §60). The
 * structured-vs-prose boundary is precisely the question counsel is best placed to confirm, and
 * asking it once is far cheaper than restructuring a reviewed agreement afterwards.
 */

/** Who carries an obligation. `shared` means the agreement splits it and the prose says how. */
export const RTO_PARTIES = ['customer', 'seller', 'owner', 'shared'] as const;
export type RtoParty = (typeof RTO_PARTIES)[number];

/** What becomes of the goods when a customer hands them back mid-term (§51/§54). */
export const RTO_RETURN_DESTINATIONS = ['owner', 'seller', 'either_by_agreement'] as const;
export type RtoReturnDestination = (typeof RTO_RETURN_DESTINATIONS)[number];

/** The event that transfers title (§53/§54). Never "at some point"; always a named trigger. */
export const RTO_OWNERSHIP_TRIGGERS = ['final_payment', 'early_payoff', 'either'] as const;
export type RtoOwnershipTrigger = (typeof RTO_OWNERSHIP_TRIGGERS)[number];

/**
 * §44 per-listing obligations. Every field here answers a question a customer is entitled to have
 * answered before they sign, and that a different listing may answer differently.
 */
export interface RtoListingTerms {
  /** Who services and maintains the goods during the term. */
  maintenanceResponsibility: RtoParty;
  /** Who bears loss or damage while the customer holds the goods. */
  damageResponsibility: RtoParty;
  /** §51 — whether the customer may hand the goods back before the term ends. */
  returnAllowed: boolean;
  /** Who pays to move the goods back. Only meaningful when `returnAllowed`. */
  returnTransportResponsibility: RtoParty;
  /** Charged on a voluntary return, if any. */
  restockingFeeCents: number;
  /**
   * §51's sharpest requirement: the customer must never be led to believe past payments create
   * ownership unless the agreement actually grants credit. Both flags are explicit and default to
   * the conservative answer, so silence can never be read as a promise.
   */
  paymentsRefundableOnReturn: boolean;
  ownershipCreditPreservedOnReturn: boolean;
  /** Whether a cancelled agreement can be revived after a catch-up payment (§50). */
  reinstatementAllowed: boolean;
  /** Notice the customer must give to cancel, in days. */
  cancellationNoticeDays: number;
  /** One-time delivery charge (§44). Collected separately from the installment schedule. */
  deliveryFeeCents: number;
  /** Sales-tax rate applied at the point of sale (§44), in basis points. */
  taxBps: number;
}

/** Conservative defaults: whatever leaves the customer least surprised if a seller omits a field. */
export const DEFAULT_RTO_LISTING_TERMS: RtoListingTerms = {
  maintenanceResponsibility: 'customer',
  damageResponsibility: 'customer',
  // Default-DENY on the two that could mislead: a seller must opt IN to offering returns, and must
  // opt in to refunding or preserving credit. Defaulting these to `true` would let a listing imply
  // protections it never agreed to.
  returnAllowed: false,
  returnTransportResponsibility: 'customer',
  restockingFeeCents: 0,
  paymentsRefundableOnReturn: false,
  ownershipCreditPreservedOnReturn: false,
  reinstatementAllowed: true,
  cancellationNoticeDays: 7,
  deliveryFeeCents: 0,
  taxBps: 0,
};

/**
 * §54's ten allocations for a three-party consignment RTO. Unlike the listing terms these have NO
 * defaults and are required: an agreement between three parties that does not say who handles a
 * missed payment is not an agreement, it is a future dispute.
 */
export interface ConsignmentRtoTerms {
  /** Who holds title while the customer pays. */
  ownerDuringTerm: 'owner' | 'seller';
  deliveryBy: RtoParty;
  returnsManagedBy: RtoParty;
  customerSupportBy: RtoParty;
  damageResponsibility: RtoParty;
  missedPaymentsHandledBy: RtoParty;
  earlyPayoffApprovedBy: RtoParty;
  onCustomerReturn: RtoReturnDestination;
  ownershipTransfersAt: RtoOwnershipTrigger;
  /**
   * How each payment divides. The numeric split lives on the agreement itself
   * (`commission_bps` + the platform fee), which is what the settlement math reads; this is the
   * human-readable statement of it that goes on every party's copy.
   */
  paymentDivisionNote: string;
}

/** Plain-language rendering of the obligations, for the acceptance screen and every party's copy. */
export function describeListingTerms(t: RtoListingTerms): string[] {
  const who = (p: RtoParty) =>
    ({ customer: 'You', seller: 'The seller', owner: 'The owner', shared: 'You and the seller' })[p];
  const lines = [
    `${who(t.maintenanceResponsibility)} ${t.maintenanceResponsibility === 'customer' ? 'are' : 'is'} responsible for maintaining the item.`,
    `${who(t.damageResponsibility)} ${t.damageResponsibility === 'customer' ? 'are' : 'is'} responsible for loss or damage while you have it.`,
  ];
  if (t.returnAllowed) {
    lines.push(
      `You can return the item before the end of the term. ${who(t.returnTransportResponsibility)} ${t.returnTransportResponsibility === 'customer' ? 'pay' : 'pays'} to move it back` +
        (t.restockingFeeCents > 0
          ? `, and a ${usd(t.restockingFeeCents)} restocking fee applies.`
          : ', and there is no restocking fee.'),
    );
    // The §51 sentence that must never be softened.
    lines.push(
      t.paymentsRefundableOnReturn
        ? 'If you return the item, your previous payments are refundable as set out in the agreement.'
        : 'If you return the item, your previous payments are NOT refunded — they were rent for the time you had it.',
    );
    lines.push(
      t.ownershipCreditPreservedOnReturn
        ? 'The ownership credit you have built is preserved if you take the item again later.'
        : 'Returning the item ends the ownership credit you have built. It does not carry over.',
    );
  } else {
    lines.push('This agreement does not offer a voluntary return before the term ends.');
  }
  lines.push(
    t.reinstatementAllowed
      ? 'If the agreement is cancelled for missed payments, it can be reinstated once you catch up.'
      : 'A cancelled agreement cannot be reinstated.',
  );
  lines.push(`To cancel, give ${t.cancellationNoticeDays} days' notice.`);
  if (t.deliveryFeeCents > 0) {
    lines.push(`A one-time ${usd(t.deliveryFeeCents)} delivery fee applies, charged separately.`);
  }
  if (t.taxBps > 0) {
    lines.push(`Sales tax of ${(t.taxBps / 100).toFixed(2)}% applies where required.`);
  }
  return lines;
}

/** Plain-language rendering of the three-party allocations (§54). */
export function describeConsignmentTerms(t: ConsignmentRtoTerms): string[] {
  const who = (p: RtoParty) =>
    ({ customer: 'the customer', seller: 'the managing business', owner: 'the product owner', shared: 'the owner and the managing business together' })[p];
  return [
    `The ${t.ownerDuringTerm === 'owner' ? 'product owner' : 'managing business'} holds ownership until the agreement completes.`,
    `Delivery is handled by ${who(t.deliveryBy)}.`,
    `Returns are managed by ${who(t.returnsManagedBy)}.`,
    `Customer support is provided by ${who(t.customerSupportBy)}.`,
    `Loss or damage is the responsibility of ${who(t.damageResponsibility)}.`,
    `Missed payments are handled by ${who(t.missedPaymentsHandledBy)}.`,
    `Early payoff is approved by ${who(t.earlyPayoffApprovedBy)}.`,
    `If the customer returns the item it goes to ${
      t.onCustomerReturn === 'either_by_agreement' ? 'whichever party the two agree' : `the ${t.onCustomerReturn === 'owner' ? 'product owner' : 'managing business'}`
    }.`,
    `Ownership transfers to the customer at ${
      { final_payment: 'the final scheduled payment', early_payoff: 'early payoff', either: 'the final payment or early payoff, whichever comes first' }[
        t.ownershipTransfersAt
      ]
    }.`,
    t.paymentDivisionNote,
  ];
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
