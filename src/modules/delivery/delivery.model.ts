import { Schema, type InferSchemaType } from 'mongoose';

import { DRIVER_VEHICLE_TYPES } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ DELIVERY ASSIST NETWORK (ADR-004) ═══
 *
 * A vendor swamped with orders taps for help; nearby drivers are offered the job; the first to
 * accept takes it; the customer watches it arrive.
 *
 * ## The shape this is modelled on
 *
 * `WaveDownSchema`, not `jobs`. Jobs is a HIRING flow — post, apply, poster selects, check in —
 * measured in hours and built around a poster choosing a person. A wave-down is a DISPATCH —
 * request, broadcast, accept-or-expire — measured in minutes and built around the first willing
 * party. Delivery is the second thing, so it inherits the wave's shape: server-authoritative
 * timestamps, an expiry, and every price SNAPSHOTTED at request time.
 *
 * ## What is deliberately absent
 *
 * There is **no acceptance rate, no decline counter, and no driver score.** ADR-004 prohibits
 * acceptance-rate pressure, and the surest way to reintroduce a prohibited mechanic is to start
 * collecting the number that would drive it. A declined offer leaves no trace on the driver at all.
 */

// ─── driver_profiles ────────────────────────────────────────────────────────────────────────
const DriverProfileSchema = new Schema(
  {
    user_id: { type: String, required: true, unique: true },
    vehicle_type: { type: String, enum: DRIVER_VEHICLE_TYPES, required: true },
    vehicle_description: { type: String, default: null },

    /**
     * ADR-004 §3(a) — the driver's OWN obligation, recorded as an attestation and an expiry date.
     *
     * The platform stores what it was told and when it runs out. It does not store a policy number,
     * does not verify the policy, and does not assess whether the cover is adequate — telling
     * somebody "you're covered" when their personal policy excludes delivery use is exactly the harm
     * ADR-003 §2 refused to risk.
     */
    insurance_attested_at: { type: Date, default: null },
    insurance_expires_at: { type: Date, default: null },
    licence_expires_at: { type: Date, default: null },

    /** Third-party check. About third-party SAFETY, not about directing how the work is performed. */
    background_check_status: {
      type: String,
      enum: ['pending', 'passed', 'failed'],
      default: 'pending',
    },
    background_check_at: { type: Date, default: null },

    status: {
      type: String,
      enum: ['pending', 'approved', 'suspended'],
      default: 'pending',
      index: true,
    },
    /** Why dispatch is switched off. A lapsed attestation is the common case, not misconduct. */
    suspended_reason: { type: String, default: null },

    /**
     * A-14 — who to contact if something goes wrong on a trip. The specification never mentioned
     * safety; a platform that sends people to strangers' addresses needs this before it sends the
     * first one.
     */
    emergency_contact_name: { type: String, default: null },
    emergency_contact_phone: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'driver_profiles',
  },
);
/** The lapse sweep walks approved drivers by whichever date runs out first. */
DriverProfileSchema.index({ status: 1, insurance_expires_at: 1 });
DriverProfileSchema.index({ status: 1, licence_expires_at: 1 });

export type DriverProfileDoc = InferSchemaType<typeof DriverProfileSchema>;
export const DriverProfileModel = defineModel('DriverProfile', DriverProfileSchema);

