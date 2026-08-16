import { DRIVER_MIN_TIER, TIER_RANK, type DriverVehicleType, type Tier } from '../../config/constants';
import { reportSweepBatch, SWEEP_BATCH_LIMIT } from '../../jobs/sweepBatch';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { identityRepository } from '../identity/identity.repository';
import { notificationsService } from '../notifications/notifications.service';
import { DriverProfileModel } from './delivery.model';

/**
 * Driver vetting and eligibility (ADR-004 §3/§4).
 *
 * ## The one thing this file must never do
 *
 * It must never tell a driver they are covered. The platform's own liability policy protects the
 * PLATFORM; a driver's cover is the driver's own, and the copy rule (CR-3) forbids attributing it.
 * Everything here is phrased as the driver's obligation and an expiry date the platform merely
 * records — see the model comment.
 *
 * Equally: there is no acceptance rate here, and no score. Declining an offer is free and leaves no
 * trace, because a right to decline that carries a penalty is not a right to decline.
 */

/** Everything that must be true before a driver may receive offers. */
export interface DriverEligibility {
  eligible: boolean;
  reasons: string[];
}

export const driverService = {
  async getProfile(userId: string) {
    const p = await DriverProfileModel.findOne({ user_id: userId }).lean();
    if (!p) return null;
    return {
      userId: p.user_id,
      vehicleType: p.vehicle_type,
      vehicleDescription: p.vehicle_description ?? null,
      status: p.status,
      backgroundCheckStatus: p.background_check_status,
      insuranceExpiresAt: p.insurance_expires_at ?? null,
      licenceExpiresAt: p.licence_expires_at ?? null,
      suspendedReason: p.suspended_reason ?? null,
      emergencyContactName: p.emergency_contact_name ?? null,
    };
  },

  /**
   * Apply to drive. Creates a `pending` profile — approval is a separate, human step, because the
   * background check is.
   *
   * The attestations are recorded as stated. The platform does not verify the policy and does not
   * advise on whether it permits delivery use; that is the driver's own responsibility, and saying
   * otherwise is the harm ADR-003 §2 refused to risk.
   */
  async apply(
    principal: Principal,
    input: {
      vehicleType: DriverVehicleType;
      vehicleDescription?: string;
      licenceExpiresAt: string;
      insuranceExpiresAt: string;
      emergencyContactName?: string;
      emergencyContactPhone?: string;
    },
  ) {
    /**
     * ═══ Ask Stripe before refusing them. ═══
     *
     * Driving needs Silver, and Silver IS the bank-account verification — which is approved only
     * when a payout account becomes payouts-enabled. That approval hung entirely off the
     * `account.updated` webhook, so someone who had finished Stripe onboarding and watched it
     * succeed was still Bronze, and got told to "verify your identity and bank account" — advice
     * for something they had already done, with no way to act on it.
     *
     * Reconciling here costs one Stripe read on a rare action and turns a permanent block into a
     * self-correcting one. The tier is re-read afterwards because `principal` was resolved before
     * any of this ran.
     */
    let tier = principal.verificationTier;
    if (TIER_RANK[tier] < TIER_RANK[DRIVER_MIN_TIER]) {
      const { paymentsService } = await import('../payments/payments.service');
      await paymentsService.syncAccountFromStripe('user', principal.userId);
      const approved = await identityRepository.approvedVerifications(principal.userId);
      tier = approved.reduce<Tier>(
        (best, rec) => (TIER_RANK[rec.tier] > TIER_RANK[best] ? rec.tier : best),
        'tier0',
      );
    }
    if (TIER_RANK[tier] < TIER_RANK[DRIVER_MIN_TIER]) {
      throw ForbiddenError(
        /**
         * Names the ONE thing that is actually missing. "Verify your identity and bank account" was
         * refusing people who had done half of it without saying which half, and identity alone
         * (Bronze) is never enough — it is always the bank account that is outstanding here.
         */
        TIER_RANK[tier] < TIER_RANK['bronze']
          ? 'Verify your identity before applying to drive — you can do that from your profile'
          : 'Connect a payout account before applying to drive — drivers are paid straight to their bank, so we need somewhere to send it',
        ERROR_CODES.TIER_TOO_LOW,
      );
    }

    const licence = new Date(input.licenceExpiresAt);
    const insurance = new Date(input.insuranceExpiresAt);
    if (licence.getTime() <= Date.now() || insurance.getTime() <= Date.now()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Your licence and insurance must both be in date',
      );
    }

    const profile = await DriverProfileModel.findOneAndUpdate(
      { user_id: principal.userId },
      {
        $set: {
          vehicle_type: input.vehicleType,
          vehicle_description: input.vehicleDescription ?? null,
          licence_expires_at: licence,
          insurance_expires_at: insurance,
          insurance_attested_at: new Date(),
          emergency_contact_name: input.emergencyContactName ?? null,
          emergency_contact_phone: input.emergencyContactPhone ?? null,
        },
        $setOnInsert: { user_id: principal.userId, status: 'pending' },
      },
      { upsert: true, new: true },
    ).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'driver.applied',
      entityType: 'driver_profile',
      entityId: principal.userId,
      metadata: { vehicleType: input.vehicleType },
    });
    return this.getProfile(String(profile.user_id));
  },

  /** Re-attest after a lapse, or ahead of one. Lifts a suspension that was only about dates. */
  async renewAttestation(
    principal: Principal,
    input: { licenceExpiresAt: string; insuranceExpiresAt: string },
  ) {
    const profile = await DriverProfileModel.findOne({ user_id: principal.userId }).exec();
    if (!profile) throw NotFoundError('You have not applied to drive');

    const licence = new Date(input.licenceExpiresAt);
    const insurance = new Date(input.insuranceExpiresAt);
    if (licence.getTime() <= Date.now() || insurance.getTime() <= Date.now()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Your licence and insurance must both be in date',
      );
    }

    // Only a DATE suspension lifts itself. A failed background check or an ops suspension does not,
    // and must not be clearable by the person it was applied to.
    const liftable = profile.status === 'suspended' && profile.suspended_reason === 'lapsed';
    await DriverProfileModel.updateOne(
      { user_id: principal.userId },
      {
        $set: {
          licence_expires_at: licence,
          insurance_expires_at: insurance,
          insurance_attested_at: new Date(),
          ...(liftable ? { status: 'approved', suspended_reason: null } : {}),
        },
      },
    ).exec();
    return this.getProfile(principal.userId);
  },

  /** Ops: record the outcome of the third-party background check, and approve or refuse. */
  async decide(
    principal: Principal,
    userId: string,
    input: { backgroundCheck: 'passed' | 'failed'; approve: boolean; reason?: string },
  ) {
    const profile = await DriverProfileModel.findOne({ user_id: userId }).exec();
    if (!profile) throw NotFoundError('Driver profile not found');

    const approved = input.approve && input.backgroundCheck === 'passed';
    await DriverProfileModel.updateOne(
      { user_id: userId },
      {
        $set: {
          background_check_status: input.backgroundCheck,
          background_check_at: new Date(),
          status: approved ? 'approved' : 'suspended',
          suspended_reason: approved ? null : (input.reason ?? 'not_approved'),
        },
      },
    ).exec();

    notificationsService.notify(userId, {
      category: 'delivery',
      title: approved ? 'You’re approved to drive' : 'Your driver application wasn’t approved',
      body: approved
        ? 'You can go on shift and start receiving delivery offers.'
        : 'Get in touch if you think this is wrong.',
      data: { audience: 'driver' },
    });

    await writeAudit({
      actorId: principal.userId,
      action: approved ? 'driver.approved' : 'driver.refused',
      entityType: 'driver_profile',
      entityId: userId,
      metadata: { backgroundCheck: input.backgroundCheck },
    });
    return this.getProfile(userId);
  },

  /**
   * May this person be offered work right now? Returns every failing reason rather than the first,
   * so a driver fixes one thing and does not discover a second.
   */
  async eligibility(userId: string): Promise<DriverEligibility> {
    const p = await DriverProfileModel.findOne({ user_id: userId }).lean();
    const reasons: string[] = [];
    if (!p) return { eligible: false, reasons: ['no_profile'] };
    if (p.status !== 'approved')
      reasons.push(p.status === 'pending' ? 'awaiting_approval' : 'suspended');
    if (p.background_check_status !== 'passed') reasons.push('background_check');
    const now = Date.now();
    if (!p.licence_expires_at || p.licence_expires_at.getTime() <= now)
      reasons.push('licence_expired');
    if (!p.insurance_expires_at || p.insurance_expires_at.getTime() <= now) {
      reasons.push('insurance_expired');
    }

    /**
     * A payout account is an eligibility requirement, not an afterthought. `payoutTransfer` returns
     * null when there is no payouts-enabled account, so without this check a driver could complete a
     * delivery and simply never be paid — silently, with the delivery marked delivered. Never offer
     * somebody work they cannot be paid for.
     */
    const { ConnectedAccountModel } = await import('../payments/payments.model');
    const account = await ConnectedAccountModel.findOne({
      owner_type: 'user',
      owner_id: userId,
    }).lean();
    if (!account?.payouts_enabled) reasons.push('payout_account');

    return { eligible: reasons.length === 0, reasons };
  },

  /**
   * ADR-004 §3(c) — a lapse suspends dispatch until the driver re-attests.
   *
   * This is a factual eligibility check on a date the driver themselves supplied, not an assessment
   * of whether their cover is adequate. That distinction is what keeps it out of ADR-003's territory.
   */
  async suspendLapsed(): Promise<number> {
    const now = new Date();
    const lapsed = await DriverProfileModel.find({
      status: 'approved',
      $or: [{ insurance_expires_at: { $lte: now } }, { licence_expires_at: { $lte: now } }],
    })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    let suspended = 0;
    for (const p of lapsed) {
      const claimed = await DriverProfileModel.findOneAndUpdate(
        { user_id: p.user_id, status: 'approved' },
        { $set: { status: 'suspended', suspended_reason: 'lapsed' } },
      ).exec();
      if (!claimed) continue;

      notificationsService.notify(p.user_id, {
        category: 'delivery',
        title: 'Your details need updating',
        body: 'Your licence or insurance is out of date, so you won’t get offers until you update it.',
        data: { audience: 'driver' },
      });
      suspended += 1;
    }

    reportSweepBatch('driver-lapse', lapsed.length);
    return suspended;
  },
};
