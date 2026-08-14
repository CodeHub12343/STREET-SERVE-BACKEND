import { QUEUE_HOLD_DEFAULT_SEC, WAVE_DOWN_SLA_DEFAULT_SEC } from '../../config/constants';
import { SWEEP_BATCH_LIMIT, reportSweepBatch } from '../../jobs/sweepBatch';
import { publish } from '../../events/bus';
import { realtime } from '../../realtime/hub';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { UserModel } from '../identity/identity.model';
import { BusinessModel } from '../vendors/vendors.model';
import { LiveSessionModel } from '../livemap/livemap.model';
import { notificationsService } from '../notifications/notifications.service';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { queuePositionDiscount, resolveDiscount } from '../orders/discounts';
import { QueueEntryModel } from './queue.model';
import { queueRepository as repo } from './queue.repository';

type OwnerType = 'business' | 'seller';
interface Tier {
  position: number;
  discount_percent: number;
}

async function assertOwnerControl(
  principal: Principal,
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  if (ownerType === 'business') {
    const owner = await vendorsService.getBusinessOwner(ownerId);
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }
  } else if (ownerId !== principal.userId) {
    throw ForbiddenError('Not your queue', ERROR_CODES.NOT_OWNER);
  }
}

interface ScheduleLike {
  tiers: { position?: number | null; discount_percent?: number | null }[];
  cap_percent: number;
}

/**
 * The queue's position→percent lookup. Position-indexed tiers with a cap beyond the last one are
 * genuinely queue-specific, so the storage stays here — but the RESULT goes through the shared
 * discount contest (A-7, `orders/discounts.ts`) rather than being applied directly, so that when
 * flash sales land there is one place that decides which discount a customer actually gets.
 */
function discountForPosition(
  schedule: ScheduleLike | null,
  position: number,
  owner: { ownerType: OwnerType; ownerId: string },
): { percent: number; label: string } {
  const raw = (() => {
    if (!schedule || schedule.tiers.length === 0) return 0;
    const tier = schedule.tiers.find((t) => t.position === position);
    if (tier) return tier.discount_percent ?? 0;
    // Beyond the last configured tier → the cap applies.
    return schedule.cap_percent;
  })();

  const resolved = resolveDiscount([
    queuePositionDiscount({ ...owner, position, percent: raw }),
  ]);
  return { percent: resolved.percent, label: resolved.label };
}

/**
 * §32.4 — every charge a Waved Down request carries, in money and in words, BEFORE the customer
 * confirms. Two separate fees with different payees: the vendor's travel fee is theirs, the
 * convenience fee is the platform's. Naming them separately is the point — "$5.99 of fees" tells a
 * customer nothing about who they are paying or what for.
 */
function waveFeeDisclosure(travelFeeCents: number, convenienceFeeCents: number) {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const parts: string[] = [];
  if (travelFeeCents > 0) parts.push(`${usd(travelFeeCents)} to come to you`);
  if (convenienceFeeCents > 0) parts.push(`a ${usd(convenienceFeeCents)} request fee`);
  return {
    travelFeeCents,
    convenienceFeeCents,
    totalFeeCents: travelFeeCents + convenienceFeeCents,
    feeLines: [
      ...(travelFeeCents > 0 ? [{ label: 'Vendor travel fee', amountCents: travelFeeCents }] : []),
      ...(convenienceFeeCents > 0
        ? [{ label: 'Request fee', amountCents: convenienceFeeCents }]
        : []),
    ],
    travelFeeDisclosure:
      parts.length > 0
        ? `This request adds ${parts.join(' and ')}, charged when you pay.`
        : null,
  };
}

