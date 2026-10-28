import {
  GIVEAWAY_SPONSOR_TIERS,
  SPONSOR_TIERS,
  type SponsorProgram,
} from '../../config/constants';
import { writeAudit } from '../../shared/audit';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import { SponsorModel } from '../sponsors/sponsors.model';
import {
  FULFILLMENT_DELIVERABLE_TYPES,
  FulfillmentEventModel,
  SponsorFulfillmentModel,
  type FulfillmentDeliverableType,
} from './sponsorFulfillment.model';

/**
 * ═══ SPONSOR FULFILMENT SERVICE ═══
 *
 * One row per approved sponsorship, delivery events logged append-only. See the model file for
 * why `delivered` is a cached projection of the events, not the source of truth.
 */

interface CommittedCounts {
  shoutouts: number;
  promotionalVideos: number;
  postcards: number;
  spotlightVideos: number;
}

/** Resolve the committed-count envelope from the tier + program at purchase time. */
function committedFromTier(program: SponsorProgram, tierSlug: string): CommittedCounts | null {
  if (program === 'ice_cream_giveaway') {
    const t = GIVEAWAY_SPONSOR_TIERS.find((x) => x.slug === tierSlug);
    if (!t) return null;
    return {
      shoutouts: t.benefits.shoutouts,
      promotionalVideos: t.benefits.promotionalVideos,
      postcards: t.benefits.postcards,
      spotlightVideos: t.benefits.spotlightVideos,
    };
  }
  /**
   * Platform sponsorships commit no deliverable counts — a landing-page logo is a placement,
   * not a workflow with countable items. The tracker row still exists so the admin surface can
   * show "nothing to deliver — this is a placement" rather than 404, and so that the row is in
   * place if the platform program ever adds countable deliverables.
   */
  const t = SPONSOR_TIERS.find((x) => x.slug === tierSlug);
  if (!t) return null;
  return { shoutouts: 0, promotionalVideos: 0, postcards: 0, spotlightVideos: 0 };
}

function reportingCadenceFromTier(program: SponsorProgram, tierSlug: string): 'final' | 'monthly' {
  if (program !== 'ice_cream_giveaway') return 'final';
  const t = GIVEAWAY_SPONSOR_TIERS.find((x) => x.slug === tierSlug);
  return t?.benefits.reporting === 'monthly' ? 'monthly' : 'final';
}

export const sponsorFulfillmentService = {
  /**
   * Called on sponsor approval. Idempotent: a re-approval of the same sponsor does not reset the
   * committed envelope or wipe already-logged deliveries. The unique index on `sponsor_id` is
   * what enforces that at the database level.
   */
  async seedForSponsor(input: {
    sponsorId: string;
    tier: string;
    program: SponsorProgram;
    startedAt: Date;
    endsAt: Date;
  }) {
    const committed = committedFromTier(input.program, input.tier);
    if (!committed) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Cannot seed fulfillment: unknown tier "${input.tier}" for program "${input.program}"`,
      );
    }
    const cadence = reportingCadenceFromTier(input.program, input.tier);
    /**
     * $setOnInsert: an existing row is left exactly as it was — the committed envelope is frozen
     * at the first seed and never moves. If the sponsor is somehow re-approved (window edge,
     * admin re-runs it), nothing already recorded is overwritten.
     */
    await SponsorFulfillmentModel.updateOne(
      { sponsor_id: input.sponsorId },
      {
        $setOnInsert: {
          sponsor_id: input.sponsorId,
          program: input.program,
          tier: input.tier,
          committed,
          delivered: { shoutouts: 0, promotionalVideos: 0, postcards: 0, spotlightVideos: 0 },
          started_at: input.startedAt,
          ends_at: input.endsAt,
          reporting_cadence: cadence,
        },
      },
      { upsert: true },
    ).exec();
    return { seeded: true };
  },

  /**
   * Admin logs a delivery. Appends an immutable event row and increments the cached counter in a
   * two-step: the event is the source of truth, so the counter being briefly stale would be a
   * display defect, not a correctness one.
   */
  async logDelivery(
    admin: Principal,
    sponsorId: string,
    dto: {
      deliverableType: FulfillmentDeliverableType;
      count: number;
      proofUrl?: string;
      note?: string;
      deliveredAt?: Date;
    },
  ) {
    if (!FULFILLMENT_DELIVERABLE_TYPES.includes(dto.deliverableType)) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Unknown deliverable type');
    }
    if (!Number.isFinite(dto.count) || dto.count === 0) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Count must be non-zero (negative counts correct an earlier over-log).',
      );
    }

    const row = await SponsorFulfillmentModel.findOne({ sponsor_id: sponsorId }).exec();
    if (!row) {
      throw NotFoundError('No fulfillment record for this sponsor — have they been approved?');
    }

    const event = await FulfillmentEventModel.create({
      sponsor_id: sponsorId,
      deliverable_type: dto.deliverableType,
      count: dto.count,
      proof_url: dto.proofUrl ?? null,
      note: dto.note ?? null,
      logged_by: admin.userId,
      delivered_at: dto.deliveredAt ?? new Date(),
    });

    await SponsorFulfillmentModel.updateOne(
      { sponsor_id: sponsorId },
      { $inc: { [`delivered.${dto.deliverableType}`]: dto.count } },
    ).exec();

    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'sponsor.fulfillment.logged',
      entityType: 'sponsor_fulfillment',
      entityId: sponsorId,
      metadata: {
        deliverableType: dto.deliverableType,
        count: dto.count,
        proofUrl: dto.proofUrl ?? null,
      },
    });

    return { id: String(event._id), ok: true };
  },

  /** Admin view: the record + the last N events, newest first. */
  async getForSponsor(sponsorId: string, eventLimit = 50) {
    const row = await SponsorFulfillmentModel.findOne({ sponsor_id: sponsorId }).lean().exec();
    if (!row) return null;
    const events = await FulfillmentEventModel.find({ sponsor_id: sponsorId })
      .sort({ created_at: -1 })
      .limit(eventLimit)
      .lean()
      .exec();
    return {
      sponsorId: row.sponsor_id,
      program: row.program,
      tier: row.tier,
      committed: row.committed,
      delivered: row.delivered,
      startedAt: row.started_at,
      endsAt: row.ends_at,
      reportingCadence: row.reporting_cadence,
      events: events.map((e) => ({
        id: String(e._id),
        deliverableType: e.deliverable_type,
        count: e.count,
        proofUrl: e.proof_url ?? null,
        note: e.note ?? null,
        loggedBy: e.logged_by,
        deliveredAt: e.delivered_at,
        createdAt: e.created_at ?? null,
      })),
    };
  },

  /**
   * Sponsor-facing view: the sponsor's OWN campaign only. Looks up the sponsor by owner-user-id
   * first — a URL that took a sponsorId directly would let any authenticated user read any
   * campaign's report, which is the kind of broken access control that only looks wrong once.
   */
  async getForOwner(userId: string) {
    const sponsor = await SponsorModel.findOne({
      owner_user_id: userId,
      active: true,
    })
      .sort({ created_at: -1 })
      .lean()
      .exec();
    if (!sponsor) return null;
    return this.getForSponsor(String(sponsor._id), 50);
  },
};
