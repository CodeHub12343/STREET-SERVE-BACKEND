import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Wave-down + line-up discount engine. Queue position is derived from server-timestamped join
 * order; the discount is snapshotted at join so reflow never changes a locked discount (FR-3.2/3.3).
 * See DATABASE_SCHEMA_PLAN.md §4.
 */

// ─── discount_schedules (one per owner) ─────────────────────────────────────────────────────
const DiscountScheduleSchema = new Schema(
  {
    owner_type: { type: String, enum: ['business', 'seller'], required: true },
    owner_id: { type: String, required: true },
    tiers: {
      type: [{ position: Number, discount_percent: Number }],
      default: [],
    },
    cap_percent: { type: Number, required: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'discount_schedules',
  },
);
DiscountScheduleSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export type DiscountScheduleDoc = InferSchemaType<typeof DiscountScheduleSchema>;
export const DiscountScheduleModel = defineModel('DiscountSchedule', DiscountScheduleSchema);

// ─── wave_downs ────────────────────────────────────────────────────────────────────────────
const WaveDownSchema = new Schema(
  {
    customer_id: { type: String, required: true },
    target_type: { type: String, enum: ['business', 'seller'], required: true },
    target_id: { type: String, required: true },
    note: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired', 'cancelled'],
      default: 'pending',
    },
    requested_at: { type: Date, required: true }, // server-authoritative
    expires_at: { type: Date, required: true },
    eta_seconds: { type: Number, default: null },
    accepted_at: { type: Date, default: null },
    decline_reason: { type: String, default: null },
    /**
     * The vendor's travel fee (spec §32.4), SNAPSHOTTED when the wave is raised — same reason
     * consignment terms are snapshotted at checkout: the customer must be charged the fee they were
     * shown, and a vendor editing their settings mid-journey must not silently re-price a request
     * already in flight. Null = the vendor charges nothing to come to you.
     */
    travel_fee_cents: { type: Number, default: null },
    /** Set once the fee has actually been collected, so it can never be charged twice. */
    travel_fee_charged_at: { type: Date, default: null },
    /**
     * §32.4 — the platform's Waved Down convenience fee, paid by the CUSTOMER for the dispatch
     * itself. Snapshotted alongside the vendor's travel fee for the same reason: the customer must
     * be charged the number they were shown, and a fee-schedule change mid-journey must not re-price
     * a request already in flight.
     */
    convenience_fee_cents: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'wave_downs' },
);
WaveDownSchema.index({ target_id: 1, status: 1, requested_at: 1 });
WaveDownSchema.index({ customer_id: 1, requested_at: -1 });
WaveDownSchema.index({ status: 1, expires_at: 1 });

export type WaveDownDoc = InferSchemaType<typeof WaveDownSchema>;
export const WaveDownModel = defineModel('WaveDown', WaveDownSchema);

// ─── queues (one open queue per owner) ─────────────────────────────────────────────────────
const QueueSchema = new Schema(
  {
    owner_type: { type: String, enum: ['business', 'seller'], required: true },
    owner_id: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'queues' },
);
QueueSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export type QueueDoc = InferSchemaType<typeof QueueSchema>;
export const QueueModel = defineModel('Queue', QueueSchema);

// ─── queue_entries ─────────────────────────────────────────────────────────────────────────
const QueueEntrySchema = new Schema(
  {
    queue_id: { type: Schema.Types.ObjectId, ref: 'Queue', required: true },
    customer_id: { type: String, required: true },
    joined_at: { type: Date, required: true }, // server-authoritative
    discount_percent_locked: { type: Number, required: true },
    hold_expires_at: { type: Date, required: true },
    left_at: { type: Date, default: null },
  },
  { collection: 'queue_entries' },
);
QueueEntrySchema.index({ queue_id: 1, joined_at: 1 }); // authoritative ordering
QueueEntrySchema.index({ customer_id: 1 });
QueueEntrySchema.index({ hold_expires_at: 1, left_at: 1 });

export type QueueEntryDoc = InferSchemaType<typeof QueueEntrySchema>;
export const QueueEntryModel = defineModel('QueueEntry', QueueEntrySchema);

// ─── pop_up_events ─────────────────────────────────────────────────────────────────────────
const PopUpEventSchema = new Schema(
  {
    owner_type: { type: String, enum: ['business', 'seller'], required: true },
    owner_id: { type: String, required: true },
    started_at: { type: Date, default: () => new Date() },
    notified_count: { type: Number, default: 0 },
  },
  { collection: 'pop_up_events' },
);

export type PopUpEventDoc = InferSchemaType<typeof PopUpEventSchema>;
export const PopUpEventModel = defineModel('PopUpEvent', PopUpEventSchema);
