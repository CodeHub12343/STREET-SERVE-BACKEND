import { SPOT_ME_MIN_ACCOUNT_AGE_DAYS } from '../../config/constants';
import { TIER_RANK } from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { identityService } from '../identity/identity.service';
import { notificationsService } from '../notifications/notifications.service';
import { trustService } from '../trust/trust.service';
import { SpotMeModel } from './growth.model';

export const spotMeService = {
  /**
   * The signed-in user's Spot-Me requests, newest first (SCREEN_TO_API_MAPPING C-35). Only the
   * requester's own rows — this is the wallet's "what do I still owe" view, so it never exposes
   * anyone else's obligations.
   */
  async listMine(userId: string) {
    const rows = await SpotMeModel.find({ requester_id: userId })
      .sort({ created_at: -1 })
      .limit(50)
      .lean()
      .exec();
    return rows.map((r) => ({
      id: String(r._id),
      counterpartyType: r.counterparty_type,
      counterpartyId: r.counterparty_id,
      amountCents: r.amount_cents,
      repayBy: r.repay_by,
      status: r.status,
      decidedAt: r.decided_at,
      createdAt: (r as { created_at?: Date }).created_at ?? null,
      /** Still owed: accepted but not yet repaid (defaulted stays outstanding until settled). */
      outstanding: r.status === 'accepted' || r.status === 'defaulted',
    }));
  },

  /**
   * Request Spot Me credit. Gated: account age ≥ 30 days AND verification ≥ Bronze (Business
   * Rules §3). Acceptance is trust-informed and at the counterparty's discretion.
   */
  async request(
    principal: Principal,
    input: {
      counterpartyType: 'vendor' | 'peer';
      counterpartyId: string;
      amountCents: number;
      repayBy: string;
    },
  ) {
    const ageDays = await identityService.getAccountAgeDays(principal.userId);
    const tierOk = TIER_RANK[principal.verificationTier] >= TIER_RANK.bronze;
    if (ageDays < SPOT_ME_MIN_ACCOUNT_AGE_DAYS || !tierOk) {
      throw BusinessRuleError(
        ERROR_CODES.SPOT_ME_INELIGIBLE,
        'Spot Me requires an account at least 30 days old and Bronze verification',
      );
    }
    const requesterScore = await trustService.getScore('seller', principal.userId);
    const spot = await SpotMeModel.create({
      requester_id: principal.userId,
      counterparty_type: input.counterpartyType,
      counterparty_id: input.counterpartyId,
      amount_cents: input.amountCents,
      repay_by: new Date(input.repayBy),
    });
    await publish('spot_me.requested', {
      spotMeId: String(spot._id),
      requesterId: principal.userId,
    });
    return {
      id: String(spot._id),
      status: spot.status,
      amountCents: spot.amount_cents,
      requesterTrustScore: requesterScore.score,
    };
  },

  async decide(principal: Principal, spotMeId: string, accept: boolean) {
    const spot = await SpotMeModel.findById(spotMeId).exec();
    if (!spot) throw NotFoundError('Spot Me request not found');
    if (spot.counterparty_id !== principal.userId) {
      throw ForbiddenError('Not the counterparty', ERROR_CODES.NOT_PARTICIPANT);
    }
    const updated = await SpotMeModel.findOneAndUpdate(
      { _id: spotMeId, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'declined', decided_at: new Date() } },
      { new: true },
    ).exec();
    if (!updated)
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Request already decided');
    notificationsService.notify(spot.requester_id, {
      category: 'spot_me',
      title: 'Spot Me update',
      body: accept ? 'Your Spot Me request was accepted' : 'Your Spot Me request was declined',
      data: { spotMeId },
    });
    return { id: spotMeId, status: updated.status };
  },

  async repay(principal: Principal, spotMeId: string) {
    const spot = await SpotMeModel.findById(spotMeId).exec();
    if (!spot) throw NotFoundError('Spot Me request not found');
    if (spot.requester_id !== principal.userId) {
      throw ForbiddenError('Not the requester', ERROR_CODES.NOT_OWNER);
    }
    const updated = await SpotMeModel.findOneAndUpdate(
      { _id: spotMeId, status: 'accepted' },
      { $set: { status: 'repaid' } },
      { new: true },
    ).exec();
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Nothing to repay');
    return { id: spotMeId, status: 'repaid' };
  },

  /**
   * Default sweep: accepted requests past repay-by become defaulted. The consequence is
   * reputational (Trust recompute), never debt collection (platform ethos, FR-6.3).
   */
  async sweepDefaults(): Promise<number> {
    const overdue = await SpotMeModel.find({ status: 'accepted', repay_by: { $lt: new Date() } })
      .limit(500)
      .exec();
    let count = 0;
    for (const s of overdue) {
      const moved = await SpotMeModel.findOneAndUpdate(
        { _id: s._id, status: 'accepted' },
        { $set: { status: 'defaulted' } },
        { new: true },
      ).exec();
      if (!moved) continue;
      await writeAudit({
        actorId: s.requester_id,
        action: 'spot_me.defaulted',
        entityType: 'spot_me',
        entityId: String(s._id),
        reason: 'repay_by_passed',
      });
      await trustService.recompute('seller', s.requester_id);
      await publish('spot_me.defaulted', { spotMeId: String(s._id), requesterId: s.requester_id });
      count += 1;
    }
    return count;
  },
};
