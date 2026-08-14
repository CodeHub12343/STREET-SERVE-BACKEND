import { z } from 'zod';

import {
  CONSIGNMENT_TERM_DAYS,
  RTO_FREQUENCIES,
  RTO_MAX_INSTALLMENTS,
  MAX_RETURN_WINDOW_DAYS,
  MAX_TERMINATION_NOTICE_DAYS,
  MIN_RETURN_WINDOW_DAYS,
} from '../../config/constants';
import { NonNegativeCents, PositiveCents } from '../../shared/money';

const objectId = z.string().length(24);

/** A consignment term: one of the allowed day-counts, or an open-ended `no_limit` term (R14). */
export const TermDays = z.union([
  z.literal('no_limit'),
  z
    .number()
    .int()
    .refine((v) => (CONSIGNMENT_TERM_DAYS as readonly number[]).includes(v), {
      message: `term must be one of ${CONSIGNMENT_TERM_DAYS.join('/')} days or "no_limit"`,
    }),
]);

const SellerPermissions = z
  .object({
    may_discount: z.boolean().optional(),
    may_bundle: z.boolean().optional(),
    may_accept_offers: z.boolean().optional(),
    may_sell_below_min: z.boolean().optional(),
  })
  .strict();

export const RegisterHubBody = z
  .object({
    businessId: objectId,
    address: z.string().max(300).optional(),
    /**
     * A-6: the hub's tax + regulatory jurisdiction. Sales tax already treats the hub's city as the
     * place the sale happens, and food permits follow the same boundary. Optional here — a hub that
     * never lists food never needs it — and settable later via the approval-policy patch.
     */
    citySlug: z.string().min(1).max(64).optional(),
  })
  .strict();

export const HubIdParam = z.object({ id: objectId }).strict();