// ─── delivery_requests ──────────────────────────────────────────────────────────────────────
const DeliveryRequestSchema = new Schema(
  {
    order_id: { type: String, required: true, unique: true },
    business_id: { type: String, required: true, index: true },
    customer_id: { type: String, required: true },
    /** Null until somebody accepts. First-to-accept is an atomic claim on this + status. */
    driver_id: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: [
        'broadcasting', // out to nearby drivers, nobody has taken it
        'accepted', // a driver is on the way to collect
        'picked_up', // goods are with the driver
        'delivered',
        'expired', // nobody accepted, after the last broadcast round
        'cancelled', // vendor or driver pulled out before hand-off
        'undeliverable', // driver got there and could not complete
      ],
      required: true,
      default: 'broadcasting',
    },

    /** Where the driver collects — the vendor's pitch at the moment of the request. */
    pickup: {
      lng: { type: Number, required: true },
      lat: { type: Number, required: true },
    },
    /**
     * The EXACT destination, copied from the order. A-15 stages what a driver may see: an
     * approximate point before acceptance, this after, and nothing once the delivery is over. That
     * staging happens where the address is SERVED, never by storing it twice.
     */
    destination: {
      line1: { type: String, required: true },
      line2: { type: String, default: null },
      city: { type: String, required: true },
      postal_code: { type: String, default: null },
      lng: { type: Number, required: true },
      lat: { type: Number, required: true },
      notes: { type: String, default: null },
      contact_phone: { type: String, default: null },
    },

    /**
     * Snapshotted at request time, for the same reason the wave's travel fee is: the driver must be
     * paid the amount they were shown, and the customer charged the amount they were shown. A vendor
     * editing a setting mid-flight must not silently re-price a request already in the air.
     */
    driver_payout_cents: { type: Number, required: true, min: 0 },
    coordination_fee_cents: { type: Number, default: 0 },
    customer_total_cents: { type: Number, default: 0 },
    /** Set only once the customer's card has actually been charged — never before acceptance. */
    charged_at: { type: Date, default: null },
    transaction_id: { type: String, default: null },
    payout_ref: { type: String, default: null },

    requested_at: { type: Date, required: true },
    /** Server-authoritative. When the current broadcast round lapses. */
    expires_at: { type: Date, required: true },
    broadcast_count: { type: Number, default: 1 },
    broadcast_radius_m: { type: Number, required: true },

    accepted_at: { type: Date, default: null },
    picked_up_at: { type: Date, default: null },
    delivered_at: { type: Date, default: null },
    ended_reason: { type: String, default: null },

    /**
     * DAN-12 — proof of hand-off. A short code the CUSTOMER reads out, rather than a photo: a photo
     * of somebody's doorstep is a moderation surface and a privacy problem, and a code proves the
     * driver actually met them.
     */
    proof_code: { type: String, required: true },

    /** A-14 — an opaque token the customer can share so somebody else can watch the trip. */
    share_token: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'delivery_requests',
  },
);
/** The expiry / re-broadcast sweep. */
DeliveryRequestSchema.index({ status: 1, expires_at: 1 });
/** A driver's current job, and their history. */
DeliveryRequestSchema.index({ driver_id: 1, status: 1 });
DeliveryRequestSchema.index({ share_token: 1 }, { unique: true, sparse: true });

export type DeliveryRequestDoc = InferSchemaType<typeof DeliveryRequestSchema>;
export const DeliveryRequestModel = defineModel('DeliveryRequest', DeliveryRequestSchema);

// ─── delivery_incidents (A-14) ──────────────────────────────────────────────────────────────
/**
 * Something went wrong on a trip. Absent from the specification entirely; every comparable platform
 * added incident reporting after an incident rather than before one.
 */
const DeliveryIncidentSchema = new Schema(
  {
    delivery_id: { type: String, required: true, index: true },
    reported_by: { type: String, required: true },
    reporter_role: { type: String, enum: ['driver', 'customer', 'vendor'], required: true },
    kind: {
      type: String,
      enum: ['safety', 'accident', 'harassment', 'goods_damaged', 'other'],
      required: true,
    },
    detail: { type: String, default: null },
    /** Ops triage. `open` until somebody has actually looked at it. */
    status: { type: String, enum: ['open', 'reviewed'], default: 'open', index: true },
    reviewed_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'delivery_incidents',
  },
);

export type DeliveryIncidentDoc = InferSchemaType<typeof DeliveryIncidentSchema>;
export const DeliveryIncidentModel = defineModel('DeliveryIncident', DeliveryIncidentSchema);
