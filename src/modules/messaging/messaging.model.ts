import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Scoped customer↔business messaging (Flow 2c) — a narrow, moderated inquiry channel, not a
 * general DM system. See DATABASE_SCHEMA_PLAN.md §11.
 */
const MessageThreadSchema = new Schema(
  {
    customer_id: { type: String, required: true },
    business_id: { type: String, required: true },
    last_message_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'message_threads',
  },
);
MessageThreadSchema.index({ customer_id: 1, business_id: 1 }, { unique: true });
MessageThreadSchema.index({ business_id: 1, last_message_at: -1 });

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
