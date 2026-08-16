import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Scoped customer↔business messaging (Flow 2c) — a narrow, moderated inquiry channel, not a
 * general DM system. See DATABASE_SCHEMA_PLAN.md §11.
 */
/**
 * ═══ THREADS ARE ABOUT SOMETHING ═══
 *
 * This was hardcoded customer↔business: two id fields and a unique index on the pair. That is the
 * only relationship the product could carry a conversation for — so a hub and the street seller
 * holding its stock had no way to talk, and neither did the two sides of a job, even though both
 * are working relationships with money and deadlines in them.
 *
 * Rather than a second messaging system — which would mean a second inbox, a second unread badge,
 * a second socket namespace and two implementations of read receipts that would drift apart — a
 * thread now names its SUBJECT: the thing the conversation is about.
 *
 *   business     — a customer and a business, keyed on the pair (unchanged, and still the default)
 *   consignment  — a hub and the seller holding its stock, keyed on the checkout
 *   job          — the poster and the worker, keyed on the engagement
 *
 * The subject is also the ACCESS RULE. `startThread` already refused to open a customer↔business
 * thread without a live booking or order, because messaging is where two parties settle a job they
 * are actually doing, not an open inbox any stranger can start. A checkout and an engagement are
 * that same proof for the new kinds — which is why the thread is keyed on them rather than on the
 * pair of people, and why a conversation survives after the work ends.
 *
 * Deliberately ADDITIVE: existing rows keep `customer_id`/`business_id` and their unique index, and
 * the business path is untouched. No migration, and no risk to conversations already in flight.
 */
const MessageThreadSchema = new Schema(
  {
    /** The two original fields. Populated for `business` threads only. */
    customer_id: { type: String, default: null },
    business_id: { type: String, default: null },

    subject_type: {
      type: String,
      enum: ['business', 'consignment', 'job'],
      default: 'business',
      index: true,
    },
    /** The checkout or engagement this thread is about. Null for `business` threads. */
    subject_ref_id: { type: String, default: null },
    /**
     * Everyone who may read it, denormalised.
     *
     * "My threads" is the single most-run query in messaging, and deriving membership from a
     * checkout's seller plus its hub's owner would mean two extra lookups per row on every inbox
     * load. Membership is fixed when the thread opens and never changes, so denormalising it costs
     * nothing in correctness.
     */
    participant_user_ids: { type: [String], default: [] },
    last_message_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'message_threads',
  },
);
/**
 * Unchanged, and now PARTIAL: one thread per customer/business pair, but only among rows that have
 * both. Without the filter every consignment and job thread would collide on (null, null) and the
 * second one inserted would be rejected.
 */
MessageThreadSchema.index(
  { customer_id: 1, business_id: 1 },
  {
    unique: true,
    partialFilterExpression: { customer_id: { $type: 'string' }, business_id: { $type: 'string' } },
  },
);
MessageThreadSchema.index({ business_id: 1, last_message_at: -1 });
/** One thread per checkout, per engagement — the subject IS the identity. */
MessageThreadSchema.index(
  { subject_type: 1, subject_ref_id: 1 },
  { unique: true, partialFilterExpression: { subject_ref_id: { $type: 'string' } } },
);
/** The inbox query for the new kinds. */
MessageThreadSchema.index({ participant_user_ids: 1, last_message_at: -1 });

export type MessageThreadDoc = InferSchemaType<typeof MessageThreadSchema>;
export const MessageThreadModel = defineModel('MessageThread', MessageThreadSchema);

const MessageSchema = new Schema(
  {
    thread_id: { type: Schema.Types.ObjectId, ref: 'MessageThread', required: true },
    sender_user_id: { type: String, required: true },
    body: { type: String, required: true },
    read_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'messages' },
);
MessageSchema.index({ thread_id: 1, created_at: 1 });

export type MessageDoc = InferSchemaType<typeof MessageSchema>;
export const MessageModel = defineModel('Message', MessageSchema);
