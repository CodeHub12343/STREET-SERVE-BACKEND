import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Scheduling domain (FR-7). A business exposes bookable services + weekly availability windows;
 * customers book slots; reminders fire at 24h and 1h; no-shows feed Trust Score (Phase 4).
 * See DATABASE_SCHEMA_PLAN.md §2 (bookings).
 */

// ─── services (bookable offerings) ──────────────────────────────────────────────────────────
const ServiceSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    duration_min: { type: Number, required: true },
    price_cents: { type: Number, required: true },
    photo_url: { type: String, default: null }, // customer-facing listing image
    cutoff_min: { type: Number, default: null }, // reschedule/cancel cutoff; null → platform default
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'services' },
);

export type ServiceDoc = InferSchemaType<typeof ServiceSchema>;
export const ServiceModel = defineModel('Service', ServiceSchema);

// ─── availability_windows (weekly recurring open windows) ──────────────────────────────────
const AvailabilityWindowSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    day_of_week: { type: Number, required: true, min: 0, max: 6 }, // 0 = Sunday
    start_min: { type: Number, required: true }, // minutes from local midnight
    end_min: { type: Number, required: true },
  },
  { collection: 'availability_windows' },
);
AvailabilityWindowSchema.index({ business_id: 1, day_of_week: 1 });

export type AvailabilityWindowDoc = InferSchemaType<typeof AvailabilityWindowSchema>;
export const AvailabilityWindowModel = defineModel('AvailabilityWindow', AvailabilityWindowSchema);

// ─── bookings ──────────────────────────────────────────────────────────────────────────────
const BookingSchema = new Schema(
  {
    customer_id: { type: String, required: true },
    business_id: { type: String, required: true },
    service_id: { type: String, required: true },
    scheduled_at: { type: Date, required: true },
    duration_min: { type: Number, required: true },
    status: {
      type: String,
      enum: ['booked', 'completed', 'cancelled', 'no_show'],
      default: 'booked',
    },
    recurrence_rule: { type: String, default: null },
    reminder_sent_24h: { type: Boolean, default: false },
    reminder_sent_1h: { type: Boolean, default: false },
    cancelled_reason: { type: String, default: null },
    /**
     * §32 — the platform's fee on this completed booking. Recorded on completion (a reserved slot
     * that was never served earns nobody anything), and kept on the row so the vendor's own reporting
     * can show what was taken rather than re-deriving it from a rate that may since have moved.
     */
    platform_fee_cents: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'bookings' },
);
BookingSchema.index({ business_id: 1, scheduled_at: 1 });
BookingSchema.index({ customer_id: 1, scheduled_at: -1 });
BookingSchema.index({ status: 1, scheduled_at: 1 }); // reminder sweep
BookingSchema.index({ service_id: 1, scheduled_at: 1, status: 1 }); // slot conflict checks

export type BookingDoc = InferSchemaType<typeof BookingSchema>;
export const BookingModel = defineModel('Booking', BookingSchema);
