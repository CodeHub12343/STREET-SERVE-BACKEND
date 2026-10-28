import { Schema, type InferSchemaType } from 'mongoose';

import { SPONSOR_PROGRAMS, DEFAULT_SPONSOR_PROGRAM } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ SPONSOR FULFILMENT ═══
 *
 * Tracks what a sponsor was promised and what has actually been delivered against those
 * promises — shout-outs posted, promotional videos published, postcards mailed, spotlight videos
 * aired. One row per approved sponsorship: `committed` is frozen at approval from the tier's
 * benefits, `delivered` moves up as the operator logs work.
 *
 * `committed` is COPIED, not resolved from the tier table at read time. A later edit to the tier
 * (prices, counts) must not change what an existing sponsor was promised at purchase; what they
 * paid for is what we owe, not whatever the tier currently says.
 *
 * The delivery events are append-only (see FulfillmentEventSchema below). The `delivered`
 * counters on this row are a cached projection of those events — convenient to read, authoritative
 * nowhere. Reconciliation can rebuild them from the events, and any disagreement is a bug.
 */
const CounterSchema = new Schema(
  {
    shoutouts: { type: Number, default: 0, min: 0 },
    promotionalVideos: { type: Number, default: 0, min: 0 },
    postcards: { type: Number, default: 0, min: 0 },
    spotlightVideos: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const SponsorFulfillmentSchema = new Schema(
  {
    sponsor_id: { type: String, required: true, unique: true, index: true },
    program: {
      type: String,
      enum: SPONSOR_PROGRAMS,
      default: DEFAULT_SPONSOR_PROGRAM,
      index: true,
    },
    tier: { type: String, required: true },

    /** What this sponsor was promised — frozen at approval. */
    committed: { type: CounterSchema, default: () => ({}) },

    /** Cached delivered counts — authoritative source is FulfillmentEventModel below. */
    delivered: { type: CounterSchema, default: () => ({}) },

    /** Campaign window — used for the "running out" alert and the end-of-campaign report. */
    started_at: { type: Date, required: true },
    ends_at: { type: Date, required: true },

    /**
     * Reporting cadence (`final` | `monthly`), set from the tier at seed time. The monthly
     * report job reads this to decide which sponsors to email on the 1st; a sponsor on `final`
     * cadence gets exactly one report, when the campaign ends.
     */
    reporting_cadence: { type: String, enum: ['final', 'monthly'], default: 'final' },

    /** Set by the monthly report job on dispatch, so the next one is a month out from the last. */
    last_report_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'sponsor_fulfillments',
  },
);

export type SponsorFulfillmentDoc = InferSchemaType<typeof SponsorFulfillmentSchema>;
export const SponsorFulfillmentModel = defineModel(
  'SponsorFulfillment',
  SponsorFulfillmentSchema,
);

/**
 * ═══ FULFILLMENT EVENTS — append-only delivery log. ═══
 *
 * Every logged delivery lands here with its proof (URL to the social post, the video, the postcard
 * batch report). Append-only on purpose: a reconciler must be able to rebuild `delivered` counts
 * from the event stream, which it cannot do if an operator can edit or delete a row.
 *
 * Corrections are an inverse row — a negative count with a reason — not an edit. Same mechanism
 * as the money ledger.
 */
export const FULFILLMENT_DELIVERABLE_TYPES = [
  'shoutouts',
  'promotionalVideos',
  'postcards',
  'spotlightVideos',
] as const;
export type FulfillmentDeliverableType = (typeof FULFILLMENT_DELIVERABLE_TYPES)[number];

const FulfillmentEventSchema = new Schema(
  {
    sponsor_id: { type: String, required: true, index: true },
    deliverable_type: {
      type: String,
      enum: FULFILLMENT_DELIVERABLE_TYPES,
      required: true,
    },
    /**
     * Signed. Positive = delivered, negative = correction (e.g. a shout-out was removed). The
     * delivered counter is a sum over this field, so a correction keeps the audit trail intact
     * instead of a mutable edit erasing what was once there.
     */
    count: { type: Number, required: true },
    /** The actual thing — a URL to the social post, the video, the postcard-batch report. */
    proof_url: { type: String, default: null },
    note: { type: String, default: null },
    logged_by: { type: String, required: true },
    /** `delivered_at` is user-reported (the deliverable's own date); `created_at` is the log time. */
    delivered_at: { type: Date, default: () => new Date() },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
    collection: 'sponsor_fulfillment_events',
  },
);
FulfillmentEventSchema.index({ sponsor_id: 1, created_at: -1 });

export type FulfillmentEventDoc = InferSchemaType<typeof FulfillmentEventSchema>;
export const FulfillmentEventModel = defineModel(
  'SponsorFulfillmentEvent',
  FulfillmentEventSchema,
);
