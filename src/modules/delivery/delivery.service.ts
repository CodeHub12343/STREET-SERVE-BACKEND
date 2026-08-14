import { randomBytes, randomInt } from 'node:crypto';

import {
  DELIVERY_BROADCAST_MAX_RADIUS_M,
  DELIVERY_BROADCAST_RADIUS_M,
  DELIVERY_COARSE_LOCATION_M,
  DELIVERY_MAX_BROADCASTS,
  DELIVERY_MAX_PAYOUT_CENTS,
  DELIVERY_MIN_PAYOUT_CENTS,
  DELIVERY_OFFER_TTL_SEC,
  DELIVERY_POSITION_MIN_INTERVAL_MS,
  DELIVERY_POSITION_PERSIST_EVERY,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { reportSweepBatch, SWEEP_BATCH_LIMIT } from '../../jobs/sweepBatch';
import { realtime } from '../../realtime/hub';
import { writeAudit } from '../../shared/audit';
import { kv } from '../../shared/kv';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { livemapRepository } from '../livemap/livemap.repository';
import { notificationsService } from '../notifications/notifications.service';
import { OrderModel } from '../orders/orders.model';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { DeliveryIncidentModel, DeliveryRequestModel, DriverProfileModel } from './delivery.model';
import { driverService } from './driver.service';

/**
 * ═══ DISPATCH (ADR-004, DAN-1..DAN-13) ═══
 *
 * The rules that shape this file, all from ADR-004:
 *
 *  • **Broadcast, never assign.** Directing WHO does the work is the clearest indicator of control
 *    there is. Every driver in range gets the same offer and the first to accept takes it.
 *  • **Declining is free and untracked.** Nothing anywhere counts a decline.
 *  • **The price is shown before acceptance and never changes afterwards.** It is snapshotted on the
 *    request, like the wave-down's travel fee.
 *  • **Nobody is charged before a driver accepts** (DAN-13). The most likely outcome of a dispatch is
 *    that nobody takes it, and a customer charged for a delivery that never happened is the worst
 *    version of this feature.
 *  • **Addresses are staged** (A-15): approximate before acceptance, exact after, nothing once done.
 */

/** Six digits, read aloud at a doorstep. Not guessable by counting up from a previous one. */
function proofCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

/**
 * Coarsen a point to roughly `DELIVERY_COARSE_LOCATION_M`. Deterministic per delivery so the blurred
 * point does not jitter between polls — a moving "approximate" location is worse than a static one,
 * because watching it move narrows it down.
 */
function coarsen(lng: number, lat: number): { lng: number; lat: number } {
  const degrees = DELIVERY_COARSE_LOCATION_M / 111_000;
  const round = (v: number) => Math.round(v / degrees) * degrees;
  return { lng: Number(round(lng).toFixed(4)), lat: Number(round(lat).toFixed(4)) };
}

/**
 * The subset of a delivery that dispatch reads. Structural rather than the Mongoose document type:
 * `broadcast` and `offerPayload` are called with both hydrated docs and sweep results, and a shape
 * they both satisfy keeps the call sites honest without casting at each one.
 */
interface DispatchableDelivery {
  _id: unknown;
  driver_payout_cents: number;
  // Optional to match Mongoose's inferred subdocument types; both are required on the schema, so a
  // missing one is a document that could never have been created.
  pickup?: { lng: number; lat: number } | null;
  destination?: { lng: number; lat: number; city: string } | null;
  broadcast_radius_m: number;
  expires_at: Date;
}

/** Statuses in which a driver is still expected to be moving. */
const LIVE_STATUSES = ['accepted', 'picked_up'] as const;

export const deliveryService = {
  // ─── DAN-1 · the request ──────────────────────────────────────────────────────────────────
  /**
   * A vendor asks for help with an order they have already accepted.
   *
   * The vendor names the driver's payout. A platform-set rate the driver only discovers after
   * accepting would be the kind of control ADR-004 prohibits; the vendor knows what the trip is
   * worth to them, and the driver decides whether it is worth taking.
   */
  async request(principal: Principal, input: { orderId: string; driverPayoutCents: number }) {
    if (
      input.driverPayoutCents < DELIVERY_MIN_PAYOUT_CENTS ||
      input.driverPayoutCents > DELIVERY_MAX_PAYOUT_CENTS
    ) {
      throw ValidationError(
        `Offer between ${formatCents(DELIVERY_MIN_PAYOUT_CENTS)} and ${formatCents(DELIVERY_MAX_PAYOUT_CENTS)}`,
      );
    }

    const order = await OrderModel.findById(input.orderId).lean();
    if (!order) throw NotFoundError('Order not found');
    const owner = await vendorsService.getBusinessOwner(order.business_id);
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }
    if (order.fulfillment_type !== 'delivery' || !order.destination) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This order is not a delivery');
    }
    if (order.status === 'cancelled' || order.status === 'completed') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This order is already finished');
    }

    const existing = await DeliveryRequestModel.findOne({ order_id: input.orderId }).lean();
    if (existing) {
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        'A driver has already been requested for this order',
      );
    }

    // Where the driver collects: the vendor's pitch right now.
    const session = await livemapRepository.findActiveByActor('business', order.business_id);
    if (!session) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_AWAY,
        'Go live before requesting a driver — they need somewhere to collect from',
      );
    }
    const [pickupLng, pickupLat] = session.current_location!.coordinates as [number, number];

    // DAN-8: flat, from the registry. Priced at 0 until the pilot's economics are known — nothing is
    // charged, and a made-up number would be worse than none.
    const coordinationFee = await feeService.resolveFee(
      'delivery_coordination',
      input.driverPayoutCents,
    );

    const delivery = await DeliveryRequestModel.create({
      order_id: input.orderId,
      business_id: order.business_id,
      customer_id: order.customer_id,
      pickup: { lng: pickupLng, lat: pickupLat },
      destination: {
        line1: order.destination.line1,
        line2: order.destination.line2 ?? null,
        city: order.destination.city,
        postal_code: order.destination.postal_code ?? null,
        lng: order.destination.location!.coordinates[0]!,
        lat: order.destination.location!.coordinates[1]!,
        notes: order.destination.notes ?? null,
        contact_phone: order.destination.contact_phone ?? null,
      },
      driver_payout_cents: input.driverPayoutCents,
      coordination_fee_cents: coordinationFee,
      customer_total_cents: input.driverPayoutCents + coordinationFee,
      requested_at: new Date(),
      expires_at: new Date(Date.now() + DELIVERY_OFFER_TTL_SEC * 1000),
      broadcast_radius_m: DELIVERY_BROADCAST_RADIUS_M,
      proof_code: proofCode(),
      share_token: randomBytes(12).toString('hex'),
    });

    await this.broadcast(delivery);
    await writeAudit({
      actorId: principal.userId,
      action: 'delivery.requested',
      entityType: 'delivery',
      entityId: String(delivery._id),
      metadata: { orderId: input.orderId, payoutCents: input.driverPayoutCents },
    });
    return this.viewFor(principal, String(delivery._id));
  },

  /**
   * DAN-2 / A-6 — fan the offer to on-shift drivers in range.
   *
   * **Event-driven, not a sweep.** The existing proximity fan-out runs on a 60-second poll, which is
   * right for "a vendor you follow is nearby" and completely wrong here: a minute of silence after
   * tapping "Need Delivery Help" reads as a broken button. The sweep below handles only expiry and
   * re-broadcast. Same reasoning the corridor alerts already record.
   */
  async broadcast(delivery: DispatchableDelivery): Promise<number> {
    const pickup = delivery.pickup!;
    const sessions = await livemapRepository.nearby({
      lng: pickup.lng,
      lat: pickup.lat,
      radiusM: delivery.broadcast_radius_m,
      statuses: ['driving', 'parked'],
      limit: 50,
      // The one place drivers are wanted: this is dispatch, not the customer map.
      includeDrivers: true,
    });

    const driverIds = sessions.filter((s) => s.actor_type === 'driver').map((s) => s.actor_id);
    if (driverIds.length === 0) return 0;

    // Only eligible drivers see it. Checked at fan-out rather than at accept, so a suspended driver
    // is never shown work they cannot take.
    const approved = await DriverProfileModel.find({
      user_id: { $in: driverIds },
      status: 'approved',
      background_check_status: 'passed',
      insurance_expires_at: { $gt: new Date() },
      licence_expires_at: { $gt: new Date() },
    })
      .select('user_id')
      .lean();

    const payload = this.offerPayload(delivery);
    for (const d of approved) {
      realtime.deliveryOffer(d.user_id, payload);
      notificationsService.notify(d.user_id, {
        category: 'delivery',
        title: `Delivery offer — ${formatCents(delivery.driver_payout_cents)}`,
        body: 'A vendor nearby needs a hand. Tap to see the trip.',
        data: { deliveryId: String(delivery._id), audience: 'driver' },
      });
    }
    return approved.length;
  },

  /**
   * What a driver sees BEFORE accepting (A-15): the pickup exactly — they need to know how far they
   * are from it — and the destination only as an approximate point. A broadcast carrying a precise
   * home address reaches every driver in range, almost all of whom will not take the job.
   */
  offerPayload(delivery: DispatchableDelivery) {
    const dest = delivery.destination!;
    const pickup = delivery.pickup!;
    const coarse = coarsen(dest.lng, dest.lat);
    return {
      deliveryId: String(delivery._id),
      payoutCents: delivery.driver_payout_cents,
      pickup: { lng: pickup.lng, lat: pickup.lat },
      dropOffArea: { ...coarse, city: dest.city },
      expiresAt: delivery.expires_at,
    };
  },

  /** A driver's live offers. Same coarse view as the push — the address is not in here either. */
  async offersFor(principal: Principal) {
    const { eligible } = await driverService.eligibility(principal.userId);
    if (!eligible) return [];
    const open = await DeliveryRequestModel.find({
      status: 'broadcasting',
      expires_at: { $gt: new Date() },
    })
      .limit(20)
      .exec();
    return open.map((d) => this.offerPayload(d));
  },

  /**
   * The driver's delivery in progress, if any.
   *
   * Without this a driver who closed the app — or whose phone died, which is the whole reason the
   * ops "stuck delivery" runbook exists — had no way back to the job they had already accepted. The
   * offers list only shows work nobody has taken.
   */
  async activeFor(principal: Principal) {
    const active = await DeliveryRequestModel.findOne({
      driver_id: principal.userId,
      status: { $in: LIVE_STATUSES },
    })
      .sort({ accepted_at: -1 })
      .lean();
    if (!active) return null;
    return this.viewFor(principal, String(active._id));
  },

  // ─── DAN-4 · first to accept ──────────────────────────────────────────────────────────────
  /**
   * Atomic claim. The interesting case is the LOSER: two drivers tapping at the same instant must
   * not both end up believing the job is theirs, and a read-then-write would let them.
   *
   * The `findOneAndUpdate` guard on `{status:'broadcasting', driver_id:null}` is what decides it —
   * the database, not the application.
   */
  async accept(principal: Principal, deliveryId: string) {
    const { eligible, reasons } = await driverService.eligibility(principal.userId);
    if (!eligible) {
      throw ForbiddenError(
        `You can't take deliveries right now (${reasons.join(', ')})`,
        ERROR_CODES.ROLE_REQUIRED,
      );
    }

    // One at a time. A driver holding two live jobs is one who is late for both.
    const busy = await DeliveryRequestModel.findOne({
      driver_id: principal.userId,
      status: { $in: LIVE_STATUSES },
    }).lean();
    if (busy) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Finish your current delivery first');
    }

    const claimed = await DeliveryRequestModel.findOneAndUpdate(
      { _id: deliveryId, status: 'broadcasting', driver_id: null, expires_at: { $gt: new Date() } },
      { $set: { driver_id: principal.userId, status: 'accepted', accepted_at: new Date() } },
      { new: true },
    ).exec();
    if (!claimed) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Someone else has already taken this one');
    }

    // Every other driver's card disappears, rather than failing on tap.
    realtime.deliveryClaimed('*', deliveryId);

    /**
     * DAN-13 — the customer is charged HERE, at acceptance, and never before. Until a driver has
     * taken the job there is nothing to charge for.
     */
    if (claimed.customer_total_cents > 0) {
      try {
        const charge = await paymentsService.charge({
          customerId: claimed.customer_id,
          counterpartyType: 'business',
          counterpartyId: claimed.business_id,
          amountCents: claimed.customer_total_cents,
          feeType: 'delivery_coordination',
          idempotencyKey: `delivery_charge_${deliveryId}`,
        });
        await DeliveryRequestModel.updateOne(
          { _id: deliveryId },
          { $set: { charged_at: new Date(), transaction_id: charge.transactionId } },
        ).exec();
      } catch (err) {
        // The driver has already been told it is theirs. Releasing it now would be worse than
        // carrying an uncharged delivery and reconciling it — but it must be loud.
        logger.error({ deliveryId, err }, 'delivery accepted but the customer charge failed');
      }
    }

    this.notifyStatus(claimed, 'accepted');
    return this.viewFor(principal, deliveryId);
  },

  // ─── lifecycle ────────────────────────────────────────────────────────────────────────────
  async markPickedUp(principal: Principal, deliveryId: string) {
    const updated = await DeliveryRequestModel.findOneAndUpdate(
      { _id: deliveryId, driver_id: principal.userId, status: 'accepted' },
      { $set: { status: 'picked_up', picked_up_at: new Date() } },
      { new: true },
    ).exec();
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Not ready to collect');
    this.notifyStatus(updated, 'picked_up');
    return this.viewFor(principal, deliveryId);
  },

  /**
   * DAN-12 — the customer reads out a six-digit code. A code proves the driver actually met them; a
   * photo of a doorstep proves somebody was at a door, and brings a moderation surface with it.
   */
  async complete(principal: Principal, deliveryId: string, code: string) {
    const delivery = await DeliveryRequestModel.findOne({
      _id: deliveryId,
      driver_id: principal.userId,
    }).exec();
    if (!delivery) throw NotFoundError('Delivery not found');
    if (delivery.status !== 'picked_up') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Collect the order first');
    }
    if (code !== delivery.proof_code) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'That code does not match');
    }

    const done = await DeliveryRequestModel.findOneAndUpdate(
      { _id: deliveryId, status: 'picked_up' },
      { $set: { status: 'delivered', delivered_at: new Date() } },
      { new: true },
    ).exec();
    if (!done) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Already finished');

    // DAN-9 — the same Stripe Connect gig rail the jobs module already uses and reconciles.
    const payout = await paymentsService.payoutTransfer({
      ownerType: 'user',
      ownerId: principal.userId,
      amountCents: done.driver_payout_cents,
      transferGroup: `delivery_${deliveryId}`,
      idempotencyKey: `delivery_payout_${deliveryId}`,
    });
    await DeliveryRequestModel.updateOne(
      { _id: deliveryId },
      { $set: { payout_ref: payout?.transferId ?? null } },
    ).exec();
    if (!payout) {
      // Eligibility requires a payouts-enabled account, so reaching here means it was revoked
      // mid-delivery. The work is done and the debt is real — this must never be silent.
      logger.error(
        { deliveryId, driverId: principal.userId, amountCents: done.driver_payout_cents },
        'delivery completed but the driver payout did not send',
      );
    }

    this.notifyStatus(done, 'delivered');
    await writeAudit({
      actorId: principal.userId,
      action: 'delivery.completed',
      entityType: 'delivery',
      entityId: deliveryId,
      metadata: { payoutCents: done.driver_payout_cents },
    });
    return this.viewFor(principal, deliveryId);
  },

  /** The driver got there and could not finish. Not a failure of theirs — it is a real outcome. */
  async markUndeliverable(principal: Principal, deliveryId: string, reason: string) {
    const updated = await DeliveryRequestModel.findOneAndUpdate(
      { _id: deliveryId, driver_id: principal.userId, status: { $in: LIVE_STATUSES } },
      { $set: { status: 'undeliverable', ended_reason: reason } },
      { new: true },
    ).exec();
    if (!updated)
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Not an active delivery');

    // They travelled and did the work asked of them, so they are still paid.
    await paymentsService.payoutTransfer({
      ownerType: 'user',
      ownerId: principal.userId,
      amountCents: updated.driver_payout_cents,
      transferGroup: `delivery_${deliveryId}`,
      idempotencyKey: `delivery_payout_${deliveryId}`,
    });
    this.notifyStatus(updated, 'undeliverable');
    return this.viewFor(principal, deliveryId);
  },

  /**
   * Either side pulls out before hand-off. A driver cancelling is recorded on the DELIVERY, never on
   * the driver — there is no counter for it, by design.
   */
  async cancel(principal: Principal, deliveryId: string, reason?: string) {
    const delivery = await DeliveryRequestModel.findById(deliveryId).exec();
    if (!delivery) throw NotFoundError('Delivery not found');

    const isDriver = delivery.driver_id === principal.userId;
    const owner = await vendorsService.getBusinessOwner(delivery.business_id);
    if (!isDriver && owner !== principal.userId) {
      throw ForbiddenError('Not your delivery', ERROR_CODES.NOT_OWNER);
    }
    if (delivery.status === 'delivered' || delivery.status === 'undeliverable') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'This delivery is already finished',
      );
    }

    await DeliveryRequestModel.updateOne(
      { _id: deliveryId },
      {
        $set: {
          status: 'cancelled',
          ended_reason: reason ?? (isDriver ? 'driver_cancelled' : 'vendor_cancelled'),
        },
      },
    ).exec();

    // Whatever was taken at acceptance goes back. Nobody pays for a delivery that did not happen.
    if (delivery.transaction_id) {
      await this.refundCustomer(delivery.transaction_id, principal.userId, deliveryId);
    }

    this.notifyStatus(delivery, 'cancelled');
    return { deliveryId, status: 'cancelled' as const };
  },

  async refundCustomer(transactionId: string, actorId: string, deliveryId: string): Promise<void> {
    try {
      // `fulfilled: false` — the delivery did not happen, so every part of the charge comes back,
      // including the platform's own coordination fee. Retaining a fee on a service nobody received
      // is the version of this the refund policy exists to prevent.
      await paymentsService.refund(transactionId, actorId, { fulfilled: false });
    } catch (err) {
      logger.error({ deliveryId, err }, 'delivery refund failed');
    }
  },

  // ─── DAN-13 · nobody accepts ──────────────────────────────────────────────────────────────
  /**
   * The most likely outcome of a dispatch, and the one the specification never mentions.
   *
   * A lapsed round widens the radius and goes again; after `DELIVERY_MAX_BROADCASTS` the request
   * gives up and tells the vendor plainly. **Nobody has been charged at any point**, because the
   * charge happens at acceptance.
   */
  async sweepOffers(): Promise<{ rebroadcast: number; expired: number }> {
    const due = await DeliveryRequestModel.find({
      status: 'broadcasting',
      expires_at: { $lte: new Date() },
    })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    let rebroadcast = 0;
    let expired = 0;
    for (const delivery of due) {
      if (delivery.broadcast_count >= DELIVERY_MAX_BROADCASTS) {
        const claimed = await DeliveryRequestModel.findOneAndUpdate(
          { _id: delivery._id, status: 'broadcasting' },
          { $set: { status: 'expired', ended_reason: 'no_driver_accepted' } },
        ).exec();
        if (!claimed) continue;
        expired += 1;

        const owner = await vendorsService.getBusinessOwner(delivery.business_id);
        if (owner) {
          notificationsService.notify(owner, {
            category: 'delivery',
            title: 'No driver picked this up',
            body: 'Nobody was free. The customer hasn’t been charged for delivery — you can offer more, or hand it over yourself.',
            data: { deliveryId: String(delivery._id), audience: 'vendor' },
          });
        }
        continue;
      }

      // Widen rather than starting wide: the nearest drivers get first refusal, and a 8km-wide first
      // broadcast would push an offer to people who could never make it in time.
      const nextRadius = Math.min(DELIVERY_BROADCAST_MAX_RADIUS_M, delivery.broadcast_radius_m * 2);
      const updated = await DeliveryRequestModel.findOneAndUpdate(
        { _id: delivery._id, status: 'broadcasting' },
        {
          $set: {
            expires_at: new Date(Date.now() + DELIVERY_OFFER_TTL_SEC * 1000),
            broadcast_radius_m: nextRadius,
          },
          $inc: { broadcast_count: 1 },
        },
        { new: true },
      ).exec();
      if (!updated) continue;
      await this.broadcast(updated);
      rebroadcast += 1;
    }

    reportSweepBatch('delivery-offer-sweep', due.length);
    return { rebroadcast, expired };
  },

  // ─── DAN-6 · live tracking ────────────────────────────────────────────────────────────────
  /**
   * A courier position. Two protections, both server-side:
   *
   *  1. **A rate ceiling.** A client bug, or a driver with two app instances open, must not be able
   *     to raise the platform's first sustained write load. Anything inside the window is dropped.
   *  2. **Decimated persistence.** One in `DELIVERY_POSITION_PERSIST_EVERY` is written; the rest are
   *     broadcast and forgotten. A precise minute-by-minute trace of a worker's movements is a
   *     privacy exposure as much as a storage cost.
   */
  async reportPosition(principal: Principal, deliveryId: string, lng: number, lat: number) {
    const delivery = await DeliveryRequestModel.findOne({
      _id: deliveryId,
      driver_id: principal.userId,
      status: { $in: LIVE_STATUSES },
    }).lean();
    // Position is accepted only while the delivery is live. Outside that window a driver's location
    // is nobody's business, including the platform's.
    if (!delivery) throw NotFoundError('No active delivery');

    const gate = `delivery:pos:${deliveryId}`;
    const first = await kv().setNx(gate, '1', Math.ceil(DELIVERY_POSITION_MIN_INTERVAL_MS / 1000));
    if (!first) return { accepted: false as const };

    realtime.deliveryPosition(deliveryId, { lng, lat, at: Date.now() });

    const n = await kv().incrWithTtl(`delivery:poscount:${deliveryId}`, 60 * 60 * 6);
    if (n % DELIVERY_POSITION_PERSIST_EVERY === 0) {
      await livemapRepository
        .appendPing(deliveryId, { type: 'Point', coordinates: [lng, lat] })
        .catch((err: unknown) => logger.warn({ deliveryId, err }, 'delivery ping persist failed'));
    }
    return { accepted: true as const };
  },

  // ─── views ────────────────────────────────────────────────────────────────────────────────
  /**
   * A-15 — the address is staged by WHO is asking and WHEN.
   *
   * A driver who has accepted sees the exact address and the access notes; one who has not sees an
   * approximate area; and once the delivery is over, nobody but the customer and the vendor sees it
   * at all. Applied here, at the single point the delivery is served.
   */
  async viewFor(principal: Principal, deliveryId: string) {
    const d = await DeliveryRequestModel.findById(deliveryId).lean();
    if (!d) throw NotFoundError('Delivery not found');

    const isDriver = d.driver_id === principal.userId;
    const isCustomer = d.customer_id === principal.userId;
    const owner = await vendorsService.getBusinessOwner(d.business_id);
    const isVendor = owner === principal.userId;
    if (!isDriver && !isCustomer && !isVendor) {
      throw ForbiddenError('Not your delivery', ERROR_CODES.NOT_OWNER);
    }

    const finished = ['delivered', 'cancelled', 'undeliverable', 'expired'].includes(d.status);
    const driverMaySeeExact = isDriver && !finished;
    // Required on the schema; the lean type widens it. A delivery with no destination is not one.
    const dest = d.destination!;
    const coarse = coarsen(dest.lng, dest.lat);

    return {
      id: String(d._id),
      orderId: d.order_id,
      status: d.status,
      pickup: d.pickup,
      destination:
        isCustomer || isVendor || driverMaySeeExact
          ? {
              line1: dest.line1,
              line2: dest.line2 ?? null,
              city: dest.city,
              postalCode: dest.postal_code ?? null,
              lng: dest.lng,
              lat: dest.lat,
              notes: dest.notes ?? null,
              contactPhone: dest.contact_phone ?? null,
            }
          : { city: dest.city, ...coarse },
      payoutCents: d.driver_payout_cents,
      coordinationFeeCents: d.coordination_fee_cents,
      customerTotalCents: d.customer_total_cents,
      /** Only the customer sees the code — they are the one who reads it out. */
      proofCode: isCustomer ? d.proof_code : undefined,
      /** A-14 — the customer's own link to let someone else watch the trip. */
      shareToken: isCustomer ? d.share_token : undefined,
      expiresAt: d.expires_at,
      acceptedAt: d.accepted_at ?? null,
      deliveredAt: d.delivered_at ?? null,
      endedReason: d.ended_reason ?? null,
    };
  },

  notifyStatus(d: { _id: unknown; customer_id: string }, status: string) {
    const id = String(d._id);
    realtime.deliveryStatus(id, { status });
    const COPY: Record<string, string> = {
      accepted: 'A driver is on the way to collect your order.',
      picked_up: 'Your order is on its way.',
      delivered: 'Your order has been delivered.',
      cancelled: 'Your delivery was cancelled. Anything charged for it has been refunded.',
      undeliverable: 'The driver couldn’t complete your delivery. We’re sorting it out.',
    };
    if (COPY[status]) {
      notificationsService.notify(d.customer_id, {
        category: 'delivery',
        title: 'Delivery update',
        body: COPY[status],
        data: { deliveryId: id },
      });
    }
  },

  // ─── A-14 · safety ────────────────────────────────────────────────────────────────────────
  async reportIncident(
    principal: Principal,
    deliveryId: string,
    input: { kind: string; detail?: string },
  ) {
    const d = await DeliveryRequestModel.findById(deliveryId).lean();
    if (!d) throw NotFoundError('Delivery not found');

    const owner = await vendorsService.getBusinessOwner(d.business_id);
    const role =
      d.driver_id === principal.userId
        ? 'driver'
        : d.customer_id === principal.userId
          ? 'customer'
          : owner === principal.userId
            ? 'vendor'
            : null;
    if (!role) throw ForbiddenError('Not your delivery', ERROR_CODES.NOT_OWNER);

    const incident = await DeliveryIncidentModel.create({
      delivery_id: deliveryId,
      reported_by: principal.userId,
      reporter_role: role,
      kind: input.kind,
      detail: input.detail ?? null,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'delivery.incident_reported',
      entityType: 'delivery',
      entityId: deliveryId,
      metadata: { kind: input.kind, role },
    });
    return { id: String(incident._id), status: 'open' as const };
  },

  /** Ops triage. An incident nobody has looked at is the one that matters. */
  async reviewIncident(principal: Principal, incidentId: string) {
    const updated = await DeliveryIncidentModel.findOneAndUpdate(
      { _id: incidentId, status: 'open' },
      { $set: { status: 'reviewed', reviewed_at: new Date() } },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Incident not found or already reviewed');
    await writeAudit({
      actorId: principal.userId,
      action: 'delivery.incident_reviewed',
      entityType: 'delivery_incident',
      entityId: incidentId,
    });
    return { id: incidentId, status: 'reviewed' as const };
  },
};
