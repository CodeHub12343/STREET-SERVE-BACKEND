import { Schema, type InferSchemaType } from 'mongoose';

import { logger } from '../../config/logger';
import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';
import { writeAudit } from '../../shared/audit';
import {
  messagingProviderName,
  sendOutbound,
  type DeliveryOutcome,
} from '../../integrations/messaging';
import { UserModel } from '../identity/identity.model';
import { notificationsService } from './notifications.service';

/**
 * 7.1 — **contractual notices**, as distinct from notifications.
 *
 * ## The distinction, and why it needs its own module
 *
 * A notification is a courtesy: "your order is ready". If it is missed, the user checks the app.
 *
 * A **notice** is something a signed agreement says will be given. §37 termination, §38 expiry,
 * §49's payment reminders, §51 return, §53 completion — each is an obligation, and each has a
 * consequence attached to it (stock returns, an agreement escalates, ownership transfers). Sending
 * it only in-app means a user with push disabled receives nothing, and "it was in your inbox" is
 * not a defence when the disagreement is about whether they were told.
 *
 * So notices go out on **every channel at once** — in-app, email, SMS — and, critically, **the
 * attempt is recorded immutably**. In a dispute the question is never "did the code call notify?";
 * it is "what was sent, to which address, when, and did anything accept it". A row you can produce
 * answers that. A log line rotated out after 30 days does not.
 *
 * ## `delivered: false` is a first-class outcome
 *
 * The record stores what actually happened, including nothing happening. A notice with no channel
 * accepted is a compliance problem someone must act on — it is not something to hide behind an
 * optimistic return value. `undeliverable` (the user has neither an email nor a phone) is recorded
 * distinctly from `failed`, because those need different responses: one is a data problem, the
 * other is a provider problem.
 */

export const NOTICE_TYPES = [
  'consignment_expiry', // §38
  'consignment_terminated', // §37
  'rto_payment_reminder', // §49 — carries its own stage, including `late`
  'rto_completed', // §53
  'rto_return_confirmed', // §51
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

const NoticeDeliverySchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    notice_type: { type: String, enum: NOTICE_TYPES, required: true },
    /** The thing the notice is about — agreement id, checkout id — so it can be produced on demand. */
    entity_type: { type: String, required: true },
    entity_id: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    /** What was tried, and what happened. Empty when the user had no address at all. */
    channels: {
      type: [
        {
          _id: false,
          channel: { type: String, enum: ['in_app', 'email', 'sms'], required: true },
          delivered: { type: Boolean, required: true },
          provider: { type: String, default: null },
          provider_ref: { type: String, default: null },
          error: { type: String, default: null },
        },
      ],
      default: [],
    },
    /** True when at least one channel accepted it. The single question a dispute asks first. */
    delivered: { type: Boolean, required: true },
    /** No email and no phone — a data problem, not a provider problem. Recorded separately. */
    undeliverable: { type: Boolean, default: false },
    idempotency_key: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'notice_deliveries' },
);
NoticeDeliverySchema.index({ entity_type: 1, entity_id: 1, created_at: -1 });
NoticeDeliverySchema.index({ notice_type: 1, delivered: 1, created_at: -1 });
// Immutable: the record of what was sent is evidence. Editing it after the fact would defeat it.
NoticeDeliverySchema.plugin(immutablePlugin);

export type NoticeDeliveryDoc = InferSchemaType<typeof NoticeDeliverySchema>;
export const NoticeDeliveryModel = defineModel('NoticeDelivery', NoticeDeliverySchema);

export interface NoticeInput {
  userId: string;
  type: NoticeType;
  entityType: string;
  entityId: string;
  subject: string;
  body: string;
  /** In-app category, so the notice also lands in the bell like everything else. */
  category: string;
  data?: Record<string, unknown>;
  /** Stable per (notice, entity, stage) so a re-run of a sweep cannot notify twice. */
  idempotencyKey: string;
}

export const noticesService = {
  /**
   * Send a contractual notice on every available channel and record the attempt.
   *
   * Returns the delivery record. Callers on a sweep should keep going regardless of the result —
   * a consignment does not un-expire because an email bounced — but they should not report success
   * they did not get.
   */
  async send(input: NoticeInput): Promise<{ delivered: boolean; undeliverable: boolean }> {
    // Idempotent by construction: a duplicate key means this exact notice already went out.
    const already = await NoticeDeliveryModel.findOne({
      idempotency_key: input.idempotencyKey,
    }).lean();
    if (already) {
      return { delivered: already.delivered, undeliverable: Boolean(already.undeliverable) };
    }

    const user = await UserModel.findById(input.userId).select('email phone').lean();
    const to = { email: user?.email ?? null, phone: user?.phone ?? null };

    // In-app always, first: it is the channel that cannot fail for connectivity reasons, and it is
    // where the user will look after an email tells them to.
    notificationsService.notify(input.userId, {
      category: input.category,
      title: input.subject,
      body: input.body,
      ...(input.data ? { data: input.data } : {}),
    });

    const outbound: DeliveryOutcome[] =
      to.email || to.phone
        ? await sendOutbound({
            to,
            subject: input.subject,
            body: input.body,
            idempotencyKey: input.idempotencyKey,
          })
        : [];

    const undeliverable = !to.email && !to.phone;
    const channels = [
      { channel: 'in_app' as const, delivered: true, provider: 'realtime', provider_ref: null, error: null },
      ...outbound.map((o) => ({
        channel: o.channel,
        delivered: o.delivered,
        provider: messagingProviderName(),
        provider_ref: o.providerRef ?? null,
        error: o.error ?? null,
      })),
    ];
    const deliveredOutOfApp = outbound.some((o) => o.delivered);

    try {
      await NoticeDeliveryModel.create({
        user_id: input.userId,
        notice_type: input.type,
        entity_type: input.entityType,
        entity_id: input.entityId,
        subject: input.subject,
        body: input.body,
        channels,
        // In-app alone is NOT treated as delivered for a contractual notice. That is the whole
        // point of A-9: a user with push off and no email has not been reached, and recording that
        // as success would make the record useless in exactly the case it exists for.
        delivered: deliveredOutOfApp,
        undeliverable,
        idempotency_key: input.idempotencyKey,
      });
    } catch (err) {
      // A duplicate key here means a concurrent send won the race — which is the correct outcome.
      logger.warn({ err, key: input.idempotencyKey }, 'notice delivery record not written');
    }

    if (!deliveredOutOfApp) {
      // Loud, and auditable. Someone has to be able to find these.
      logger.warn(
        { userId: input.userId, type: input.type, entityId: input.entityId, undeliverable },
        undeliverable
          ? 'contractual notice has no deliverable channel — user has neither email nor phone'
          : 'contractual notice was not accepted by any outbound channel',
      );
      await writeAudit({
        action: 'notice.undelivered',
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: { userId: input.userId, noticeType: input.type, undeliverable },
      });
    }

    return { delivered: deliveredOutOfApp, undeliverable };
  },

  /** Every notice sent about one entity, newest first — what you produce in a dispute. */
  async listForEntity(entityType: string, entityId: string) {
    return NoticeDeliveryModel.find({ entity_type: entityType, entity_id: entityId })
      .sort({ created_at: -1 })
      .lean();
  },

  /**
   * Notices that reached nobody, for the ops queue. This is the report that makes the whole module
   * worth having: without it, undelivered notices are a fact nobody learns until a dispute.
   */
  async listUndelivered(sinceDays = 30) {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    return NoticeDeliveryModel.find({ delivered: false, created_at: { $gte: since } })
      .sort({ created_at: -1 })
      .limit(500)
      .lean();
  },
};
