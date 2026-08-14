import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { FULFILMENT_PIPELINE } from '../fulfilment/fulfilment';

/**
 * ═══ POSTCARD MARKETING — direct orders (ADR-007) ═══
 *
 * A business buys its own mailing: pick an area, pick a quantity, upload artwork, pay. The vendor
 * (PostcardMania DirectMail v3) prints and mails it.
 *
 * ## Why this is a sibling of Boost, not a variant of it (ADR-007 §1)
 *
 * Boost mails postcards too, which invites merging them. The money semantics are opposites:
 *
 *   Boost      — MANY contributors, custodial community funds (ADR-005), refundable until funded
 *   Postcards  — ONE buyer, a direct purchase, irreversible once the vendor's batch closes
 *
 * ADR-006 already made this call once, keeping `boost_campaigns` out of `placements`: *"the
 * lifecycle patterns are shared; the table is not."* It applies with more force here, because
 * putting refundable custodial money and non-refundable purchase money in one collection is a
 * compliance problem rather than an awkward schema. What they DO share is the fulfilment pipeline,
 * and that is shared as code, not as rows.
 *
 * ## Consumer PII is not stored here, on purpose (ADR-007 §6)
 *
 * An audience is a vendor list-count ID and a COUNT. The vendor resolves, holds, and mails the
 * list; recipient names and home addresses never reach StreetServe. Their API also accepts an
 * explicit `recipients[]` array — deliberately unused, because it would drag consumer PII into this
 * database for no product gain.
 */

// ─── postcard_audiences ─────────────────────────────────────────────────────────────────────
/**
 * A resolved, orderable mailing area.
 *
 * `record_count` comes from the VENDOR and is never recomputed by us: only they know current
 * deliverable counts, and a number we derive would disagree with their invoice after the buyer was
 * quoted ours (audit F-9).
 */
const PostcardAudienceSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    created_by: { type: String, required: true },
    /**
     * `radius` is included because the vendor supports it and it fits how mobile vendors actually
     * think about their pitch. `neighborhood` is absent: it is not a postal unit, the vendor has no
     * such targeting, and offering it would mean inventing a mapping onto routes (audit PC-6).
     */
    selection_type: { type: String, enum: ['zip', 'carrier_route', 'radius'], required: true },
    /** ZIPs, or carrier routes in the vendor's `ZIP:ROUTE` form. Empty for a radius. */
    selection_keys: { type: [String], default: [] },
    radius: {
      type: new Schema(
        {
          miles: { type: Number, required: true },
          address: { type: String, required: true },
          city: { type: String, required: true },
          state: { type: String, required: true },
          zip: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Vendor list type key (e.g. resident/occupant). Their catalogue, their vocabulary. */
    list_type: { type: String, required: true },
    /** Vendor-opaque handle. Replayed verbatim when ordering; never parsed. */
    list_count_id: { type: String, required: true },
    /** Deliverable addresses per the vendor. */
    record_count: { type: Number, required: true, min: 0 },
    /** Per-area totals, for showing the buyer how the count breaks down. Not authoritative. */
    breakdown: {
      type: [new Schema({ code: String, label: String, total: Number }, { _id: false })],
      default: [],
    },
    resolved_at: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_audiences',
  },
);
/** A business reviewing the areas it has priced recently. */
PostcardAudienceSchema.index({ business_id: 1, created_at: -1 });

export type PostcardAudienceDoc = InferSchemaType<typeof PostcardAudienceSchema>;
export const PostcardAudienceModel = defineModel('PostcardAudience', PostcardAudienceSchema);

// ─── postcard_assets ────────────────────────────────────────────────────────────────────────
/**
 * Uploaded artwork and its two verdicts.
 *
 * ## Two independent gates, kept separate on purpose
 *
 * `prepress_status` answers "will this print well?" and `moderation_status` answers "should we
 * print this at all?". They fail for unrelated reasons, are fixed by different people, and one
 * passing tells you nothing about the other — collapsing them into a single `status` would lose the
 * ability to say "your file is fine, it is the content we are querying".
 *
 * ## Why the row is created BEFORE the upload
 *
 * The client is handed a presigned URL and never chooses the storage key: the key is generated
 * server-side and recorded here at the moment the URL is issued. Everything afterwards addresses
 * the asset by ID. A flow where the client posts back a key it claims to have written is one where
 * the client picks the path — the "no user-controlled paths" requirement, enforced structurally
 * rather than by validating a string.
 */
export const PREPRESS_STATUSES = ['awaiting_upload', 'passed', 'failed'] as const;
export type PrepressStatus = (typeof PREPRESS_STATUSES)[number];

/**
 * `pending` covers "uploaded, not yet reviewed". There is no `auto_approved` value: the automated
 * pass can only ever raise suspicion, never clear it (see `screening.ts`), so approval always has a
 * human behind it and a status implying otherwise would be a lie in the schema.
 */
export const MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

const PostcardAssetSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    created_by: { type: String, required: true },
    /** Server-generated. Never supplied by, or echoed from, the client. */
    storage_key: { type: String, required: true, unique: true },
    /** What the client SAID it would upload. The real format is sniffed from the bytes. */
    declared_content_type: { type: String, required: true },

    prepress_status: { type: String, enum: PREPRESS_STATUSES, default: 'awaiting_upload', index: true },
    /** Which product it was validated against — the same file can pass for one size and fail another. */
    validated_sku: { type: String, default: null },
    detected_format: { type: String, default: null },
    width_px: { type: Number, default: null },
    height_px: { type: Number, default: null },
    /** Resolution at PRINTED size, which is the only one that matters. */
    effective_dpi: { type: Number, default: null },
    color_space: { type: String, default: null },
    size_bytes: { type: Number, default: null },
    /** Plain-language findings, stored so the buyer sees the same words twice. */
    prepress_errors: {
      type: [new Schema({ code: String, message: String }, { _id: false })],
      default: [],
    },
    prepress_warnings: {
      type: [new Schema({ code: String, message: String }, { _id: false })],
      default: [],
    },
    validated_at: { type: Date, default: null },

    moderation_status: { type: String, enum: MODERATION_STATUSES, default: 'pending', index: true },
    /** What the automated pass flagged. Advisory only — a reviewer decides. */
    screening_flags: { type: [String], default: [] },
    moderation_reason: { type: String, default: null },
    moderated_by: { type: String, default: null },
    moderated_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_assets',
  },
);
/** The reviewer queue: everything uploaded and waiting, oldest first. */
PostcardAssetSchema.index({ moderation_status: 1, prepress_status: 1, created_at: 1 });

