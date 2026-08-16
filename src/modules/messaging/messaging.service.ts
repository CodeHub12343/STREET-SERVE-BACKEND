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
  /** Everyone allowed in, whichever kind of thread this is. */
  memberIds: string[];
}

/**
 * Membership, for either kind of thread.
 *
 * A `business` thread derives it the way it always did — the customer, plus whoever owns the
 * business, resolved live so a change of owner does not lock the new one out. A subject thread
 * (consignment, job) carries its members on the row, fixed when it opened.
 */
async function loadParticipants(threadId: string): Promise<{
  thread: ThreadParticipants;
  raw: { _id: unknown; customer_id: string | null; business_id: string | null };
}> {
  const thread = await MessageThreadModel.findById(threadId).lean().exec();
  if (!thread) throw NotFoundError('Thread not found');

  const owner = thread.business_id
    ? await vendorsService.getBusinessOwner(thread.business_id)
    : null;
  const memberIds = thread.business_id
    ? [thread.customer_id, owner].filter((x): x is string => Boolean(x))
    : (thread.participant_user_ids ?? []);

  return {
    raw: {
      _id: thread._id,
      customer_id: thread.customer_id ?? null,
      business_id: thread.business_id ?? null,
    },
    thread: {
      customerId: thread.customer_id ?? '',
      businessId: thread.business_id ?? '',
      businessOwnerId: owner,
      memberIds,
    },
  };
}

