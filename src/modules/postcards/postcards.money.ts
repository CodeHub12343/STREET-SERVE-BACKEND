import { POSTCARD_VENDOR_ACCOUNT_ID } from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { stripe } from '../../integrations/stripe';
import { ledgerService, type EntryInput } from '../ledger/ledger.service';
import { PostcardPayableModel, type PostcardOrderDoc } from './postcards.model';

/**
 * ═══ THE MONEY LEGS OF A POSTCARD ORDER (ADR-007 §4, Topology B) ═══
 *
 * Wholesale resale, so the shape is unlike every other money path in this codebase: the buyer's
 * WHOLE payment lands in platform cash, and only the margin is ours. There is no destination charge
 * and no connected account, because the print vendor is a supplier we buy from, not a marketplace
 * seller we route funds to.
 *
 * ## One capture, three obligations
 *
 *   cash                 DEBIT   the entire amount the buyer paid
 *   ├─ vendor_payable   CREDIT   wholesale cost — a debt to the printer, settled later
 *   ├─ fee_revenue      CREDIT   our margin — the only part that is income
 *   └─ tax_payable      CREDIT   sales tax, if charged — the state's money, never ours
 *
 * Booking all three at capture is the whole of PC-15. A correct Stripe charge alone does not give
 * "no manual accounting": money that moves without a double-entry record is manual accounting
 * deferred to whoever reconciles the quarter (audit F-10).
 */

const log = logger.child({ module: 'postcards.money' });

/**
 * Sales tax.
 *
 * **Off by default, and that default is a decision rather than an omission.** Under Topology B
 * StreetServe is plausibly the merchant of record for a taxable print-and-mail service in every
 * state it mails into — but "plausibly" is not a tax position, and ADR-007 §5 is still open pending
 * an accountant. Charging tax we should not collect and failing to collect tax we owe are both
 * real harms, so the plumbing ships complete and inert.
 *
 * This follows the existing convention for customer-facing charges (`CUSTOMER_SERVICE_FEE_ENABLED`
 * and friends): the mechanism is wired and disclosed, and a flag decides whether anyone is charged.
 * Flipping it is a tax decision that needs sign-off, not a deploy.
 */
export function computeTaxCents(_order: Pick<PostcardOrderDoc, 'total_cents'>): number {
  // The parameter is unused only because the flag is off. It is the signature Stripe Tax will need,
  // kept so turning tax on is a change inside this function rather than at every call site.
  if (!env.POSTCARD_TAX_ENABLED) return 0;
  /**
   * Deliberately NOT a hardcoded rate. Destination-based sales tax depends on where each piece
   * lands, and inventing a flat percentage would produce a number that is confidently wrong. When
   * the flag is turned on this must call Stripe Tax (already integrated for the marketplace path).
   */
  throw new Error(
    'POSTCARD_TAX_ENABLED is on but no tax calculation is wired. Connect Stripe Tax before ' +
      'enabling — see ADR-007 §5.',
  );
}

