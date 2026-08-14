import { logger } from '../../config/logger';
import {
  MUTABLE_NOTIFICATION_CATEGORIES,
  NOTIFICATION_HOURLY_CEILING,
  NOTIFICATION_PREF_CATEGORIES,
  UNMUTABLE_NOTIFICATION_CATEGORIES,
} from '../../config/constants';
import { realtime } from '../../realtime/hub';
import { kv } from '../../shared/kv';
import { decodeCursor, encodeCursor, type Page } from '../../shared/pagination';
import { NotFoundError, ValidationError } from '../../shared/errors/AppError';
import { UserModel } from '../identity/identity.model';
import { NotificationModel, PushSubscriptionModel } from './notifications.model';

/**
 * Notification dispatch + durable inbox. `notify` emits over the realtime hub (live channel) AND
 * persists a record (GAP-3) so the notification center and reconnect catch-up have history; the
 * persistence is fire-and-forget so the many synchronous callers keep their void signature.
 * Push (GAP-4) stores browser subscriptions for the out-of-app channel. FCM/SMS/email land later;
 * the interface here is stable so adding channels is non-breaking.
 * See MODULE_BREAKDOWN.md §15 and REALTIME_ARCHITECTURE.md §7.
 */
export interface Notification {
  category: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface InboxCursor {
  createdAt: string;
  id: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

function shape(doc: {
  _id: unknown;
  category: string;
  title: string;
  body: string;
  data?: unknown;
  read_at?: Date | null;
  created_at?: Date;
}) {
  return {
    id: String(doc._id),
    category: doc.category,
    title: doc.title,
    body: doc.body,
    data: doc.data ?? null,
    read: Boolean(doc.read_at),
    readAt: doc.read_at ?? null,
    createdAt: doc.created_at,
  };
}

export const notificationsService = {
  /**
   * Dispatch live over the realtime hub and persist to the durable inbox (fire-and-forget).
   *
   * ## Two suppressions, and why neither drops the record
   *
   * Until Phase 7.3 this method consulted **nothing**: a user could mute a category, the API would
   * store it and read it back, and every notification arrived anyway. That is the third time this
   * codebase has shipped a switch that appears to work and does nothing — after the `notification_prefs`
   * schema silently dropping writes, and the route comment recording six switches that "read a 404
   * and wrote to nothing while appearing to work". A preference nothing enforces is worse than no
   * preference, because the user believes the problem is solved.
   *
   * Both suppressions stop the **live interruption** and still write the inbox row:
   *
   *  1. **Muted category.** Muting means "stop interrupting me", not "hide this from me". A customer
   *     who silenced order updates still needs to find them when they go looking.
   *  2. **Volume ceiling.** A delivery re-broadcasts up to four times to every eligible driver, and
   *     generosity events fire per gift. Without a cap, the honest fix for a noisy inbox is for the
   *     user to disable notifications entirely — which then silences the payout and dispute alerts
   *     that are unmutable precisely because missing them costs money.
   *
   * Unmutable categories (payout, dispute, verification) bypass both. "Safety-critical alerts can't
   * be turned off" has to be true of the dispatcher for that sentence to mean anything.
   */
  notify(userId: string, n: Notification): void {
    void this.deliver(userId, n).catch((err: unknown) =>
      logger.error({ err, userId }, 'notification dispatch failed'),
    );
  },

  async deliver(userId: string, n: Notification): Promise<void> {
    const unmutable = (UNMUTABLE_NOTIFICATION_CATEGORIES as readonly string[]).includes(n.category);
    const live = unmutable || (await this.mayInterrupt(userId, n.category));

    if (live) realtime.notify(userId, n);
    // The inbox row is written either way — a suppressed interruption is not a lost message.
    await NotificationModel.create({
      user_id: userId,
      category: n.category,
      title: n.title,
      body: n.body,
      data: n.data ?? null,
    }).catch((err: unknown) => logger.error({ err, userId }, 'notification persist failed'));
    logger.debug({ userId, category: n.category, live }, 'notification dispatched');
  },

  /**
   * May this category interrupt this user right now? False when they muted it, or when they have
   * already had `NOTIFICATION_HOURLY_CEILING` live pushes of it this hour.
   *
   * Fails OPEN: a KV outage or an unreadable preference lets the notification through. Losing the
   * ceiling means a noisy hour; losing the notification could mean a missed delivery.
   */
  async mayInterrupt(userId: string, category: string): Promise<boolean> {
    try {
      if ((MUTABLE_NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) {
        const user = await UserModel.findById(userId).select('notification_prefs').lean().exec();
        const prefs = (user?.notification_prefs ?? {}) as Record<string, boolean | undefined>;
        if (prefs[category] === false) return false;
      }
      const used = await kv().incrWithTtl(`notif:rate:${userId}:${category}`, 3600);
      return used <= NOTIFICATION_HOURLY_CEILING;
    } catch (err) {
      logger.debug({ userId, category, err }, 'notification gate unavailable — allowing');
      return true;
    }
  },

  /** Cursor-paginated inbox (newest first) for reconnect catch-up + the bell. */
  async list(userId: string, opts: { cursor?: string; limit: number }): Promise<Page<unknown>> {
    const cursor = decodeCursor<InboxCursor>(opts.cursor);
    const filter: Record<string, unknown> = { user_id: userId };
    if (cursor) {
      filter.$or = [
        { created_at: { $lt: new Date(cursor.createdAt) } },
        { created_at: new Date(cursor.createdAt), _id: { $lt: cursor.id } },
      ];
    }
    const docs = await NotificationModel.find(filter)
      .sort({ created_at: -1, _id: -1 })
      .limit(opts.limit + 1)
      .lean()
      .exec();
    const items = docs.slice(0, opts.limit);
    const last = items[items.length - 1];
    const nextCursor =
      docs.length > opts.limit && last
        ? encodeCursor({ createdAt: (last.created_at as Date).toISOString(), id: String(last._id) })
        : null;
    return { items: items.map(shape), nextCursor };
  },

  /** Count of unread notifications (drives the bell badge). */
  async unreadCount(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ user_id: userId, read_at: null }).exec();
  },

  /** Mark one notification read. Scoped to the owner — a 404 if it isn't theirs. */
  async markRead(userId: string, id: string): Promise<{ id: string; read: true }> {
    const updated = await NotificationModel.findOneAndUpdate(
      { _id: id, user_id: userId, read_at: null },
      { $set: { read_at: new Date() } },
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) {
      // Either not found, not theirs, or already read — treat "already read" as success (idempotent).
      const exists = await NotificationModel.exists({ _id: id, user_id: userId }).exec();
      if (!exists) throw NotFoundError('Notification not found');
    }
    return { id, read: true };
  },

  /** Mark every unread notification read (bulk "clear"). Returns how many were affected. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await NotificationModel.updateMany(
      { user_id: userId, read_at: null },
      { $set: { read_at: new Date() } },
    ).exec();
    return { updated: res.modifiedCount ?? 0 };
  },

  // ─── Web Push subscriptions (GAP-4) ─────────────────────────────────────────────────────────

  /** Register (or refresh) a browser push subscription. Idempotent on the endpoint. */
  async registerPushSubscription(userId: string, input: PushSubscriptionInput) {
    const doc = await PushSubscriptionModel.findOneAndUpdate(
      { endpoint: input.endpoint },
      {
        $set: {
          user_id: userId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          user_agent: input.userAgent ?? null,
          last_seen_at: new Date(),
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true, new: true },
    )
      .lean()
      .exec();
    return { id: String(doc?._id), endpoint: input.endpoint };
  },

  /** Remove a push subscription by endpoint (e.g. on 410 Gone or user opt-out). Owner-scoped. */
  async removePushSubscription(userId: string, endpoint: string): Promise<{ removed: boolean }> {
    const res = await PushSubscriptionModel.deleteOne({ user_id: userId, endpoint }).exec();
    return { removed: (res.deletedCount ?? 0) > 0 };
  },

  /** All of a user's active push endpoints (used by the push worker to fan out). */
  async listPushSubscriptions(userId: string) {
    const docs = await PushSubscriptionModel.find({ user_id: userId }).lean().exec();
    return docs.map((d) => ({
      id: String(d._id),
      endpoint: d.endpoint,
      keys: { p256dh: d.p256dh, auth: d.auth },
    }));
  },

  // ─── Per-category preferences ───────────────────────────────────────────────────────────────

  /**
   * Every category with its current on/off state. The unmutable ones are always reported `true`
   * rather than omitted, so the client renders a complete, honest list without having to know the
   * policy — and a stored `false` (from an older write, or a hand-edited document) can never
   * silence a payout or dispute alert.
   */
  async getPreferences(userId: string): Promise<Record<string, boolean>> {
    const user = await UserModel.findById(userId).lean().exec();
    if (!user) throw NotFoundError('User not found');
    const stored = (user.notification_prefs ?? {}) as Record<string, boolean | undefined>;

    const out: Record<string, boolean> = {};
    for (const key of MUTABLE_NOTIFICATION_CATEGORIES) out[key] = stored[key] !== false;
    for (const key of UNMUTABLE_NOTIFICATION_CATEGORIES) out[key] = true;
    return out;
  },

  /**
   * Patch one or more categories. Muting an unmutable category is rejected outright: the UI
   * disables those switches, but a client is not an authorization boundary, and "safety-critical
   * alerts can't be turned off" has to be true of the API for that sentence to mean anything.
   */
  async updatePreferences(
    userId: string,
    patch: Record<string, boolean>,
  ): Promise<Record<string, boolean>> {
    const blocked = Object.entries(patch)
      .filter(
        ([key, value]) =>
          value === false && !MUTABLE_NOTIFICATION_CATEGORIES.includes(key as never),
      )
      .map(([key]) => key);
    if (blocked.length > 0) {
      throw ValidationError(
        `These alerts are safety-critical and cannot be turned off: ${blocked.join(', ')}`,
        { details: { categories: blocked } },
      );
    }

    const $set: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(patch)) {
      // Unknown keys are rejected by the route schema; unmutable ones are simply not persisted,
      // since getPreferences reports them as true unconditionally.
      if (MUTABLE_NOTIFICATION_CATEGORIES.includes(key as never)) {
        $set[`notification_prefs.${key}`] = value;
      }
    }
    if (Object.keys($set).length > 0) {
      const res = await UserModel.updateOne({ _id: userId }, { $set }).exec();
      if (res.matchedCount === 0) throw NotFoundError('User not found');
    }
    return this.getPreferences(userId);
  },
};

/** Exported for the route schema so the wire vocabulary and the policy cannot drift apart. */
export const PREFERENCE_CATEGORIES = NOTIFICATION_PREF_CATEGORIES;
