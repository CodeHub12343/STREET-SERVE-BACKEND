import { POSTCARD_PRODUCTS, POSTCARD_TEMPLATES_URL } from '../../config/constants';
import { printVendor, type AudienceRequest, type MailClass } from '../../integrations/print';
import { bizMetrics } from '../../observability/bizMetrics';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { feeService } from '../payments/fees';
import { vendorsService } from '../vendors/vendors.service';
import type { PostcardAudienceDoc, PostcardOrderDoc } from './postcards.model';
import {
  assertOrderable,
  findProduct,
  isQuoteExpired,
  priceOrder,
  quoteExpiresAt,
} from './postcards.pricing';
import { prepressSpecFor } from './prepress.rules';
import { pilotService } from './pilot.service';
import { describeStage, isFulfilmentStage } from '../fulfilment/fulfilment';
import { PostcardAssetModel, PostcardOrderModel } from './postcards.model';
import { computeTaxCents, postcardsMoney } from './postcards.money';
import { stripe } from '../../integrations/stripe';
import { postcardsRepository as repo } from './postcards.repository';

/**
 * ═══ POSTCARD MARKETING — order building and quoting (ADR-007) ═══
 *
 * Phase 3: an order can be built and priced end to end. **No money moves here.** Payment,
 * submission and fulfilment arrive in later phases, and the status enum deliberately stops short of
 * them (`postcards.model.ts`).
 *
 * Two rules do most of the work:
 *
 *  1. **The vendor is authoritative for counts and prices.** We never compute a deliverable count
 *     or invent a rate; a number we derived would disagree with their invoice after the buyer had
 *     already been quoted ours (audit F-9).
 *  2. **A quote is a snapshot with an expiry.** The vendor publishes prices but does not reserve
 *     them, so a quote honoured after it lapses is a loss taken silently (audit F-8). Anything that
 *     changes what is being bought drops the order back to `draft` rather than leaving a stale
 *     price attached to a different order.
 */

async function ensureOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

function shapeAudience(a: PostcardAudienceDoc & { _id: unknown }) {
  return {
    id: String(a._id),
    selectionType: a.selection_type,
    selectionKeys: a.selection_keys,
    radius: a.radius ?? null,
    listType: a.list_type,
    /** Deliverable addresses, per the vendor. */
    recordCount: a.record_count,
    breakdown: a.breakdown,
    resolvedAt: a.resolved_at,
    /**
     * Stated so the client never has to wonder. The vendor holds the list; this object is an id and
     * a count, and no recipient name or address exists anywhere in it (ADR-007 §6).
     */
    containsRecipientData: false,
  };
}

