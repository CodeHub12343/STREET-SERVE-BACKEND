import { z } from 'zod';

import { RTO_FREQUENCIES, RTO_MAX_INSTALLMENTS } from '../../config/constants';
import { NonNegativeCents, PositiveCents } from '../../shared/money';
import {
  RTO_OWNERSHIP_TRIGGERS,
  RTO_PARTIES,
  RTO_RETURN_DESTINATIONS,
} from './rto.terms';

const objectId = z.string().length(24);
const party = z.enum(RTO_PARTIES);

/**
 * §44 per-listing obligations. Optional as a block — a seller who says nothing gets
 * `DEFAULT_RTO_LISTING_TERMS`, which is deliberately the conservative reading (no returns offered,
 * nothing refundable) so silence can never imply a protection the seller did not agree to.
 */
export const ListingTermsSchema = z
  .object({
    maintenanceResponsibility: party,
    damageResponsibility: party,
    returnAllowed: z.boolean(),
    returnTransportResponsibility: party,
    restockingFeeCents: NonNegativeCents,
    paymentsRefundableOnReturn: z.boolean(),
    ownershipCreditPreservedOnReturn: z.boolean(),
    reinstatementAllowed: z.boolean(),
    cancellationNoticeDays: z.number().int().min(0).max(90),
    deliveryFeeCents: NonNegativeCents,
    taxBps: z.number().int().min(0).max(3000),
  })
  .strict()
  .partial();

/**
 * §54's ten allocations. NOT partial and NOT optional when the deal is a consignment RTO: a
 * three-party agreement that does not say who handles a missed payment is a future dispute, not an
 * agreement.
 */
export const ConsignmentTermsSchema = z
  .object({
    ownerDuringTerm: z.enum(['owner', 'seller']),
    deliveryBy: party,
    returnsManagedBy: party,
    customerSupportBy: party,
    damageResponsibility: party,
    missedPaymentsHandledBy: party,
    earlyPayoffApprovedBy: party,
    onCustomerReturn: z.enum(RTO_RETURN_DESTINATIONS),
    ownershipTransfersAt: z.enum(RTO_OWNERSHIP_TRIGGERS),
    paymentDivisionNote: z.string().min(1).max(500),
  })
  .strict();

/** The disclosed-terms shape shared by the preview (disclose) and acceptance. */
const RtoTerms = {
  cashPriceCents: PositiveCents,
  initialPaymentCents: NonNegativeCents,
  installmentCount: z.number().int().min(1).max(RTO_MAX_INSTALLMENTS),
  frequency: z.enum(RTO_FREQUENCIES),
  customIntervalDays: z.number().int().min(1).max(365).optional(),
  markupBps: z.number().int().min(0).max(20000), // up to 200% rental markup, disclosed
  setupFeeCents: NonNegativeCents.optional(),
  lateFeeCents: NonNegativeCents.optional(),
  listingTerms: ListingTermsSchema.optional(),
};

export const DiscloseBody = z.object(RtoTerms).strict();

/** Publish an offer (§42/§44). The seller states the terms; the customer only chooses to accept. */
export const CreateListingBody = z
  .object({
    sellerId: objectId,
    productName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    photos: z.array(z.string().url().max(2048)).max(12).optional(),
    // Required, not optional: §43 is default-deny and "uncategorised" is not a category.
    categoryId: objectId,
    citySlug: z.string().min(1).max(64),
    ...RtoTerms,
    quantityAvailable: z.number().int().min(1).max(1000),
    /**
     * §54 — declared here rather than at acceptance. The three-party arrangement is a deal between
     * the owner and the managing business that the customer joins; it is not something a customer
     * could opt into, and requiring it in the acceptance body meant no UI could ever create one.
     */
    isConsignment: z.boolean().optional(),
    ownerId: objectId.optional(),
    ownerType: z.enum(['user', 'business']).optional(),
    commissionBps: z.number().int().min(0).max(10000).optional(),
    consignmentTerms: ConsignmentTermsSchema.optional(),
  })
  .strict()
  .refine((v) => !v.isConsignment || Boolean(v.ownerId && v.consignmentTerms), {
    message:
      'A consignment listing must name the owner and state all ten §54 allocations before it goes live',
  });

export const ListingIdParam = z.object({ id: objectId }).strict();

export const CitySlugParam = z.object({ slug: z.string().min(1).max(64) }).strict();
export const CityRtoBody = z.object({ enabled: z.boolean() }).strict();

export const ListingStatusBody = z
  .object({ status: z.enum(['active', 'paused', 'withdrawn']) })
  .strict();

export const BrowseListingsQuery = z
  .object({
    citySlug: z.string().min(1).max(64).optional(),
    categoryId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** §52 — a condition report, at delivery or at return. Every field the spec names. */
export const ConditionReportSchema = z
  .object({
    photos: z.array(z.string().url().max(2048)).max(12).optional(),
    videoUrl: z.string().url().max(2048).optional(),
    serial: z.string().max(200).optional(),
    existingDamage: z.string().max(2000).optional(),
    accessories: z.array(z.string().max(120)).max(30).optional(),
    estimatedValueCents: NonNegativeCents.optional(),
  })
  .strict();

// ─── §50 seller remedies ─────────────────────────────────────────────────────────────────────
export const DeferBody = z.object({ days: z.number().int().min(1).max(60) }).strict();
export const PartialPaymentBody = z.object({ amountCents: PositiveCents }).strict();
export const ArrangementBody = z
  .object({
    catchUpCents: PositiveCents,
    dueAt: z.string().datetime(),
    note: z.string().max(500).optional(),
  })
  .strict();
/** A pause is time-boxed — an open-ended one is a cancellation nobody wrote down. */
export const PauseBody = z.object({ until: z.string().datetime() }).strict();
export const AcknowledgeConditionBody = z
  .object({ report: z.enum(['delivery', 'return']) })
  .strict();

/**
 * Accepting an offer. Note what is NOT here: no price, no schedule, no product name. Those used to
 * be customer-supplied, which meant an "agreement" recorded one party's wishes and called them
 * terms. They now come from the listing, server-side.
 */
export const AcceptRtoBody = z
  .object({
    listingId: objectId,
    /** §52 delivery condition report, captured at acceptance. */
    condition: ConditionReportSchema.optional(),
  })
  .strict();

export const ApproveSellerBody = z
  .object({ sellerId: objectId, note: z.string().max(500).optional() })
  .strict();

export const AgreementIdParam = z.object({ id: objectId }).strict();

/** Vendor-scoped pre-flight for the offer form. `categoryId` optional — the form picks it later. */
export const RtoEligibilityQuery = z.object({
  sellerId: z.string().length(24),
  citySlug: z.string().min(1).max(64).optional(),
  categoryId: z.string().length(24).optional(),
});
