import { ValidationError } from '../../shared/errors/AppError';
import { ledgerService } from './ledger.service';

/**
 * ═══ COMMUNITY FUNDS — the money rail for Pay It Forward and Boost My Marketing (ADR-005) ═══
 *
 * A pool balance is **custodial**: real customer money, held by the platform, owed to no identified
 * person until someone redeems it. It lives in `community_fund_payable`, which is modelled on
 * `tax_payable` — held, never earned.
 *
 * This file is the ONLY way that account is written, and it exists as a narrow surface rather than
 * a general `post()` call for one reason: **there is no withdrawal function here, and there must
 * never be one.** A vendor who could fund their own pool and cash it out would turn a marketplace
 * feature into a money-movement service, which is a different regulated business. The four
 * functions below are the complete set of ways money may leave a pool:
 *
 *   contribute → redeem   (against a real order at that business)
 *              → expire   (12 months, to the platform's city fund)
 *              → refund   (24h window, or a failed Boost campaign)
 *
 * Balances are read through `balanceOf`, never computed by a caller.
 *
 * ## What this file does NOT do
 *
 * It moves money and nothing else. Caps, per-day limits, fraud checks, and the expiry schedule are
 * the `payforward` module's job (Phase 3) — enforced BEFORE calling in here, in the same transaction
 * as the deduction. A posting function that also policed policy would end up with two callers
 * disagreeing about which of them had already checked.
 */

/**
 * Scope of a pool. Two kinds share this account type and must NOT share a balance:
 *
 *  • a business's Pay It Forward pool, and
 *  • one Boost campaign's contributions, held until the campaign funds or refunds.
 *
 * Mixing them would be a real defect rather than an untidiness: refunding a failed campaign would
 * reach into money customers gave to feed people, and a redemption at the counter could spend money
 * earmarked for a mailing. So a campaign gets its own ledger account, keyed `campaign:<id>` — the
 * same shape already used for the platform's `city:<slug>` fund.
 */
export interface FundRef {
  /** The business whose pool this is. */
  businessId: string;
  /** Present = this is a campaign's escrow, not the business's Pay It Forward pool. */
  campaignId?: string;
}

/** The ledger `owner_id` for a fund scope. Campaign money is deliberately a separate account. */
function ownerOf(fund: FundRef): string {
  return fund.campaignId ? `campaign:${fund.campaignId}` : fund.businessId;
}

function assertPositive(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw ValidationError('Community fund amounts must be positive integer cents');
  }
}