// ── Hub approval gate (H-03) ──
export const DeclineCheckoutBody = z.object({ reason: z.string().max(300).optional() }).strict();
export const ApprovalPolicyBody = z
  .object({
    autoApproveMinTrust: z.number().int().min(0).max(100).optional(),
    /** null = no value cap (trusted sellers clear at any value). */
    autoApproveMaxValueCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    /** A-6: set or correct the hub's jurisdiction — what food-permit clearance is checked against. */
    citySlug: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

// ── Seller-side discovery (S-01 browse) ──
export const NearbyProductsQuery = z
  .object({
    category: z.string().min(1).max(40).optional(),
    // Geospatial narrowing (Phase 6) — lng/lat travel together or not at all.
    lng: z.coerce.number().min(-180).max(180).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    radiusM: z.coerce.number().int().min(100).max(100_000).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((v) => (v.lng === undefined) === (v.lat === undefined), {
    message: 'lng and lat must be provided together',
  });
export const ProductIdParam = z.object({ id: objectId }).strict();

/** Pre-publish fee calculator (R12) — all read-only; fees are computed server-side, never supplied. */
export const FeePreviewQuery = z
  .object({
    unitPriceCents: z.coerce.number().int().min(1).max(100_000_00),
    splitPercent: z.coerce.number().int().min(0).max(100),
    quantity: z.coerce.number().int().min(1).max(100_000).default(1),
    /** §57.2 — supply these and the calculator also prices the rent-to-own deal. */
    rtoInstallmentCount: z.coerce.number().int().min(1).max(RTO_MAX_INSTALLMENTS).optional(),
    rtoFrequency: z.enum(RTO_FREQUENCIES).optional(),
    rtoMarkupBps: z.coerce.number().int().min(0).max(20000).optional(),
    rtoInitialPaymentCents: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const AddProductBody = z
  .object({
    name: z.string().min(1).max(160),
    unitValueCents: PositiveCents,
    consignmentSplitPercent: z.number().int().min(0).max(100),
    returnWindowHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
    quantityAvailable: z.number().int().min(1).max(100000),
    photos: z.array(z.string().url().max(2048)).max(6).optional(),
    category: z.string().min(1).max(40).optional(),
    listingType: z.enum(['consignment', 'wholesale', 'rental', 'donation']).optional(),
    conditionRequirements: z.string().max(1000).optional(),
    categoryId: z.string().length(24).optional(),
    // ── Owner-authored consignment terms (R14/R17/R18) ──
    termDays: TermDays.optional(), // default 30d if omitted
    minimumAuthorizedPriceCents: NonNegativeCents.optional(),
    sellerPermissions: SellerPermissions.optional(),
    returnResponsibility: z.enum(['seller', 'hub']).optional(),
    returnWindowDays: z.number().int().min(MIN_RETURN_WINDOW_DAYS).max(MAX_RETURN_WINDOW_DAYS).optional(),
    storageFeeCentsPerDay: NonNegativeCents.optional(),
    abandonmentAfterDays: z.number().int().min(1).max(365).optional(),
    /** §37 — override the value-derived notice period (3 / 7 / 14–30 days). */
    terminationNoticeDays: z.number().int().min(1).max(MAX_TERMINATION_NOTICE_DAYS).optional(),
    /** §39 — opt this product's consignments into automatic renewal. Off unless stated. */
    autoRenew: z.boolean().optional(),
    autoRenewTerm: z
      .union([z.literal(7), z.literal(30), z.literal(60), z.literal(90), z.literal('until_sold')])
      .optional(),
    // A-3: gate this product behind an earned Trust Score. Omit for open inventory.
    minSellerTrustScore: z.number().int().min(0).max(100).optional(),
    // D-5: gate on an Academy certification. Validated against the catalog in the service.
    requiredCertification: z.string().min(1).max(60).nullable().optional(),
  })
  .strict();

// ── Lifecycle action bodies (R15/R18) ──
/**
 * §35.2 — extend by a standard term, run open-ended, OR name an explicit end date. The date option
 * was the gap: `termDays` only accepted the preset day-counts, so "until the market on the 14th"
 * had no expressible form and owners rounded to whichever preset was closest.
 */
export const ExtendTermBody = z
  .object({
    termDays: TermDays.optional(),
    endDate: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => (v.termDays === undefined) !== (v.endDate === undefined), {
    message: 'Provide either termDays or endDate, not both',
  });
/** §39 — either party toggles renewal; a term is required when switching it on. */
export const AutoRenewBody = z
  .object({
    enabled: z.boolean(),
    term: z.union([z.literal(7), z.literal(30), z.literal(60), z.literal(90), z.literal('until_sold')]).optional(),
  })
  .strict();
/** §36 — the hub sets the seller's share going forward. */
export const CommissionBody = z
  .object({ splitPercent: z.number().int().min(0).max(100) })
  .strict();
export const ReducePriceBody = z.object({ unitPriceCents: PositiveCents }).strict();

export const AcceptAgreementBody = z.object({ version: z.string().min(1).max(40) }).strict();

export const CheckoutBody = z
  .object({
    productId: objectId,
    quantity: z.number().int().min(1).max(10000),
    conditionPhotoUrl: z.string().url().max(2048),
    qrToken: z.string().min(1).max(200),
  })
  .strict();

export const CheckoutIdParam = z.object({ id: objectId }).strict();

export const LogSaleBody = z
  .object({
    quantitySold: z.number().int().min(1).max(10000),
    saleAmountCents: NonNegativeCents,
    /**
     * How the customer paid. Required from Phase 3 so a cash sale can create the debt it really
     * implies rather than silently vanishing. Defaults to `cash` for older clients, since a sale
     * logged by hand is a cash sale by definition — a digital one is created by the payment flow.
     */
    paymentRail: z.enum(['cash', 'digital']).default('cash'),
    loggedVia: z.enum(['qr_scan', 'manual']).optional(),
    proofPhotoUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export const ReturnBody = z
  .object({
    quantityReturned: z.number().int().min(0).max(10000),
    conditionPhotoUrl: z.string().url().max(2048).optional(),
    conditionAssessment: z.enum(['good', 'damaged', 'lost']).optional(),
  })
  .strict();
