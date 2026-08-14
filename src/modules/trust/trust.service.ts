import {
  TRUST_CONFIDENCE_COMPLETIONS,
  TRUST_DEFAULT_SCORE,
  TRUST_FORMULA_VERSION,
  TRUST_STARTING_SCORE,
  nextTrustBand,
  trustBandFor,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { consignmentRepository } from '../consignment/consignment.repository';
import { disputesRepository } from '../disputes/disputes.repository';
import { ReviewModel } from '../reviews/reviews.model';
import { TrustScoreModel } from './trust.model';

type SubjectType = 'seller' | 'business' | 'hub';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function avgReview(subjectType: SubjectType, subjectId: string): Promise<number> {
  const rows = await ReviewModel.aggregate<{ _id: null; avg: number }>([
    { $match: { subject_type: subjectType, subject_id: subjectId } },
    { $group: { _id: null, avg: { $avg: '$rating' } } },
  ]).exec();
  return rows[0]?.avg ?? 3;
}

export const trustService = {
  /**
   * Recompute a subject's Trust Score from the versioned, explainable formula (PRD §3). Only
   * RESOLVED-upheld disputes penalise the score — unresolved disputes never do (FR-10.3).
   *   score = 100 − 25·upheldDisputeRate − 15·lateReturnRate + 10·onTimeRate + (avgReview−3)·5
   */
  async recompute(subjectType: SubjectType, subjectId: string) {
    const returnStats =
      subjectType === 'seller'
        ? await consignmentRepository.sellerReturnStats(subjectId)
        : { total: 0, onTime: 0, late: 0 };
    const [upheld, review] = await Promise.all([
      disputesRepository.upheldResolvedCount(subjectType, subjectId),
      avgReview(subjectType, subjectId),
    ]);

    const denom = Math.max(1, returnStats.total);
    const onTimeRate = returnStats.total > 0 ? returnStats.onTime / returnStats.total : 0;
    const lateReturnRate = returnStats.total > 0 ? returnStats.late / returnStats.total : 0;
    const upheldDisputeRate = upheld / denom;

    const behavioural =
      100 - 25 * upheldDisputeRate - 15 * lateReturnRate + 10 * onTimeRate + (review - 3) * 5;

    /**
     * v2 CONFIDENCE RAMP (Phase 3). v1 handed a brand-new seller 100/100 — maximum trust for zero
     * evidence — so a fresh account cleared every auto-approval and credit limit instantly. Trust
     * must be EARNED: start newcomers at the floor and converge on their behavioural score as real
     * completed consignments accumulate. Penalties still bite immediately; only the *upside* is
     * gated on evidence.
     */
    const confidence = Math.min(1, returnStats.total / TRUST_CONFIDENCE_COMPLETIONS);
    const ramped = TRUST_STARTING_SCORE + (behavioural - TRUST_STARTING_SCORE) * confidence;
    const score = clamp(Math.round(Math.min(ramped, behavioural)), 0, 100);

    const doc = await TrustScoreModel.create({
      subject_type: subjectType,
      subject_id: subjectId,
      score,
      formula_version: TRUST_FORMULA_VERSION,
      inputs: {
        unresolved_dispute_rate: 0,
        upheld_dispute_rate: upheldDisputeRate,
        late_return_rate: lateReturnRate,
        on_time_rate: onTimeRate,
        avg_review: review,
      },
    });
    await writeAudit({
      action: 'trust_score.recomputed',
      entityType: 'trust_score',
      entityId: `${subjectType}:${subjectId}`,
      metadata: { score, formula_version: TRUST_FORMULA_VERSION },
    });
    await publish('trust_score.recomputed', { subjectType, subjectId, score });
    return { subjectType, subjectId, score, formulaVersion: doc.formula_version };
  },

  /**
   * Batch score lookup (Phase 6). The approvals queue previously issued one query per pending
   * item — fine at 10 pending, poor at 500. One aggregate replaces the fan-out; subjects with no
   * score yet fall back to the default, matching `getScore`.
   */
  async getScores(subjectType: SubjectType, subjectIds: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(subjectIds)];
    if (unique.length === 0) return new Map();

    const rows = await TrustScoreModel.aggregate<{ _id: string; score: number }>([
      { $match: { subject_type: subjectType, subject_id: { $in: unique } } },
      { $sort: { computed_at: -1 } },
      // The newest row per subject wins.
      { $group: { _id: '$subject_id', score: { $first: '$score' } } },
    ]).exec();

    const byId = new Map(rows.map((r) => [String(r._id), r.score]));
    return new Map(unique.map((id) => [id, byId.get(id) ?? TRUST_DEFAULT_SCORE]));
  },

  /**
   * A-3. What a seller's score is actually WORTH, in the same numbers the enforcement code uses.
   *
   * This exists because a score with no stated consequences is just a number people distrust. It
   * reads from the single `TRUST_BANDS` table that `creditStatus`, `checkout` and `settle` all read,
   * so the screen can never promise a benefit the enforcement path doesn't grant.
   */
  async benefits(sellerId: string) {
    const { score, computedAt, inputs } = await this.getScore('seller', sellerId);
    const band = trustBandFor(score);
    const next = nextTrustBand(band);
    return {
      score,
      computedAt,
      inputs,
      formulaVersion: TRUST_FORMULA_VERSION,
      band: {
        key: band.key,
        label: band.label,
        minScore: band.minScore,
        inventoryMultiplier: band.inventoryMultiplier,
        feeDiscountBps: band.feeDiscountBps,
        premiumEligible: band.premiumEligible,
      },
      nextBand: next
        ? {
            key: next.key,
            label: next.label,
            minScore: next.minScore,
            pointsAway: Math.max(0, next.minScore - score),
            unlocks: {
              inventoryMultiplier: next.inventoryMultiplier,
              feeDiscountBps: next.feeDiscountBps,
              premiumEligible: next.premiumEligible && !band.premiumEligible,
            },
          }
        : null,
      /**
       * The levers that actually move the score, in the order they carry weight in `recompute`.
       * Stated plainly so "build your Trust Score" is an instruction rather than a platitude.
       */
      howToImprove: [
        'Return unsold stock before the return window closes',
        'Keep customer reviews above 3 stars',
        'Complete more consignments — a new account starts low until it has a record',
        'Resolve disputes before they are upheld against you',
      ],
    };
  },

  async getScore(subjectType: SubjectType, subjectId: string) {
    const latest = await TrustScoreModel.findOne({
      subject_type: subjectType,
      subject_id: subjectId,
    })
      .sort({ computed_at: -1 })
      .lean()
      .exec();
    if (!latest) {
      return {
        subjectType,
        subjectId,
        score: TRUST_DEFAULT_SCORE,
        formulaVersion: TRUST_FORMULA_VERSION,
        computedAt: null,
        inputs: null,
      };
    }
    return {
      subjectType,
      subjectId,
      score: latest.score,
      formulaVersion: latest.formula_version,
      computedAt: latest.computed_at,
      inputs: latest.inputs,
    };
  },
};