export const postcardsMoney = {
  /**
   * Charges the buyer.
   *
   * A PLATFORM charge, not a destination charge: we are the merchant here and the vendor is settled
   * separately. The intent is created and stored, and the order stays where it is — only the
   * webhook may advance it (`credit` below).
   */
  async createCharge(input: {
    orderId: string;
    businessId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null }> {
    const res = await stripe().createPlatformCharge({
      amountCents: input.amountCents,
      currency: env.PLATFORM_CURRENCY,
      /** Groups the charge with anything else this order ever does at Stripe. */
      transferGroup: `postcard_${input.orderId}`,
      metadata: {
        kind: 'postcard_order',
        order_id: input.orderId,
        business_id: input.businessId,
      },
      idempotencyKey: input.idempotencyKey,
    });
    return { paymentIntentId: res.paymentIntentId, clientSecret: res.clientSecret };
  },

  /**
   * Books the capture and accrues the debt. Called from the Stripe webhook and nowhere else.
   *
   * Idempotent twice over: the ledger de-duplicates on `transactionId`, and the payable is an
   * upsert keyed by order. Stripe delivers at least once, and a replayed webhook must not double
   * the books or the debt.
   */
  async recordCapture(input: {
    orderId: string;
    businessId: string;
    chargedCents: number;
    vendorCostCents: number;
    marginCents: number;
    taxCents: number;
  }): Promise<void> {
    const entries: EntryInput[] = [
      {
        ownerType: 'platform',
        ownerId: null,
        accountType: 'cash',
        direction: 'debit',
        amountCents: input.chargedCents,
        entryType: 'postcard_order_payment',
      },
      {
        ownerType: 'platform',
        ownerId: POSTCARD_VENDOR_ACCOUNT_ID,
        accountType: 'vendor_payable',
        direction: 'credit',
        amountCents: input.vendorCostCents,
        entryType: 'postcard_vendor_cost',
      },
    ];

    // Zero-value legs are omitted rather than posted at 0 — an entry that moves nothing is noise.
    if (input.marginCents > 0) {
      entries.push({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'fee_revenue',
        direction: 'credit',
        amountCents: input.marginCents,
        entryType: 'postcard_margin',
      });
    }
    if (input.taxCents > 0) {
      entries.push({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'tax_payable',
        direction: 'credit',
        amountCents: input.taxCents,
        entryType: 'postcard_tax',
      });
    }

    await ledgerService.post({
      transactionId: `postcard_paid_${input.orderId}`,
      refType: 'postcard_order',
      refId: input.orderId,
      memo: 'Postcard order paid',
      entries,
    });

    await PostcardPayableModel.updateOne(
      { order_id: input.orderId },
      {
        $setOnInsert: {
          order_id: input.orderId,
          business_id: input.businessId,
          amount_cents: input.vendorCostCents,
          status: 'accrued',
          accrued_at: new Date(),
        },
      },
      { upsert: true },
    );

    log.info(
      { orderId: input.orderId, chargedCents: input.chargedCents },
      'postcard order captured and vendor debt accrued',
    );
  },

  /**
   * Unwinds a capture on refund.
   *
   * Reverses every leg the capture posted, and reverses the payable rather than settling it: the
   * vendor was never paid and never will be for this order, so the debt did not exist in substance.
   * Marking it `settled` would claim we paid something we did not.
   */
  async recordRefund(input: {
    orderId: string;
    chargedCents: number;
    vendorCostCents: number;
    marginCents: number;
    taxCents: number;
    reason: string;
  }): Promise<void> {
    const entries: EntryInput[] = [
      {
        ownerType: 'platform',
        ownerId: null,
        accountType: 'cash',
        direction: 'credit',
        amountCents: input.chargedCents,
        entryType: 'postcard_order_refund',
      },
      {
        ownerType: 'platform',
        ownerId: POSTCARD_VENDOR_ACCOUNT_ID,
        accountType: 'vendor_payable',
        direction: 'debit',
        amountCents: input.vendorCostCents,
        entryType: 'postcard_vendor_cost_reversed',
      },
    ];
    if (input.marginCents > 0) {
      entries.push({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'fee_revenue',
        direction: 'debit',
        amountCents: input.marginCents,
        entryType: 'postcard_margin_reversed',
      });
    }
    if (input.taxCents > 0) {
      entries.push({
        ownerType: 'platform',
        ownerId: null,
        accountType: 'tax_payable',
        direction: 'debit',
        amountCents: input.taxCents,
        entryType: 'postcard_tax_reversed',
      });
    }

    await ledgerService.post({
      transactionId: `postcard_refunded_${input.orderId}`,
      refType: 'postcard_order',
      refId: input.orderId,
      memo: `Postcard order refunded: ${input.reason}`,
      entries,
    });

    await PostcardPayableModel.updateOne(
      { order_id: input.orderId, status: 'accrued' },
      { $set: { status: 'reversed', reversed_at: new Date(), reversal_reason: input.reason } },
    );
  },
};
