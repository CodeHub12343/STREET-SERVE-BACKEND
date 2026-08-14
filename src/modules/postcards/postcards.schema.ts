import { z } from 'zod';

/** Request validation for postcard ordering (ADR-007). Mirrors the vendor's own constraints. */

export const BusinessIdParam = z.object({ businessId: z.string().min(1) });
export const OrderIdParam = z.object({ orderId: z.string().min(1) });

/** USPS five-digit ZIP. The vendor's carrier routes are `ZIP:ROUTE`, e.g. `95350:C002`. */
const Zip = z.string().regex(/^\d{5}$/, 'Enter a five-digit ZIP code');
const CarrierRoute = z.string().regex(/^\d{5}:[A-Z]\d{3}$/i, 'Expected a route like 95350:C002');

export const CreateAudienceBody = z
  .object({
    type: z.enum(['zip', 'carrier_route', 'radius']),
    listType: z.string().min(1),
    keys: z.array(z.string().min(1)).max(500).optional(),
    radius: z
      .object({
        miles: z.number().positive().max(100),
        address: z.string().min(1),
        city: z.string().min(1),
        state: z.string().length(2),
        zip: Zip,
      })
      .optional(),
  })
  /**
   * Shape-checked here rather than in the service so a malformed ZIP is a 400 with a useful
   * message, instead of a vendor round-trip that fails for reasons the buyer cannot act on.
   */
  .superRefine((val, ctx) => {
    if (val.type === 'radius') {
      if (!val.radius) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A radius needs a centre address.' });
      }
      return;
    }
    if (!val.keys?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose at least one area.' });
      return;
    }
    const each = val.type === 'zip' ? Zip : CarrierRoute;
    for (const key of val.keys) {
      const parsed = each.safeParse(key);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keys'],
          message: parsed.error.issues[0]?.message ?? 'Invalid area',
        });
        return;
      }
    }
  });

export const CreateOrderBody = z.object({
  sku: z.string().min(1),
  mailClass: z.enum(['standard', 'first_class']),
});

export const SkuParam = z.object({ sku: z.string().min(1).max(16) });
export const AssetIdParam = z.object({ assetId: z.string().min(1) });

export const CreateUploadBody = z.object({
  /** Narrower than the general photo-upload list: the print vendor rejects webp and heic. */
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
});

export const ValidateArtworkBody = z.object({ sku: z.string().min(1).max(16) });

export const ModerateBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().min(1).max(500).optional(),
});

export const QueueQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const ConfigureOrderBody = z
  .object({
    audienceId: z.string().min(1).optional(),
    /** Must already have PASSED pre-press for this order's size — enforced in the service. */
    assetId: z.string().min(1).optional(),
    quantity: z.number().int().positive().max(50_000).optional(),
    /** Date-only; the order joins the vendor's batch for that day. */
    mailDate: z.coerce.date().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export const PilotAddBody = z.object({
  businessId: z.string().min(1),
  note: z.string().max(280).optional(),
});
export const PilotRemoveBody = z.object({
  businessId: z.string().min(1),
  /** Required: removing somebody mid-pilot is a decision the review will want to understand. */
  reason: z.string().min(1).max(280),
});

export const CancelOrderBody = z.object({ reason: z.string().max(280).optional() });

/** A refund needs a reason: it is shown to the buyer and it explains a ledger reversal. */
export const RefundOrderBody = z.object({ reason: z.string().min(1).max(280) });

export const SettlementIdParam = z.object({ settlementId: z.string().min(1) });
/** The reference is the only evidence money actually left, so it is required, not optional. */
export const ConfirmSettlementBody = z.object({ externalReference: z.string().min(1).max(120) });
export const VoidSettlementBody = z.object({ reason: z.string().min(1).max(280) });
export const SettlementListQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const ListOrdersQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(50).default(20),
});