export type PostcardAssetDoc = InferSchemaType<typeof PostcardAssetSchema>;
export const PostcardAssetModel = defineModel('PostcardAsset', PostcardAssetSchema);

// ─── postcard_orders ────────────────────────────────────────────────────────────────────────
/**
 * ## The status enum stops at `cancelled` on purpose
 *
 * The full lifecycle is `draft → quoted → paid → submitted → printing → mailed`. Only the states
 * this phase can actually WRITE are declared, because `enumReachability.test.ts` forbids a schema
 * that promises a lifecycle the service does not implement — the F-3 defect, caught as a test.
 * `paid` arrives with the money path, the fulfilment states with the submission job. Adding them
 * now would put four dead values in every consumer that switches on this field.
 */
/**
 * `paid` is where Phase 5 stops. Submission, printing and mailing arrive in Phase 6, and the enum
 * deliberately does not name states the code cannot yet reach — a status nothing can produce reads
 * as a feature that exists.
 *
 * `payment_failed` is its own state rather than a silent return to `quoted`: a buyer whose card was
 * declined needs to be told, and an order that bounced back to `quoted` is indistinguishable from
 * one they never tried to pay.
 */
export const POSTCARD_ORDER_STATUSES = [
  'draft',
  'quoted',
  'paid',
  'payment_failed',
  /**
   * Handed to the vendor. **This is where the order stops being ours to change** — see
   * `fulfilment_stage` for how far along the physical run is.
   */
  'submitted',
  /**
   * Every retry exhausted, or the vendor refused it outright. A paid order that cannot be
   * submitted must be VISIBLE rather than sitting in `paid` looking healthy: somebody has money
   * from a customer and no mailing to show for it (audit F-5).
   */
  'submission_failed',
  'refunded',
  'cancelled',
] as const;
export type PostcardOrderStatus = (typeof POSTCARD_ORDER_STATUSES)[number];

const PostcardOrderSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    created_by: { type: String, required: true },
    status: { type: String, enum: POSTCARD_ORDER_STATUSES, default: 'draft', index: true },

    /** Vendor size key from the product registry (`POSTCARD_PRODUCTS`). */
    sku: { type: String, required: true },
    mail_class: { type: String, enum: ['standard', 'first_class'], required: true },
    audience_id: { type: String, default: null },
    /**
     * The artwork. Attaching one requires it to have PASSED pre-press; approval by a moderator is
     * required later, at submission. Validating before checkout rather than after is the whole
     * point of ARCHITECTURAL_IMPROVEMENTS.md §7 — an artwork problem found after payment is a
     * refund conversation, found before it is a re-export.
     */
    asset_id: { type: String, default: null },
    quantity: { type: Number, default: null, min: 1 },

    /**
     * ── Price snapshot ──
     * Written when the order is quoted, and never recomputed on read. A buyer is shown a price and
     * then charged it; re-deriving it later from whatever the vendor charges today would make the
     * two silently disagree. Every component is stored so the total can be explained, not just
     * asserted.
     */
    vendor_unit_cost_cents: { type: Number, default: null },
    vendor_cost_cents: { type: Number, default: null },
    margin_cents: { type: Number, default: null },
    total_cents: { type: Number, default: null },
    quoted_at: { type: Date, default: null },
    /**
     * The vendor publishes prices but does not RESERVE them — there is no quote endpoint, so our
     * number is computed from their published table and is not binding on them. Honouring a stale
     * one at checkout books a loss nobody sees until reconciliation (audit F-8).
     */
    quote_expires_at: { type: Date, default: null },

    /**
     * ── Money ──
     * Sparse-unique: at most one order per intent, but most orders have none. A plain `unique`
     * index would collide every unpaid order against every other on `null`.
     */
    stripe_payment_intent_id: { type: String, default: null },
    /**
     * Sales tax, held for the state and never ours (`tax_payable`). Zero while the tax flag is off
     * pending the merchant-of-record decision (ADR-007 §5) — stored regardless so a paid order
     * always records what tax treatment it received, including "none".
     */
    tax_cents: { type: Number, default: 0 },
    /** Total actually charged: goods + tax. `total_cents` above is the pre-tax price snapshot. */
    charged_cents: { type: Number, default: null },
    paid_at: { type: Date, default: null },
    payment_failure_reason: { type: String, default: null },
    refunded_at: { type: Date, default: null },
    refund_reason: { type: String, default: null },
    stripe_refund_id: { type: String, default: null },

    /**
     * ── Fulfilment (Phase 6) ──
     * The vendor's own identifiers, stored so support can correlate in both directions.
     */
    vendor_order_id: { type: String, default: null },
    vendor_batch_id: { type: String, default: null },
    submitted_at: { type: Date, default: null },
    /**
     * How far the physical run has got. Deliberately SEPARATE from `status`: the order's lifecycle
     * with us ends at `submitted`, while the pipeline keeps moving inside the vendor's factory.
     * Collapsing them would mean every new print stage became a new order status.
     */
    fulfilment_stage: { type: String, enum: FULFILMENT_PIPELINE, default: null },
    fulfilment_stage_at: { type: Date, default: null },

    /**
     * Retry bookkeeping for submission.
     *
     * Tracked on the ORDER rather than only inside the job queue, because "which paid orders have
     * not reached the printer?" is a question ops must be able to answer without reading Redis —
     * and because a queue that loses a job would otherwise lose the fact silently.
     */
    submission_attempts: { type: Number, default: 0 },
    submission_next_attempt_at: { type: Date, default: null },
    submission_last_error: { type: String, default: null },

    /** Chosen by the buyer; the order joins the vendor's batch for this date. */
    mail_date: { type: Date, default: null },
    cancelled_reason: { type: String, default: null },
    cancelled_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_orders',
  },
);
/** The business's order list, newest first. */
PostcardOrderSchema.index({ business_id: 1, created_at: -1 });
/** The quote-expiry read path. */
PostcardOrderSchema.index({ status: 1, quote_expires_at: 1 });
/** The submission sweep: paid orders waiting to reach the printer, soonest attempt first. */
PostcardOrderSchema.index({ status: 1, submission_next_attempt_at: 1 });
/** The status poll, and the vendor-webhook lookup — their id is the only handle they hand back. */
PostcardOrderSchema.index(
  { vendor_order_id: 1 },
  { unique: true, partialFilterExpression: { vendor_order_id: { $type: 'string' } } },
);
/** Webhook lookup: the intent is the only handle Stripe gives us back. */
PostcardOrderSchema.index(
  { stripe_payment_intent_id: 1 },
  { unique: true, partialFilterExpression: { stripe_payment_intent_id: { $type: 'string' } } },
);