export const communityFundLedger = {
  /**
   * Someone gave. Platform cash rises, and the pool liability rises with it — the money is held,
   * not earned, so no revenue is recognised on this leg.
   *
   * ADR-005 §4: **no platform fee is taken from a contribution.** Taking a cut of a gift is
   * indefensible, and the amount would never justify explaining it.
   *
   * The caller must only reach here from a SUCCEEDED payment webhook. Crediting a balance before the
   * money arrives is the exact defect `PingBudgetTopup` exists to record.
   */
  async contribute(input: {
    fund: FundRef;
    amountCents: number;
    /** Contribution row id — also the idempotency key, so a replayed webhook cannot double-credit. */
    contributionId: string;
    memo?: string;
  }) {
    assertPositive(input.amountCents);
    return ledgerService.post({
      transactionId: `cfund_contribute_${input.contributionId}`,
      refType: 'community_contribution',
      refId: input.contributionId,
      memo: input.memo,
      entries: [
        {
          ownerType: 'platform',
          ownerId: null,
          accountType: 'cash',
          direction: 'debit',
          amountCents: input.amountCents,
          entryType: 'community_contribution',
        },
        {
          ownerType: 'business',
          ownerId: ownerOf(input.fund),
          accountType: 'community_fund_payable',
          direction: 'credit',
          amountCents: input.amountCents,
          entryType: 'community_contribution',
        },
      ],
    });
  },

  /**
   * The pool paid for someone's order. The liability falls; the business is owed its net; the
   * platform recognises its fee.
   *
   * ADR-005 §4: **the standard marketplace fee applies here, exactly as on any other sale.** Two
   * reasons, the second decisive — the vendor handed over a real meal and is being paid real money
   * for it, and a fee-free settlement path would be an arbitrage: routing ordinary sales through the
   * pool would cost the vendor less than selling honestly.
   *
   * No cash moves: the platform has held this money since the contribution.
   */
  async redeem(input: {
    fund: FundRef;
    amountCents: number;
    /** Platform fee on this sale. May be zero; the entry is then omitted rather than posted at 0. */
    feeCents: number;
    /** Redemption row id — the idempotency key. */
    redemptionId: string;
    memo?: string;
  }) {
    assertPositive(input.amountCents);
    if (!Number.isInteger(input.feeCents) || input.feeCents < 0) {
      throw ValidationError('Community fund fee must be a non-negative integer');
    }
    if (input.feeCents > input.amountCents) {
      // A fee larger than the redemption would leave the seller owed a negative amount. That is a
      // pricing bug upstream, and it must not be allowed to reach the books.
      throw ValidationError('Community fund fee cannot exceed the redeemed amount');
    }
    const sellerNet = input.amountCents - input.feeCents;

    return ledgerService.post({
      transactionId: `cfund_redeem_${input.redemptionId}`,
      refType: 'community_redemption',
      refId: input.redemptionId,
      memo: input.memo,
      entries: [
        {
          ownerType: 'business',
          ownerId: ownerOf(input.fund),
          accountType: 'community_fund_payable',
          direction: 'debit',
          amountCents: input.amountCents,
          entryType: 'community_redemption',
        },
        ...(sellerNet > 0
          ? ([
              {
                ownerType: 'business' as const,
                // Always the BUSINESS, never the fund scope. The seller is owed for the meal they
                // handed over; a campaign escrow is not a party that can be owed anything.
                ownerId: input.fund.businessId,
                accountType: 'payable' as const,
                direction: 'credit' as const,
                amountCents: sellerNet,
                entryType: 'community_redemption' as const,
              },
            ] as const)
          : []),
        ...(input.feeCents > 0
          ? ([
              {
                ownerType: 'platform' as const,
                ownerId: null,
                accountType: 'fee_revenue' as const,
                direction: 'credit' as const,
                amountCents: input.feeCents,
                entryType: 'community_redemption' as const,
              },
            ] as const)
          : []),
      ],
    });
  },

  /**
   * Unredeemed after the expiry window. ADR-005 §6: the money moves to a platform-administered city
   * fund and is redistributed to other pools in the same city.
   *
   * It does **not** go to the vendor, and that exclusion is the point rather than a detail. A vendor
   * who kept unredeemed money would profit from suppressing redemption — and the vendor controls the
   * caps, the settings, and the prompt. Never build an incentive to withhold generosity into a
   * generosity feature. It does not go to the platform either: this money was given by the public
   * for the public, and booking it as revenue would make every impact figure the product publishes
   * quietly false.
   *
   * Note both legs are `community_fund_payable`: the liability changes hands, it is not discharged.
   */
  async expire(input: {
    fund: FundRef;
    amountCents: number;
    /** The city that keeps the money. Owner of the receiving platform-level fund. */
    citySlug: string;
    /** Expiry batch/row id — the idempotency key. */
    expiryId: string;
    memo?: string;
  }) {
    assertPositive(input.amountCents);
    return ledgerService.post({
      transactionId: `cfund_expire_${input.expiryId}`,
      refType: 'community_expiry',
      refId: input.expiryId,
      memo: input.memo ?? `expired to city fund ${input.citySlug}`,
      entries: [
        {
          ownerType: 'business',
          ownerId: ownerOf(input.fund),
          accountType: 'community_fund_payable',
          direction: 'debit',
          amountCents: input.amountCents,
          entryType: 'community_expiry',
        },
        {
          ownerType: 'platform',
          ownerId: `city:${input.citySlug}`,
          accountType: 'community_fund_payable',
          direction: 'credit',
          amountCents: input.amountCents,
          entryType: 'community_expiry',
        },
      ],
    });
  },

  /**
   * Money returned to the contributor: the 24-hour change-of-mind window (ADR-005 §7), or every
   * contributor of a Boost campaign that missed its goal (ADR-006 §3).
   *
   * The platform absorbs the payment processor's refund cost rather than netting it off — a
   * contributor is never refunded less than they gave. That cost is not modelled here because it is
   * a platform expense on the processor's own rail, not a movement of the community's money.
   */
  async refund(input: {
    fund: FundRef;
    amountCents: number;
    /** Refund row id — the idempotency key. */
    refundId: string;
    memo?: string;
  }) {
    assertPositive(input.amountCents);
    return ledgerService.post({
      transactionId: `cfund_refund_${input.refundId}`,
      refType: 'community_refund',
      refId: input.refundId,
      memo: input.memo,
      entries: [
        {
          ownerType: 'business',
          ownerId: ownerOf(input.fund),
          accountType: 'community_fund_payable',
          direction: 'debit',
          amountCents: input.amountCents,
          entryType: 'community_refund',
        },
        {
          ownerType: 'platform',
          ownerId: null,
          accountType: 'cash',
          direction: 'credit',
          amountCents: input.amountCents,
          entryType: 'community_refund',
        },
      ],
    });
  },

  /**
   * Move held money from one fund scope to another. Both legs are `community_fund_payable`: the
   * liability changes hands, it is not discharged, and no cash moves — the platform has held this
   * money since the contribution.
   *
   * Used for roll-forward (ADR-006 §5), where a contributor asked for their money to back the
   * business's NEXT campaign rather than come back to them. It is deliberately not a general
   * "move money between businesses" primitive: both ends must belong to the same business, because
   * moving one business's community money to another is not something anybody consented to.
   */
  async transferBetweenFunds(input: {
    from: FundRef;
    to: FundRef;
    amountCents: number;
    /** Idempotency key — a replayed sweep must not move the money twice. */
    transferId: string;
    memo?: string;
  }) {
    assertPositive(input.amountCents);
    if (input.from.businessId !== input.to.businessId) {
      throw ValidationError('Community money cannot move between businesses');
    }
    if (ownerOf(input.from) === ownerOf(input.to)) {
      throw ValidationError('Source and destination funds are the same');
    }

    return ledgerService.post({
      transactionId: `cfund_transfer_${input.transferId}`,
      refType: 'community_transfer',
      refId: input.transferId,
      memo: input.memo,
      entries: [
        {
          ownerType: 'business',
          ownerId: ownerOf(input.from),
          accountType: 'community_fund_payable',
          direction: 'debit',
          amountCents: input.amountCents,
          entryType: 'community_contribution',
        },
        {
          ownerType: 'business',
          ownerId: ownerOf(input.to),
          accountType: 'community_fund_payable',
          direction: 'credit',
          amountCents: input.amountCents,
          entryType: 'community_contribution',
        },
      ],
    });
  },

  /** Current held balance for a business's pool. Positive = money available to redeem. */
  async balanceOf(fund: FundRef): Promise<number> {
    return ledgerService.balanceOf({
      ownerType: 'business',
      ownerId: ownerOf(fund),
      accountType: 'community_fund_payable',
    });
  },
};
