import { randomInt } from 'node:crypto';

import {
  RESIDENT_MAX_CASH_DEBT_CENTS,
  RESIDENT_MAX_HUB_DISTANCE_M,
  RESIDENT_MAX_INVENTORY_VALUE_CENTS,
  RESIDENT_REQUIRED_TRAINING_SLUG,
  RESIDENT_STARTER_GRANT_LIMIT,
  RESIDENT_STARTER_GRANT_MAX_CENTS,
  SHELTER_ACTIVE_WINDOW_DAYS,
  TRAINING_PASS_PERCENT,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { formatCents } from '../../shared/money';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { consignmentRepository } from '../consignment/consignment.repository';
import { identityService } from '../identity/identity.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  ShelterCustodyModel,
  ShelterEnrollmentModel,
  ShelterPartnerModel,
  TrainingCompletionModel,
} from './shelter.model';
import {
  RESIDENT_STARTER_COURSE_VERSION,
  gradeCourse,
  publicCourse,
} from './training';

const CLAIM_CODE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — a shelter stay, not an hour
/** Unambiguous alphabet: no O/0, I/1, S/5. Staff read these aloud across a front desk. */
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';

function makeClaimCode(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  return out;
}

/** Grant the seller role + the cosigned Bronze-equivalent verification. */
async function activateResident(
  residentUserId: string,
  partnerId: string,
  grantedBy: string,
): Promise<void> {
  await identityService.grantRole(residentUserId, 'seller', grantedBy);
  await identityService.grantShelterCosign(residentUserId, partnerId);
}

