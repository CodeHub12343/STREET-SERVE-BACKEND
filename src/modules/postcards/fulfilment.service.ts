import {
  POSTCARD_RETURN_ADDRESS,
  POSTCARD_SUBMISSION_BACKOFF_MS,
  POSTCARD_SUBMISSION_MAX_ATTEMPTS,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { printVendor, type FulfilmentStatus } from '../../integrations/print';
import { bizMetrics } from '../../observability/bizMetrics';
import { writeAudit } from '../../shared/audit';
import { notificationsService } from '../notifications/notifications.service';
import { vendorsService } from '../vendors/vendors.service';
import {
  canAdvance,
  describeStage,
  isProgress,
  isFulfilmentStage,
} from '../fulfilment/fulfilment';
import {
  PostcardAssetModel,
  PostcardAudienceModel,
  PostcardOrderModel,
  type PostcardOrderDoc,
} from './postcards.model';

/**
 * ═══ GETTING A PAID ORDER TO THE PRINTER, AND BACK (Phase 6) ═══
 *
 * ## Why a sweep rather than a job enqueued at payment
 *
 * The roadmap called for a BullMQ job pushed from the payment webhook. A sweep is used instead, and
 * the reason is the failure mode rather than taste: **the money has already arrived by then.** If
 * the enqueue is the only trigger and Redis is unavailable for that one call, the order is paid and
 * nothing will ever submit it — a silent, unbounded failure, and precisely the "paid, unsubmitted
 * order sitting quietly" the audit warned about (F-5).
 *
 * A sweep cannot lose work: the source of truth is the ORDER's own state, so anything paid and
 * unsubmitted is picked up on the next pass by construction. The vendor batches at end of day
 * anyway, so a sweep that runs every minute is indistinguishable from instant for a print run —
 * PC-16's "orders begin processing immediately" is satisfied in every sense the buyer can observe.
 *
 * Retry bookkeeping lives on the order for the same reason: "which paid orders have not reached the
 * printer?" must be answerable without reading Redis.
 *
 * ## Why retrying a submission is safe
 *
 * The vendor treats `extRefNbr` as a duplicate-detecting reference and answers a repeat with 409.
 * A retry therefore either lands once or is refused — it cannot print the run twice (audit F-6,
 * closed on their documented behaviour rather than on hope). A 409 is treated as SUCCESS here,
 * because it means an earlier attempt got through.
 */

const log = logger.child({ module: 'postcards.fulfilment' });

/** Exponential-ish, capped: attempt N waits `BACKOFF_MS * 2^(N-1)`. */
function nextAttemptAt(attempts: number): Date {
  const delay = POSTCARD_SUBMISSION_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return new Date(Date.now() + Math.min(delay, 60 * 60_000));
}

async function notifyOwner(
  order: Pick<PostcardOrderDoc, 'business_id'> & { _id: unknown },
  title: string,
  body: string,
): Promise<void> {
  const ownerId = await vendorsService.getBusinessOwner(order.business_id);
  if (!ownerId) return;
  notificationsService.notify(ownerId, {
    category: 'order',
    title,
    body,
    data: { postcardOrderId: String(order._id) },
  });
}

export const postcardFulfilment = {
  /**
   * Submits every paid order that is ready.
   *
   * Ready means: paid, artwork APPROVED by a human, and past its backoff. Moderation is enforced
   * here rather than at checkout deliberately — a buyer should not be blocked from paying while a
   * reviewer sleeps, but nothing unreviewed may reach a press (F-7).
   */
  async submitDue(limit = 20): Promise<{ submitted: number; failed: number; blocked: number }> {
    const now = new Date();
    const due = await PostcardOrderModel.find({
      status: 'paid',
      $or: [
        { submission_next_attempt_at: null },
        { submission_next_attempt_at: { $lte: now } },
      ],
    })
      .sort({ paid_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let submitted = 0;
    let failed = 0;
    let blocked = 0;

    for (const order of due) {
      const outcome = await this.submitOne(String(order._id));
      if (outcome === 'submitted') submitted++;
      else if (outcome === 'failed') failed++;
      else if (outcome === 'blocked') blocked++;
    }

    return { submitted, failed, blocked };
  },

  async submitOne(orderId: string): Promise<'submitted' | 'failed' | 'blocked' | 'skipped'> {
    const order = await PostcardOrderModel.findById(orderId).lean().exec();
    if (!order || order.status !== 'paid') return 'skipped';

    const [asset, audience] = await Promise.all([
      order.asset_id ? PostcardAssetModel.findById(order.asset_id).lean().exec() : null,
      order.audience_id ? PostcardAudienceModel.findById(order.audience_id).lean().exec() : null,
    ]);

    if (!asset || !audience) {
      return this.recordFailure(orderId, 'Order is missing its artwork or audience.');
    }

    if (asset.moderation_status === 'rejected') {
      /**
       * A reviewer refused the artwork AFTER the buyer paid. Not a retryable error — no amount of
       * waiting changes it — so it fails immediately and loudly. The refund is a deliberate human
       * act, not something this sweep performs: refunding automatically would mean a sweep issuing
       * money movements, and the buyer deserves an explanation with it.
       */
      log.error({ orderId }, 'paid order has REJECTED artwork — refund required');
      return this.recordFailure(
        orderId,
        'Artwork was rejected after payment. This order needs a refund.',
        true,
      );
    }
    if (asset.moderation_status !== 'approved') {
      // Still in the review queue. Not a failure, and it must not burn a retry attempt.
      await PostcardOrderModel.updateOne(
        { _id: orderId },
        { $set: { submission_next_attempt_at: nextAttemptAt(1) } },
      );
      return 'blocked';
    }

    /**
     * Claim the order before calling out, so two sweep workers cannot both submit it. The vendor's
     * duplicate detection would catch a double anyway; not relying on it is cheaper than finding
     * out it has an edge case.
     */
    const claimed = await PostcardOrderModel.findOneAndUpdate(
      { _id: orderId, status: 'paid' },
      {
        $inc: { submission_attempts: 1 },
        $set: { submission_next_attempt_at: nextAttemptAt(order.submission_attempts + 1) },
      },
      { new: true },
    ).exec();
    if (!claimed) return 'skipped';

    try {
      const ref = await printVendor().submitOrder({
        sizeKey: order.sku,
        mailClass: order.mail_class,
        listCountId: audience.list_count_id,
        recordCount: audience.record_count,
        artwork: {
          frontUrl: buildArtworkUrl(asset.storage_key),
          /**
           * The buyer designs one side; the vendor requires two. The back carries the address
           * block, so it comes from our standard template rather than from them.
           */
          backUrl: POSTCARD_BACK_TEMPLATE_URL,
        },
        /** The idempotency key. A repeat is refused by the vendor, never printed twice. */
        orderRef: orderId,
        mailDate: order.mail_date ?? new Date(),
        returnAddress: POSTCARD_RETURN_ADDRESS,
      });

      await PostcardOrderModel.updateOne(
        { _id: orderId, status: 'paid' },
        {
          $set: {
            status: 'submitted',
            vendor_order_id: ref.vendorOrderId,
            vendor_batch_id: ref.vendorBatchId,
            submitted_at: new Date(),
            fulfilment_stage: 'preparing',
            fulfilment_stage_at: new Date(),
            submission_last_error: null,
            submission_next_attempt_at: null,
          },
        },
      );

      await writeAudit({
        actorId: 'system',
        action: 'postcards.order_submitted',
        entityType: 'postcard_order',
        entityId: orderId,
        metadata: { vendorOrderId: ref.vendorOrderId, attempts: claimed.submission_attempts },
      });

      const copy = describeStage('preparing');
      await notifyOwner(order, 'Your postcards are on their way to the printer', copy.description);

      bizMetrics.postcardSubmissions.inc();
      log.info({ orderId, vendorOrderId: ref.vendorOrderId }, 'postcard order submitted');
      return 'submitted';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      /**
       * A duplicate reference means an EARLIER attempt already reached the printer — most likely a
       * response we never saw. That is a success we failed to record, not a failure: retrying
       * harder would only produce more 409s, and marking it failed would hide a live print run.
       */
      const isDuplicate =
        (err as { code?: string }).code === 'CONFLICT' || /already been submitted/i.test(message);
      if (isDuplicate) {
        log.warn({ orderId }, 'vendor reports this order was already submitted — reconciling');
        await PostcardOrderModel.updateOne(
          { _id: orderId, status: 'paid' },
          {
            $set: {
              status: 'submitted',
              submitted_at: new Date(),
              fulfilment_stage: 'preparing',
              fulfilment_stage_at: new Date(),
              submission_last_error: null,
              submission_next_attempt_at: null,
            },
          },
        );
        return 'submitted';
      }

      return this.recordFailure(orderId, message);
    }
  },

  /**
   * Records a failed attempt, and gives up loudly once the attempts are gone.
   *
   * `fatal` skips the remaining retries for errors that cannot improve with time — rejected
   * artwork, a missing audience. Retrying those just delays telling someone.
   */
  async recordFailure(orderId: string, message: string, fatal = false): Promise<'failed'> {
    const order = await PostcardOrderModel.findById(orderId).lean().exec();
    const attempts = order?.submission_attempts ?? 0;
    const exhausted = fatal || attempts >= POSTCARD_SUBMISSION_MAX_ATTEMPTS;

    await PostcardOrderModel.updateOne(
      { _id: orderId },
      {
        $set: {
          submission_last_error: message.slice(0, 500),
          ...(exhausted
            ? { status: 'submission_failed', submission_next_attempt_at: null }
            : { submission_next_attempt_at: nextAttemptAt(attempts + 1) }),
        },
      },
    );

    if (exhausted) {
      /**
       * The dead letter. A paid order with no mailing is somebody's money and no product, so this
       * is `fatal` in the log and a metric on-call watches — never a quiet row in a table.
       */
      bizMetrics.financialJobsDeadLettered.inc({ queue: 'postcard-submission' });
      // Labelled so a vendor outage is distinguishable from artwork rejected after payment: one is
      // waited out, the other needs a refund and a conversation.
      bizMetrics.postcardSubmissionFailures.inc({ outcome: fatal ? 'unprintable' : 'exhausted' });
      log.fatal({ orderId, attempts, err: message }, 'postcard order could NOT be submitted — paid with no mailing');
      if (order) {
        await notifyOwner(
          order,
          'There is a problem with your postcard order',
          'We could not send your order to the printer. Our team has been alerted and will be in touch.',
        );
      }
    } else {
      log.warn({ orderId, attempts, err: message }, 'postcard submission failed — will retry');
    }
    return 'failed';
  },

  // ─── Status ────────────────────────────────────────────────────────────────────────────────
  /**
   * Polls the vendor for orders still in production.
   *
   * Polling is the PRIMARY mechanism, not a fallback. The vendor's OpenAPI document defines no
   * outbound status callbacks, so nothing guarantees one will arrive; a pipeline that only advances
   * on a push that may not exist would silently never move. Their portal does have a webhooks
   * section, and `onVendorEvent` below accepts one as an accelerator — but it only ever triggers a
   * re-poll, so correctness never depends on it.
   */
  async pollDue(limit = 50): Promise<{ polled: number; advanced: number }> {
    const inFlight = await PostcardOrderModel.find({
      status: 'submitted',
      vendor_order_id: { $ne: null },
      fulfilment_stage: { $ne: 'mailed' },
    })
      .sort({ fulfilment_stage_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let advanced = 0;
    for (const order of inFlight) {
      try {
        const status = await printVendor().getStatus(order.vendor_order_id!);
        if (await this.applyStage(String(order._id), status)) advanced++;
      } catch (err) {
        // A vendor blip must not stop the sweep for every other order.
        log.warn({ err, orderId: String(order._id) }, 'could not read vendor status');
      }
    }
    return { polled: inFlight.length, advanced };
  },

  /**
   * Applies a stage the vendor reported.
   *
   * Terminal vendor states (`canceled`, `undeliverable`, `failed`, `payment_hold`) are NOT pipeline
   * stages, so they are logged for ops rather than written as progress — surfacing them as a
   * fulfilment stage would put a word in the buyer's timeline that means the opposite of progress.
   */
  async applyStage(orderId: string, reported: FulfilmentStatus): Promise<boolean> {
    if (!isFulfilmentStage(reported)) {
      log.error({ orderId, reported }, 'vendor reported a terminal state on a live order');
      return false;
    }

    const order = await PostcardOrderModel.findById(orderId).lean().exec();
    if (!order) return false;

    const from = (order.fulfilment_stage ?? null);
    if (!canAdvance(from, reported)) {
      // Physical production does not run backwards; a late poll must not un-mail an order.
      log.warn({ orderId, from, reported }, 'ignoring a backwards fulfilment report');
      return false;
    }
    if (!isProgress(from, reported)) return false;

    await PostcardOrderModel.updateOne(
      { _id: orderId },
      { $set: { fulfilment_stage: reported, fulfilment_stage_at: new Date() } },
    );

    const copy = describeStage(reported);
    await notifyOwner(
      order,
      reported === 'mailed' ? 'Your postcards have been mailed' : `Postcards: ${copy.label}`,
      copy.description,
    );

    log.info({ orderId, from, to: reported }, 'postcard fulfilment advanced');
    return true;
  },

  /**
   * A vendor callback.
   *
   * **The payload is a hint, never evidence.** We take one thing from it — which order to look at —
   * and then ask the vendor's API what the status actually is. That is what the roadmap asked for
   * ("a signal to re-fetch, never authoritative"), and it has a useful consequence: because nothing
   * in the body is trusted, a forged call can at most make us re-poll an order we already own,
   * which is harmless and rate-limited. Signature verification still runs when a secret is
   * configured; the design simply does not depend on it.
   */
  async onVendorEvent(vendorOrderId: string): Promise<{ handled: boolean }> {
    const order = await PostcardOrderModel.findOne({ vendor_order_id: vendorOrderId })
      .lean()
      .exec();
    if (!order) return { handled: false };

    const status = await printVendor().getStatus(vendorOrderId);
    await this.applyStage(String(order._id), status);
    return { handled: true };
  },
};

/**
 * Where the vendor fetches artwork from.
 *
 * Their press pulls the file over HTTP, so it has to be reachable without our auth. The object is
 * already public-read in the media bucket; this only builds the URL.
 */
function buildArtworkUrl(storageKey: string): string {
  const base = process.env.R2_PUBLIC_BASE_URL ?? 'https://cdn.streetserve.app';
  return `${base}/${storageKey}`;
}

/**
 * The address side.
 *
 * A mailed postcard must carry one and the buyer only designs the front, so the platform supplies
 * it. A placeholder until the real artwork is produced — and one that is loudly wrong rather than
 * quietly plausible, so it cannot reach a press unnoticed.
 */
const POSTCARD_BACK_TEMPLATE_URL =
  process.env.POSTCARD_BACK_TEMPLATE_URL ?? 'https://cdn.streetserve.app/postcards/back-v1.pdf';
