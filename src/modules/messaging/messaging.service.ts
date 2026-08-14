import { publish } from '../../events/bus';
import { realtime } from '../../realtime/hub';
import { decodeCursor, encodeCursor, type Page } from '../../shared/pagination';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { vendorsService } from '../vendors/vendors.service';
import { vendorsRepository } from '../vendors/vendors.repository';
import { BusinessModel } from '../vendors/vendors.model';
import { UserModel } from '../identity/identity.model';
import { BookingModel } from '../scheduling/scheduling.model';
import { OrderModel } from '../orders/orders.model';
import { MessageModel, MessageThreadModel } from './messaging.model';
import { presence } from './presence';

interface ThreadParticipants {
  customerId: string;
  businessId: string;
  businessOwnerId: string | null;
}

async function loadParticipants(threadId: string): Promise<{
  thread: ThreadParticipants;
  raw: { _id: unknown; customer_id: string; business_id: string };
}> {
  const thread = await MessageThreadModel.findById(threadId).lean().exec();
  if (!thread) throw NotFoundError('Thread not found');
  const owner = await vendorsService.getBusinessOwner(thread.business_id);
  return {
    raw: { _id: thread._id, customer_id: thread.customer_id, business_id: thread.business_id },
    thread: {
      customerId: thread.customer_id,
      businessId: thread.business_id,
      businessOwnerId: owner,
    },
  };
}

function isParticipant(principal: Principal, p: ThreadParticipants): boolean {
  return principal.userId === p.customerId || principal.userId === p.businessOwnerId;
}

interface BusinessBrief {
  name: string;
  logoUrl: string | null;
  ownerId: string | null;
}
/** id → {name, logo, owner} for a set of businesses, in one read. */
async function businessInfoFor(ids: string[]): Promise<Map<string, BusinessBrief>> {
  const unique = [...new Set(ids)];
  const docs = await BusinessModel.find(
    { _id: { $in: unique } },
    { name: 1, logo_url: 1, owner_user_id: 1 },
  )
    .lean()
    .exec();
  return new Map(
    docs.map((b) => [
      String(b._id),
      { name: b.name, logoUrl: b.logo_url ?? null, ownerId: b.owner_user_id ? String(b.owner_user_id) : null },
    ]),
  );
}

interface UserBrief {
  name: string;
  photoUrl: string | null;
}
/** userId → {display name, avatar} for a set of users, in one read. */
async function userBriefFor(ids: string[]): Promise<Map<string, UserBrief>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const docs = await UserModel.find({ _id: { $in: unique } }, { display_name: 1, photo_url: 1 })
    .lean()
    .exec();
  return new Map(
    docs.map((u) => [String(u._id), { name: u.display_name ?? 'Customer', photoUrl: u.photo_url ?? null }]),
  );
}