export const shelterService = {
  /**
   * Admin registers + verifies a shelter partner org (FR-12.1) and grants the shelter-staff owner
   * the `shelter_admin` capability to enroll residents.
   */
  async registerPartner(
    admin: Principal,
    input: {
      organizationName: string;
      ownerUserId: string;
      lng?: number;
      lat?: number;
    },
  ) {
    const partner = await ShelterPartnerModel.create({
      organization_name: input.organizationName,
      owner_user_id: input.ownerUserId,
      status: 'verified',
      verified_by_admin_id: admin.userId,
      verified_at: new Date(),
      ...(input.lng !== undefined && input.lat !== undefined
        ? { location: { type: 'Point', coordinates: [input.lng, input.lat] } }
        : {}),
    });
    await identityService.grantRole(input.ownerUserId, 'shelter_admin', admin.userId);

    /**
     * TELL THEM. The whole programme now runs on their side of the app and nothing said so.
     *
     * An admin registered an organisation, the role was granted silently, and the person who is
     * meant to do every subsequent step — enrolling residents, holding their money, disbursing it —
     * was never informed that they could. They had no reason to open the app, and nothing to look
     * for if they did.
     */
    notificationsService.notify(input.ownerUserId, {
      category: 'system',
      title: `${input.organizationName} is approved`,
      body: 'You can now enrol residents. Open the Shelter program from the mode switcher to get started — each resident you enrol gets a code to link their account.',
      data: { partnerId: String(partner._id), deeplink: '/shelter' },
    });
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'shelter_partner.verified',
      entityType: 'shelter_partner',
      entityId: String(partner._id),
      metadata: { organizationName: input.organizationName },
    });
    await publish('shelter_partner.verified', { partnerId: String(partner._id) });
    return { id: String(partner._id), status: partner.status, ownerUserId: input.ownerUserId };
  },

  /**
   * ═══ The admin's real view of the programme. ═══
   *
   * There was no way to list shelter partners at all, so the admin screen rendered a hardcoded
   * fixture — two invented organisations with invented enrollment counts — on the production URL,
   * in both demo and live mode. An operator could not see who was actually partnered, how many
   * residents each held, or how much of other people's money was sitting in their custody.
   *
   * Counts are aggregated per partner rather than per row: this list is opened often and a
   * per-partner query would be a fan-out on a page whose whole job is one glance.
   */
  async listPartners(limit = 100) {
    const partners = await ShelterPartnerModel.find()
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    if (partners.length === 0) return [];

    const ids = partners.map((p) => String(p._id));
    const [enrolled, held] = await Promise.all([
      ShelterEnrollmentModel.aggregate<{ _id: string; count: number }>([
        { $match: { shelter_partner_id: { $in: ids }, status: 'active' } },
        { $group: { _id: '$shelter_partner_id', count: { $sum: 1 } } },
      ]).exec(),
      /**
       * Money the shelter is holding FOR residents and has not handed over. The single most
       * important number on this screen: it is the size of the fiduciary duty each partner is
       * currently carrying, and nothing anywhere surfaced it.
       */
      ShelterCustodyModel.aggregate<{ _id: string; total: number }>([
        { $match: { shelter_partner_id: { $in: ids }, status: 'held' } },
        { $group: { _id: '$shelter_partner_id', total: { $sum: '$amount_cents' } } },
      ]).exec(),
    ]);
    const enrolledBy = new Map(enrolled.map((e) => [e._id, e.count]));
    const heldBy = new Map(held.map((h) => [h._id, h.total]));

    return partners.map((p) => ({
      id: String(p._id),
      organizationName: p.organization_name,
      status: p.status,
      ownerUserId: p.owner_user_id,
      residentsEnrolled: enrolledBy.get(String(p._id)) ?? 0,
      custodyHeldCents: heldBy.get(String(p._id)) ?? 0,
      custodyAccepted: p.custody_enabled === true,
      verifiedAt: p.verified_at ?? null,
      createdAt: p.created_at ?? null,
    }));
  },

  /**
   * Suspend a partner, or reinstate one.
   *
   * `suspended` was declared in the model and reachable by no code path — so if a partner
   * mishandled resident money there was no button anywhere that did anything about it. The whole
   * programme rests on organisations holding cash that belongs to people who cannot hold it
   * themselves; "we would have to edit the database" is not an answer to that going wrong.
   *
   * Suspension stops NEW residents and NEW custody: `assertPartnerOwner` and `residentCapabilities`
   * both already require `verified`, so this needs no new enforcement. Residents already enrolled
   * are deliberately untouched, and money already held is deliberately still disbursable — cutting
   * off a resident's access to their own money because their shelter is under review would punish
   * exactly the wrong person.
   */
  async setPartnerStatus(
    admin: Principal,
    partnerId: string,
    status: 'verified' | 'suspended',
    reason?: string,
  ) {
    const partner = await ShelterPartnerModel.findByIdAndUpdate(
      partnerId,
      {
        $set: {
          status,
          ...(status === 'verified'
            ? { verified_by_admin_id: admin.userId, verified_at: new Date() }
            : {}),
        },
      },
      { new: true },
    ).exec();
    if (!partner) throw NotFoundError('Shelter partner not found');

    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: status === 'suspended' ? 'shelter_partner.suspended' : 'shelter_partner.reinstated',
      entityType: 'shelter_partner',
      entityId: partnerId,
      reason: reason ?? null,
      metadata: { organizationName: partner.organization_name },
    });

    const heldAgg = await ShelterCustodyModel.aggregate<{ total: number }>([
      { $match: { shelter_partner_id: partnerId, status: 'held' } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();

    return {
      id: partnerId,
      status: partner.status,
      /**
       * Reported back so the admin is told immediately if they have just suspended a partner who is
       * still holding residents' money. That is not a reason to refuse the suspension — it is the
       * most likely reason to be doing it — but it is the next thing that needs handling.
       */
      custodyHeldCents: heldAgg[0]?.total ?? 0,
    };
  },

  /**
   * WHICH SHELTER DO I RUN?
   *
   * The staff console took its partner id from a query string and there was no way to obtain one:
   * `/shelter` therefore rendered "No shelter linked to this account" for every shelter admin who
   * had ever been registered, because nothing could tell them their own partner id. The console
   * behind it was complete the whole time.
   *
   * Returns null rather than throwing — "you do not run a shelter" is an ordinary answer for most
   * of the people who will ever hit this route, not an error.
   */
  async myPartner(principal: Principal) {
    const partner = await ShelterPartnerModel.findOne({ owner_user_id: principal.userId })
      .lean()
      .exec();
    if (!partner) return null;

    const partnerId = String(partner._id);
    const [residentsEnrolled, custodyHeld] = await Promise.all([
      ShelterEnrollmentModel.countDocuments({
        shelter_partner_id: partnerId,
        status: 'active',
      }).exec(),
      ShelterCustodyModel.aggregate<{ _id: null; total: number }>([
        { $match: { shelter_partner_id: partnerId, status: 'held' } },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ]).exec(),
    ]);

    return {
      id: partnerId,
      organizationName: partner.organization_name,
      /**
       * Reported so the console can say WHY it is refusing to work rather than just refusing.
       * A suspended partner keeps existing residents but takes no new ones.
       */
      status: partner.status,
      custodyAccepted: Boolean(partner.custody_accepted_at),
      residentsEnrolled,
      custodyHeldCents: custodyHeld[0]?.total ?? 0,
    };
  },

  async assertPartnerOwner(principal: Principal, partnerId: string) {
    const partner = await ShelterPartnerModel.findById(partnerId).exec();
    if (!partner) throw NotFoundError('Shelter partner not found');
    if (partner.owner_user_id !== principal.userId) {
      throw ForbiddenError('Not your shelter partner', ERROR_CODES.NOT_OWNER);
    }
    if (partner.status !== 'verified') {
      throw ForbiddenError('Shelter partner is not verified', ERROR_CODES.PARTNER_NOT_VERIFIED);
    }
    return partner;
  },

  /**
   * B-3: accept the custody duty. Explicit and separately recorded because it is a real fiduciary
   * obligation — the shelter will hold money that belongs to someone else. A partner that never
   * accepts simply never receives resident funds; nothing breaks, residents just need their own
   * payout account.
   */
  async setCustody(
    shelterAdmin: Principal,
    partnerId: string,
    input: { enabled: boolean; collectionNote?: string },
  ) {
    await this.assertPartnerOwner(shelterAdmin, partnerId);
    const patch = input.enabled
      ? {
          custody_enabled: true,
          custody_accepted_by: shelterAdmin.userId,
          custody_accepted_at: new Date(),
          custody_collection_note: input.collectionNote ?? null,
        }
      : { custody_enabled: false };

    const updated = await ShelterPartnerModel.findByIdAndUpdate(
      partnerId,
      { $set: patch },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Shelter partner not found');

    await writeAudit({
      actorId: shelterAdmin.userId,
      action: input.enabled ? 'shelter.custody_accepted' : 'shelter.custody_disabled',
      entityType: 'shelter_partner',
      entityId: partnerId,
      metadata: { collectionNote: input.collectionNote ?? null },
    });
    return {
      partnerId,
      custodyEnabled: updated.custody_enabled,
      collectionNote: updated.custody_collection_note ?? null,
    };
  },

  // ─── B-1: invite → claim ─────────────────────────────────────────────────────────────────
  /**
   * Cosign a resident into the program (FR-12.2/12.4). Staff vouch in person for someone in front
   * of them, cap the org's exposure, and hand over a claim code.
   *
   * `residentUserId` is optional now. Requiring it meant staff had to walk the resident through
   * account creation first — in another session, often on a device the resident doesn't own — and
   * then copy a 24-character id back into this form. That is where the funnel died. Enrolling first
   * and claiming later matches how the conversation actually happens at a front desk.
   */
  async enroll(
    shelterAdmin: Principal,
    partnerId: string,
    input: {
      residentUserId?: string;
      cosignedAllocationCents: number;
      staffVerifierName: string;
    },
  ) {
    await this.assertPartnerOwner(shelterAdmin, partnerId);

    if (input.cosignedAllocationCents > RESIDENT_MAX_INVENTORY_VALUE_CENTS) {
      // Refuse rather than silently clamp: a shelter that believes it cosigned $500 has been misled
      // about its own exposure, which is exactly the confusion B-2 exists to remove.
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `A starter cosign is capped at ${formatCents(RESIDENT_MAX_INVENTORY_VALUE_CENTS)} per resident. Raise it later as they build a record.`,
      );
    }

    const claimCode = input.residentUserId ? null : makeClaimCode();
    let enrollment;
    try {
      enrollment = await ShelterEnrollmentModel.create({
        shelter_partner_id: partnerId,
        resident_user_id: input.residentUserId ?? null,
        cosigned_allocation_cents: input.cosignedAllocationCents,
        staff_verifier_name: input.staffVerifierName,
        claim_code: claimCode,
        claim_expires_at: claimCode ? new Date(Date.now() + CLAIM_CODE_TTL_MS) : null,
        claimed_at: input.residentUserId ? new Date() : null,
        status: input.residentUserId ? 'active' : 'invited',
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw ConflictError(ERROR_CODES.DUPLICATE, 'Resident already enrolled with this partner');
      }
      throw err;
    }

    // A directly-enrolled resident is cosigned immediately; an invited one at claim time.
    if (input.residentUserId) {
      await activateResident(input.residentUserId, partnerId, shelterAdmin.userId);
    }

    await writeAudit({
      actorId: shelterAdmin.userId,
      action: 'resident.enrolled',
      entityType: 'shelter_enrollment',
      entityId: String(enrollment._id),
      metadata: { partnerId, cosignedAllocationCents: input.cosignedAllocationCents },
    });
    await publish('resident.enrolled', {
      partnerId,
      residentUserId: input.residentUserId ?? null,
    });

    return {
      id: String(enrollment._id),
      residentUserId: input.residentUserId ?? null,
      cosignedAllocationCents: input.cosignedAllocationCents,
      status: enrollment.status,
      /** Returned ONCE, for staff to write down or read aloud. */
      claimCode,
      claimExpiresAt: enrollment.claim_expires_at,
    };
  },

  /**
   * B-1: the resident claims their invite with the code staff gave them. This is the moment they
   * become a seller — from their side it is one short screen, which is the point.
   */
  async claim(principal: Principal, code: string) {
    const enrollment = await ShelterEnrollmentModel.findOne({
      claim_code: code.trim().toUpperCase(),
      status: 'invited',
    }).exec();

    // One message for every failure mode. A code that reveals whether it existed, was used, or
    // expired is a code that can be probed.
    const invalid = () =>
      BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'That code isn’t valid. Ask the staff member who enrolled you for a new one.',
      );
    if (!enrollment) throw invalid();
    if (enrollment.claim_expires_at && enrollment.claim_expires_at.getTime() < Date.now()) {
      throw invalid();
    }

    const partner = await ShelterPartnerModel.findById(enrollment.shelter_partner_id).lean().exec();
    if (!partner || partner.status !== 'verified') throw invalid();

    // Guard the case where this person is already enrolled with this partner under another row.
    const existing = await ShelterEnrollmentModel.findOne({
      shelter_partner_id: enrollment.shelter_partner_id,
      resident_user_id: principal.userId,
    })
      .lean()
      .exec();
    if (existing) {
      throw ConflictError(ERROR_CODES.DUPLICATE, 'You’re already enrolled with this shelter');
    }

    // Atomic claim: whoever wins the conditional update owns the enrollment. Two people typing the
    // same overheard code must not both get in.
    const claimed = await ShelterEnrollmentModel.findOneAndUpdate(
      { _id: enrollment._id, status: 'invited', resident_user_id: null },
      {
        $set: {
          resident_user_id: principal.userId,
          claimed_at: new Date(),
          status: 'active',
          claim_code: null,
        },
      },
      { new: true },
    ).exec();
    if (!claimed) throw invalid();

    await activateResident(principal.userId, enrollment.shelter_partner_id, partner.owner_user_id);

    await writeAudit({
      actorId: principal.userId,
      action: 'resident.claimed',
      entityType: 'shelter_enrollment',
      entityId: String(enrollment._id),
      metadata: { partnerId: enrollment.shelter_partner_id },
    });
    await publish('resident.enrolled', {
      partnerId: enrollment.shelter_partner_id,
      residentUserId: principal.userId,
    });

    notificationsService.notify(principal.userId, {
      category: 'account',
      title: `Welcome — you're enrolled with ${partner.organization_name}`,
      body: 'Finish the short starter course and you can pick up your first stock today.',
      data: { partnerId: enrollment.shelter_partner_id },
    });

    return {
      enrollmentId: String(enrollment._id),
      partnerId: enrollment.shelter_partner_id,
      organizationName: partner.organization_name,
      cosignedAllocationCents: enrollment.cosigned_allocation_cents,
      trainingRequired: true,
    };
  },

  /** The caller's own active enrollment, or null. Cheap enough to call on any resident screen. */
  async activeEnrollmentFor(userId: string) {
    return ShelterEnrollmentModel.findOne({ resident_user_id: userId, status: 'active' })
      .lean()
      .exec();
  },

  // ─── B-2: the capability matrix ──────────────────────────────────────────────────────────
  /**
   * What a shelter-cosigned resident may currently do, and why. This is the single source the
   * checkout guard, the client, and the shelter console all read — so the number a resident is
   * shown is always the number that will be enforced.
   *
   * Returns null for everyone who isn't an active resident, which is the signal to apply the
   * ordinary rules unchanged.
   */
  async residentCapabilities(userId: string): Promise<{
    partnerId: string;
    organizationName: string;
    enrollmentId: string;
    cosignedAllocationCents: number;
    /** Already committed to live stock — the cosign is a ceiling on concurrent exposure. */
    allocationUsedCents: number;
    allocationRemainingCents: number;
    maxInventoryValueCents: number;
    maxCashDebtCents: number;
    maxHubDistanceM: number | null;
    shelterLocation: [number, number] | null;
    trainingComplete: boolean;
    starterGrantAvailable: boolean;
    custodyEnabled: boolean;
    collectionNote: string | null;
  } | null> {
    const enrollment = await this.activeEnrollmentFor(userId);
    if (!enrollment) return null;

    const partner = await ShelterPartnerModel.findById(enrollment.shelter_partner_id).lean().exec();
    if (!partner || partner.status !== 'verified') return null;

    const heldValue = await consignmentRepository.sumActiveInventoryValue(userId);
    const cosigned = enrollment.cosigned_allocation_cents;
    const coords = partner.location?.coordinates;

    return {
      partnerId: String(partner._id),
      organizationName: partner.organization_name,
      enrollmentId: String(enrollment._id),
      cosignedAllocationCents: cosigned,
      allocationUsedCents: heldValue,
      allocationRemainingCents: Math.max(0, cosigned - heldValue),
      // The platform backstop applies even to a generous cosign.
      maxInventoryValueCents: Math.min(cosigned, RESIDENT_MAX_INVENTORY_VALUE_CENTS),
      maxCashDebtCents: RESIDENT_MAX_CASH_DEBT_CENTS,
      maxHubDistanceM: coords?.length === 2 ? RESIDENT_MAX_HUB_DISTANCE_M : null,
      shelterLocation: coords?.length === 2 ? [coords[0]!, coords[1]!] : null,
      trainingComplete: Boolean(enrollment.training_completed_at),
      starterGrantAvailable: (enrollment.starter_grant_used ?? 0) < RESIDENT_STARTER_GRANT_LIMIT,
      custodyEnabled: partner.custody_enabled === true,
      collectionNote: partner.custody_collection_note ?? null,
    };
  },

  // ─── B-5: training ───────────────────────────────────────────────────────────────────────
  /** The course, without answer keys. Public to any signed-in user — nothing here is sensitive. */
  course() {
    return publicCourse();
  },

  async trainingStatus(userId: string) {
    const best = await TrainingCompletionModel.findOne({
      user_id: userId,
      course_slug: RESIDENT_REQUIRED_TRAINING_SLUG,
      course_version: RESIDENT_STARTER_COURSE_VERSION,
      passed: true,
    })
      .sort({ completed_at: -1 })
      .lean()
      .exec();
    return {
      courseSlug: RESIDENT_REQUIRED_TRAINING_SLUG,
      courseVersion: RESIDENT_STARTER_COURSE_VERSION,
      passed: Boolean(best),
      scorePercent: best?.score_percent ?? null,
      completedAt: best?.completed_at ?? null,
      passMark: TRAINING_PASS_PERCENT,
    };
  },

  /**
   * Submit the course. Failing is not punished — the score is recorded either way and the resident
   * can retake immediately, with the explanations shown for every question. The goal is that they
   * understand the return window, not that they pass a test.
   */
  async submitTraining(
    principal: Principal,
    answers: Array<{ moduleSlug: string; questionId: string; answerIndex: number }>,
  ) {
    const graded = gradeCourse(answers);
    const passed = graded.scorePercent >= TRAINING_PASS_PERCENT;

    await TrainingCompletionModel.create({
      user_id: principal.userId,
      course_slug: RESIDENT_REQUIRED_TRAINING_SLUG,
      course_version: RESIDENT_STARTER_COURSE_VERSION,
      score_percent: graded.scorePercent,
      passed,
    });

    if (passed) {
      // Stamp the enrollment so the checkout guard is one read, not a join.
      await ShelterEnrollmentModel.updateOne(
        { resident_user_id: principal.userId, status: 'active' },
        {
          $set: { training_completed_at: new Date() },
          $max: { training_score_percent: graded.scorePercent },
        },
      ).exec();
      await publish('training.completed', {
        userId: principal.userId,
        courseSlug: RESIDENT_REQUIRED_TRAINING_SLUG,
        scorePercent: graded.scorePercent,
      });
    }

    return {
      passed,
      scorePercent: graded.scorePercent,
      correctCount: graded.correctCount,
      totalCount: graded.totalCount,
      passMark: TRAINING_PASS_PERCENT,
      results: graded.results,
    };
  },

  // ─── B-3: custody ────────────────────────────────────────────────────────────────────────
  /**
   * Record that a payout was transferred into the shelter's account on a resident's behalf. Called
   * from the payout path, never by a client. Idempotent on (source_type, source_ref_id) so a
   * retried webhook cannot double-earmark.
   */
  async recordCustody(input: {
    partnerId: string;
    residentUserId: string;
    amountCents: number;
    sourceType: 'consignment_settlement' | 'sale_payment' | 'job_payout';
    sourceRefId: string;
    transferId: string | null;
  }) {
    if (input.amountCents <= 0) return null;
    try {
      const entry = await ShelterCustodyModel.create({
        shelter_partner_id: input.partnerId,
        resident_user_id: input.residentUserId,
        amount_cents: input.amountCents,
        source_type: input.sourceType,
        source_ref_id: input.sourceRefId,
        transfer_id: input.transferId,
      });

      const partner = await ShelterPartnerModel.findById(input.partnerId).lean().exec();
      notificationsService.notify(input.residentUserId, {
        category: 'payments',
        title: `${formatCents(input.amountCents)} ready to collect`,
        body: partner?.custody_collection_note
          ? `Your earnings are being held for you — ${partner.custody_collection_note}`
          : `Your earnings are being held for you at ${partner?.organization_name ?? 'your shelter'}.`,
        data: { custodyId: String(entry._id), amountCents: input.amountCents },
      });
      // The shelter needs to know it now owes someone cash at the desk.
      if (partner) {
        notificationsService.notify(partner.owner_user_id, {
          category: 'payments',
          title: 'Resident earnings received',
          body: `${formatCents(input.amountCents)} arrived for a resident to collect.`,
          data: { audience: 'shelter', custodyId: String(entry._id) },
        });
      }
      return entry;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null; // already recorded
      throw err;
    }
  },

  /** What the shelter is currently holding, per resident. Staff-facing. */
  async custodyLedger(shelterAdmin: Principal, partnerId: string, status?: 'held' | 'disbursed') {
    await this.assertPartnerOwner(shelterAdmin, partnerId);
    const rows = await ShelterCustodyModel.find({
      shelter_partner_id: partnerId,
      ...(status ? { status } : {}),
    })
      .sort({ created_at: -1 })
      .limit(200)
      .lean()
      .exec();

    const heldCents = rows
      .filter((r) => r.status === 'held')
      .reduce((s, r) => s + r.amount_cents, 0);

    return {
      partnerId,
      heldCents,
      entries: rows.map((r) => ({
        id: String(r._id),
        residentUserId: r.resident_user_id,
        amountCents: r.amount_cents,
        sourceType: r.source_type,
        status: r.status,
        createdAt: r.created_at,
        disbursedAt: r.disbursed_at,
        disbursementMethod: r.disbursement_method,
        residentAcknowledged: Boolean(r.resident_ack_at),
      })),
    };
  },

  /** Staff hand the money over and say so. */
  async disburseCustody(
    shelterAdmin: Principal,
    partnerId: string,
    custodyId: string,
    input: { method: 'cash' | 'in_kind' | 'stored'; note?: string },
  ) {
    await this.assertPartnerOwner(shelterAdmin, partnerId);
    const updated = await ShelterCustodyModel.findOneAndUpdate(
      { _id: custodyId, shelter_partner_id: partnerId, status: 'held' },
      {
        $set: {
          status: 'disbursed',
          disbursed_at: new Date(),
          disbursed_by: shelterAdmin.userId,
          disbursement_method: input.method,
          note: input.note ?? null,
        },
      },
      { new: true },
    ).exec();
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'That entry is not currently held — it may already have been handed over.',
      );
    }

    await writeAudit({
      actorId: shelterAdmin.userId,
      action: 'shelter.custody_disbursed',
      entityType: 'shelter_custody',
      entityId: custodyId,
      metadata: { amountCents: updated.amount_cents, method: input.method },
    });
    notificationsService.notify(updated.resident_user_id, {
      category: 'payments',
      title: `${formatCents(updated.amount_cents)} handed over`,
      body: 'Tap to confirm you received it — that closes it out on your record.',
      data: { custodyId, needsAck: true },
    });
    return { id: custodyId, status: updated.status, amountCents: updated.amount_cents };
  },

  /** The resident's own view: what's waiting, and where to collect it. */
  async myCustody(userId: string) {
    const rows = await ShelterCustodyModel.find({ resident_user_id: userId })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    const held = rows.filter((r) => r.status === 'held');
    const partnerIds = [...new Set(rows.map((r) => r.shelter_partner_id))];
    const partners = await ShelterPartnerModel.find({ _id: { $in: partnerIds } })
      .lean()
      .exec();
    const byId = new Map(partners.map((p) => [String(p._id), p]));

    return {
      heldCents: held.reduce((s, r) => s + r.amount_cents, 0),
      entries: rows.map((r) => {
        const p = byId.get(r.shelter_partner_id);
        return {
          id: String(r._id),
          amountCents: r.amount_cents,
          status: r.status,
          sourceType: r.source_type,
          createdAt: r.created_at,
          disbursedAt: r.disbursed_at,
          acknowledged: Boolean(r.resident_ack_at),
          organizationName: p?.organization_name ?? 'your shelter',
          collectionNote: p?.custody_collection_note ?? null,
        };
      }),
    };
  },

  /** The resident confirms receipt. Their own record, closed by their own hand. */
  async acknowledgeCustody(principal: Principal, custodyId: string) {
    const updated = await ShelterCustodyModel.findOneAndUpdate(
      { _id: custodyId, resident_user_id: principal.userId, resident_ack_at: null },
      { $set: { resident_ack_at: new Date() } },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Nothing to confirm');
    return { id: custodyId, acknowledged: true };
  },

  // ─── B-4: starter grant ──────────────────────────────────────────────────────────────────
  /**
   * Consume the resident's one-time starter grant. Called by the checkout path when a resident
   * takes their first stock: it records that the shelter's cosign — not the resident — carries the
   * downside on this checkout, so an unsold first pickup writes no debt against the person.
   *
   * Returns false when they've already used it, which is not an error: the checkout proceeds under
   * the ordinary rules.
   */
  async consumeStarterGrant(userId: string, valueCents: number): Promise<boolean> {
    if (valueCents > RESIDENT_STARTER_GRANT_MAX_CENTS) return false;
    const updated = await ShelterEnrollmentModel.findOneAndUpdate(
      {
        resident_user_id: userId,
        status: 'active',
        starter_grant_used: { $lt: RESIDENT_STARTER_GRANT_LIMIT },
      },
      { $inc: { starter_grant_used: 1 } },
      { new: true },
    ).exec();
    if (!updated) return false;

    await writeAudit({
      actorId: userId,
      action: 'resident.starter_grant_used',
      entityType: 'shelter_enrollment',
      entityId: String(updated._id),
      metadata: { valueCents, partnerId: updated.shelter_partner_id },
    });
    await publish('resident.starter_grant_used', {
      residentUserId: userId,
      partnerId: updated.shelter_partner_id,
      valueCents,
    });
    return true;
  },

  /**
   * Exit a resident from the program. Capabilities revert to their own verification tier — which,
   * for someone who never added ID, means they can no longer take stock. Deliberately does NOT
   * revoke the cosign verification record: it happened, and the audit trail is not rewritten.
   */
  async exitResident(
    shelterAdmin: Principal,
    partnerId: string,
    enrollmentId: string,
    reason?: string,
  ) {
    await this.assertPartnerOwner(shelterAdmin, partnerId);
    const updated = await ShelterEnrollmentModel.findOneAndUpdate(
      { _id: enrollmentId, shelter_partner_id: partnerId, status: { $in: ['invited', 'active'] } },
      { $set: { status: 'exited', exited_at: new Date(), exit_reason: reason ?? null, claim_code: null } },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Enrollment not found or already closed');

    // Money already held for them is still theirs — exiting the program does not forfeit it.
    const outstanding = await ShelterCustodyModel.countDocuments({
      shelter_partner_id: partnerId,
      resident_user_id: updated.resident_user_id,
      status: 'held',
    }).exec();

    await writeAudit({
      actorId: shelterAdmin.userId,
      action: 'resident.exited',
      entityType: 'shelter_enrollment',
      entityId: enrollmentId,
      metadata: { partnerId, reason: reason ?? null, outstandingCustodyEntries: outstanding },
    });
    return { id: enrollmentId, status: 'exited' as const, outstandingCustodyEntries: outstanding };
  },

  /**
   * Aggregate, privacy-preserving outcome report (FR-12.3): counts + totals only, never raw
   * per-resident transaction detail. Serves the shelter's own funder reporting.
   */
  async report(shelterAdmin: Principal, partnerId: string) {
    const partner = await this.assertPartnerOwner(shelterAdmin, partnerId);
    const enrollments = await ShelterEnrollmentModel.find({ shelter_partner_id: partnerId })
      .lean()
      .exec();
    const active = enrollments.filter((e) => e.status === 'active');
    const residentIds = active
      .map((e) => e.resident_user_id)
      .filter((id): id is string => typeof id === 'string');
    const totalCosignedCents = active.reduce((s, e) => s + e.cosigned_allocation_cents, 0);

    const since = new Date(Date.now() - SHELTER_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const earnings = await consignmentRepository.residentEarnings(residentIds, since);

    const custodyHeld = await ShelterCustodyModel.aggregate<{ _id: null; total: number }>([
      { $match: { shelter_partner_id: partnerId, status: 'held' } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();

    return {
      partnerId,
      organizationName: partner.organization_name,
      residentCount: active.length,
      invitedCount: enrollments.filter((e) => e.status === 'invited').length,
      trainedCount: active.filter((e) => e.training_completed_at).length,
      totalCosignedCents,
      totalEarnedCents: earnings.totalCents,
      activeResidentCount: earnings.activeSellerIds.length,
      activeWindowDays: SHELTER_ACTIVE_WINDOW_DAYS,
      custodyHeldCents: custodyHeld[0]?.total ?? 0,
      custodyEnabled: partner.custody_enabled === true,
      // Deliberately NO per-resident rows — aggregate only (FR-12.3).
    };
  },
};