export const queueService = {
  // ─── Discount schedule ──────────────────────────────────────────────────────────────────
  async setDiscountSchedule(
    principal: Principal,
    ownerType: OwnerType,
    ownerId: string,
    tiers: Tier[],
    capPercent: number,
  ) {
    await assertOwnerControl(principal, ownerType, ownerId);

    const sorted = [...tiers].sort((a, b) => a.position - b.position);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i]!;
      if (t.position !== i + 1) {
        throw BusinessRuleError(
          ERROR_CODES.INVALID_DISCOUNT_SCHEDULE,
          'Positions must be 1..n contiguous',
        );
      }
      if (t.discount_percent < 0 || t.discount_percent > 100) {
        throw BusinessRuleError(
          ERROR_CODES.INVALID_DISCOUNT_SCHEDULE,
          'discount_percent out of range',
        );
      }
      if (i > 0 && t.discount_percent <= sorted[i - 1]!.discount_percent) {
        throw BusinessRuleError(
          ERROR_CODES.INVALID_DISCOUNT_SCHEDULE,
          'discount_percent must strictly increase by position',
        );
      }
    }
    const last = sorted[sorted.length - 1];
    if (capPercent < 0 || capPercent > 100 || (last && capPercent < last.discount_percent)) {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_DISCOUNT_SCHEDULE,
        'cap_percent must be ≥ the last tier and ≤ 100',
      );
    }
    const doc = await repo.upsertSchedule(ownerType, ownerId, sorted, capPercent);
    return { tiers: doc.tiers, capPercent: doc.cap_percent };
  },

  async getDiscountSchedule(ownerType: OwnerType, ownerId: string) {
    const s = await repo.getSchedule(ownerType, ownerId);
    return s ? { tiers: s.tiers, capPercent: s.cap_percent } : { tiers: [], capPercent: 0 };
  },

  // ─── Wave-down ──────────────────────────────────────────────────────────────────────────
  async createWaveDown(
    principal: Principal,
    input: { targetType: OwnerType; targetId: string; note?: string },
  ) {
    const now = new Date();
    // §32.4: the vendor's travel fee is snapshotted at the moment of the request and echoed back,
    // so what the customer confirmed is what they are charged. Sellers have no travel fee.
    const travelFeeCents =
      input.targetType === 'business'
        ? await vendorsService.getTravelFeeCents(input.targetId)
        : null;
    /**
     * §32.4 — the platform's own convenience fee for the dispatch, resolved from the fee registry
     * server-side (never client-supplied) and snapshotted alongside the vendor's travel fee. Flat
     * rather than a percentage: it prices the trip, which costs the same whether the order is $8
     * or $80.
     */
    const convenienceFeeCents = await feeService.resolveWaveConvenienceFee();
    const wave = await repo.createWaveDown({
      customer_id: principal.userId,
      target_type: input.targetType,
      target_id: input.targetId,
      note: input.note ?? null,
      requested_at: now,
      expires_at: new Date(now.getTime() + WAVE_DOWN_SLA_DEFAULT_SEC * 1000),
      travel_fee_cents: travelFeeCents,
      convenience_fee_cents: convenienceFeeCents,
    });
    const id = String(wave._id);
    if (input.targetType === 'business') {
      const owner = await vendorsService.getBusinessOwner(input.targetId);
      if (owner) {
        notificationsService.notify(owner, {
          category: 'wave_down',
          title: 'New wave down',
          body: 'A customer waved you down',
          // `audience` disambiguates the two directions of a wave_down notification so the client
          // can deep-link correctly: the target opens their wave inbox, the customer their tracker.
          data: { waveDownId: id, audience: 'vendor' },
        });
      }
    } else {
      notificationsService.notify(input.targetId, {
        category: 'wave_down',
        title: 'New wave down',
        body: 'A customer waved you down',
        data: { waveDownId: id, audience: 'vendor' },
      });
    }
    await publish('wave_down.created', {
      waveDownId: id,
      targetId: input.targetId,
      customerId: principal.userId,
    });
    return {
      id,
      status: wave.status,
      expiresAt: wave.expires_at,
      ...waveFeeDisclosure(travelFeeCents ?? 0, convenienceFeeCents),
    };
  },

  async acceptWaveDown(principal: Principal, waveDownId: string, etaSeconds: number | undefined) {
    const wave = await repo.findWaveDownById(waveDownId);
    if (!wave) throw NotFoundError('Wave-down not found');
    await assertOwnerControl(principal, wave.target_type, wave.target_id);
    if (wave.status !== 'pending') {
      if (wave.status === 'expired')
        throw ConflictError(ERROR_CODES.WAVE_EXPIRED, 'Wave-down expired');
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Wave-down is ${wave.status}`);
    }
    if (wave.expires_at.getTime() < Date.now()) {
      await repo.transitionWaveDown(waveDownId, 'pending', { status: 'expired' });
      throw ConflictError(ERROR_CODES.WAVE_EXPIRED, 'Wave-down expired');
    }

    const updated = await repo.transitionWaveDown(waveDownId, 'pending', {
      status: 'accepted',
      accepted_at: new Date(),
      eta_seconds: etaSeconds ?? null,
    });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Wave-down changed');

    // Flow 2 step 9: the customer joins the line-up automatically on acceptance.
    const queue = await this.joinQueueInternal(wave.customer_id, wave.target_type, wave.target_id);
    realtime.waveAccepted(wave.customer_id, {
      waveDownId,
      etaSeconds: etaSeconds ?? null,
      queue,
    });
    notificationsService.notify(wave.customer_id, {
      category: 'wave_down',
      title: 'Wave down accepted',
      body: 'The vendor is on the way',
      data: { waveDownId, etaSeconds: etaSeconds ?? null },
    });
    await publish('wave_down.accepted', { waveDownId, customerId: wave.customer_id });
    return { id: waveDownId, status: 'accepted', etaSeconds: etaSeconds ?? null, queue };
  },

  async declineWaveDown(principal: Principal, waveDownId: string, reason?: string) {
    const wave = await repo.findWaveDownById(waveDownId);
    if (!wave) throw NotFoundError('Wave-down not found');
    await assertOwnerControl(principal, wave.target_type, wave.target_id);
    const updated = await repo.transitionWaveDown(waveDownId, 'pending', {
      status: 'declined',
      decline_reason: reason ?? null,
    });
    if (!updated)
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Wave-down not pending');
    notificationsService.notify(wave.customer_id, {
      category: 'wave_down',
      title: 'Wave down declined',
      body: reason ?? 'The vendor cannot serve you right now',
      data: { waveDownId },
    });
    return { id: waveDownId, status: 'declined' };
  },

  /**
   * The vendor's wave inbox (V-03): every still-live incoming wave for their business. The UI was
   * shipped against this endpoint but the endpoint never was, so the inbox always read empty and a
   * wave could not be accepted. Only the owner may list; expired waves are excluded so a dead
   * countdown never shows.
   */
  async listIncomingWaveDowns(principal: Principal, businessId: string) {
    await assertOwnerControl(principal, 'business', businessId);
    const now = new Date();
    const waves = await repo.findPendingWaveDownsForTarget('business', businessId, now);
    if (waves.length === 0) return [];

    // One read for all the customer names rather than N.
    const customerIds = [...new Set(waves.map((w) => w.customer_id))];
    const users = await UserModel.find({ _id: { $in: customerIds } }, { display_name: 1 })
      .lean()
      .exec();
    const nameById = new Map(users.map((u) => [String(u._id), u.display_name]));

    return waves.map((w) => ({
      id: String(w._id),
      customerName: nameById.get(w.customer_id) || 'A customer',
      note: w.note ?? undefined,
      // The per-request SLA countdown (docs/13 V-03) is the server-authoritative expiry.
      slaDeadline: (w.expires_at as Date).toISOString(),
      // Wave-downs don't capture the customer's coordinates, so distance isn't known server-side.
      distanceLabel: 'nearby',
    }));
  },

  /**
   * Serve the front of the line (V-04). The owner marks the #1 customer as served, which removes
   * them and advances everyone behind — the vendor's "next!" during a rush. Notifies the served
   * customer so their queue screen resolves cleanly instead of just going empty.
   */
  async serveNext(principal: Principal, businessId: string) {
    await assertOwnerControl(principal, 'business', businessId);
    const queue = await repo.findQueue('business', businessId);
    if (!queue) throw NotFoundError('No queue for this business');
    const entries = await repo.activeEntries(String(queue._id));
    const front = entries[0];
    if (!front) throw ConflictError(ERROR_CODES.NOT_IN_QUEUE, 'No one is in line');

    await repo.leaveEntry(String(queue._id), front.customer_id);
    realtime.queueUpdate(businessId, await this.buildState('business', businessId));

    const [biz, user] = await Promise.all([
      BusinessModel.findById(businessId, { name: 1 }).lean().exec(),
      UserModel.findById(front.customer_id, { display_name: 1 }).lean().exec(),
    ]);
    notificationsService.notify(front.customer_id, {
      category: 'order',
      title: 'You’re up!',
      body: `${biz?.name ?? 'The vendor'} is serving you now — head to the window.`,
      data: { businessId },
    });
    return { servedCustomerName: user?.display_name || 'A customer', remaining: entries.length - 1 };
  },

  /** The customer's own wave-down history (C-25). Enriched with the target's name in one read. */
  async listMyWaveDowns(customerId: string, limit = 30) {
    const waves = await repo.listWaveDownsByCustomer(customerId, limit);
    if (waves.length === 0) return [];
    const bizIds = waves.filter((w) => w.target_type === 'business').map((w) => w.target_id);
    const bizzes = await BusinessModel.find({ _id: { $in: [...new Set(bizIds)] } }, { name: 1 })
      .lean()
      .exec();
    const nameById = new Map(bizzes.map((b) => [String(b._id), b.name]));
    return waves.map((w) => ({
      id: String(w._id),
      targetType: w.target_type,
      targetId: w.target_id,
      businessName: w.target_type === 'business' ? nameById.get(w.target_id) ?? 'A vendor' : 'A seller',
      status: w.status,
      note: w.note ?? null,
      requestedAt: w.requested_at,
    }));
  },

  /**
   * Fetch a single wave-down. Viewable by the customer who raised it or the target's owner. This is
   * what the customer's tracker polls to see the vendor accept/decline — so it carries the target's
   * name, letting the screen render on a cold load (e.g. opened from the accepted notification).
   */
  async getWaveDown(principal: Principal, waveDownId: string) {
    const wave = await repo.findWaveDownById(waveDownId);
    if (!wave) throw NotFoundError('Wave-down not found');
    if (wave.customer_id !== principal.userId) {
      await assertOwnerControl(principal, wave.target_type as OwnerType, wave.target_id);
    }
    let targetName: string | null = null;
    if (wave.target_type === 'business') {
      const biz = await BusinessModel.findById(wave.target_id, { name: 1 }).lean().exec();
      targetName = biz?.name ?? null;
    }
    return { ...this.waveView(wave), targetName };
  },

  /** The customer cancels their own still-pending wave-down. */
  async cancelWaveDown(principal: Principal, waveDownId: string) {
    const wave = await repo.findWaveDownById(waveDownId);
    if (!wave) throw NotFoundError('Wave-down not found');
    if (wave.customer_id !== principal.userId) {
      throw ForbiddenError('Not your wave-down', ERROR_CODES.NOT_OWNER);
    }
    const updated = await repo.transitionWaveDown(waveDownId, 'pending', { status: 'cancelled' });
    if (!updated) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Wave-down is ${wave.status}`);
    }
    await publish('wave_down.cancelled', { waveDownId, customerId: principal.userId });
    return { id: waveDownId, status: 'cancelled' };
  },

  waveView(wave: {
    _id: unknown;
    customer_id: string;
    target_type: string;
    target_id: string;
    status: string;
    note?: string | null;
    expires_at: Date;
    eta_seconds?: number | null;
    travel_fee_cents?: number | null;
    convenience_fee_cents?: number | null;
    travel_fee_charged_at?: Date | null;
  }) {
    return {
      id: String(wave._id),
      targetType: wave.target_type,
      targetId: wave.target_id,
      status: wave.status,
      note: wave.note ?? null,
      expiresAt: wave.expires_at,
      etaSeconds: wave.eta_seconds ?? null,
      // §32.4: the snapshotted fees travel with the request, so the tracker keeps showing the
      // customer what they'll owe right up to the moment they pay.
      ...waveFeeDisclosure(wave.travel_fee_cents ?? 0, wave.convenience_fee_cents ?? 0),
      travelFeeCharged: Boolean(wave.travel_fee_charged_at),
    };
  },

  async expireWaveDowns(): Promise<number> {
    const now = new Date();
    const due = await repo.expirePendingWaveDowns(now, SWEEP_BATCH_LIMIT);
    let expired = 0;
    for (const w of due) {
      const updated = await repo.transitionWaveDown(String(w._id), 'pending', {
        status: 'expired',
      });
      if (updated) {
        expired += 1;
        notificationsService.notify(w.customer_id, {
          category: 'wave_down',
          title: 'Wave down expired',
          body: 'The vendor did not respond in time',
          data: { waveDownId: String(w._id) },
        });
      }
    }
    return expired;
  },

  // ─── Queue / line-up ────────────────────────────────────────────────────────────────────
  async joinQueue(principal: Principal, ownerType: OwnerType, ownerId: string) {
    // Internal join returns just the entry facts; the customer's screen needs the full membership
    // (business name, hold deadline, ahead count, status), so build and return that.
    await this.joinQueueInternal(principal.userId, ownerType, ownerId);
    return this.getMembership(principal.userId, ownerType, ownerId);
  },

  /**
   * The customer's own place in a line (C-20). Returns null when they aren't in it — the client
   * treats null as "not joined yet" and joins. Derived live from active entries; positions renumber
   * as people ahead are served (they leave the queue), so there is no stored position to drift.
   */
  async getMembership(customerId: string, ownerType: OwnerType, ownerId: string) {
    const queue = await repo.findQueue(ownerType, ownerId);
    if (!queue) return null;
    const entries = await repo.activeEntries(String(queue._id));
    const idx = entries.findIndex((e) => e.customer_id === customerId);
    if (idx < 0) return null;
    const entry = entries[idx]!;
    const position = idx + 1;

    const schedule = await this.getDiscountSchedule(ownerType, ownerId);
    let businessName = 'Business';
    if (ownerType === 'business') {
      const biz = await BusinessModel.findById(ownerId, { name: 1 }).lean().exec();
      businessName = biz?.name ?? businessName;
    }
    return {
      ownerId,
      businessName,
      position,
      aheadCount: idx,
      // People served leave the line, so there is no historical "served" counter to expose.
      nowServing: 0,
      discountPercent: entry.discount_percent_locked ?? 0,
      cap: 0,
      schedule: schedule.tiers.map((t) => ({
        position: t.position ?? 0,
        percent: t.discount_percent ?? 0,
      })),
      holdDeadline: entry.hold_expires_at ? (entry.hold_expires_at as Date).toISOString() : undefined,
      status: position === 1 ? 'your_turn' : 'in_line',
    };
  },

  async joinQueueInternal(customerId: string, ownerType: OwnerType, ownerId: string) {
    const queue = await repo.getOrCreateQueue(ownerType, ownerId);
    if (queue.status !== 'open') throw ConflictError(ERROR_CODES.QUEUE_CLOSED, 'Queue is closed');
    const queueId = String(queue._id);

    const existing = await repo.activeEntryFor(queueId, customerId);
    if (existing) {
      const ahead = await repo.countActiveBefore(queueId, existing.joined_at);
      return {
        entryId: String(existing._id),
        position: ahead + 1,
        discountPercent: existing.discount_percent_locked,
        alreadyInQueue: true,
      };
    }

    const joinedAt = new Date();
    const ahead = await repo.countActiveBefore(queueId, joinedAt);
    const position = ahead + 1;
    const schedule = await repo.getSchedule(ownerType, ownerId);
    const { percent: discountPercent } = discountForPosition(schedule, position, {
      ownerType,
      ownerId,
    });

    const entry = await repo.createEntry({
      queue_id: queueId,
      customer_id: customerId,
      joined_at: joinedAt,
      discount_percent_locked: discountPercent, // locked at join (FR-3.3)
      hold_expires_at: new Date(joinedAt.getTime() + QUEUE_HOLD_DEFAULT_SEC * 1000),
    });
    realtime.queueUpdate(ownerId, await this.buildState(ownerType, ownerId));
    return {
      entryId: String(entry._id),
      position,
      discountPercent,
      alreadyInQueue: false,
    };
  },

  async leaveQueue(principal: Principal, ownerType: OwnerType, ownerId: string) {
    const queue = await repo.findQueue(ownerType, ownerId);
    if (!queue) throw NotFoundError('Queue not found');
    const left = await repo.leaveEntry(String(queue._id), principal.userId);
    if (!left) throw ConflictError(ERROR_CODES.NOT_IN_QUEUE, 'Not in this queue');
    realtime.queueUpdate(ownerId, await this.buildState(ownerType, ownerId));
    return { ok: true };
  },

  async getQueueState(ownerType: OwnerType, ownerId: string) {
    return this.buildState(ownerType, ownerId);
  },

  /**
   * Queue conversion + average wait since `from` (V-11 analytics).
   *
   * "Converted" = the customer was served, i.e. they left the line with `left_at` set rather than
   * still standing in it. Wait is measured from joining to leaving. Returns zeros for a business
   * that has never run a queue — an empty line is a real answer, not a reason to invent one.
   */
  async conversionSince(businessId: string, from: Date) {
    const queue = await repo.findQueue('business', businessId);
    if (!queue) return { conversion: 0, joined: 0, avgWaitMin: 0 };

    const entries = await QueueEntryModel.find({
      queue_id: queue._id,
      joined_at: { $gte: from },
    })
      .lean()
      .exec();
    if (entries.length === 0) return { conversion: 0, joined: 0, avgWaitMin: 0 };

    const served = entries.filter((e) => e.left_at);
    const waitMs = served.reduce(
      (sum, e) => sum + ((e.left_at as Date).getTime() - (e.joined_at as Date).getTime()),
      0,
    );
    return {
      joined: entries.length,
      conversion: served.length / entries.length,
      avgWaitMin: served.length > 0 ? Math.round(waitMs / served.length / 60_000) : 0,
    };
  },

  /**
   * The vendor's queue-management view (V-04). Unlike the public queue read, this is owner-gated and
   * carries the customers' NAMES (never expose who's in a line publicly) plus the active live-session
   * id, so the screen can show the line and trigger a Pop-Up. Business-scoped.
   */
  async getManageView(businessId: string) {
    const queue = await repo.findQueue('business', businessId);
    const schedule = await this.getDiscountSchedule('business', businessId);
    const session = await LiveSessionModel.findOne(
      { actor_type: 'business', actor_id: businessId, ended_at: null },
      { _id: 1 },
    )
      .lean()
      .exec();
    const activeSessionId = session ? String(session._id) : null;
    if (!queue) return { count: 0, entries: [], schedule, activeSessionId };

    const entries = await repo.activeEntries(String(queue._id));
    const ids = [...new Set(entries.map((e) => e.customer_id))];
    const users = await UserModel.find({ _id: { $in: ids } }, { display_name: 1 }).lean().exec();
    const nameById = new Map(users.map((u) => [String(u._id), u.display_name]));
    return {
      count: entries.length,
      entries: entries.map((e, i) => ({
        position: i + 1,
        customerName: nameById.get(e.customer_id) || 'A customer',
        discountPercent: e.discount_percent_locked ?? 0,
        joinedAt: e.joined_at,
      })),
      schedule, // { tiers: [{ position, discount_percent }], capPercent }
      activeSessionId,
    };
  },

  async buildState(ownerType: OwnerType, ownerId: string) {
    const queue = await repo.findQueue(ownerType, ownerId);
    const schedule = await this.getDiscountSchedule(ownerType, ownerId);
    if (!queue) return { ownerId, status: 'open', entries: [], schedule };
    const entries = await repo.activeEntries(String(queue._id));
    return {
      ownerId,
      status: queue.status,
      entries: entries.map((e, i) => ({
        customerId: e.customer_id,
        position: i + 1, // derived live from join order (FR-3.2)
        discountPercent: e.discount_percent_locked, // locked at join (FR-3.3)
        joinedAt: e.joined_at,
      })),
      schedule,
    };
  },

  /** Pop-Up Mode / delay: notify every waiting customer in the owner's active queue. */
  async notifyActiveQueueDelay(
    ownerType: OwnerType,
    ownerId: string,
    reason: string,
  ): Promise<number> {
    const queue = await repo.findQueue(ownerType, ownerId);
    if (!queue) return 0;
    const entries = await repo.activeEntries(String(queue._id));
    for (const e of entries) {
      notificationsService.notify(e.customer_id, {
        category: 'popup_delay',
        title: 'Heads up — a short delay',
        body: 'The vendor has stopped to serve the current line',
        data: { ownerId, reason },
      });
    }
    if (entries.length > 0) {
      realtime.popupDelay(ownerId, { reason, affected: entries.length });
      await repo.createPopUpEvent(ownerType, ownerId, entries.length);
    }
    return entries.length;
  },

  async expireHolds(): Promise<number> {
    const now = new Date();
    const due = await repo.expireHolds(now, SWEEP_BATCH_LIMIT);
    for (const e of due) await repo.markLeft(String(e._id));
    return reportSweepBatch('queue-hold-expiry', due.length);
  },

  /**
   * Per-owner Trending inputs (R1b): the best discount a customer could get (the *boost*) and the
   * current line length (live demand). Batched — one pair of queries for the whole candidate page.
   * Owners with no schedule simply score 0 on discount; absence is never a penalty beyond that.
   */
  async trendingSignals(
    ownerType: OwnerType,
    ownerIds: string[],
  ): Promise<Map<string, { discountPercent: number; queueCount: number }>> {
    const out = new Map<string, { discountPercent: number; queueCount: number }>();
    if (ownerIds.length === 0) return out;
    const [schedules, counts] = await Promise.all([
      repo.schedulesForOwners(ownerType, ownerIds),
      repo.activeCountsForOwners(ownerType, ownerIds),
    ]);
    const discountByOwner = new Map<string, number>();
    for (const s of schedules) {
      // The cap is the ceiling and (by the set-schedule rule) never below the biggest tier, so the
      // best available discount is max(cap, tiers) — defensive against legacy rows.
      const maxTier = Math.max(0, ...s.tiers.map((t) => t.discount_percent ?? 0));
      discountByOwner.set(s.owner_id, Math.max(maxTier, s.cap_percent ?? 0));
    }
    for (const id of ownerIds) {
      out.set(id, {
        discountPercent: discountByOwner.get(id) ?? 0,
        queueCount: counts.get(id) ?? 0,
      });
    }
    return out;
  },

  /**
   * The discount a customer has locked in this owner's line, or 0 if they aren't in it. Used by the
   * order quote + place paths (R9) so the previewed and charged totals agree — same source the
   * checkout path reads from.
   */
  async lockedDiscountFor(ownerType: OwnerType, ownerId: string, userId: string): Promise<number> {
    const queue = await repo.findQueue(ownerType, ownerId);
    if (!queue) return 0;
    const entry = await repo.activeEntryFor(String(queue._id), userId);
    return entry ? entry.discount_percent_locked : 0;
  },

  // ─── Checkout with the locked line-up discount (Phase 2 exit) ────────────────────────────
  async checkout(
    principal: Principal,
    ownerType: OwnerType,
    ownerId: string,
    input: {
      baseAmountCents: number;
      tipCents?: number;
      roundUpCents?: number;
      idempotencyKey: string;
    },
  ) {
    const queue = await repo.findQueue(ownerType, ownerId);
    let discountPercent = 0;
    let entryId: string | null = null;
    if (queue) {
      const entry = await repo.activeEntryFor(String(queue._id), principal.userId);
      if (entry) {
        discountPercent = entry.discount_percent_locked;
        entryId = String(entry._id);
      }
    }
    const tip = input.tipCents ?? 0;
    const roundUp = input.roundUpCents ?? 0;
    const discountCents = Math.floor((input.baseAmountCents * discountPercent) / 100);

    /**
     * §32.4 travel fee. The vendor drove to the customer, so the fee they set — and that the
     * customer was shown when the wave was raised — is collected on the checkout that follows.
     * Claimed atomically BEFORE the charge: a lost race must under-charge, never double-charge a
     * customer for a single trip. It is part of the vendor's revenue, so it sits inside the fee
     * base and is not discounted (a line-up discount rewards waiting, not travel).
     */
    const wave = await repo.findChargeableWaveDown(principal.userId, ownerType, ownerId);
    let travelFeeCents = 0;
    let convenienceFeeCents = 0;
    if (wave) {
      const claimed = await repo.markTravelFeeCharged(String(wave._id));
      if (claimed) {
        travelFeeCents = claimed.travel_fee_cents ?? 0;
        convenienceFeeCents = claimed.convenience_fee_cents ?? 0;
      }
    }

    const chargeAmount =
      input.baseAmountCents - discountCents + travelFeeCents + convenienceFeeCents + tip + roundUp;

    const charge = await paymentsService.charge({
      customerId: principal.userId,
      counterpartyType: ownerType === 'business' ? 'business' : 'seller',
      counterpartyId: ownerId,
      amountCents: chargeAmount,
      discountAppliedCents: discountCents,
      tipCents: tip,
      roundUpCents: roundUp,
      /**
       * The convenience fee is the PLATFORM's, so it rides the same `serviceFeeCents` channel the
       * order path uses: excluded from the vendor's marketplace-fee base (no fee on a fee) and
       * treated correctly by the refund policy. The travel fee is the vendor's revenue and stays in
       * the base.
       */
      serviceFeeCents: convenienceFeeCents,
      idempotencyKey: input.idempotencyKey,
    });

    // A replayed idempotent charge collected nothing new, so release the claim rather than
    // pocketing a fee against a transaction that was never created twice.
    if (charge.replay && wave && travelFeeCents > 0) {
      await repo.releaseTravelFeeClaim(String(wave._id));
    }

    if (entryId && !charge.replay) {
      await repo.markLeft(entryId); // served → leave the line
      realtime.queueUpdate(ownerId, await this.buildState(ownerType, ownerId));
    }
    await writeAudit({
      actorId: principal.userId,
      action: 'queue.checkout',
      entityType: 'transaction',
      entityId: charge.transactionId,
      metadata: { discountPercent, discountCents, travelFeeCents, convenienceFeeCents, chargeAmount },
    });
    return {
      ...charge,
      discountPercent,
      discountAppliedCents: discountCents,
      travelFeeCents,
      convenienceFeeCents,
      chargeAmountCents: chargeAmount,
    };
  },
};
