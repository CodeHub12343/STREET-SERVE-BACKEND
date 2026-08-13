import { Schema, type InferSchemaType } from 'mongoose';

import { RTO_FREQUENCIES } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';
import {
  RTO_OWNERSHIP_TRIGGERS,
  RTO_PARTIES,
  RTO_RETURN_DESTINATIONS,
} from './rto.terms';

/**
 * Rent-to-Own domain (R20–R27). Financial correctness via an immutable, append-only ledger (Tech
 * Debt #6) that reconciles against Stripe; the schedule + agreement carry mutable lifecycle state.
 * Compliance-gated (City.feature_flags.rto) and approval-gated (rto_seller_approvals).
 */

// ─── rto_seller_approvals (R27 — a seller cleared to offer RTO) ──────────────────────────────
const RtoSellerApprovalSchema = new Schema(
  {
    seller_id: { type: String, required: true, unique: true },
    approved_by: { type: String, required: true },
    note: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'rto_seller_approvals' },
);
export type RtoSellerApprovalDoc = InferSchemaType<typeof RtoSellerApprovalSchema>;
export const RtoSellerApprovalModel = defineModel('RtoSellerApproval', RtoSellerApprovalSchema);

// ─── rto_listings (§42/§44 — the seller's OFFER, and the source of every term) ───────────────
/**
 * The offer a seller publishes and a customer accepts.
 *
 * This did not exist, and its absence was a hole rather than a gap: `POST /rto/agreements` took the
 * cash price, markup, schedule and product name **from the customer's request body**. A customer
 * could author an agreement for any product at any price, and the seller was never consulted — the
 * "agreement" recorded one party's wishes and called them terms.
 *
 * With a listing, terms are the SELLER's and the server reads them from here. The customer chooses
 * only whether to accept.
 */
const RtoListingSchema = new Schema(
  {
    seller_id: { type: String, required: true, index: true }, // business id
    created_by: { type: String, required: true }, // the user who published it
    product_name: { type: String, required: true },
    description: { type: String, default: null },
    photos: { type: [String], default: [] },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    /** §60.3 — which market this is offered in; checked against the city's RTO feature flag. */
    city_slug: { type: String, required: true, index: true },

    // ── Disclosed money terms (§44). Locked onto each agreement at acceptance. ──
    cash_price_cents: { type: Number, required: true },
    initial_payment_cents: { type: Number, required: true },
    installment_count: { type: Number, required: true },
    frequency: { type: String, enum: RTO_FREQUENCIES, required: true },
    interval_days: { type: Number, default: null }, // only for `custom`
    markup_bps: { type: Number, required: true },
    setup_fee_cents: { type: Number, default: 0 },
    late_fee_cents: { type: Number, default: 0 },

    /** §44 per-listing obligations — see rto.terms.ts for the field-vs-prose boundary. */
    listing_terms: {
      maintenance_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      damage_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      return_allowed: { type: Boolean, default: false },
      return_transport_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      restocking_fee_cents: { type: Number, default: 0 },
      payments_refundable_on_return: { type: Boolean, default: false },
      ownership_credit_preserved_on_return: { type: Boolean, default: false },
      reinstatement_allowed: { type: Boolean, default: true },
      cancellation_notice_days: { type: Number, default: 7 },
      delivery_fee_cents: { type: Number, default: 0 },
      tax_bps: { type: Number, default: 0 },
    },

    /**
     * How many can still be taken. Decremented atomically at acceptance, so two customers cannot
     * both be sold the last one — the same conditional-`$inc` discipline the consignment rail uses.
     */
    quantity_available: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['active', 'paused', 'withdrawn'],
      default: 'active',
      index: true,
    },

    /**
     * §54 — a CONSIGNMENT rent-to-own offer: the goods belong to someone other than the business
     * managing the sale. Declared on the listing rather than at acceptance, because the three-party
     * arrangement is a deal between the owner and the managing business that the customer joins —
     * it is not something a customer could opt into, and it was previously only expressible by
     * passing the whole arrangement in the acceptance request, which no UI ever did (audit P-5).
     */
    is_consignment: { type: Boolean, default: false },
    owner_id: { type: String, default: null },
    owner_type: { type: String, enum: ['user', 'business'], default: 'business' },
    commission_bps: { type: Number, default: 0 },
    consignment_terms: {
      owner_during_term: { type: String, enum: ['owner', 'seller'], default: undefined },
      delivery_by: { type: String, enum: RTO_PARTIES, default: undefined },
      returns_managed_by: { type: String, enum: RTO_PARTIES, default: undefined },
      customer_support_by: { type: String, enum: RTO_PARTIES, default: undefined },
      damage_responsibility: { type: String, enum: RTO_PARTIES, default: undefined },
      missed_payments_handled_by: { type: String, enum: RTO_PARTIES, default: undefined },
      early_payoff_approved_by: { type: String, enum: RTO_PARTIES, default: undefined },
      on_customer_return: { type: String, enum: RTO_RETURN_DESTINATIONS, default: undefined },
      ownership_transfers_at: { type: String, enum: RTO_OWNERSHIP_TRIGGERS, default: undefined },
      payment_division_note: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'rto_listings' },
);
RtoListingSchema.index({ status: 1, city_slug: 1, category_id: 1 });
export type RtoListingDoc = InferSchemaType<typeof RtoListingSchema>;
export const RtoListingModel = defineModel('RtoListing', RtoListingSchema);