export const messagingService = {
  /**
   * Start (or reopen) the scoped thread between a customer and a business. Without `customerId`
   * the caller IS the customer. With it, the caller must own the business — this is how a vendor
   * opens the conversation with a customer who booked/ordered, instead of waiting to be messaged.
   */
  async startThread(principal: Principal, businessId: string, customerId?: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    let threadCustomerId = principal.userId;
    if (customerId && customerId !== principal.userId) {
      if (owner !== principal.userId) {
        throw ForbiddenError('Only the business owner can open a thread with a customer', ERROR_CODES.NOT_OWNER);
      }
      threadCustomerId = customerId;
    }

    /**
     * A customer may only open a thread with a business they are actually transacting with — a live
     * booking or a live order. Messaging is the private channel where the two parties settle the
     * details of that job, not an open inbox any stranger can start (which is what it was: there was
     * no check at all, so every business was reachable by anyone).
     *
     * The OWNER is never gated: they must be able to reach a customer about their own job. An
     * existing thread also stays open, so a conversation is never cut off mid-way.
     */
    if (owner !== principal.userId) {
      const existing = await MessageThreadModel.exists({
        customer_id: threadCustomerId,
        business_id: businessId,
      });
      if (!existing) {
        const [booking, order] = await Promise.all([
          BookingModel.exists({
            customer_id: threadCustomerId,
            business_id: businessId,
            // Any booking that wasn't cancelled — including a completed or no-show one. A finished
            // job is exactly when follow-ups happen, and this mirrors the order rule below rather
            // than leaving bookings arbitrarily stricter.
            status: { $ne: 'cancelled' },
          }),
          OrderModel.exists({
            customer_id: threadCustomerId,
            business_id: businessId,
            status: { $ne: 'cancelled' },
          }),
        ]);
        if (!booking && !order) {
          throw ForbiddenError(
            'Book an appointment or place an order first — messaging opens once you do',
            ERROR_CODES.FORBIDDEN,
          );
        }
      }
    }
    const thread = await MessageThreadModel.findOneAndUpdate(
      { customer_id: threadCustomerId, business_id: businessId },
      { $setOnInsert: { customer_id: threadCustomerId, business_id: businessId } },
      { upsert: true, new: true },
    ).exec();
    return { id: String(thread._id), businessId, customerId: threadCustomerId };
  },

  async sendMessage(principal: Principal, threadId: string, body: string) {
    const { thread } = await loadParticipants(threadId);
    if (!isParticipant(principal, thread)) {
      throw ForbiddenError('Not a participant of this thread', ERROR_CODES.NOT_PARTICIPANT);
    }
    const clean = body.trim();
    const message = await MessageModel.create({
      thread_id: threadId,
      sender_user_id: principal.userId,
      body: clean,
    });
    await MessageThreadModel.findByIdAndUpdate(threadId, {
      $set: { last_message_at: new Date() },
    }).exec();

    const recipient =
      principal.userId === thread.customerId ? thread.businessOwnerId : thread.customerId;
    const payload = { id: String(message._id), threadId, senderId: principal.userId, body: clean };
    realtime.messageNew(threadId, payload);
    if (recipient) {
      notificationsService.notify(recipient, {
        category: 'message',
        title: 'New message',
        body: clean.slice(0, 120),
        data: { threadId },
      });
    }
    await publish('message.sent', { threadId, senderId: principal.userId });
    return payload;
  },

  /**
   * The inbox needs a name, a preview, and an unread count per thread — it cannot render a row
   * from ids alone, and it must not N+1 for them. Two batched reads cover the whole list:
   * business names, and each thread's newest message + unread tally.
   */
  async listThreads(principal: Principal) {
    const ownedBusinesses = await vendorsRepository.listBusinessesByOwner(principal.userId);
    const businessIds = ownedBusinesses.map((b) => String(b._id));
    const threads = await MessageThreadModel.find({
      $or: [{ customer_id: principal.userId }, { business_id: { $in: businessIds } }],
    })
      .sort({ last_message_at: -1 })
      .lean()
      .exec();
    if (threads.length === 0) return [];

    const threadIds = threads.map((t) => t._id);
    const [info, users, stats] = await Promise.all([
      businessInfoFor(threads.map((t) => t.business_id)),
      // Only threads where I'm the business need the customer's identity, but batching every
      // customer_id costs one read and keeps the mapping branch-free.
      userBriefFor(threads.map((t) => t.customer_id)),
      // Newest body + unread-for-me count, per thread, in one pass.
      MessageModel.aggregate<{ _id: unknown; lastBody: string; lastAt: Date; unread: number }>([
        { $match: { thread_id: { $in: threadIds } } },
        { $sort: { created_at: 1 } },
        {
          $group: {
            _id: '$thread_id',
            lastBody: { $last: '$body' },
            lastAt: { $last: '$created_at' },
            unread: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$sender_user_id', principal.userId] },
                      { $eq: ['$read_at', null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]).exec(),
    ]);
    const statById = new Map(stats.map((s) => [String(s._id), s]));

    // The counterparty is whoever ISN'T me: the business (when I'm the customer) or the customer
    // (when I own the business). Resolving it here is what stops the vendor from seeing their own
    // business name at the top of every thread. Presence is looked up for those counterparty users.
    const rows = threads.map((t) => {
      const side: 'customer' | 'business' = t.customer_id === principal.userId ? 'customer' : 'business';
      const biz = info.get(t.business_id);
      const businessName = biz?.name ?? 'Business';
      const cp =
        side === 'customer'
          ? { name: businessName, avatarUrl: biz?.logoUrl ?? null, userId: biz?.ownerId ?? null }
          : (() => {
              const u = users.get(t.customer_id);
              return { name: u?.name ?? 'Customer', avatarUrl: u?.photoUrl ?? null, userId: t.customer_id };
            })();
      return { t, side, businessName, cp };
    });

    const pres = await presence.lookup(rows.map((r) => r.cp.userId).filter((id): id is string => Boolean(id)));

    return rows.map(({ t, side, businessName, cp }) => {
      const stat = statById.get(String(t._id));
      const p = cp.userId ? pres.get(cp.userId) : undefined;
      return {
        id: String(t._id),
        customerId: t.customer_id,
        businessId: t.business_id,
        businessName,
        // Who the reader is actually talking to (name + avatar), plus their id for presence.
        counterpartyName: cp.name,
        counterpartyAvatarUrl: cp.avatarUrl,
        counterpartyId: cp.userId,
        counterpartyOnline: p?.online ?? false,
        counterpartyLastSeen: p?.lastSeen ?? null,
        // A thread with no messages yet is normal: tapping "Message" opens one before anything is
        // said. The inbox shows an empty preview rather than a broken row.
        lastMessage: stat?.lastBody ?? '',
        lastMessageAt: stat?.lastAt ?? t.last_message_at ?? t.created_at,
        unread: stat?.unread ?? 0,
        side,
      };
    });
  },

  async listMessages(
    principal: Principal,
    threadId: string,
    opts: { cursor?: string; limit: number },
  ): Promise<Page<unknown>> {
    const { thread } = await loadParticipants(threadId);
    if (!isParticipant(principal, thread)) {
      throw ForbiddenError('Not a participant of this thread', ERROR_CODES.NOT_PARTICIPANT);
    }
    const cursor = decodeCursor<{ createdAt: string; id: string }>(opts.cursor);
    const filter = cursor
      ? {
          thread_id: threadId,
          $or: [
            { created_at: { $gt: new Date(cursor.createdAt) } },
            { created_at: new Date(cursor.createdAt), _id: { $gt: cursor.id } },
          ],
        }
      : { thread_id: threadId };
    const docs = await MessageModel.find(filter)
      .sort({ created_at: 1, _id: 1 })
      .limit(opts.limit + 1)
      .lean()
      .exec();
    const items = docs.slice(0, opts.limit);
    const last = items[items.length - 1];
    const nextCursor =
      docs.length > opts.limit && last
        ? encodeCursor({ createdAt: (last.created_at as Date).toISOString(), id: String(last._id) })
        : null;
    return {
      items: items.map((m) => ({
        id: String(m._id),
        senderId: m.sender_user_id,
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
      nextCursor,
    };
  },

  async markRead(principal: Principal, threadId: string) {
    const { thread } = await loadParticipants(threadId);
    if (!isParticipant(principal, thread)) {
      throw ForbiddenError('Not a participant of this thread', ERROR_CODES.NOT_PARTICIPANT);
    }
    const res = await MessageModel.updateMany(
      { thread_id: threadId, sender_user_id: { $ne: principal.userId }, read_at: null },
      { $set: { read_at: new Date() } },
    ).exec();
    // Tell the OTHER participant's open thread that their messages were just read, so their bubbles
    // flip to "Seen" without a refetch. Only when something actually changed.
    if (res.modifiedCount > 0) {
      realtime.messageRead(threadId, {
        threadId,
        readerId: principal.userId,
        at: new Date().toISOString(),
      });
    }
    return { ok: true };
  },
};
