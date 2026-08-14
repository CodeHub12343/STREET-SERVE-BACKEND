import {
  DiscountScheduleModel,
  PopUpEventModel,
  QueueEntryModel,
  QueueModel,
  WaveDownModel,
} from './queue.model';

type OwnerType = 'business' | 'seller';

export const queueRepository = {
  // ─── Discount schedule ──────────────────────────────────────────────────────────────────
  upsertSchedule(
    ownerType: OwnerType,
    ownerId: string,
    tiers: { position: number; discount_percent: number }[],
    capPercent: number,
  ) {
    return DiscountScheduleModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: ownerId },
      { $set: { tiers, cap_percent: capPercent } },
      { upsert: true, new: true },
    ).exec();
  },
  getSchedule(ownerType: OwnerType, ownerId: string) {
    return DiscountScheduleModel.findOne({ owner_type: ownerType, owner_id: ownerId })
      .lean()
      .exec();
  },
  /** Batched schedule read — Trending scores a page of owners in one query, not one query each. */
  schedulesForOwners(ownerType: OwnerType, ownerIds: string[]) {
    return DiscountScheduleModel.find({
      owner_type: ownerType,
      owner_id: { $in: ownerIds },
    })
      .lean()
      .exec();
  },

  /**
   * Active (still-in-line) entry count per owner — Trending's live demand signal. Two batched reads
   * (queues, then a grouped count of their entries) regardless of how many owners are scored.
   */
  async activeCountsForOwners(
    ownerType: OwnerType,
    ownerIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ownerIds.length === 0) return out;
    const queues = await QueueModel.find({ owner_type: ownerType, owner_id: { $in: ownerIds } })
      .select({ _id: 1, owner_id: 1 })
      .lean()
      .exec();
    if (queues.length === 0) return out;
    const ownerByQueue = new Map(queues.map((q) => [String(q._id), q.owner_id]));
    const rows = await QueueEntryModel.aggregate<{ _id: unknown; count: number }>([
      { $match: { queue_id: { $in: queues.map((q) => q._id) }, left_at: null } },
      { $group: { _id: '$queue_id', count: { $sum: 1 } } },
    ]).exec();
    for (const r of rows) {
      const owner = ownerByQueue.get(String(r._id));
      if (owner) out.set(owner, r.count);
    }
    return out;
  },

  // ─── Wave-downs ─────────────────────────────────────────────────────────────────────────
  createWaveDown(data: {
    customer_id: string;
    target_type: OwnerType;
    target_id: string;
    note: string | null;
    requested_at: Date;
    expires_at: Date;
    travel_fee_cents: number | null;
    convenience_fee_cents: number;
  }) {
    return WaveDownModel.create(data);
  },
  /**
   * The customer's accepted, still-unbilled wave-down for this vendor — the one whose travel fee
   * the imminent checkout should collect (spec §32.4). Newest first, so a repeat customer pays the
   * fee attached to the trip actually being made.
   */
  findChargeableWaveDown(customerId: string, targetType: OwnerType, targetId: string) {
    return WaveDownModel.findOne({
      customer_id: customerId,
      target_type: targetType,
      target_id: targetId,
      status: 'accepted',
      travel_fee_charged_at: null,
      // Either fee makes this billable — a vendor with no travel fee can still owe the platform's.
      $or: [{ travel_fee_cents: { $gt: 0 } }, { convenience_fee_cents: { $gt: 0 } }],
    })
      .sort({ accepted_at: -1 })
      .exec();
  },
  /** Claim the travel fee atomically, so a retried checkout can never bill the trip twice. */
  markTravelFeeCharged(waveDownId: string) {
    return WaveDownModel.findOneAndUpdate(
      { _id: waveDownId, travel_fee_charged_at: null },
      { $set: { travel_fee_charged_at: new Date() } },
      { new: true },
    ).exec();
  },
  /** Undo a claim whose charge turned out to be an idempotent replay (no new money moved). */
  releaseTravelFeeClaim(waveDownId: string) {
    return WaveDownModel.updateOne(
      { _id: waveDownId },
      { $set: { travel_fee_charged_at: null } },
    ).exec();
  },
  findWaveDownById(id: string) {
    return WaveDownModel.findById(id).exec();
  },
  transitionWaveDown(id: string, from: string, patch: Record<string, unknown>) {
    return WaveDownModel.findOneAndUpdate(
      { _id: id, status: from },
      { $set: patch },
      { new: true },
    ).exec();
  },
  expirePendingWaveDowns(now: Date, limit: number) {
    return WaveDownModel.find({ status: 'pending', expires_at: { $lt: now } })
      .limit(limit)
      .exec();
  },
  /** A customer's own wave-downs, newest first (their history feed). */
  listWaveDownsByCustomer(customerId: string, limit: number) {
    return WaveDownModel.find({ customer_id: customerId })
      .sort({ requested_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  /** The still-live incoming waves for a target (the vendor inbox): pending and not yet expired. */
  findPendingWaveDownsForTarget(targetType: OwnerType, targetId: string, now: Date) {
    return WaveDownModel.find({
      target_type: targetType,
      target_id: targetId,
      status: 'pending',
      expires_at: { $gt: now },
    })
      .sort({ requested_at: 1 })
      .lean()
      .exec();
  },

  // ─── Queues + entries ───────────────────────────────────────────────────────────────────
  getOrCreateQueue(ownerType: OwnerType, ownerId: string) {
    return QueueModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: ownerId },
      { $setOnInsert: { owner_type: ownerType, owner_id: ownerId, status: 'open' } },
      { upsert: true, new: true },
    ).exec();
  },
  findQueue(ownerType: OwnerType, ownerId: string) {
    return QueueModel.findOne({ owner_type: ownerType, owner_id: ownerId }).exec();
  },
  activeEntryFor(queueId: string, customerId: string) {
    return QueueEntryModel.findOne({
      queue_id: queueId,
      customer_id: customerId,
      left_at: null,
    }).exec();
  },
  countActiveBefore(queueId: string, joinedAt: Date) {
    return QueueEntryModel.countDocuments({
      queue_id: queueId,
      left_at: null,
      joined_at: { $lt: joinedAt },
    }).exec();
  },
  createEntry(data: {
    queue_id: string;
    customer_id: string;
    joined_at: Date;
    discount_percent_locked: number;
    hold_expires_at: Date;
  }) {
    return QueueEntryModel.create(data);
  },
  activeEntries(queueId: string) {
    return QueueEntryModel.find({ queue_id: queueId, left_at: null })
      .sort({ joined_at: 1 })
      .lean()
      .exec();
  },
  leaveEntry(queueId: string, customerId: string) {
    return QueueEntryModel.findOneAndUpdate(
      { queue_id: queueId, customer_id: customerId, left_at: null },
      { $set: { left_at: new Date() } },
      { new: true },
    ).exec();
  },
  expireHolds(now: Date, limit: number) {
    return QueueEntryModel.find({ left_at: null, hold_expires_at: { $lt: now } })
      .limit(limit)
      .exec();
  },
  markLeft(entryId: string) {
    return QueueEntryModel.findByIdAndUpdate(entryId, { $set: { left_at: new Date() } }).exec();
  },

  createPopUpEvent(ownerType: OwnerType, ownerId: string, notifiedCount: number) {
    return PopUpEventModel.create({
      owner_type: ownerType,
      owner_id: ownerId,
      notified_count: notifiedCount,
    });
  },
};