/**
 * §52 — a condition report. Used for both the delivery and the return snapshot, because the whole
 * point is that the two are comparable: different shapes would make "what changed?" a judgement
 * call rather than a diff.
 */
const ConditionReportSchema = new Schema(
  {
    photos: { type: [String], default: [] },
    /** §52 names video specifically — a walk-round shows what a still frame can hide. */
    video_url: { type: String, default: null },
    serial: { type: String, default: null },
    /** Damage present AT THIS MOMENT. Empty on delivery means "arrived clean", not "unrecorded". */
    existing_damage: { type: String, default: null },
    accessories: { type: [String], default: [] },
    estimated_value_cents: { type: Number, default: null },
    recorded_at: { type: Date, default: null },
    /**
     * Dual acknowledgment. A report signed by one party is that party's account of the condition;
     * signed by both, it is an agreed fact. Stored as timestamps rather than booleans so the record
     * says WHEN each side agreed, which is what a dispute actually turns on.
     */
    customer_ack_at: { type: Date, default: null },
    seller_ack_at: { type: Date, default: null },
  },
  { _id: false },
);

// ─── rto_agreements (the contract + running lifecycle state) ─────────────────────────────────
const RtoAgreementSchema = new Schema(
  {
    customer_id: { type: String, required: true, index: true },
    seller_id: { type: String, required: true, index: true }, // business id
    product_name: { type: String, required: true },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },

    // Disclosed terms (R20), locked at acceptance.
    cash_price_cents: { type: Number, required: true },
    initial_payment_cents: { type: Number, required: true },
    installment_amount_cents: { type: Number, required: true },
    installment_count: { type: Number, required: true },
    frequency: { type: String, enum: RTO_FREQUENCIES, required: true },
    interval_days: { type: Number, required: true },
    grace_days: { type: Number, required: true },
    total_to_own_cents: { type: Number, required: true },
    cost_over_cash_cents: { type: Number, required: true },
    markup_bps: { type: Number, required: true },
    fee_bps: { type: Number, required: true }, // locked platform fee per payment (R26)
    setup_fee_cents: { type: Number, default: 0 },
    late_fee_cents: { type: Number, default: 0 },

    // Agreement acceptance (R20 via the agreements framework — tamper-evident).
    agreement_version: { type: String, required: true },
    agreement_hash: { type: String, required: true },

    /**
     * §44 per-listing obligations, SNAPSHOTTED at acceptance like every other disclosed term. These
     * used to exist only inside the agreement's prose, which meant they could not be validated,
     * defaulted, or compared between listings — so "the customer must see the full cost before
     * accepting" was enforceable for the money and unenforceable for everything else.
     * See rto.terms.ts for the field-vs-prose boundary and why it is drawn there.
     */
    listing_terms: {
      maintenance_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      damage_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      return_allowed: { type: Boolean, default: false },
      return_transport_responsibility: { type: String, enum: RTO_PARTIES, default: 'customer' },
      restocking_fee_cents: { type: Number, default: 0 },
      payments_refundable_on_return: { type: Boolean, default: false },
      ownership_credit_preserved_on_return: { type: Boolean, default: false },
      reinstatement_allowed: { type: Boolean, default: true },
      cancellation_notice_days: { type: Number, default: 7 },
      delivery_fee_cents: { type: Number, default: 0 },
      tax_bps: { type: Number, default: 0 },
    },

    /**
     * §52 condition documentation, at DELIVERY and again at RETURN.
     *
     * Both reports exist so a dispute has a baseline instead of two assertions. The fields the spec
     * names are all here — photographs, video, serial, existing damage, accessories, estimated
     * value, transfer date — but the load-bearing pair is the two acknowledgments: a report only
     * one side signed is weak evidence in the argument it exists to settle.
     *
     * `condition_return` previously had no writer at all (audit F-4): the schema described a second
     * report the code never produced, so every returned-item dispute resolved on assertion against
     * a delivery baseline only one party had captured.
     */
    condition_delivery: { type: ConditionReportSchema, default: () => ({}) },
    condition_return: { type: ConditionReportSchema, default: () => ({}) },

    // Running state.
    ownership_credited_cents: { type: Number, default: 0 },
    installments_paid: { type: Number, default: 0 },
    next_due_at: { type: Date, default: null },
    /**
     * §49 — which reminder stages have already fired for the CURRENT due date. Keyed by that date
     * so a deferral or a new instalment re-arms the whole ladder: the customer should hear the
     * "coming up" reminder again for the new date, not be told nothing because they heard it once.
     */
    reminders_sent: { type: [String], default: [] },
    reminders_sent_for: { type: Date, default: null },
    status: {
      type: String,
      enum: [
        'active',
        'grace',
        'late',
        'arrangement',
        'paused',
        'return_pending',
        'completed',
        'cancelled',
        'disputed',
      ],
      default: 'active',
      index: true,
    },
    ownership_transferred_at: { type: Date, default: null },
    proof_of_ownership_ref: { type: String, default: null },

    /**
     * ═══ The card payment this agreement is currently waiting on. ═══
     *
     * Acceptance and early payoff both used to call `paymentsService.charge()` — which only OPENS a
     * PaymentIntent — and then immediately `completeForOrder()`, which marks the transaction
     * `completed`. Nothing ever collected a card. The result was an agreement created with
     * `ownership_credited_cents` already set, a ledger entry asserting money had moved, a seller
     * statement crediting the owner their share, and (on payoff) ownership transferred outright —
     * all against a PaymentIntent sitting at `requires_payment_method`. The customer got equity in a
     * product for free and the seller was told they had been paid.
     *
     * The intent ref is recorded HERE so the webhook can find the agreement the money belongs to,
     * and `pending_intent_kind` says what settling it should DO — crediting the initial payment and
     * transferring ownership are very different acts, and the webhook only knows which is owed
     * because acceptance and payoff each said so when they opened the charge.
     *
     * Cleared as the credit is applied, which is also the claim that makes a duplicate webhook a
     * no-op: the second delivery finds no pending intent and does nothing.
     */
    pending_intent_ref: { type: String, default: null, index: true },
    pending_intent_kind: { type: String, enum: ['acceptance', 'payoff'], default: null },

    /**
     * §50 — the remedies a seller can offer instead of letting an agreement fail.
     *
     * These statuses (`arrangement`, `paused`, `return_pending`, `cancelled`) were declared in the
     * enum above and reachable by no code path (audit F-3): the sweep could move an agreement
     * Grace → Late and then nothing. Delinquency was the only outcome available to a struggling
     * customer, which is the opposite of the spec's closing instruction to encourage communication
     * before cancellation.
     */
    paused_at: { type: Date, default: null },
    /** A pause is time-boxed. An open-ended one is a cancellation nobody wrote down. */
    pause_until: { type: Date, default: null },
    /** The catch-up schedule agreed with the seller: what is owed, by when. */
    arrangement: {
      agreed_at: { type: Date, default: null },
      agreed_by: { type: String, default: null }, // the seller's user id
      catch_up_cents: { type: Number, default: 0 },
      due_at: { type: Date, default: null },
      note: { type: String, default: null },
    },
    /** Running total of part-payments credited against arrears (§50 "accept a partial payment"). */
    arrears_paid_cents: { type: Number, default: 0 },
    /** §49/§50 — late fees assessed against this agreement. Owed, never auto-charged, never equity. */
    late_fees_assessed_cents: { type: Number, default: 0 },
    /** How many times a seller has moved a due date — visible, because forbearance is not free. */
    deferrals_granted: { type: Number, default: 0 },

    // ── §51 voluntary return ──
    return_requested_at: { type: Date, default: null },
    return_requested_by: { type: String, enum: ['customer', 'seller'], default: null },
    returned_at: { type: Date, default: null },
    /**
     * What the customer actually got back, decided by the agreement's own terms — never by whoever
     * processed the return. §51 forbids implying that past payments create ownership unless the
     * agreement grants credit, so the outcome is computed and recorded, not negotiated at the desk.
     */
    return_refund_cents: { type: Number, default: 0 },
    return_restocking_fee_cents: { type: Number, default: 0 },
    return_credit_preserved_cents: { type: Number, default: 0 },
    return_disclosure: { type: String, default: null },
    cancelled_at: { type: Date, default: null },
    cancelled_reason: { type: String, default: null },
    reinstated_at: { type: Date, default: null },

    /** The offer this agreement was struck against (§42). Every money term came from it. */
    listing_id: { type: String, default: null, index: true },

    // ── Consignment Rent-to-Own (R19): 3-party split (owner / managing business / platform) ──
    is_consignment: { type: Boolean, default: false },
    owner_id: { type: String, default: null }, // the consignor who receives the owner share
    owner_type: { type: String, enum: ['user', 'business'], default: 'business' },
    commission_bps: { type: Number, default: 0 }, // managing business commission on distributable
    /**
     * §54's ten allocations, required whenever `is_consignment`. Structured rather than prose for
     * the same reason as `listing_terms`, and with more force: three parties who have not written
     * down who handles a missed payment have not made an agreement.
     */
    consignment_terms: {
      owner_during_term: { type: String, enum: ['owner', 'seller'], default: undefined },
      delivery_by: { type: String, enum: RTO_PARTIES, default: undefined },
      returns_managed_by: { type: String, enum: RTO_PARTIES, default: undefined },
      customer_support_by: { type: String, enum: RTO_PARTIES, default: undefined },
      damage_responsibility: { type: String, enum: RTO_PARTIES, default: undefined },
      missed_payments_handled_by: { type: String, enum: RTO_PARTIES, default: undefined },
      early_payoff_approved_by: { type: String, enum: RTO_PARTIES, default: undefined },
      on_customer_return: { type: String, enum: RTO_RETURN_DESTINATIONS, default: undefined },
      ownership_transfers_at: { type: String, enum: RTO_OWNERSHIP_TRIGGERS, default: undefined },
      payment_division_note: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'rto_agreements' },
);
RtoAgreementSchema.index({ status: 1, next_due_at: 1 }); // due-installment + reminder sweeps
export type RtoAgreementDoc = InferSchemaType<typeof RtoAgreementSchema>;
export const RtoAgreementModel = defineModel('RtoAgreement', RtoAgreementSchema);

