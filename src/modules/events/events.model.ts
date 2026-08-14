import { Schema, type InferSchemaType } from 'mongoose';

import { EVENT_SOURCES } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ E-4 — EVENTS ═══
 *
 * The brief's "Smart Event Selling": fairs, festivals, farmers markets, sporting events, concerts —
 * and an alert that says "500 people expected at this event, here's what to bring".
 *
 * Nothing in the platform knew an event existed. This is the entity that makes E-5 (alerts), E-8
 * (event pricing) and the map's fourth layer possible at all.
 *
 * `expected_attendance` is the field everything downstream keys on, and it is deliberately
 * NULLABLE. An event with unknown attendance is still worth showing a seller; inventing a number
 * for it would make the alert threshold meaningless and the pricing suggestion dishonest.
 */
const EventSchema = new Schema(
  {
    name: { type: String, required: true },
    /** Free text from the venue/source. Never parsed — only displayed. */
    venue: { type: String, default: null },
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    starts_at: { type: Date, required: true, index: true },
    ends_at: { type: Date, default: null },
    /** Null = genuinely unknown. Downstream code must handle that rather than defaulting to 0. */
    expected_attendance: { type: Number, default: null },
    category: { type: String, default: null },
    source: { type: String, enum: EVENT_SOURCES, default: 'manual' },
    /**
     * The upstream id, so re-ingesting the same feed updates rather than duplicates. Null for
     * manually-entered events, which is why the unique index is partial.
     */
    source_ref: { type: String, default: null },
    url: { type: String, default: null },
    /** Admin-entered events are trusted; ingested ones are shown but flagged for review. */
    verified: { type: Boolean, default: false },
    cancelled: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'events' },
);
EventSchema.index({ location: '2dsphere' });
/** Idempotent ingestion: one row per upstream event, but manual rows aren't constrained. */
EventSchema.index(
  { source: 1, source_ref: 1 },
  { unique: true, partialFilterExpression: { source_ref: { $type: 'string' } } },
);
/** The hot query: upcoming, not cancelled. */
EventSchema.index({ starts_at: 1, cancelled: 1 });

export type EventDoc = InferSchemaType<typeof EventSchema>;
export const EventModel = defineModel('Event', EventSchema);

/**
 * E-5 alert ledger. Exists purely so a seller is told about an event ONCE.
 *
 * Without this the sweep re-notifies on every run, which is how a genuinely useful alert becomes
 * the notification people mute — and muting the channel costs us every future alert too.
 */
const EventAlertSchema = new Schema(
  {
    event_id: { type: String, required: true },
    user_id: { type: String, required: true },
    sent_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'event_alerts' },
);
EventAlertSchema.index({ event_id: 1, user_id: 1 }, { unique: true });
EventAlertSchema.index({ created_at: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export type EventAlertDoc = InferSchemaType<typeof EventAlertSchema>;
export const EventAlertModel = defineModel('EventAlert', EventAlertSchema);