function isParticipant(principal: Principal, p: ThreadParticipants): boolean {
  // One list, so a consignment or job thread is authorised by exactly the same check as a
  // customer↔business one — the whole point of generalising rather than forking.
  return p.memberIds.includes(principal.userId);
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

/**
 * Who may talk about a consignment checkout: the seller holding the stock, and the person who owns
 * the hub it came from. Read from the checkout rather than passed in, so a caller cannot name
 * themselves into someone else's conversation.
 */
/**
 * Who may talk about a delivery: the driver carrying it and the customer waiting for it.
 *
 * Only once a driver has ACCEPTED — before that there is no driver, and opening a channel to an
 * unassigned delivery would mean messaging whoever happens to take it next. The exact address is
 * already withheld until acceptance for the same reason.
 *
 * For coordination, not price. The customer paid at checkout and the driver was offered a fixed
 * amount computed from the distance; a channel that could change either would turn "where shall I
 * leave it?" into a negotiation with someone whose food is going cold.
 */
/**
 * Who may talk about a Rent-to-Own agreement: the customer paying it off and whoever owns the
 * business they are paying.
 *
 * The longest-running relationship in the product — twelve instalments over a year — and until now
 * the only one with no way to say anything. §50 gives the seller remedies (more time, a part
 * payment, a catch-up plan, a pause) and the dashboard tells a customer in Grace to "message the
 * seller", which was an instruction with nothing behind it. This is what that copy meant.
 *
 * Deliberately open for the WHOLE life of the agreement, including after it completes or is
 * cancelled: a dispute about a paid-off item, or about a return, arrives after the money stops.
 */
async function participantsForRtoAgreement(
  agreementId: string,
): Promise<{ userIds: string[]; title: string } | null> {
  const { RtoAgreementModel } = await import('../rto/rto.model');
  const agreement = await RtoAgreementModel.findById(agreementId).lean().exec();
  if (!agreement) return null;
  const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
  if (!owner) return null;
  return {
    userIds: [...new Set([agreement.customer_id, owner])],
    title: agreement.product_name ?? 'Rent to own',
  };
}

async function participantsForDelivery(
  deliveryId: string,
): Promise<{ userIds: string[]; title: string } | null> {
  const { DeliveryRequestModel } = await import('../delivery/delivery.model');
  const delivery = await DeliveryRequestModel.findById(deliveryId).lean().exec();
  if (!delivery?.driver_id) return null;
  return {
    userIds: [...new Set([delivery.driver_id, delivery.customer_id])],
    title: 'Delivery',
  };
}

async function participantsForCheckout(
  checkoutId: string,
): Promise<{ userIds: string[]; title: string } | null> {
  const { InventoryCheckoutModel, HubModel } = await import('../consignment/consignment.model');
  const checkout = await InventoryCheckoutModel.findById(checkoutId).lean().exec();
  if (!checkout) return null;
  const hub = await HubModel.findById(checkout.hub_id).lean().exec();
  if (!hub?.owner_user_id) return null;

  return {
    // Deduped: a hub owner selling their own stock is one person, not two participants.
    userIds: [...new Set([checkout.seller_id, hub.owner_user_id])],
    title: 'Consignment',
  };
}

/**
 * Who may talk about a job: the person who posted it and the person doing it.
 *
 * Keyed on the APPLICATION rather than the posting, because a posting can have many applicants and
 * one shared thread across all of them would leak every applicant to every other. An `applied` row
 * counts — questions before accepting are exactly when a worker needs to ask them — but the
 * conversation is still one-to-one.
 */
async function participantsForEngagement(
  applicationId: string,
): Promise<{ userIds: string[]; title: string } | null> {
  const { JobApplicationModel, JobPostingModel } = await import('../jobs/jobs.model');
  const application = await JobApplicationModel.findById(applicationId).lean().exec();
  if (!application) return null;
  const posting = await JobPostingModel.findById(application.job_id).lean().exec();
  if (!posting) return null;

  return {
    userIds: [...new Set([posting.poster_user_id, application.applicant_id])],
    title: posting.title ?? 'Job',
  };
}

export const messagingService = {
  /**
   * Start (or reopen) the scoped thread between a customer and a business. Without `customerId`
   * the caller IS the customer. With it, the caller must own the business — this is how a vendor
   * opens the conversation with a customer who booked/ordered, instead of waiting to be messaged.
   */
  /**
   * ═══ Open the thread for a piece of work. ═══
   *
   * The subject is also the access rule. `startThread` refuses to open a customer↔business thread
   * without a live booking or order, because messaging is where two parties settle a job they are
   * actually doing rather than an open inbox any stranger can start. A consignment checkout and a
   * job engagement are that same proof, so membership is read from the record itself: whoever is on
   * it can talk, and nobody else can — there is no "invite" and no way to name your own
   * counterparty.
   *
   * Idempotent by construction. The thread is keyed on the subject, so both sides tapping "Message"
   * at the same moment land in the same conversation instead of creating two.
   */
  async openForSubject(
    principal: Principal,
    subjectType: 'consignment' | 'job' | 'delivery' | 'rto',
    subjectRefId: string,
  ) {
    const participants =
      subjectType === 'consignment'
        ? await participantsForCheckout(subjectRefId)
        : subjectType === 'delivery'
          ? await participantsForDelivery(subjectRefId)
          : subjectType === 'rto'
            ? await participantsForRtoAgreement(subjectRefId)
            : await participantsForEngagement(subjectRefId);

    if (!participants) throw NotFoundError('That work no longer exists');
    if (!participants.userIds.includes(principal.userId)) {
      throw ForbiddenError(
        'Only the two people working on this can message about it',
        ERROR_CODES.NOT_PARTICIPANT,
      );
    }

    const thread = await MessageThreadModel.findOneAndUpdate(
      { subject_type: subjectType, subject_ref_id: subjectRefId },
      {
        $setOnInsert: {
          subject_type: subjectType,
          subject_ref_id: subjectRefId,
          participant_user_ids: participants.userIds,
        },
      },
      { upsert: true, new: true },
    ).exec();

    return {
      id: String(thread._id),
      subjectType,
      subjectRefId,
      title: participants.title,
    };
  },

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
    /**
     * ONE inbox, whatever the thread is about. The third clause picks up consignment and job
     * threads, which carry their members on the row rather than deriving them from a business —
     * so a hub owner, a street seller and a gig worker all read from the same list, with the same
     * unread count and the same socket.
     */
    const threads = await MessageThreadModel.find({
      $or: [
        { customer_id: principal.userId },
        { business_id: { $in: businessIds } },
        { participant_user_ids: principal.userId },
      ],
    })
      .sort({ last_message_at: -1 })
      .lean()
      .exec();
    if (threads.length === 0) return [];

    const threadIds = threads.map((t) => t._id);
    const [info, users, stats] = await Promise.all([
      businessInfoFor(threads.map((t) => t.business_id).filter((x): x is string => Boolean(x))),
      // Only threads where I'm the business need the customer's identity, but batching every
      // customer_id costs one read and keeps the mapping branch-free.
      userBriefFor(threads.map((t) => t.customer_id).filter((x): x is string => Boolean(x))),
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
    /**
     * A subject thread has no business and no customer — just the other member. Resolved the same
     * way regardless: the counterparty is whoever is not me, which is what stops anyone seeing
     * their own name at the top of every thread.
     */
    const otherMemberIds = threads
      .filter((t) => !t.business_id)
      .map((t) => (t.participant_user_ids ?? []).find((id) => id !== principal.userId))
      .filter((id): id is string => Boolean(id));
    const otherMembers = await userBriefFor(otherMemberIds);

    const rows = threads.map((t) => {
      if (!t.business_id) {
        const otherId = (t.participant_user_ids ?? []).find((id) => id !== principal.userId) ?? null;
        const u = otherId ? otherMembers.get(otherId) : undefined;
        return {
          t,
          side: 'business' as const,
          // Labelled by what the conversation is ABOUT, since there is no business behind it.
          businessName:
            t.subject_type === 'consignment'
              ? 'Consignment'
              : t.subject_type === 'delivery'
                ? 'Delivery'
                : t.subject_type === 'rto'
                  ? 'Rent to own'
                  : 'Job',
          cp: { name: u?.name ?? 'Member', avatarUrl: u?.photoUrl ?? null, userId: otherId },
        };
      }
      const side: 'customer' | 'business' = t.customer_id === principal.userId ? 'customer' : 'business';
      const biz = info.get(t.business_id);
      const businessName = biz?.name ?? 'Business';
      const cp =
        side === 'customer'
          ? { name: businessName, avatarUrl: biz?.logoUrl ?? null, userId: biz?.ownerId ?? null }
          : (() => {
              const u = users.get(t.customer_id ?? '');
              return { name: u?.name ?? 'Customer', avatarUrl: u?.photoUrl ?? null, userId: t.customer_id ?? null };
            })();
      return { t, side, businessName, cp };
    });

    const pres = await presence.lookup(rows.map((r) => r.cp.userId).filter((id): id is string => Boolean(id)));

    return rows.map(({ t, side, businessName, cp }) => {
      const stat = statById.get(String(t._id));
      const p = cp.userId ? pres.get(cp.userId) : undefined;
      return {
        id: String(t._id),
        customerId: t.customer_id ?? null,
        businessId: t.business_id ?? null,
        /** What this conversation is about, so the client can route and label it. */
        subjectType: t.subject_type ?? 'business',
        subjectRefId: t.subject_ref_id ?? null,
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