function shapeOrder(o: PostcardOrderDoc & { _id: unknown }, now: Date = new Date()) {
  const expired = o.status === 'quoted' && isQuoteExpired(o.quote_expires_at, now);
  return {
    id: String(o._id),
    businessId: o.business_id,
    status: o.status,
    sku: o.sku,
    mailClass: o.mail_class,
    audienceId: o.audience_id,
    assetId: o.asset_id,
    quantity: o.quantity,
    /**
     * The price is reported as a snapshot plus a liveness flag rather than being silently recomputed
     * or hidden once stale — the buyer should see what they were quoted AND that it needs redoing.
     */
    price:
      o.total_cents === null
        ? null
        : {
            vendorUnitCostCents: o.vendor_unit_cost_cents,
            vendorCostCents: o.vendor_cost_cents,
            marginCents: o.margin_cents,
            totalCents: o.total_cents,
            quotedAt: o.quoted_at,
            expiresAt: o.quote_expires_at,
            isExpired: expired,
          },
    /**
     * Reported separately from `price` because it is what was CHARGED, not what was quoted. The
     * two differ by tax, and conflating them would hide the difference at exactly the moment a
     * buyer is checking their receipt.
     */
    payment:
      o.charged_cents === null
        ? null
        : {
            taxCents: o.tax_cents ?? 0,
            chargedCents: o.charged_cents,
            paidAt: o.paid_at,
            failureReason: o.payment_failure_reason,
            refundedAt: o.refunded_at,
            refundReason: o.refund_reason,
          },
    /**
     * Where the physical run has got to. Separate from `status` because the order's lifecycle with
     * us ends at `submitted` while the pipeline keeps moving inside the vendor's factory.
     *
     * `stage: null` on a submitted order means "handed over, nothing reported yet" — not "stuck".
     */
    fulfilment:
      o.status === 'submitted' || o.fulfilment_stage
        ? {
            stage: o.fulfilment_stage,
            stageAt: o.fulfilment_stage_at,
            ...(isFulfilmentStage(o.fulfilment_stage)
              ? describeStage(o.fulfilment_stage)
              : { label: 'Submitted', description: 'Your order is with the printer.' }),
            /** Shown to the buyer so support conversations have a shared reference. */
            vendorOrderId: o.vendor_order_id,
            submittedAt: o.submitted_at,
          }
        : null,
    /**
     * Surfaced rather than hidden. A paid order that could not reach the printer is the buyer's
     * money with nothing to show for it, and they should see that before they chase us.
     */
    submissionProblem:
      o.status === 'submission_failed'
        ? { message: o.submission_last_error, attempts: o.submission_attempts }
        : null,
    mailDate: o.mail_date,
    cancelledReason: o.cancelled_reason,
    createdAt: (o as { created_at?: Date }).created_at ?? null,
  };
}