export type PostcardOrderDoc = InferSchemaType<typeof PostcardOrderSchema>;
export const PostcardOrderModel = defineModel('PostcardOrder', PostcardOrderSchema);

// ─── postcard_payables ──────────────────────────────────────────────────────────────────────
/**
 * What we owe the print vendor for one order (ADR-007 §4, Topology B).
 *
 * ## Why this exists at all
 *
 * Under wholesale resale the buyer's entire payment lands in OUR account and only the margin is
 * ours to keep. The rest is a debt, and a debt nobody records is a debt discovered at quarter-end.
 * A row per order — accrued the moment the money arrives, discharged when we settle — is what turns
 * "no manual accounting" from a promise into a property of the system.
 *
 * ## Why per order rather than a running total
 *
 * A single balance cannot answer "which orders is this invoice for?", which is the only question
 * that matters when the vendor's number and ours disagree. Reconciliation is a set comparison, and
 * you cannot compare sets you never kept.
 *
 * Amount is the vendor's WHOLESALE cost. Margin and tax never appear here — neither is theirs.
 */
export const POSTCARD_PAYABLE_STATUSES = ['accrued', 'settling', 'settled', 'reversed'] as const;
export type PostcardPayableStatus = (typeof POSTCARD_PAYABLE_STATUSES)[number];

const PostcardPayableSchema = new Schema(
  {
    order_id: { type: String, required: true, unique: true },
    business_id: { type: String, required: true, index: true },
    /** Wholesale cost owed to the vendor. Never includes our margin or the buyer's tax. */
    amount_cents: { type: Number, required: true, min: 0 },
    status: { type: String, enum: POSTCARD_PAYABLE_STATUSES, default: 'accrued', index: true },
    settlement_id: { type: String, default: null, index: true },
    accrued_at: { type: Date, required: true },
    settled_at: { type: Date, default: null },
    /**
     * Set when an order is refunded before the vendor was paid. The debt never existed in
     * substance, so it is reversed rather than settled — and the distinction is kept because
     * "we did not owe this" and "we paid this" are different facts about the same money.
     */
    reversed_at: { type: Date, default: null },
    reversal_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_payables',
  },
);
/** The settlement sweep: everything accrued and not yet claimed by a settlement. */
PostcardPayableSchema.index({ status: 1, accrued_at: 1 });

export type PostcardPayableDoc = InferSchemaType<typeof PostcardPayableSchema>;
export const PostcardPayableModel = defineModel('PostcardPayable', PostcardPayableSchema);

// ─── postcard_settlements ───────────────────────────────────────────────────────────────────
/**
 * A period's worth of payables, closed into one statement to pay the vendor.
 *
 * ## The honest boundary of the automation
 *
 * Everything up to "here is exactly what we owe, for these orders" is automatic. The **bank
 * transfer is not**, and cannot be: the vendor's API has no endpoint that accepts money, they run a
 * prepaid retainer topped up out of band, and nothing in this codebase should be moving funds to an
 * external account on a timer without a human. So a settlement closes automatically and an
 * authorised person confirms the payment with an external reference.
 *
 * That is still "no manual accounting" in the sense that matters — nobody adds up invoices or keys
 * figures — but it is not "money leaves the building unattended", and the difference is worth being
 * precise about rather than describing the job as fully automatic.
 */
export const POSTCARD_SETTLEMENT_STATUSES = ['open', 'paid', 'void'] as const;
export type PostcardSettlementStatus = (typeof POSTCARD_SETTLEMENT_STATUSES)[number];

const PostcardSettlementSchema = new Schema(
  {
    status: { type: String, enum: POSTCARD_SETTLEMENT_STATUSES, default: 'open', index: true },
    /** Inclusive lower bound / exclusive upper bound on `accrued_at`. */
    period_start: { type: Date, required: true },
    period_end: { type: Date, required: true },
    payable_count: { type: Number, required: true, min: 0 },
    total_cents: { type: Number, required: true, min: 0 },
    /** Bank/ACH reference or retainer top-up id. Required to mark paid — proof, not a checkbox. */
    external_reference: { type: String, default: null },
    paid_by: { type: String, default: null },
    paid_at: { type: Date, default: null },
    void_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_settlements',
  },
);
PostcardSettlementSchema.index({ status: 1, period_end: -1 });

export type PostcardSettlementDoc = InferSchemaType<typeof PostcardSettlementSchema>;
export const PostcardSettlementModel = defineModel('PostcardSettlement', PostcardSettlementSchema);