// ─── rto_installments (the schedule — mutable per-installment status) ────────────────────────
const RtoInstallmentSchema = new Schema(
  {
    agreement_id: { type: String, required: true, index: true },
    installment_number: { type: Number, required: true },
    due_at: { type: Date, required: true },
    amount_cents: { type: Number, required: true },
    ownership_credit_cents: { type: Number, required: true },
    rental_cents: { type: Number, required: true },
    fee_cents: { type: Number, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'paid', 'missed', 'waived'],
      default: 'scheduled',
    },
    transaction_id: { type: String, default: null },
    paid_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'rto_installments' },
);
RtoInstallmentSchema.index({ agreement_id: 1, installment_number: 1 }, { unique: true });
RtoInstallmentSchema.index({ status: 1, due_at: 1 });
export type RtoInstallmentDoc = InferSchemaType<typeof RtoInstallmentSchema>;
export const RtoInstallmentModel = defineModel('RtoInstallment', RtoInstallmentSchema);

// ─── rto_ledger (IMMUTABLE, append-only — the money record that reconciles to Stripe) ────────
const RtoLedgerEntrySchema = new Schema(
  {
    agreement_id: { type: String, required: true, index: true },
    entry_type: {
      type: String,
      enum: ['initial', 'installment', 'setup_fee', 'late_fee', 'payoff', 'refund'],
      required: true,
    },
    installment_number: { type: Number, default: null },
    amount_cents: { type: Number, required: true },
    fee_cents: { type: Number, default: 0 },
    ownership_credit_cents: { type: Number, default: 0 },
    transaction_id: { type: String, default: null },
    idempotency_key: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'rto_ledger' },
);
RtoLedgerEntrySchema.plugin(immutablePlugin);
export type RtoLedgerEntryDoc = InferSchemaType<typeof RtoLedgerEntrySchema>;
export const RtoLedgerEntryModel = defineModel('RtoLedgerEntry', RtoLedgerEntrySchema);

// ─── rto_statements (IMMUTABLE per-party statement lines — consignment-RTO 3-party, R19) ──────
const RtoStatementEntrySchema = new Schema(
  {
    agreement_id: { type: String, required: true, index: true },
    installment_number: { type: Number, default: null },
    party: { type: String, enum: ['owner', 'managing_business', 'platform', 'processor'], required: true },
    party_ref: { type: String, default: null }, // the owner/business id (null for platform)
    role: { type: String, required: true }, // human label: 'owner share', 'commission', 'platform fee'…
    amount_cents: { type: Number, required: true },
    transfer_ref: { type: String, default: null },
    idempotency_key: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'rto_statements' },
);
RtoStatementEntrySchema.index({ agreement_id: 1, party: 1 });
RtoStatementEntrySchema.plugin(immutablePlugin);
export type RtoStatementEntryDoc = InferSchemaType<typeof RtoStatementEntrySchema>;
export const RtoStatementEntryModel = defineModel('RtoStatementEntry', RtoStatementEntrySchema);