export const postcardsService = {
  /** The catalogue a buyer can order from. Public: it is a price list, not a secret. */
  products() {
    return POSTCARD_PRODUCTS.filter((p) => p.active);
  },

  /**
   * Exact artwork requirements for a product (4.4).
   *
   * This is the "template pack", and it is numbers plus a link rather than files we generated.
   * PostcardMania publishes press-ready templates for their own equipment; shipping our own would
   * mean encoding a bleed we have not confirmed with them, and artwork built to a template that
   * disagrees with the press is worse than artwork built to none. Designers get the exact pixel
   * and inch figures, everyone else gets the vendor's own downloads.
   */
  artworkSpec(sku: string) {
    const product = findProduct(sku);
    if (!product) throw ValidationError('That postcard size is not available.');
    return {
      sku: product.sku,
      label: product.label,
      /** The buyer designs one side; the address side is composed by the vendor. */
      designedSides: product.designedSides,
      ...prepressSpecFor(product),
      templatesUrl: POSTCARD_TEMPLATES_URL,
    };
  },

  /** Vendor list types (resident/occupant and friends). Their catalogue, fetched live. */
  async listTypes() {
    return printVendor().listTypes();
  },

  // ─── Audiences ──────────────────────────────────────────────────────────────────────────────
  /**
   * Resolves an area to a counted, orderable audience.
   *
   * The count comes back from the vendor along with a handle we replay at order time. Crucially the
   * ADDRESSES stay with them — see ADR-007 §6 for why the alternative shape their API offers is
   * deliberately unused.
   */
  async createAudience(
    principal: Principal,
    businessId: string,
    input: AudienceRequest,
  ): Promise<ReturnType<typeof shapeAudience>> {
    await ensureOwner(principal, businessId);

    if (input.type === 'radius') {
      if (!input.radius) throw ValidationError('A radius needs a centre address.');
      if (input.radius.miles <= 0) throw ValidationError('A radius must be greater than zero.');
    } else if (!input.keys?.length) {
      throw ValidationError('Choose at least one area to mail to.');
    }

    const count = await printVendor().createAudienceCount(input);
    if (count.recordCount <= 0) {
      // Better to say so now than to let someone build an order that cannot be mailed.
      throw ValidationError('No deliverable addresses were found for that area.');
    }

    const doc = await repo.createAudience({
      business_id: businessId,
      created_by: principal.userId,
      selection_type: input.type,
      selection_keys: input.keys ?? [],
      radius: input.radius ?? null,
      list_type: input.listType,
      list_count_id: count.listCountId,
      record_count: count.recordCount,
      breakdown: count.breakdown,
      resolved_at: new Date(),
    });

    return shapeAudience(doc.toObject() as PostcardAudienceDoc & { _id: unknown });
  },

  // ─── Orders ─────────────────────────────────────────────────────────────────────────────────
  async createOrder(
    principal: Principal,
    businessId: string,
    input: { sku: string; mailClass: MailClass },
  ) {
    await ensureOwner(principal, businessId);
    /**
     * Phase 8.1 — the pilot gate. Enforced here rather than only on the route, because the next
     * person to add an endpoint will not know a route guard was load-bearing.
     */
    await pilotService.assertMayOrder(businessId);

    const product = findProduct(input.sku);
    if (!product) throw ValidationError('That postcard size is not available.');
    if (!product.mailClasses.includes(input.mailClass)) {
      throw ValidationError(
        `${product.label} cannot be mailed ${input.mailClass === 'standard' ? 'Standard' : 'First Class'}.`,
      );
    }

    const doc = await repo.createOrder({
      business_id: businessId,
      created_by: principal.userId,
      sku: product.sku,
      mail_class: input.mailClass,
      status: 'draft',
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.order_created',
      entityType: 'postcard_order',
      entityId: String(doc._id),
    });

    return shapeOrder(doc.toObject() as PostcardOrderDoc & { _id: unknown });
  },

  async getOrder(principal: Principal, orderId: string) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);
    return shapeOrder(order as PostcardOrderDoc & { _id: unknown });
  },

  async listOrders(principal: Principal, businessId: string, page: number, perPage: number) {
    await ensureOwner(principal, businessId);
    const [rows, total] = await Promise.all([
      repo.listOrdersForBusiness(businessId, perPage, (page - 1) * perPage),
      repo.countOrdersForBusiness(businessId),
    ]);
    return {
      results: rows.map((r) => shapeOrder(r as PostcardOrderDoc & { _id: unknown })),
      total,
    };
  },

  /**
   * Chooses what is being bought: the area and how many pieces.
   *
   * **Any change here drops the order back to `draft` and discards the price.** A quantity or area
   * change makes the previous quote a price for a different order, and carrying it forward is how a
   * buyer ends up charged for something they did not agree to.
   */
  async configureOrder(
    principal: Principal,
    orderId: string,
    input: { audienceId?: string; assetId?: string; quantity?: number; mailDate?: Date },
  ) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);

    const product = findProduct(order.sku);
    if (!product) throw ValidationError('That postcard size is no longer available.');

    const patch: Record<string, unknown> = {};

    if (input.audienceId !== undefined) {
      const audience = await repo.findAudience(input.audienceId);
      if (!audience) throw NotFoundError('Audience not found');
      if (audience.business_id !== order.business_id) {
        // Another business's audience is not merely wrong, it is a cross-tenant read.
        throw ForbiddenError('That audience belongs to another business');
      }
      patch.audience_id = String(audience._id);
      /**
       * Quantity defaults to the whole area. Buying a fraction of a resolved list is a vendor
       * capability we are not exposing yet, and silently leaving quantity unset after choosing an
       * area would strand the order one invisible step from being quotable.
       */
      patch.quantity = audience.record_count;
    }

    if (input.quantity !== undefined) {
      assertOrderable(product, order.mail_class as MailClass, input.quantity);
      const audienceId = (patch.audience_id as string | undefined) ?? order.audience_id;
      if (audienceId) {
        const audience = await repo.findAudience(audienceId);
        if (audience && input.quantity > audience.record_count) {
          throw ValidationError(
            `That area only has ${audience.record_count.toLocaleString()} deliverable addresses.`,
          );
        }
      }
      patch.quantity = input.quantity;
    }

    if (input.assetId !== undefined) {
      const asset = await PostcardAssetModel.findById(input.assetId).lean().exec();
      if (!asset) throw NotFoundError('Artwork not found');
      if (asset.business_id !== order.business_id) {
        throw ForbiddenError('That artwork belongs to another business');
      }
      /**
       * Pre-press must have PASSED, and passed for THIS size — the same file can be fine on a 6x9
       * and unusable on a 6x11. Checking the verdict rather than merely its existence is the whole
       * value of validating before checkout (ARCHITECTURAL_IMPROVEMENTS.md §7).
       */
      if (asset.prepress_status !== 'passed') {
        throw ValidationError(
          'That artwork has not passed our print checks yet. Fix the issues listed on it and try again.',
        );
      }
      if (asset.validated_sku !== order.sku) {
        throw ValidationError(
          'That artwork was checked for a different postcard size. Re-check it against this one.',
        );
      }
      /**
       * Moderation is NOT required here. It is required at submission, which is the last moment
       * before anything is printed — blocking attachment on it would leave a buyer unable to
       * assemble their order while a human is asleep.
       */
      patch.asset_id = String(asset._id);
    }

    if (input.mailDate !== undefined) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (input.mailDate < today) throw ValidationError('Pick a mail date that has not passed.');
      patch.mail_date = input.mailDate;
    }

    if (Object.keys(patch).length === 0) return shapeOrder(order as PostcardOrderDoc & { _id: unknown });

    // Configuring invalidates any price and returns the order to draft.
    Object.assign(patch, {
      status: 'draft',
      vendor_unit_cost_cents: null,
      vendor_cost_cents: null,
      margin_cents: null,
      total_cents: null,
      quoted_at: null,
      quote_expires_at: null,
    });

    const updated = await repo.patchIfEditable(orderId, patch);
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        'This order can no longer be changed.',
      );
    }
    return shapeOrder(updated.toObject() as PostcardOrderDoc & { _id: unknown });
  },

  /**
   * Prices the order and moves it to `quoted`.
   *
   * The vendor's rate is fetched at quote time and SNAPSHOT onto the order. It is not re-derived on
   * read: a buyer is shown a price and later charged it, and recomputing would let those two drift
   * apart without anyone noticing.
   */
  async quoteOrder(principal: Principal, orderId: string) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);

    if (order.status === 'cancelled') {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This order was cancelled.');
    }
    if (!order.audience_id) throw ValidationError('Choose an area to mail to first.');
    if (!order.quantity) throw ValidationError('Choose how many pieces to mail first.');

    const product = findProduct(order.sku);
    if (!product) throw ValidationError('That postcard size is no longer available.');
    assertOrderable(product, order.mail_class as MailClass, order.quantity);

    /**
     * Timed because quoting sits on the buyer's critical path — it runs while they adjust the
     * quantity — and it is a live upstream call whose latency is not ours to control (7.5).
     */
    const quoteStart = Date.now();
    const vendorPrice = await printVendor().priceRun({
      sizeKey: order.sku,
      mailClass: order.mail_class as MailClass,
      quantity: order.quantity,
    });

    bizMetrics.postcardQuoteSeconds.observe((Date.now() - quoteStart) / 1000);

    const marginRule = await feeService.resolveFeeRule('postcard_margin');
    const price = priceOrder({
      quantity: order.quantity,
      vendorUnitCostCents: vendorPrice.unitCostCents,
      marginBps: marginRule?.rate_bps ?? 0,
    });

    const now = new Date();
    const updated = await repo.transition(orderId, ['draft', 'quoted'], {
      status: 'quoted',
      vendor_unit_cost_cents: price.vendorUnitCostCents,
      vendor_cost_cents: price.vendorCostCents,
      margin_cents: price.marginCents,
      total_cents: price.totalCents,
      quoted_at: now,
      quote_expires_at: quoteExpiresAt(now),
    });
    if (!updated) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This order can no longer be quoted.');
    }

    return shapeOrder(updated.toObject() as PostcardOrderDoc & { _id: unknown }, now);
  },

  /**
   * Cancels an order.
   *
   * Free while nothing has been bought. This is NOT the irreversible edge — that arrives with
   * submission, where the vendor's batch cutoff decides (ADR-007 §2). Guarded atomically so two
   * tabs cannot both cancel, and so a cancel cannot land on an order that has since been paid for.
   */
  async cancelOrder(principal: Principal, orderId: string, reason?: string) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);

    /**
     * Phase 6: `submitted` is absent from the allowed set, and that is the irreversible edge. Once
     * the vendor holds the job the buyer must go through the vendor's own cancellation window
     * (ADR-007 §2), not through a status flip on our side that would leave a live print run behind.
     */
    const updated = await repo.transition(orderId, ['draft', 'quoted'], {
      status: 'cancelled',
      cancelled_reason: reason ?? null,
      cancelled_at: new Date(),
    });
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        order.status === 'cancelled'
          ? 'This order was already cancelled.'
          : 'This order can no longer be cancelled.',
      );
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.order_cancelled',
      entityType: 'postcard_order',
      entityId: orderId,
      metadata: { reason: reason ?? null },
    });

    return shapeOrder(updated.toObject() as PostcardOrderDoc & { _id: unknown });
  },

  // ─── Money (Phase 5, ADR-007 §4 Topology B) ─────────────────────────────────────────────────
  /**
   * Starts checkout.
   *
   * Everything that could still change the price or block the print run is checked HERE, before a
   * card is touched: a live quote, an audience, artwork that passed pre-press for this exact size.
   * A charge taken against an order that cannot be fulfilled is a refund conversation we chose to
   * have.
   *
   * **Nothing about the order advances here.** The intent is created and stored; only the Stripe
   * webhook may mark it paid. A client cannot be trusted to report that money arrived — the same
   * discipline every other money path in this codebase follows.
   */
  async payOrder(principal: Principal, orderId: string, idempotencyKey: string) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);

    if (order.status === 'paid') {
      // Not an error: a retried checkout on an order that already went through.
      return { orderId, alreadyPaid: true as const, clientSecret: null };
    }
    if (order.status !== 'quoted' && order.status !== 'payment_failed') {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This order is not ready to pay for.');
    }
    // `== null` catches undefined too — a lean doc types an unset default as either.
    if (order.total_cents == null || !order.quantity || !order.audience_id) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Finish setting up this order first.');
    }
    // Captured here, not after the artwork lookup: narrowing is discarded across an `await`.
    const totalCents = order.total_cents;
    /**
     * Phase 8.1 — the pilot spend ceiling, checked at the last moment before a card is touched.
     * A guard against our own arithmetic: quantity flows from a vendor count we deliberately do not
     * compute, and a bug there is a five-figure charge on somebody's real card.
     */
    pilotService.assertWithinPilotCap(totalCents);
    if (isQuoteExpired(order.quote_expires_at)) {
      /**
       * The vendor publishes prices but does not reserve them, so honouring an expired quote is a
       * loss taken at our own expense (audit F-8). Re-quote rather than absorb it.
       */
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        'This price has expired. Refresh the quote before paying.',
      );
    }
    if (!order.asset_id) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Attach your artwork before paying.');
    }

    const asset = await PostcardAssetModel.findById(order.asset_id).lean().exec();
    if (!asset || asset.prepress_status !== 'passed' || asset.validated_sku !== order.sku) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Your artwork needs to pass our print checks for this postcard size before you can pay.',
      );
    }

    const taxCents = computeTaxCents(order);
    const chargedCents = totalCents + taxCents;

    const charge = await postcardsMoney.createCharge({
      orderId,
      businessId: order.business_id,
      amountCents: chargedCents,
      /**
       * Derived from the order, not taken from the caller's header. Two checkout attempts on one
       * order must reach Stripe as a single charge even if the client sent no key or a fresh one —
       * the buyer is paying for one mailing either way.
       */
      idempotencyKey: `postcard_charge_${orderId}`,
    });

    await repo.transition(orderId, ['quoted', 'payment_failed'], {
      stripe_payment_intent_id: charge.paymentIntentId,
      tax_cents: taxCents,
      charged_cents: chargedCents,
      payment_failure_reason: null,
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.checkout_started',
      entityType: 'postcard_order',
      entityId: orderId,
      metadata: { chargedCents, idempotencyKey },
    });

    return { orderId, alreadyPaid: false as const, clientSecret: charge.clientSecret };
  },

  /**
   * The webhook's entry point: the money actually arrived.
   *
   * Returns `{ handled }` so the shared Stripe webhook can try each module in turn — the same
   * contract Boost and Pay It Forward use.
   */
  async completeByPaymentIntent(paymentIntentId: string): Promise<{ handled: boolean }> {
    const order = await PostcardOrderModel.findOne({
      stripe_payment_intent_id: paymentIntentId,
    })
      .lean()
      .exec();
    if (!order) return { handled: false };

    // At-least-once delivery: a replayed webhook must not book the capture twice.
    if (order.status === 'paid') return { handled: true };

    const orderId = String(order._id);
    await postcardsMoney.recordCapture({
      orderId,
      businessId: order.business_id,
      chargedCents: order.charged_cents ?? order.total_cents ?? 0,
      vendorCostCents: order.vendor_cost_cents ?? 0,
      marginCents: order.margin_cents ?? 0,
      taxCents: order.tax_cents ?? 0,
    });

    await repo.transition(orderId, ['quoted', 'payment_failed'], {
      status: 'paid',
      paid_at: new Date(),
      payment_failure_reason: null,
    });

    return { handled: true };
  },

  /** The card was declined. Says so, rather than leaving the order looking untouched. */
  async failByPaymentIntent(paymentIntentId: string, reason: string): Promise<{ handled: boolean }> {
    const order = await PostcardOrderModel.findOne({
      stripe_payment_intent_id: paymentIntentId,
    })
      .lean()
      .exec();
    if (!order) return { handled: false };

    await repo.transition(String(order._id), ['quoted', 'payment_failed'], {
      status: 'payment_failed',
      payment_failure_reason: reason,
    });
    return { handled: true };
  },

  /**
   * Refunds a paid order (audit F-4).
   *
   * Allowed only while nothing has been printed. Phase 5 stops at `paid`, so every refundable order
   * is pre-submission by construction — but this is written as a status guard rather than resting
   * on that, because Phase 6 adds the states where it stops being true. Then the vendor's batch
   * cutoff, not our clock, decides (ADR-007 §2).
   */
  async refundOrder(principal: Principal, orderId: string, reason: string) {
    const order = await repo.findOrder(orderId);
    if (!order) throw NotFoundError('Order not found');
    await ensureOwner(principal, order.business_id);

    if (order.status === 'refunded') {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This order has already been refunded.');
    }
    if (order.status !== 'paid') {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Only a paid order can be refunded.');
    }
    if (!order.stripe_payment_intent_id) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This order has no payment to refund.');
    }

    const refund = await stripe().createRefund({
      paymentIntentId: order.stripe_payment_intent_id,
      amountCents: order.charged_cents ?? undefined,
      /** A platform charge routed nothing to a connected account, so there is no transfer to reverse. */
      reverseTransfer: false,
      idempotencyKey: `postcard_refund_${orderId}`,
    });

    await postcardsMoney.recordRefund({
      orderId,
      chargedCents: order.charged_cents ?? 0,
      vendorCostCents: order.vendor_cost_cents ?? 0,
      marginCents: order.margin_cents ?? 0,
      taxCents: order.tax_cents ?? 0,
      reason,
    });

    const updated = await repo.transition(orderId, ['paid'], {
      status: 'refunded',
      refunded_at: new Date(),
      refund_reason: reason,
      stripe_refund_id: refund.refundId,
    });
    if (!updated) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'This order changed while being refunded.');
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.order_refunded',
      entityType: 'postcard_order',
      entityId: orderId,
      metadata: { reason, amountCents: order.charged_cents },
    });

    return shapeOrder(updated.toObject() as PostcardOrderDoc & { _id: unknown });
  },
};
