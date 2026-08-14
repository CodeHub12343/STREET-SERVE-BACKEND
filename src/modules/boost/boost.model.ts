import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { FULFILMENT_PIPELINE } from '../fulfilment/fulfilment';

/**
 * ═══ BOOST MY MARKETING — community-funded direct mail (ADR-006) ═══
 *
 * Customers, and other vendors, chip in toward one business's mailing. When the goal is reached the
 * campaign is bought; when it is not, everybody gets their money back automatically.
 *
 * ## Why this is a sibling of `placements`, not a variant of it
 *
 * `placements` is a single-owner prepaid aggregate: one `owner_id`, one `budget_cents`, one
 * `spent_cents`. A crowdfunded campaign has MANY contributors, a goal rather than a budget, a
 * deadline, and a fulfilment pipeline that ends in a physical mailbox. Forcing both into one
 * document gives you a schema where half the fields are null for half the rows and an `owner_id`
 * that means two different things. The lifecycle *patterns* are shared; the table is not.
 *
 * ## Money
 *
 * Contributions are CAPTURED on contribution (ADR-006 reverses the audit's authorise-don't-capture
 * recommendation) into a campaign-scoped `community_fund_payable` account — see
 * `ledger/communityFund.ts`. Campaign money and Pay It Forward money share an account type and are
 * deliberately kept in separate accounts.
 */

// ─── boost_campaigns ────────────────────────────────────────────────────────────────────────
const BoostCampaignSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    created_by: { type: String, required: true },
    title: { type: String, required: true },
    goal_cents: { type: Number, required: true, min: 1 },
    /**
     * Hard, always set, never null. ADR-006 §2: an open-ended campaign is one that can never fail,
     * and therefore one whose contributors' money is held indefinitely.
     */
    deadline_at: { type: Date, required: true },
    /**
     * NOT a counter. `raised` is always derived by summing succeeded contribution rows — a counter
     * drifts under refunds and roll-forwards, and a public "raised so far" that is wrong is a
     * credibility problem rather than a rounding error (D-9).
     *
     * This field is a cached projection for list views only, refreshed on every contribution.
     */
    raised_cents_cached: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['open', 'funded', 'expired', 'cancelled'],
      default: 'open',
      index: true,
    },
    funded_at: { type: Date, default: null },
    /** Service fee taken from the raised total once funded (ADR-006 §6). Never from a contribution. */
    service_fee_cents: { type: Number, default: 0 },
    /** The owner picked when it should go out (MB-6). Null until they confirm. */
    mail_date: { type: Date, default: null },
    /**
     * MB-9 / D-12 — only statuses the print vendor actually reports.
     *
     * **`delivered` is deliberately absent.** Most saturation-mail vendors confirm handover to the
     * postal service and nothing after it. A status the platform cannot observe is a promise it
     * cannot keep, so the pipeline stops at `mailed`.
     */
    mailing_status: {
      type: String,
      // Phase 6 (TD-6): one vocabulary, shared with Postcard Marketing. See modules/fulfilment.
      enum: FULFILMENT_PIPELINE,
      default: null,
    },
    mailing_status_at: { type: Date, default: null },
    cancelled_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'boost_campaigns',
  },
);
/** The deadline sweep: open campaigns whose time is up. */
BoostCampaignSchema.index({ status: 1, deadline_at: 1 });
/** One open campaign per business is enforced in the service; this is the lookup it uses. */
BoostCampaignSchema.index({ business_id: 1, status: 1 });

export type BoostCampaignDoc = InferSchemaType<typeof BoostCampaignSchema>;
export const BoostCampaignModel = defineModel('BoostCampaign', BoostCampaignSchema);

// ─── boost_contributions ────────────────────────────────────────────────────────────────────
/**
 * Same intent → webhook → credit discipline as `CommunityContribution` and `PingBudgetTopup`: the
 * row is created `pending` against a payment intent, and only the webhook makes it `succeeded`.
 */
const BoostContributionSchema = new Schema(
  {
    campaign_id: { type: String, required: true, index: true },
    business_id: { type: String, required: true },
    contributor_id: { type: String, required: true, index: true },
    amount_cents: { type: Number, required: true, min: 1 },
    stripe_payment_intent_id: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'refunded', 'rolled_forward'],
      default: 'pending',
    },
    failure_reason: { type: String, default: null },
    /**
     * ADR-006 §5 — what happens if the campaign misses its goal, chosen by the CONTRIBUTOR at the
     * time they give, and defaulting to a refund.
     *
     * Rolling money into a campaign somebody did not choose to fund, by default, is deciding what to
     * do with their money for them.
     */
    on_unmet: { type: String, enum: ['refund', 'roll_forward'], default: 'refund' },
    /** Where roll-forward money went, once a next campaign existed to take it. */
    rolled_to_campaign_id: { type: String, default: null },
    /**
     * When roll-forward money stops waiting and is refunded anyway. Set at expiry, so "roll it into
     * the next one" cannot quietly become the indefinite hold the deadline exists to prevent.
     */
    rollover_expires_at: { type: Date, default: null },
    /** Anonymity is the default and is applied at serialisation — shared model with Pay It Forward. */
    anonymous: { type: Boolean, default: true },
    display_name: { type: String, default: null },
    credited_at: { type: Date, default: null },
    refunded_at: { type: Date, default: null },
    stripe_refund_id: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'boost_contributions',
  },
);
/** Summing `raised`, and the refund walk at expiry. */
BoostContributionSchema.index({ campaign_id: 1, status: 1 });
/** The rollover sweep: money still waiting for a next campaign that never came. */
BoostContributionSchema.index({ status: 1, rollover_expires_at: 1 });

export type BoostContributionDoc = InferSchemaType<typeof BoostContributionSchema>;
export const BoostContributionModel = defineModel('BoostContribution', BoostContributionSchema);
