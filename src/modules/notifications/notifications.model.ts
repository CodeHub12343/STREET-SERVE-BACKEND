import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Notifications persistence (GAP-3 + GAP-4). The realtime hub delivers live, but a durable inbox
 * is needed for the notification center (C-32-ish bell) and for reconnect catch-up: a client that
 * was offline pulls what it missed. Web-push subscriptions (GAP-4) are stored so the push worker
 * can reach a user across devices. See MODULE_BREAKDOWN.md §15, REALTIME_ARCHITECTURE.md §7,
 * PWA_IMPLEMENTATION.md §5 (frontend).
 */

// ─── notifications (durable inbox; realtime is the live channel, this is the record) ─────────
const NotificationSchema = new Schema(
  {
    user_id: { type: String, required: true },
    category: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: null },
    read_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'notifications' },
);
// Inbox feed: newest first, per user. Also serves the unread count.
NotificationSchema.index({ user_id: 1, created_at: -1 });
NotificationSchema.index({ user_id: 1, read_at: 1 });

export type NotificationDoc = InferSchemaType<typeof NotificationSchema>;
export const NotificationModel = defineModel('Notification', NotificationSchema);

// ─── push_subscriptions (Web Push; one per browser endpoint, upserted on re-register) ────────
const PushSubscriptionSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    // Web Push encryption keys (from PushSubscription.toJSON().keys). Not secrets we mint —
    // browser-provided public material, safe to store; still, never logged.
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    user_agent: { type: String, default: null },
    last_seen_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'push_subscriptions' },
);

export type PushSubscriptionDoc = InferSchemaType<typeof PushSubscriptionSchema>;
export const PushSubscriptionModel = defineModel('PushSubscription', PushSubscriptionSchema);
