import { Schema, type InferSchemaType } from 'mongoose';

import { POSTCARD_ACCESS_MODE, POSTCARD_PILOT_MAX_ORDER_CENTS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ForbiddenError, ValidationError } from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';

/**
 * ═══ THE PILOT GATE (Phase 8.1) ═══
 *
 * ## Why a feature needs a gate at all
 *
 * Every other feature on this platform can be rolled back. This one cannot: once the vendor's batch
 * closes, paper exists and is in the postal system. It is also the first feature paid for with real
 * money and fulfilled by a third party nobody has run a live order through, and the unit economics
 * are still unverified — the audit was explicit that the real per-piece cost is unknown until real
 * orders exist.
 *
 * So the blast radius starts small and deliberately: a handful of businesses somebody chose, each
 * watched end to end. General availability is a config flip once the review (8.2) says the numbers
 * and the failure modes are understood.
 *
 * ## Why not the existing module system
 *
 * `resolveModules()` is the natural-looking home and is the wrong one. Modules are archetype-driven
 * capabilities and **an owner can switch them on themselves** — which is exactly backwards for a
 * pilot, where the entire point is that ops decides who is in it. A gate a participant can let
 * themselves through is not a gate.
 *
 * ## Why not a city feature flag
 *
 * `requireFeature` is city-scoped, so enabling it would enable it for every business in Modesto at
 * once. That is the opposite of a controlled pilot.
 */

const PostcardPilotParticipantSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    /** Who let them in, and why. A pilot roster nobody can explain is not a roster. */
    added_by: { type: String, required: true },
    note: { type: String, default: null },
    /**
     * Removal is a soft flag rather than a delete, so the review (8.2) can still see that a
     * business took part — and so removing somebody mid-pilot leaves a trace of when and why.
     */
    active: { type: Boolean, default: true },
    removed_by: { type: String, default: null },
    removed_at: { type: Date, default: null },
    removed_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'postcard_pilot_participants',
  },
);

export type PostcardPilotParticipantDoc = InferSchemaType<typeof PostcardPilotParticipantSchema>;
export const PostcardPilotParticipantModel = defineModel(
  'PostcardPilotParticipant',
  PostcardPilotParticipantSchema,
);

export const pilotService = {
  /** `true` while access is restricted to the allowlist. */
  isPilot(): boolean {
    return POSTCARD_ACCESS_MODE === 'pilot';
  },

  async isParticipant(businessId: string): Promise<boolean> {
    const row = await PostcardPilotParticipantModel.findOne({
      business_id: businessId,
      active: true,
    })
      .lean()
      .exec();
    return Boolean(row);
  },

  /**
   * The gate itself. Called from the order service, not only from middleware.
   *
   * Enforced in the service for the same reason every other rule in this codebase is: a route guard
   * protects one route, and the next person to add an endpoint will not know it was load-bearing.
   */
  async assertMayOrder(businessId: string): Promise<void> {
    if (!this.isPilot()) return;
    if (await this.isParticipant(businessId)) return;

    /**
     * `ForbiddenError` + `FEATURE_DISABLED` (403), matching `requireFeature` — this is a gate
     * saying "you may not", not a rule saying "this request is malformed". The spend cap below is
     * genuinely a business rule and stays a 422; the distinction is worth keeping.
     */
    throw ForbiddenError(
      'Postcard marketing is in a limited pilot. Ask us to add your business to it.',
      ERROR_CODES.FEATURE_DISABLED,
    );
  },

  /**
   * Per-order ceiling while piloting.
   *
   * A guard against OUR arithmetic rather than against the buyer. Quantity flows from a vendor
   * count we deliberately do not compute, and a mistake there is a five-figure charge on somebody's
   * real card. Every pilot order is meant to be small enough that a bug is survivable.
   */
  assertWithinPilotCap(totalCents: number): void {
    if (!this.isPilot()) return;
    if (totalCents > POSTCARD_PILOT_MAX_ORDER_CENTS) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `During the pilot a single mailing is capped at ${formatCents(
          POSTCARD_PILOT_MAX_ORDER_CENTS,
        )}. Get in touch and we will run a larger one with you directly.`,
      );
    }
  },

  // ─── Ops management ───────────────────────────────────────────────────────────────────────
  async add(principal: Principal, businessId: string, note?: string) {
    if (!businessId.trim()) throw ValidationError('A business is required.');

    const row = await PostcardPilotParticipantModel.findOneAndUpdate(
      { business_id: businessId },
      {
        $set: {
          active: true,
          added_by: principal.userId,
          note: note?.trim() ?? null,
          removed_by: null,
          removed_at: null,
          removed_reason: null,
        },
      },
      { new: true, upsert: true },
    ).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.pilot_added',
      entityType: 'business',
      entityId: businessId,
      metadata: { note: note?.trim() ?? null },
    });

    return shape(row.toObject() as PostcardPilotParticipantDoc & { _id: unknown });
  },

  async remove(principal: Principal, businessId: string, reason: string) {
    if (!reason.trim()) {
      // Removing someone mid-pilot is a decision the review will want to understand.
      throw ValidationError('Give a reason for removing them from the pilot.');
    }

    const row = await PostcardPilotParticipantModel.findOneAndUpdate(
      { business_id: businessId, active: true },
      {
        $set: {
          active: false,
          removed_by: principal.userId,
          removed_at: new Date(),
          removed_reason: reason.trim(),
        },
      },
      { new: true },
    ).exec();

    if (!row) throw ValidationError('That business is not in the pilot.');

    await writeAudit({
      actorId: principal.userId,
      action: 'postcards.pilot_removed',
      entityType: 'business',
      entityId: businessId,
      metadata: { reason: reason.trim() },
    });

    return shape(row.toObject() as PostcardPilotParticipantDoc & { _id: unknown });
  },

  /** The roster, including people who have been removed — the review needs both. */
  async list() {
    const rows = await PostcardPilotParticipantModel.find({}).sort({ created_at: 1 }).lean().exec();
    return {
      mode: POSTCARD_ACCESS_MODE,
      maxOrderCents: POSTCARD_PILOT_MAX_ORDER_CENTS,
      activeCount: rows.filter((r) => r.active).length,
      participants: rows.map((r) =>
        shape(r as PostcardPilotParticipantDoc & { _id: unknown }),
      ),
    };
  },
};

function shape(p: PostcardPilotParticipantDoc & { _id: unknown }) {
  return {
    businessId: p.business_id,
    active: p.active,
    note: p.note,
    addedBy: p.added_by,
    addedAt: (p as { created_at?: Date }).created_at ?? null,
    removedReason: p.removed_reason,
    removedAt: p.removed_at,
  };
}
