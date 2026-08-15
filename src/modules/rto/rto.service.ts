import { randomUUID } from 'node:crypto';
import { SWEEP_BATCH_LIMIT, reportSweepBatch } from '../../jobs/sweepBatch';

import {
  DEFAULT_CONSIGNMENT_FEE_BPS,
  RTO_PRE_RECOVERY_DAYS,
  RTO_PROHIBITED_CATEGORY_SLUGS,
  RTO_REMINDER_LEAD_DAYS,
  type RtoReminderStage,
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
import { agreementsService } from '../agreements/agreements.service';
import { isAgreementReviewed } from '../agreements/agreements.registry';
import { platformService } from '../platform/platform.service';
import { CategoryModel, CityModel } from '../catalog/catalog.model';
import { notificationsService } from '../notifications/notifications.service';
import { noticesService } from '../notifications/notices.service';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import {
  computePayoff,
  computeRtoQuote,
  splitConsignmentRto,
  type RtoQuoteInput,
} from './rto.pricing';
import { computeRtoReturn } from './rto.returnPolicy';
import { rtoRepository as repo } from './rto.repository';
import type { RtoAgreementDoc, RtoListingDoc } from './rto.model';
import {
  DEFAULT_RTO_LISTING_TERMS,
  describeConsignmentTerms,
  describeListingTerms,
  type ConsignmentRtoTerms,
  type RtoListingTerms,
} from './rto.terms';

type AgreementDoc = RtoAgreementDoc & { _id: unknown };

/** A condition report as the client renders it, including who has signed it (§52). */
function conditionReportView(r: RtoAgreementDoc['condition_delivery'] | undefined) {
  if (!r?.recorded_at) return null;
  return {
    photos: r.photos ?? [],
    videoUrl: r.video_url ?? null,
    serial: r.serial ?? null,
    existingDamage: r.existing_damage ?? null,
    accessories: r.accessories ?? [],
    estimatedValueCents: r.estimated_value_cents ?? null,
    recordedAt: r.recorded_at,
    customerAcknowledged: Boolean(r.customer_ack_at),
    sellerAcknowledged: Boolean(r.seller_ack_at),
    /** Both signatures present — the point at which this stops being one side's account. */
    agreed: Boolean(r.customer_ack_at && r.seller_ack_at),
  };
}

/**
 * §52 — a condition report, as supplied by whoever is recording it. Every field the spec names, so
 * the delivery and return snapshots are directly comparable.
 */
export interface ConditionReportInput {
  photos?: string[];
  videoUrl?: string;
  serial?: string;
  existingDamage?: string;
  accessories?: string[];
  estimatedValueCents?: number;
}

/**
 * Persist a condition report, stamping the recorder's acknowledgement. The OTHER party signs
 * separately via `acknowledgeCondition` — the second signature is what turns one side's account of
 * the condition into an agreed fact, which is the whole reason §52 asks for both.
 */
function conditionReportToDoc(
  input: ConditionReportInput,
  ack: { customerAck?: boolean; sellerAck?: boolean } = {},
) {
  const now = new Date();
  return {
    photos: input.photos ?? [],
    video_url: input.videoUrl ?? null,
    serial: input.serial ?? null,
    existing_damage: input.existingDamage ?? null,
    accessories: input.accessories ?? [],
    estimated_value_cents: input.estimatedValueCents ?? null,
    recorded_at: now,
    customer_ack_at: ack.customerAck ? now : null,
    seller_ack_at: ack.sellerAck ? now : null,
  };
}

/** §49 reminder copy. Plain, specific, and never alarming before it needs to be. */
function reminderCopy(
  stage: RtoReminderStage,
  ctx: { amountCents: number; dueAt: Date; graceDays: number; productName: string },
): { title: string; body: string } {
  const amount = dollars(ctx.amountCents);
  const when = ctx.dueAt.toDateString();
  switch (stage) {
    case 'upcoming':
      return {
        title: 'Payment coming up',
        body: `${amount} for your ${ctx.productName} is due ${when}.`,
      };
    case 'due_today':
      return { title: 'Payment due today', body: `${amount} for your ${ctx.productName} is due today.` };
    case 'grace':
      return {
        title: "You're in your grace period",
        body: `${amount} is outstanding. You have ${ctx.graceDays} days from the due date before it counts as late — talk to the seller if you need more time.`,
      };
    case 'late':
      return {
        title: 'Payment is late',
        body: `${amount} for your ${ctx.productName} is overdue. The seller can give you more time, take a part payment, or agree a catch-up plan — message them.`,
      };
    case 'pre_recovery':
      /**
       * The last message before the seller can ask for the goods back. It says so plainly: a
       * customer who is about to lose the item deserves to know that, not a fourth nudge.
       */
      return {
        title: 'Last chance before the item is recalled',
        body: `${amount} is still unpaid on your ${ctx.productName}. If we don't hear from you, the seller may ask for it back. Any payment or arrangement stops this.`,
      };
  }
}

/** Fill a partial listing-terms input with the conservative defaults (see rto.terms.ts). */
function resolveListingTerms(input?: Partial<RtoListingTerms>): RtoListingTerms {
  return { ...DEFAULT_RTO_LISTING_TERMS, ...(input ?? {}) };
}

/** Snake-case the listing terms for storage; the model owns the persisted shape. */
function listingTermsToDoc(t: RtoListingTerms) {
  return {
    maintenance_responsibility: t.maintenanceResponsibility,
    damage_responsibility: t.damageResponsibility,
    return_allowed: t.returnAllowed,
    return_transport_responsibility: t.returnTransportResponsibility,
    restocking_fee_cents: t.restockingFeeCents,
    payments_refundable_on_return: t.paymentsRefundableOnReturn,
    ownership_credit_preserved_on_return: t.ownershipCreditPreservedOnReturn,
    reinstatement_allowed: t.reinstatementAllowed,
    cancellation_notice_days: t.cancellationNoticeDays,
    delivery_fee_cents: t.deliveryFeeCents,
    tax_bps: t.taxBps,
  };
}

/** The persisted listing terms, back in the shape the pure helpers speak. */
function listingTermsFromDoc(lt: RtoListingDoc['listing_terms'] | undefined): RtoListingTerms {
  if (!lt) return DEFAULT_RTO_LISTING_TERMS;
  return {
    maintenanceResponsibility: lt.maintenance_responsibility,
    damageResponsibility: lt.damage_responsibility,
    returnAllowed: lt.return_allowed,
    returnTransportResponsibility: lt.return_transport_responsibility,
    restockingFeeCents: lt.restocking_fee_cents,
    paymentsRefundableOnReturn: lt.payments_refundable_on_return,
    ownershipCreditPreservedOnReturn: lt.ownership_credit_preserved_on_return,
    reinstatementAllowed: lt.reinstatement_allowed,
    cancellationNoticeDays: lt.cancellation_notice_days,
    deliveryFeeCents: lt.delivery_fee_cents,
    taxBps: lt.tax_bps,
  };
}

/**
 * The single translation from a published offer to priced terms. Both the disclosure the customer
 * reads and the agreement they sign go through here, so the two cannot describe different deals.
 */
function quoteInputFromListing(listing: RtoListingDoc) {
  return {
    cashPriceCents: listing.cash_price_cents,
    initialPaymentCents: listing.initial_payment_cents,
    installmentCount: listing.installment_count,
    frequency: listing.frequency,
    ...(listing.interval_days ? { customIntervalDays: listing.interval_days } : {}),
    markupBps: listing.markup_bps,
    setupFeeCents: listing.setup_fee_cents ?? 0,
    lateFeeCents: listing.late_fee_cents ?? 0,
    listingTerms: listingTermsFromDoc(listing.listing_terms),
  };
}

function consignmentTermsToDoc(t: ConsignmentRtoTerms) {
  return {
    owner_during_term: t.ownerDuringTerm,
    delivery_by: t.deliveryBy,
    returns_managed_by: t.returnsManagedBy,
    customer_support_by: t.customerSupportBy,
    damage_responsibility: t.damageResponsibility,
    missed_payments_handled_by: t.missedPaymentsHandledBy,
    early_payoff_approved_by: t.earlyPayoffApprovedBy,
    on_customer_return: t.onCustomerReturn,
    ownership_transfers_at: t.ownershipTransfersAt,
    payment_division_note: t.paymentDivisionNote,
  };
}

async function rtoFeeBps(): Promise<number> {
  const rule = await feeService.resolveFeeRule('rto_installment');
  return rule?.rate_bps ?? DEFAULT_CONSIGNMENT_FEE_BPS; // 10% default
}

/**
 * §43 category eligibility — **default-deny**.
 *
 * The previous rule allowed anything that wasn't licence-regulated, which is allow-by-default
 * wearing a denial's clothing: a seller approved for furniture was equally approved for a
 * motorcycle, because nothing said motorcycles were different. §43 requires the opposite posture —
 * an explicit set of things RTO may be offered on — because the unsafe set is open-ended and the
 * safe set is small and knowable.
 *
 * Three gates, in order of how hard they are to override:
 *   1. A category is required. "Uncategorised" is not a licence to sell anything on credit terms.
 *   2. Hard prohibitions (`RTO_PROHIBITED_CATEGORY_SLUGS`, licensed, regulated) — not overridable.
 *   3. The admin's explicit `rto_eligible` opt-in.
 */
/**
 * The category rule as a PREDICATE, so the publish path and the up-front eligibility check share
 * one definition.
 *
 * They used to be destined to diverge: the gate threw, so telling a vendor in advance whether they
 * could publish would have meant a second copy of the same rules. Two copies of a compliance rule
 * is how one of them quietly stops matching. `assertCategoryEligible` is now a thin wrapper.
 */
async function checkCategoryEligible(
  categoryId: string | null,
): Promise<{ ok: boolean; message?: string }> {
  if (!categoryId) {
    return { ok: false, message: 'Rent-to-Own listings must state a product category' };
  }
  const cat = await CategoryModel.findById(categoryId).lean().exec();
  if (!cat) throw NotFoundError('Category not found');

  const prohibited =
    (RTO_PROHIBITED_CATEGORY_SLUGS as readonly string[]).includes(cat.slug) ||
    cat.requires_license ||
    Boolean(cat.regulated_by);
  if (prohibited) {
    return {
      ok: false,
      message:
        'Rent-to-Own is not available for this kind of product. Vehicles and regulated goods need a separate programme.',
    };
  }
  if (!cat.rto_eligible) {
    return { ok: false, message: 'Rent-to-Own is not open for this category yet' };
  }
  return { ok: true };
}

async function assertCategoryEligible(categoryId: string | null): Promise<void> {
  const r = await checkCategoryEligible(categoryId);
  if (!r.ok) throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, r.message);
}

/**
 * §60.3 — RTO launches city by city. `City.feature_flags.rto` has been documented as the compliance
 * gate since the module was written and was never actually checked, so an approved seller could
 * offer RTO in a jurisdiction the company had not cleared. Unknown city → denied, for the same
 * reason as the category rule: silence is not consent.
 */
async function assertCityEnabled(citySlug: string | null | undefined): Promise<void> {
  // Delegates to the default-DENY variant (A-6) rather than re-reading the flag: an unconfigured
  // city must never be treated as cleared, and one definition of "explicitly enabled" is the only
  // way that stays true.
  if (!(await platformService.isFeatureExplicitlyEnabled(citySlug, 'rto'))) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      'Rent-to-Own is not available in this area yet',
    );
  }
}

/**
 * §60 — the launch gate for placeholder legal text.
 *
 * The four agreements are versioned, hashed, and tamper-evident, but their bodies are still
 * PLACEHOLDER pending attorney review. Shipping the RTO flow without this check would mean real
 * customers clickwrapping unenforceable terms and accumulating acceptance records that would all
 * have to be re-collected. The engineering can ship; the acceptance cannot, until the text is real.
 *
 * Deliberately keyed on the text itself rather than a config flag, so it cannot be switched off
 * without the thing it guards actually being fixed.
 */
function assertAgreementReviewed(type: 'rto' | 'consignment_rto'): void {
  if (!isAgreementReviewed(type)) {
    throw BusinessRuleError(
      ERROR_CODES.BUSINESS_RULE,
      'Rent-to-Own is not open yet — the agreement is still in legal review.',
    );
  }
}

export const rtoService = {
  // ─── Approval (R27) ───────────────────────────────────────────────────────────────────────
  /**
   * Can this business publish an RTO offer, and if not, why?
   *
   * Exists because the three gates below used to fire only on SUBMIT — a vendor filled in the cash
   * price, term, frequency, markup, quantity and both toggles, pressed Publish, and only then
   * learned they were never cleared to offer Rent-to-Own at all. That is the artwork-after-payment
   * mistake in a different costume: the rule is right, its position was wrong.
   *
   * Reports every failing gate rather than the first, because fixing one only to meet the next is
   * the same frustration served twice. `categoryId` is optional — the form picks it later, so a
   * page-load check answers the two gates it can and leaves the third until there is something to
   * judge.
   *
   * Deliberately reuses the publish path's own predicates. A second copy of a compliance rule is
   * how one of them quietly stops matching.
   */
  async getEligibility(
    principal: Principal,
    input: { sellerId: string; citySlug?: string; categoryId?: string },
  ) {
    const owner = await vendorsService.getBusinessOwner(input.sellerId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }

    const sellerApproved = await repo.isSellerApproved(input.sellerId);
    const cityEnabled = await platformService.isFeatureExplicitlyEnabled(input.citySlug, 'rto');
    const category = input.categoryId ? await checkCategoryEligible(input.categoryId) : null;

    const blockers: { code: string; message: string }[] = [];
    if (!sellerApproved) {
      blockers.push({
        code: 'seller_not_approved',
        /**
         * Names a real route to a human, because there is no in-app request flow yet — and copy
         * that implies a button somewhere is worse than copy that admits the process is manual.
         * When a "Request review" flow exists (held until a real vendor asks for one), this string
         * is where it gets advertised.
         */
        message:
          'This business has not been approved for Rent-to-Own yet. Renting to own is a ' +
          'credit-like arrangement, so every seller is reviewed by a person first. Email ' +
          'support@streetserve.app with your business name to start that review.',
      });
    }
    if (!cityEnabled) {
      blockers.push({
        code: 'city_not_enabled',
        message: 'Rent-to-Own is not available in this area yet.',
      });
    }
    if (category && !category.ok) {
      blockers.push({ code: 'category_not_eligible', message: category.message! });
    }

    return {
      eligible: blockers.length === 0,
      checks: { sellerApproved, cityEnabled, categoryEligible: category ? category.ok : null },
      blockers,
    };
  },

  async approveSeller(principal: Principal, sellerId: string, note?: string) {
    /**
     * The id must actually be a business.
     *
     * This wrote whatever 24-character string it was handed. An operator pasted a USER id into the
     * "business id" field, the approval was recorded, the screen reported success — and the seller
     * stayed blocked, with the admin list showing an approval and the vendor's screen showing a
     * refusal, neither of them wrong and neither explaining the other.
     *
     * A permission granted against something that does not exist is worse than a rejected one: it
     * looks done.
     */
    const owner = await vendorsService.getBusinessOwner(sellerId);
    if (!owner) {
      throw NotFoundError(
        'No business with that id. Search for the business by name rather than entering an id — ' +
          'a user id and a business id look identical and only one of them can be approved.',
      );
    }
    await repo.approveSeller(sellerId, principal.userId, note ?? null);
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.seller_approved',
      entityType: 'business',
      entityId: sellerId,
      metadata: { note: note ?? null },
    });
    return { sellerId, approved: true };
  },

  /** Admin: who is currently cleared to offer RTO, and revoking that. */
  async listApprovedSellers(limit = 100) {
    const rows = await repo.listApprovedSellers(limit);
    /**
     * Resolved to names. The roster listed raw ids, so the only way to check whether the right
     * business had been approved was to recognise a hex string — which is how a user id sat in this
     * list looking exactly as legitimate as a business id.
     *
     * One query for the batch rather than one per row: this list is read on every visit to the
     * screen and is allowed to be long.
     */
    const { BusinessModel } = await import('../vendors/vendors.model');
    const businesses = await BusinessModel.find({ _id: { $in: rows.map((r) => r.seller_id) } })
      .select('name')
      .lean()
      .exec();
    const nameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return rows.map((r) => ({
      sellerId: r.seller_id,
      /**
       * Null when the id matches no business — which is exactly the state that prompted this, and
       * the UI marks it as unknown rather than hiding it. A stale approval must stay visible so it
       * can be revoked; silently dropping it would leave a permission nobody can see or remove.
       */
      businessName: nameById.get(r.seller_id) ?? null,
      approvedBy: r.approved_by,
      note: r.note ?? null,
      approvedAt: r.created_at,
    }));
  },

  async revokeSeller(principal: Principal, sellerId: string) {
    await repo.revokeSeller(sellerId);
    /**
     * Existing agreements are deliberately untouched. Revocation stops a seller taking NEW
     * customers; unwinding contracts people are already paying into is a different decision with
     * its own consequences, and it is not one an admin should make by clicking "revoke".
     */
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.seller_revoked',
      entityType: 'business',
      entityId: sellerId,
    });
    return { sellerId, approved: false };
  },

  /**
   * §43/§60.3 — the compliance surface, in one read: which markets are open for RTO and which
   * categories may be offered. Kept together because these are the two switches that decide whether
   * RTO may happen at all, and an admin reviewing one almost always needs the other.
   */
  async getMarkets() {
    const [cities, categories] = await Promise.all([
      CityModel.find({}, { slug: 1, name: 1, state: 1, status: 1, feature_flags: 1 })
        .sort({ name: 1 })
        .lean()
        .exec(),
      CategoryModel.find(
        {},
        { slug: 1, name: 1, rto_eligible: 1, requires_license: 1, regulated_by: 1 },
      )
        .sort({ name: 1 })
        .lean()
        .exec(),
    ]);
    const agreement = agreementsService.get('rto');
    return {
      /**
       * The launch gate, surfaced rather than hidden: an admin looking at an empty RTO marketplace
       * should be told the reason is legal review, not left to guess at a config problem.
       */
      agreementReviewed: agreement.reviewed,
      agreementVersion: agreement.version,
      cities: cities.map((c) => ({
        slug: c.slug,
        name: c.name,
        state: c.state,
        status: c.status,
        rtoEnabled: ((c.feature_flags ?? {}) as Record<string, unknown>).rto === true,
      })),
      categories: categories.map((c) => {
        const prohibited =
          (RTO_PROHIBITED_CATEGORY_SLUGS as readonly string[]).includes(c.slug) ||
          c.requires_license ||
          Boolean(c.regulated_by);
        return {
          id: String(c._id),
          slug: c.slug,
          name: c.name,
          rtoEligible: c.rto_eligible === true,
          /** Hard prohibition — the toggle is shown disabled rather than hidden, so the rule is legible. */
          prohibited,
        };
      }),
    };
  },

  /** Open or close a city for RTO (§60.3). */
  async setCityRto(principal: Principal, citySlug: string, enabled: boolean) {
    const city = await CityModel.findOneAndUpdate(
      { slug: citySlug },
      { $set: { 'feature_flags.rto': enabled } },
      { new: true },
    )
      .lean()
      .exec();
    if (!city) throw NotFoundError('City not found');
    await writeAudit({
      actorId: principal.userId,
      action: enabled ? 'rto.city_opened' : 'rto.city_closed',
      entityType: 'city',
      entityId: citySlug,
    });
    return { citySlug, rtoEnabled: enabled };
  },

  // ─── Listings (§42/§44) ───────────────────────────────────────────────────────────────────
  /**
   * Publish an offer. Every gate that governs whether RTO may happen at all is checked HERE, at
   * publish time, so a customer never sees an offer they would be refused on — and checked again at
   * acceptance, because a category or city can be closed while a listing is live.
   */
  async createListing(
    principal: Principal,
    input: {
      sellerId: string;
      productName: string;
      description?: string;
      photos?: string[];
      categoryId: string;
      citySlug: string;
      cashPriceCents: number;
      initialPaymentCents: number;
      installmentCount: number;
      frequency: RtoQuoteInput['frequency'];
      customIntervalDays?: number;
      markupBps: number;
      setupFeeCents?: number;
      lateFeeCents?: number;
      listingTerms?: Partial<RtoListingTerms>;
      quantityAvailable: number;
      /** §54 — the three-party arrangement, agreed before the offer goes live. */
      isConsignment?: boolean;
      ownerId?: string;
      ownerType?: 'user' | 'business';
      commissionBps?: number;
      consignmentTerms?: ConsignmentRtoTerms;
    },
  ) {
    const owner = await vendorsService.getBusinessOwner(input.sellerId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }
    if (!(await repo.isSellerApproved(input.sellerId))) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This business is not approved to offer Rent-to-Own',
      );
    }
    await assertCategoryEligible(input.categoryId);
    await assertCityEnabled(input.citySlug);

    const terms = resolveListingTerms(input.listingTerms);
    const doc = await repo.createListing({
      seller_id: input.sellerId,
      created_by: principal.userId,
      product_name: input.productName,
      description: input.description ?? null,
      photos: input.photos ?? [],
      category_id: input.categoryId,
      city_slug: input.citySlug,
      cash_price_cents: input.cashPriceCents,
      initial_payment_cents: input.initialPaymentCents,
      installment_count: input.installmentCount,
      frequency: input.frequency,
      interval_days: input.customIntervalDays ?? null,
      markup_bps: input.markupBps,
      setup_fee_cents: input.setupFeeCents ?? 0,
      late_fee_cents: input.lateFeeCents ?? 0,
      listing_terms: listingTermsToDoc(terms),
      quantity_available: input.quantityAvailable,
      status: 'active',
      /**
       * §54 — the ten allocations are settled at publish, so a customer never accepts a three-party
       * agreement whose responsibilities the two businesses have not written down.
       */
      is_consignment: input.isConsignment ?? false,
      owner_id: input.ownerId ?? null,
      owner_type: input.ownerType ?? 'business',
      commission_bps: input.commissionBps ?? 0,
      ...(input.consignmentTerms
        ? { consignment_terms: consignmentTermsToDoc(input.consignmentTerms) }
        : {}),
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'rto.listing_created',
      entityType: 'rto_listing',
      entityId: String(doc._id),
      metadata: { sellerId: input.sellerId, cashPriceCents: input.cashPriceCents },
    });
    return this.listingView(doc.toObject());
  },

  async listMyListings(principal: Principal, sellerId: string, limit = 50) {
    const owner = await vendorsService.getBusinessOwner(sellerId);
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }
    const rows = await repo.listListingsForSeller(sellerId, limit);
    return rows.map((r) => this.listingView(r));
  },

  async setListingStatus(
    principal: Principal,
    listingId: string,
    status: 'active' | 'paused' | 'withdrawn',
  ) {
    const listing = await repo.findListingById(listingId);
    if (!listing) throw NotFoundError('Listing not found');
    const owner = await vendorsService.getBusinessOwner(listing.seller_id);
    if (owner !== principal.userId) {
      throw ForbiddenError('Not your listing', ERROR_CODES.NOT_OWNER);
    }
    const updated = await repo.setListingStatus(listingId, listing.seller_id, status);
    return this.listingView(updated!);
  },

  /** Public browse — live, in-stock offers only. */
  async browseListings(
    filter: { citySlug?: string; categoryId?: string; sellerId?: string },
    limit = 50,
  ) {
    const rows = await repo.browseListings(filter, limit);
    return rows.map((r) => this.listingView(r));
  },

  /**
   * The §44 disclosure for one listing: every money field, the full obligations, and the plain
   * "may cost more than buying outright" line — computed from the SELLER's terms, so what the
   * customer reads is what they will be held to.
   */
  async getListingDisclosure(listingId: string) {
    const listing = await repo.findListingById(listingId);
    if (!listing) throw NotFoundError('Listing not found');
    const quote = await this.disclose(quoteInputFromListing(listing));
    return { listing: this.listingView(listing), ...quote };
  },

  /**
   * Disclosure quote (R20/U8): the full itemized cost of an RTO deal, with the plain "may cost more
   * than buying outright" delta. Pure — no agreement is created.
   */
  async disclose(
    input: Omit<RtoQuoteInput, 'feeBps'> & { listingTerms?: Partial<RtoListingTerms> },
  ) {
    const feeBps = await rtoFeeBps();
    const quote = computeRtoQuote({ ...input, feeBps });
    const terms = resolveListingTerms(input.listingTerms);
    return {
      ...quote,
      feeBps,
      /**
       * §44 requires far more than the money on the listing: maintenance, damage, return rights and
       * cancellation terms must all be visible BEFORE acceptance. They are returned here as both the
       * structured terms (so a client can lay them out, compare them, or gate on them) and as
       * plain-language lines (so a screen can render them without re-deriving the wording, and every
       * surface says the same thing).
       */
      listingTerms: terms,
      obligations: describeListingTerms(terms),
      disclosure:
        `You'll pay ${dollars(quote.totalToOwnCents)} total to own this — ` +
        `${dollars(quote.costOverCashCents)} more than the ${dollars(quote.cashPriceCents)} cash price. ` +
        `Rent-to-own may cost more than buying outright.`,
    };
  },

  /**
   * Accept an RTO agreement (R20/R21/R24/R26): eligibility + approval gated, the RTO clickwrap is
   * recorded (tamper-evident), the disclosed schedule is locked into an immutable plan, and the
   * initial payment + optional setup fee are charged and appended to the immutable ledger.
   */
  async accept(
    principal: Principal,
    input: {
      /**
       * The offer being accepted. REQUIRED — and the only thing the customer chooses.
       *
       * Every money term used to come from this request body, which meant a customer could author
       * an agreement for any product at any price and the seller was never consulted. Terms are now
       * read from the listing, so the customer's input is genuinely a yes/no.
       */
      listingId: string;
      /** §52 delivery condition report — photos, video, serial, damage, accessories, value. */
      condition?: ConditionReportInput;
    },
    idempotencyKey: string,
  ) {
    const listingForGate = await repo.findListingById(input.listingId);
    /**
     * §60 — no acceptance while the agreement text is still a placeholder. Checked before anything
     * is written or charged, so a pre-review environment cannot accumulate clickwrap records that
     * would all have to be re-collected. A consignment offer is gated on ITS agreement, which is a
     * separate document with its own review state.
     */
    assertAgreementReviewed(listingForGate?.is_consignment ? 'consignment_rto' : 'rto');

    const listing = await repo.findListingById(input.listingId);
    if (!listing) throw NotFoundError('Listing not found');
    if (listing.status !== 'active') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This offer is no longer available');
    }
    const sellerId = listing.seller_id;

    // Seller (managing business) must be approved for RTO and own a payout account; category eligible.
    const owner = await vendorsService.getBusinessOwner(sellerId);
    if (!owner) throw NotFoundError('Seller business not found');
    if (owner === principal.userId) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'You cannot rent your own listing');
    }
    if (!(await repo.isSellerApproved(sellerId))) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This seller is not approved to offer Rent-to-Own',
      );
    }
    // Re-checked at acceptance, not just at publish: a category or a city can be closed while a
    // listing is still live, and the gate that matters is the one at the moment money moves.
    await assertCityEnabled(listing.city_slug);
    await assertCategoryEligible(String(listing.category_id));
    /**
     * §54: a three-party listing must carry the owner AND all ten allocations. Enforced at publish
     * too, but re-checked here because this is the moment a customer becomes bound by them — and a
     * three-party deal that has not written down who eats a damaged item is a future dispute rather
     * than an agreement.
     */
    if (
      listing.is_consignment &&
      (!listing.owner_id || !listing.consignment_terms?.owner_during_term)
    ) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This consignment offer is incomplete — it must name the owner and state who handles delivery, returns, support, damage, missed payments, early payoff, and when ownership transfers',
      );
    }
    /**
     * Claim a unit BEFORE charging. Two customers racing for the last item must not both end up
     * with an agreement — and if anything downstream fails, the unit goes back on the shelf.
     */
    const claimed = await repo.claimListingUnit(input.listingId);
    if (!claimed) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This offer has just been taken');
    }

    try {
      return await this.finalizeAcceptance(principal, listing, input, idempotencyKey);
    } catch (err) {
      await repo.releaseListingUnit(input.listingId);
      throw err;
    }
  },

  /** The write half of `accept`, split out so the unit claim above has a clean rollback path. */
  async finalizeAcceptance(
    principal: Principal,
    listing: RtoListingDoc,
    input: {
      listingId: string;
      /** §52 delivery condition report — photos, video, serial, damage, accessories, value. */
      condition?: ConditionReportInput;
    },
    idempotencyKey: string,
  ) {
    /**
     * Terms come from the LISTING, never the request. This is the line that turns an agreement from
     * a statement of one party's wishes into a contract.
     */
    const quoteInput = quoteInputFromListing(listing);
    const listingTerms = quoteInput.listingTerms;
    const sellerId = listing.seller_id;

    // Record the RTO agreement clickwrap (R20 via the Phase-2 agreements framework).
    const accepted = await agreementsService.accept(
      principal,
      listing.is_consignment ? 'consignment_rto' : 'rto',
    );

    const feeBps = await rtoFeeBps();
    const quote = computeRtoQuote({ ...quoteInput, feeBps });
    const now = Date.now();

    const agreement = (await repo.createAgreement({
      customer_id: principal.userId,
      seller_id: sellerId,
      listing_id: String(listing._id),
      product_name: listing.product_name,
      category_id: listing.category_id,
      cash_price_cents: quote.cashPriceCents,
      initial_payment_cents: quote.initialPaymentCents,
      installment_amount_cents: quote.installmentAmountCents,
      installment_count: quote.installmentCount,
      frequency: quote.frequency,
      interval_days: quote.intervalDays,
      grace_days: quote.graceDays,
      total_to_own_cents: quote.totalToOwnCents,
      cost_over_cash_cents: quote.costOverCashCents,
      markup_bps: quoteInput.markupBps,
      fee_bps: feeBps,
      setup_fee_cents: quote.setupFeeCents,
      late_fee_cents: quote.lateFeeCents,
      agreement_version: accepted.version,
      agreement_hash: accepted.contentHash,
      listing_terms: listingTermsToDoc(listingTerms),
      /**
       * §52 — the delivery report, acknowledged by the CUSTOMER at acceptance (they are the one
       * confirming what they received). The seller signs separately, which is what turns one side's
       * account of the condition into an agreed fact.
       */
      condition_delivery: conditionReportToDoc(input.condition ?? {}, { customerAck: true }),
      ownership_credited_cents: quote.initialOwnershipCreditCents,
      installments_paid: 0,
      next_due_at: quote.schedule[0] ? new Date(now + quote.schedule[0].dueOffsetDays * 86_400_000) : null,
      status: 'active',
      /** §54 — the arrangement is the LISTING's, snapshotted onto the agreement at acceptance. */
      is_consignment: listing.is_consignment ?? false,
      owner_id: listing.owner_id ?? null,
      owner_type: listing.owner_type ?? 'business',
      commission_bps: listing.commission_bps ?? 0,
      ...(listing.consignment_terms?.owner_during_term
        ? { consignment_terms: listing.consignment_terms }
        : {}),
    })) as AgreementDoc;
    const agreementId = String(agreement._id);

    // Lock the immutable schedule.
    await repo.insertInstallments(
      quote.schedule.map((s) => ({
        agreement_id: agreementId,
        installment_number: s.installmentNumber,
        due_at: new Date(now + s.dueOffsetDays * 86_400_000),
        amount_cents: s.amountCents,
        ownership_credit_cents: s.ownershipCreditCents,
        rental_cents: s.rentalCents,
        fee_cents: s.feeCents,
        status: 'scheduled',
      })),
    );

    // Charge the initial payment (fee applies per payment) + optional setup fee; append to ledger.
    if (quote.initialPaymentCents > 0) {
      const charge = await paymentsService.charge({
        customerId: principal.userId,
        counterpartyType: 'business',
        counterpartyId: sellerId,
        amountCents: quote.initialPaymentCents,
        feeType: 'rto_installment',
        idempotencyKey: `${idempotencyKey}_initial`,
      });
      await repo.appendLedger({
        agreement_id: agreementId,
        entry_type: 'initial',
        installment_number: null,
        amount_cents: quote.initialPaymentCents,
        fee_cents: charge.platformFeeCents ?? 0,
        ownership_credit_cents: quote.initialOwnershipCreditCents,
        transaction_id: charge.transactionId,
        idempotency_key: `rto_initial_${agreementId}`,
      });
      await paymentsService.completeForOrder(charge.transactionId); // capture-at-acceptance
      await this.recordSplit(agreement, null, 'initial', quote.initialPaymentCents);
    }
    if (quote.setupFeeCents > 0) {
      const setup = await paymentsService.charge({
        customerId: principal.userId,
        counterpartyType: 'business',
        counterpartyId: sellerId,
        amountCents: quote.setupFeeCents,
        feeType: 'setup',
        idempotencyKey: `${idempotencyKey}_setup`,
      });
      await repo.appendLedger({
        agreement_id: agreementId,
        entry_type: 'setup_fee',
        installment_number: null,
        amount_cents: quote.setupFeeCents,
        fee_cents: setup.platformFeeCents ?? 0,
        ownership_credit_cents: 0,
        transaction_id: setup.transactionId,
        idempotency_key: `rto_setup_${agreementId}`,
      });
      await paymentsService.completeForOrder(setup.transactionId);
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'rto.agreement_accepted',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { sellerId: sellerId, totalToOwnCents: quote.totalToOwnCents },
    });
    await publish('rto.agreement_accepted', { agreementId, customerId: principal.userId });
    return this.dashboardFrom(agreement, quote);
  },

  /**
   * Charge sweep (R21): charge every installment now due. Success → paid + ownership credit (and
   * completion/ownership transfer on the final one). A failed charge → the installment is missed and
   * the agreement enters Grace (R22). Idempotent via the ledger's unique key and Stripe idempotency.
   */
  async chargeDueInstallments(): Promise<{ charged: number; missed: number; completed: number }> {
    const now = new Date();
    const due = await repo.dueInstallments(now, SWEEP_BATCH_LIMIT);
    let charged = 0;
    let missed = 0;
    let completed = 0;

    for (const inst of due) {
      const agreementId = inst.agreement_id;
      const n = inst.installment_number;
      const agreement = await repo.findAgreementById(agreementId);
      /**
       * Never charge an agreement that is paused (§50) or whose goods are on their way back (§51).
       * `return_pending` was the gap: a customer who had agreed to hand the item over would still
       * have been billed for it while it sat in the van.
       */
      if (
        !agreement ||
        ['completed', 'cancelled', 'disputed', 'paused', 'return_pending'].includes(agreement.status)
      ) {
        continue;
      }
      try {
        const charge = await paymentsService.charge({
          customerId: agreement.customer_id,
          counterpartyType: 'business',
          counterpartyId: agreement.seller_id,
          amountCents: inst.amount_cents,
          feeType: 'rto_installment',
          idempotencyKey: `rto_${agreementId}_${n}`,
        });
        const ledger = await repo.appendLedger({
          agreement_id: agreementId,
          entry_type: 'installment',
          installment_number: n,
          amount_cents: inst.amount_cents,
          fee_cents: charge.platformFeeCents ?? 0,
          ownership_credit_cents: inst.ownership_credit_cents,
          transaction_id: charge.transactionId,
          idempotency_key: `rto_ledger_${agreementId}_${n}`,
        });
        if (!ledger) continue; // already recorded — skip (idempotent)
        await paymentsService.completeForOrder(charge.transactionId);
        await repo.claimInstallment(agreementId, n);
        await repo.setInstallmentTxn(agreementId, n, charge.transactionId);
        await this.recordSplit(agreement as AgreementDoc, n, String(n), inst.amount_cents);
        const done = await this.applyPaidInstallment(agreement as AgreementDoc, inst.ownership_credit_cents);
        charged += 1;
        if (done) completed += 1;
      } catch {
        // Charge failed → the installment is Missed and the agreement enters Grace (R22). Never a
        // silent skip: the customer is notified with a supportive next step (U10).
        await repo.markInstallmentMissed(agreementId, n);
        await repo.transitionAgreement(agreementId, ['active', 'grace', 'late'], {
          status: 'grace',
        });
        notificationsService.notify(agreement.customer_id, {
          category: 'rto',
          title: 'Payment didn’t go through',
          body: 'We couldn’t process your Rent-to-Own payment. You’re in the grace period — update your payment method or set up an arrangement to stay on track.',
          data: { agreementId, installmentNumber: n, actions: ['update_payment', 'arrangement'] },
        });
        missed += 1;
      }
    }
    // 5.3: hourly × 500 = 12,000/day, and installments cluster on the 1st and 15th. Saturation here
    // means a customer's payment lands hours after they budgeted for it.
    reportSweepBatch('rto-installments', due.length);
    return { charged, missed, completed };
  },

  /**
   * Delinquency sweep (R22): agreements in Grace whose missed installment is past the grace window
   * move to Late (audit-logged), and get a reminder. Kept separate so Grace→Late timing is explicit.
   */
  async sweepDelinquency(): Promise<number> {
    const now = new Date();
    const graced = await import('./rto.model').then(({ RtoAgreementModel }) =>
      RtoAgreementModel.find({ status: 'grace' }).limit(SWEEP_BATCH_LIMIT).lean().exec(),
    );
    let escalated = 0;
    for (const a of graced) {
      const schedule = await repo.installmentsForAgreement(String(a._id));
      const oldestMissed = schedule.find((s) => s.status === 'missed');
      if (!oldestMissed) continue;
      const lateAt = new Date(oldestMissed.due_at.getTime() + (a.grace_days ?? 7) * 86_400_000);
      if (now >= lateAt) {
        await repo.transitionAgreement(String(a._id), ['grace'], { status: 'late' });
        const lateFeeCents = await this.assessLateFee(a, oldestMissed.installment_number);
        await writeAudit({
          action: 'rto.late',
          entityType: 'rto_agreement',
          entityId: String(a._id),
          metadata: { installmentNumber: oldestMissed.installment_number, lateFeeCents },
        });
        escalated += 1;
      }
    }
    reportSweepBatch('rto-delinquency', graced.length);
    return escalated;
  },

  /**
   * §49/§50 — assess the disclosed late fee, once, when an agreement escalates Grace → Late.
   *
   * This closes a gap the A-2 reachability gate surfaced: `late_fee_cents` is a seller-set listing
   * term, it is shown to the customer in the §44 disclosure before they accept, and the ledger
   * declared a `late_fee` entry type — but nothing ever wrote one. A fee that is disclosed and never
   * charged is a promise made to the customer in the wrong direction, and it leaves the seller
   * without the remedy the terms said they had.
   *
   * Three deliberate constraints:
   *   - **Once per installment.** The idempotency key is per (agreement, installment), so a sweep
   *     that runs twice, or a re-escalation after a cure, cannot stack fees on the same miss.
   *   - **Recorded, not charged.** The fee is appended to the immutable ledger and added to what the
   *     customer owes; no card is touched. Auto-charging a penalty to a customer who has just failed
   *     a payment is how an overdraft spiral starts, and §50 asks for communication before
   *     escalation.
   *   - **No ownership credit.** A late fee buys the customer nothing. Like arrears, it carries
   *     `ownership_credit_cents: 0` — paying a penalty must never move someone closer to owning the
   *     item, or the fee would quietly become equity.
   *
   * Returns the fee assessed (0 when the listing set none, which is the default).
   */
  async assessLateFee(agreement: AgreementDoc, installmentNumber: number): Promise<number> {
    const lateFeeCents = agreement.late_fee_cents ?? 0;
    if (lateFeeCents <= 0) return 0;
    const agreementId = String(agreement._id);

    const entry = await repo.appendLedger({
      agreement_id: agreementId,
      entry_type: 'late_fee',
      installment_number: installmentNumber,
      amount_cents: lateFeeCents,
      fee_cents: 0, // the platform takes no cut of a penalty; it is the seller's remedy, not revenue
      ownership_credit_cents: 0,
      transaction_id: null,
      idempotency_key: `rto_late_fee_${agreementId}_${installmentNumber}`,
    });
    if (!entry) return 0; // already assessed for this installment

    await repo.updateAgreement(agreementId, {
      late_fees_assessed_cents: (agreement.late_fees_assessed_cents ?? 0) + lateFeeCents,
    });
    notificationsService.notify(agreement.customer_id, {
      category: 'rto',
      title: 'A late fee was added',
      body: `A ${formatCents(lateFeeCents)} late fee was added for payment #${installmentNumber}. Paying the missed installment stops further fees — it is not charged automatically.`,
      data: { agreementId, installmentNumber, lateFeeCents },
    });
    return lateFeeCents;
  },

  /** Apply a paid installment's ownership credit; on the last one, complete + transfer ownership. */
  async applyPaidInstallment(agreement: AgreementDoc, ownershipCredit: number): Promise<boolean> {
    const agreementId = String(agreement._id);
    const paid = (agreement.installments_paid ?? 0) + 1;
    const credited = (agreement.ownership_credited_cents ?? 0) + ownershipCredit;
    const schedule = await repo.installmentsForAgreement(agreementId);
    const nextScheduled = schedule.find((s) => s.status === 'scheduled');
    const allPaid = paid >= agreement.installment_count;

    await repo.updateAgreement(agreementId, {
      installments_paid: paid,
      ownership_credited_cents: credited,
      next_due_at: nextScheduled?.due_at ?? null,
      status: allPaid ? 'completed' : 'active',
    });
    if (allPaid) {
      await this.completeAndTransfer({
        _id: agreement._id,
        customer_id: agreement.customer_id,
        product_name: agreement.product_name,
        seller_id: agreement.seller_id,
      });
    }
    return allPaid;
  },

  /** Ownership transfer (R25): on paid-in-full, issue proof of ownership and close recovery/auto-pay. */
  async completeAndTransfer(agreement: {
    _id: unknown;
    customer_id: string;
    product_name: string;
    /** §53 step 9 — who the completion feedback prompt is about. */
    seller_id: string;
  }): Promise<void> {
    const agreementId = String(agreement._id);
    const proof = `rto-own-${agreementId}-${randomUUID().slice(0, 8)}`;
    await repo.updateAgreement(agreementId, {
      status: 'completed',
      ownership_transferred_at: new Date(),
      proof_of_ownership_ref: proof,
    });
    await repo.markInstallmentsWaived(agreementId); // any residual scheduled rows are moot
    /**
     * 7.1 — §53 completion is a contractual notice, not a celebration. It is the moment ownership
     * transfers, and the proof-of-ownership reference in it is what a customer produces if anyone
     * later disputes that the item is theirs. Delivering that only to an in-app inbox they may
     * never open again — the agreement is finished, so they have no reason to — is the one case
     * where out-of-app delivery matters most.
     */
    await noticesService.send({
      userId: agreement.customer_id,
      type: 'rto_completed',
      entityType: 'rto_agreement',
      entityId: agreementId,
      subject: 'It’s yours — ownership transferred',
      body:
        `You’ve paid off ${agreement.product_name}. Ownership has transferred to you.

` +
        `Proof of ownership: ${proof}

Keep this reference. It is your record that the item is yours.`,
      category: 'rto',
      data: {
        agreementId,
        proofOfOwnership: proof,
        /**
         * §53 step 9 — completion asks for feedback. Attached to the completion notice rather than
         * sent as a second message: the moment someone has just been told the thing is theirs is
         * the moment they have an opinion about how it went, and a separate nudge a day later is
         * one more notification for a relationship that has ended.
         *
         * A review needs a completed transaction (anti-manipulation — one review per transaction),
         * so the id of the payment that finished the agreement travels with the prompt. Null when
         * no ledger entry carried one, and the client must then not offer the prompt rather than
         * offering one that will fail.
         */
        feedback: {
          transactionId: await this.lastPaidTransactionId(agreementId),
          subjectType: 'business' as const,
          subjectId: agreement.seller_id,
        },
      },
      idempotencyKey: `rto_completed_${agreementId}`,
    });
    await writeAudit({
      action: 'rto.ownership_transferred',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { proof },
    });
    await publish('rto.completed', { agreementId, customerId: agreement.customer_id });
  },

  /**
   * §53 step 9 — the transaction a completion review can be attached to.
   *
   * The most recent ledger entry that actually moved money. Refunds are excluded: a review hung off
   * a refund would be a review of getting money back, not of the deal.
   */
  async lastPaidTransactionId(agreementId: string): Promise<string | null> {
    const entries = await repo.ledgerForAgreement(agreementId);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.transaction_id && entry.entry_type !== 'refund') return entry.transaction_id;
    }
    return null;
  },

  /**
   * Early payoff (R23): the LOCKED formula captured at acceptance — remaining equity to the cash
   * price. Charge it, credit ownership to full, waive the rest, and transfer ownership.
   */
  async payoff(principal: Principal, agreementId: string, idempotencyKey: string) {
    const agreement = (await repo.findAgreementById(agreementId)) as AgreementDoc | null;
    if (!agreement) throw NotFoundError('Agreement not found');
    if (agreement.customer_id !== principal.userId)
      throw ForbiddenError('Not your agreement', ERROR_CODES.NOT_PARTICIPANT);
    if (['completed', 'cancelled'].includes(agreement.status)) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Agreement is ${agreement.status}`);
    }
    const payoffCents = computePayoff(agreement.cash_price_cents, agreement.ownership_credited_cents ?? 0);
    if (payoffCents <= 0) {
      await this.completeAndTransfer(agreement);
      return { agreementId, payoffCents: 0, completed: true };
    }
    const charge = await paymentsService.charge({
      customerId: principal.userId,
      counterpartyType: 'business',
      counterpartyId: agreement.seller_id,
      amountCents: payoffCents,
      feeType: 'rto_installment',
      idempotencyKey: `${idempotencyKey}_payoff`,
    });
    const ledger = await repo.appendLedger({
      agreement_id: agreementId,
      entry_type: 'payoff',
      installment_number: null,
      amount_cents: payoffCents,
      fee_cents: charge.platformFeeCents ?? 0,
      ownership_credit_cents: payoffCents,
      transaction_id: charge.transactionId,
      idempotency_key: `rto_payoff_${agreementId}`,
    });
    if (ledger) {
      await paymentsService.completeForOrder(charge.transactionId);
      await repo.updateAgreement(agreementId, {
        ownership_credited_cents: agreement.cash_price_cents,
      });
      await this.completeAndTransfer({
        _id: agreement._id,
        customer_id: agreement.customer_id,
        product_name: agreement.product_name,
        seller_id: agreement.seller_id,
      });
    }
    return { agreementId, payoffCents, completed: true };
  },

  /** Progress dashboard (U9): next due, balance, made/remaining, ownership %, live payoff amount. */
  async getDashboard(principal: Principal, agreementId: string) {
    const agreement = (await repo.findAgreementById(agreementId)) as AgreementDoc | null;
    if (!agreement) throw NotFoundError('Agreement not found');
    const isCustomer = agreement.customer_id === principal.userId;
    const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
    if (!isCustomer && owner !== principal.userId)
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);
    const schedule = await repo.installmentsForAgreement(agreementId);
    return this.dashboard(agreement, schedule);
  },

  async listMine(principal: Principal, limit: number) {
    const rows = await repo.listAgreementsForCustomer(principal.userId, limit);
    return rows.map((a) => this.summaryView(a as AgreementDoc));
  },

  /**
   * Consignment-RTO 3-party split (R19): for each payment, split the gross across owner / managing
   * business commission / platform fee, transfer the owner their share, and append immutable per-party
   * statement lines. Idempotent per (agreement, label). No-op for non-consignment agreements.
   */
  async recordSplit(agreement: AgreementDoc, installmentNumber: number | null, label: string, grossCents: number) {
    if (!agreement.is_consignment || !agreement.owner_id) return null;
    const agreementId = String(agreement._id);
    /**
     * §56.1 — every leg the spec names. Tax and delivery come from the agreement's own snapshotted
     * listing terms, so a rate change never re-divides a payment already made. Delivery is charged
     * once (on the first payment), because it reimburses one trip rather than each instalment.
     */
    const lt = agreement.listing_terms;
    const isFirstPayment = installmentNumber === null || installmentNumber === 1;
    const split = splitConsignmentRto(
      grossCents,
      {
        platformBps: agreement.fee_bps,
        processingBps: 0, // customer-facing processing is off at launch (§2)
        commissionBps: agreement.commission_bps ?? 0,
        taxBps: lt?.tax_bps ?? 0,
        deliveryCents: isFirstPayment ? (lt?.delivery_fee_cents ?? 0) : 0,
      },
      {
        cashPriceCents: agreement.cash_price_cents,
        ownershipCreditedCents: agreement.ownership_credited_cents ?? 0,
      },
    );

    // Pay the consignment owner their share (from the managing business's collected funds).
    const transfer = await paymentsService.payoutTransfer({
      ownerType: (agreement.owner_type) ?? 'business',
      ownerId: agreement.owner_id,
      amountCents: split.ownerCents,
      transferGroup: `rto_${agreementId}`,
      idempotencyKey: `rto_owner_${agreementId}_${label}`,
    });

    const lines: { party: string; party_ref: string | null; role: string; amount: number; transfer: string | null; key: string }[] = [
      { party: 'platform', party_ref: null, role: 'platform fee', amount: split.platformFeeCents, transfer: null, key: `rto_stmt_plat_${agreementId}_${label}` },
      { party: 'managing_business', party_ref: agreement.seller_id, role: 'commission', amount: split.commissionCents, transfer: null, key: `rto_stmt_comm_${agreementId}_${label}` },
      { party: 'owner', party_ref: agreement.owner_id, role: 'owner share', amount: split.ownerCents, transfer: transfer?.transferId ?? null, key: `rto_stmt_owner_${agreementId}_${label}` },
    ];
    if (split.processingCents > 0) {
      lines.push({ party: 'processor', party_ref: null, role: 'processing', amount: split.processingCents, transfer: null, key: `rto_stmt_proc_${agreementId}_${label}` });
    }
    /**
     * §56.1 — tax and delivery are recorded as their own lines, never folded into someone's share.
     * Tax belongs to the state; delivery reimburses whoever moved the goods. Burying either inside
     * the owner's or the platform's number makes the statement unauditable and the remittance wrong.
     */
    if (split.taxCents > 0) {
      lines.push({ party: 'platform', party_ref: null, role: 'sales tax (remitted)', amount: split.taxCents, transfer: null, key: `rto_stmt_tax_${agreementId}_${label}` });
    }
    if (split.deliveryCents > 0) {
      lines.push({ party: 'managing_business', party_ref: agreement.seller_id, role: 'delivery', amount: split.deliveryCents, transfer: null, key: `rto_stmt_deliv_${agreementId}_${label}` });
    }
    for (const l of lines) {
      await repo.appendStatement({
        agreement_id: agreementId,
        installment_number: installmentNumber,
        party: l.party,
        party_ref: l.party_ref,
        role: l.role,
        amount_cents: l.amount,
        transfer_ref: l.transfer,
        idempotency_key: l.key,
      });
    }
    return split;
  },

  /**
   * Per-party electronic statements (R19): each party's line items + running total, plus a
   * reconciliation that the split lines sum back to the gross collected (B4).
   */
  async getStatements(principal: Principal, agreementId: string) {
    const agreement = (await repo.findAgreementById(agreementId)) as AgreementDoc | null;
    if (!agreement) throw NotFoundError('Agreement not found');
    const managingOwner = await vendorsService.getBusinessOwner(agreement.seller_id);
    const isParticipant =
      agreement.customer_id === principal.userId ||
      agreement.owner_id === principal.userId ||
      managingOwner === principal.userId;
    if (!isParticipant) throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);

    const rows = await repo.statementsForAgreement(agreementId);
    const byParty: Record<string, { totalCents: number; lines: unknown[] }> = {};
    let splitTotal = 0;
    for (const r of rows) {
      const p = (byParty[r.party] ??= { totalCents: 0, lines: [] });
      p.totalCents += r.amount_cents;
      p.lines.push({
        installmentNumber: r.installment_number,
        role: r.role,
        amountCents: r.amount_cents,
        at: r.created_at,
      });
      splitTotal += r.amount_cents;
    }
    // Gross collected = sum of the ledger's customer-facing charges (initial + installments + payoff).
    const grossAgg = await repo.sumLedgerAmount(agreementId);
    const grossCollected = grossAgg[0]?.total ?? 0;
    return {
      agreementId,
      isConsignment: agreement.is_consignment ?? false,
      parties: byParty,
      reconciliation: {
        splitTotalCents: splitTotal,
        grossCollectedCents: grossCollected,
        // In a consignment-RTO every gross dollar is split, so the split lines equal the gross.
        clean: splitTotal === grossCollected,
      },
    };
  },

  /** Internal-consistency reconciliation: the immutable ledger must equal what was collected. */
  async reconcile(agreementId: string) {
    const agg = await repo.sumLedgerAmount(agreementId);
    const ledgerTotal = agg[0]?.total ?? 0;
    const schedule = await repo.installmentsForAgreement(agreementId);
    const agreement = await repo.findAgreementById(agreementId);
    const collectedFromSchedule = schedule
      .filter((s) => s.status === 'paid')
      .reduce((sum, s) => sum + s.amount_cents, 0);
    const expected =
      collectedFromSchedule + (agreement?.initial_payment_cents ?? 0) + (agreement?.setup_fee_cents ?? 0);
    return { ledgerTotal, expected, clean: ledgerTotal === expected };
  },

  // ─── Views ────────────────────────────────────────────────────────────────────────────────
  dashboard(agreement: AgreementDoc, schedule: { status: string; due_at: Date; amount_cents: number }[]) {
    const cash = agreement.cash_price_cents;
    const credited = agreement.ownership_credited_cents ?? 0;
    const paid = agreement.installments_paid ?? 0;
    return {
      ...this.summaryView(agreement),
      nextDueAt: agreement.next_due_at,
      installmentsRemaining: Math.max(0, agreement.installment_count - paid),
      ownershipPercent: cash > 0 ? Math.min(100, Math.round((credited / cash) * 100)) : 0,
      payoffCents: computePayoff(cash, credited),
      schedule: schedule.map((s) => ({ dueAt: s.due_at, amountCents: s.amount_cents, status: s.status })),
    };
  },

  dashboardFrom(agreement: AgreementDoc, quote: ReturnType<typeof computeRtoQuote>) {
    return {
      ...this.summaryView(agreement),
      nextDueAt: agreement.next_due_at,
      installmentsRemaining: agreement.installment_count,
      ownershipPercent:
        quote.cashPriceCents > 0
          ? Math.round((quote.initialOwnershipCreditCents / quote.cashPriceCents) * 100)
          : 0,
      payoffCents: computePayoff(quote.cashPriceCents, quote.initialOwnershipCreditCents),
      totalToOwnCents: quote.totalToOwnCents,
      costOverCashCents: quote.costOverCashCents,
    };
  },

  summaryView(a: AgreementDoc) {
    return {
      id: String(a._id),
      customerId: a.customer_id,
      sellerId: a.seller_id,
      productName: a.product_name,
      status: a.status,
      cashPriceCents: a.cash_price_cents,
      totalToOwnCents: a.total_to_own_cents,
      installmentAmountCents: a.installment_amount_cents,
      installmentCount: a.installment_count,
      installmentsPaid: a.installments_paid ?? 0,
      ownershipCreditedCents: a.ownership_credited_cents ?? 0,
      proofOfOwnership: a.proof_of_ownership_ref ?? null,
      isConsignment: a.is_consignment ?? false,
      /**
       * §50/§51/§52 lifecycle state. A remedy the customer cannot see is a remedy they will not
       * ask for, and a condition report nobody can check is not evidence.
       */
      pausedUntil: a.pause_until ?? null,
      arrangement: a.arrangement?.agreed_at
        ? {
            catchUpCents: a.arrangement.catch_up_cents ?? 0,
            dueAt: a.arrangement.due_at ?? null,
            note: a.arrangement.note ?? null,
          }
        : null,
      arrearsPaidCents: a.arrears_paid_cents ?? 0,
      returnRequestedAt: a.return_requested_at ?? null,
      returnRequestedBy: a.return_requested_by ?? null,
      returnDisclosure: a.return_disclosure ?? null,
      returnRefundCents: a.return_refund_cents ?? 0,
      conditionDelivery: conditionReportView(a.condition_delivery),
      conditionReturn: conditionReportView(a.condition_return),
      /**
       * The §44/§54 obligations stay readable for the life of the agreement, not just at the moment
       * of signing. A customer four months in asking "who fixes this?" must get the answer their
       * own agreement gave, from the snapshot — never from whatever the current defaults happen to
       * be, and never from prose they would have to re-read to interpret.
       */
      obligations: this.obligationsView(a),
    };
  },

  /**
   * §49 — the five reminder stages, in one daily sweep.
   *
   * The spec asks for a message BEFORE the payment is due, ON the due date, DURING the grace
   * period, WHEN it becomes late, and BEFORE any recovery action. Only the escalation existed:
   * `sweepDelinquency` moved an agreement Grace → Late silently, so the first thing a customer
   * heard about a missed payment was that they were already late.
   *
   * Each stage fires ONCE per due date, tracked by `reminders_sent_for`. When the date moves — a
   * deferral, a new instalment — the whole ladder re-arms, because the customer should hear the
   * "coming up" reminder for the new date rather than nothing at all.
   */
  async sweepReminders(): Promise<Record<RtoReminderStage, number>> {
    const now = new Date();
    const { RtoAgreementModel } = await import('./rto.model');
    const live = await RtoAgreementModel.find({
      status: { $in: ['active', 'grace', 'late', 'arrangement'] },
      next_due_at: { $ne: null },
    })
      .limit(500)
      .lean()
      .exec();

    const counts: Record<RtoReminderStage, number> = {
      upcoming: 0,
      due_today: 0,
      grace: 0,
      late: 0,
      pre_recovery: 0,
    };

    for (const a of live) {
      const agreementId = String(a._id);
      const dueAt = a.next_due_at!;
      // A moved due date is a new conversation: reset the ladder rather than staying silent.
      const sent = new Set(
        a.reminders_sent_for?.getTime() === dueAt.getTime() ? (a.reminders_sent ?? []) : [],
      );
      const msLeft = dueAt.getTime() - now.getTime();
      const daysLeft = Math.ceil(msLeft / 86_400_000);
      const daysLate = Math.floor(-msLeft / 86_400_000);
      const graceDays = a.grace_days ?? 7;

      const stage = ((): RtoReminderStage | null => {
        if (msLeft > 0) {
          return daysLeft <= RTO_REMINDER_LEAD_DAYS ? 'upcoming' : null;
        }
        if (daysLate === 0) return 'due_today';
        if (daysLate <= graceDays) return 'grace';
        if (daysLate <= graceDays + RTO_PRE_RECOVERY_DAYS) return 'late';
        return 'pre_recovery';
      })();
      if (!stage || sent.has(stage)) continue;

      const copy = reminderCopy(stage, {
        amountCents: a.installment_amount_cents ?? 0,
        dueAt,
        graceDays,
        productName: a.product_name,
      });
      /**
       * 7.1 / A-9 — §49 reminders are CONTRACTUAL notices, so they go out on every channel and the
       * attempt is recorded. In-app alone is not enough: a customer with push disabled would
       * otherwise receive no warning at all before an agreement escalated, and "it was in your
       * inbox" is not a defence for a notice the agreement says will be given.
       */
      await noticesService.send({
        userId: a.customer_id,
        type: 'rto_payment_reminder',
        entityType: 'rto_agreement',
        entityId: agreementId,
        subject: copy.title,
        body: copy.body,
        category: 'payments',
        data: { audience: 'customer', agreementId, stage, dueAt: dueAt.toISOString() },
        idempotencyKey: `rto_reminder_${agreementId}_${stage}_${dueAt.toISOString().slice(0, 10)}`,
      });
      await repo.recordReminder(agreementId, stage, dueAt);
      counts[stage] += 1;

      /**
       * The seller hears about the last two. Earlier than that it is noise, and later than that it
       * is too late for the conversation §50 exists to encourage.
       */
      if (stage === 'late' || stage === 'pre_recovery') {
        const owner = await vendorsService.getBusinessOwner(a.seller_id);
        if (owner) {
          notificationsService.notify(owner, {
            category: 'payments',
            title: stage === 'late' ? 'A payment is late' : 'An agreement needs a decision',
            body:
              stage === 'late'
                ? `${a.product_name}: the customer has missed a payment. You can give more time, take a part payment, or agree a catch-up plan.`
                : `${a.product_name}: still unpaid. Consider an arrangement or requesting the item back.`,
            data: { audience: 'seller', agreementId, stage },
          });
        }
      }
    }
    return counts;
  },

  // ─── §50 seller remedies ──────────────────────────────────────────────────────────────────
  /**
   * The seller's alternatives to letting an agreement fail.
   *
   * §50 lists seven, and none of them existed: the sweep could move an agreement Grace → Late and
   * then stop, so delinquency was the only outcome available to a customer who got into trouble.
   * That is the opposite of the spec's closing instruction to encourage communication before
   * cancellation, and it left four declared statuses unreachable (audit F-3).
   *
   * Every remedy here is the SELLER's to grant. A customer cannot pause their own agreement or move
   * their own due date — that would not be forbearance, it would be an option to stop paying.
   */
  async assertSellerOf(principal: Principal, agreement: AgreementDoc): Promise<void> {
    const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
    if (owner !== principal.userId) {
      throw ForbiddenError('Only the seller can do this', ERROR_CODES.NOT_OWNER);
    }
  },

  /** §50 "give additional time" — push the next due date out, without changing what is owed. */
  async deferPayment(principal: Principal, agreementId: string, days: number) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    this.assertLive(agreement);

    const base = agreement.next_due_at ?? new Date();
    const nextDue = new Date(base.getTime() + days * 86_400_000);
    const updated = await repo.applyRemedy(agreementId, {
      // Back to `active`: the customer is not late against a date that has moved.
      status: 'active',
      next_due_at: nextDue,
      $inc: { deferrals_granted: 1 },
    });
    await repo.deferScheduledInstallments(agreementId, days);

    this.notifyBoth(agreement, {
      title: 'More time to pay',
      body: `Your next payment is now due ${nextDue.toDateString()}.`,
      data: { agreementId, nextDueAt: nextDue },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.payment_deferred',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { days, nextDueAt: nextDue },
    });
    return this.dashboardOf(updated ?? agreement);
  },

  /**
   * §50 "accept a partial payment" — credit what the customer could manage against the arrears.
   *
   * Recorded on the immutable ledger like any other money, and it does NOT buy ownership credit: a
   * part-payment against arrears is catching up on rent already owed, not equity in the goods.
   * Conflating the two would quietly tell a struggling customer they own more than they do.
   */
  async recordPartialPayment(
    principal: Principal,
    agreementId: string,
    amountCents: number,
    idempotencyKey: string,
  ) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    this.assertLive(agreement);

    const charge = await paymentsService.charge({
      customerId: agreement.customer_id,
      counterpartyType: 'business',
      counterpartyId: agreement.seller_id,
      amountCents,
      feeType: 'rto_installment',
      idempotencyKey: `${idempotencyKey}_partial`,
    });
    await repo.appendLedger({
      agreement_id: agreementId,
      entry_type: 'installment',
      installment_number: null,
      amount_cents: amountCents,
      fee_cents: charge.platformFeeCents ?? 0,
      ownership_credit_cents: 0, // arrears, not equity — see the note above
      transaction_id: charge.transactionId,
      idempotency_key: `rto_partial_${agreementId}_${idempotencyKey}`,
    });
    await paymentsService.completeForOrder(charge.transactionId);

    const updated = await repo.applyRemedy(agreementId, {
      $inc: { arrears_paid_cents: amountCents },
    });
    this.notifyBoth(agreement, {
      title: 'Part payment received',
      body: `${dollars(amountCents)} went towards what's outstanding.`,
      data: { agreementId, amountCents },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.partial_payment',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { amountCents },
    });
    return this.dashboardOf(updated ?? agreement);
  },

  /**
   * §50 "create a catch-up schedule" — an agreed plan for clearing arrears, which is what reaches
   * the `arrangement` status. Time-boxed by a due date, because an arrangement with no deadline is
   * just a pause with extra paperwork.
   */
  async agreeArrangement(
    principal: Principal,
    agreementId: string,
    input: { catchUpCents: number; dueAt: string; note?: string },
  ) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    this.assertLive(agreement);

    const dueAt = new Date(input.dueAt);
    const updated = await repo.applyRemedy(agreementId, {
      status: 'arrangement',
      arrangement: {
        agreed_at: new Date(),
        agreed_by: principal.userId,
        catch_up_cents: input.catchUpCents,
        due_at: dueAt,
        note: input.note ?? null,
      },
    });
    this.notifyBoth(agreement, {
      title: 'Payment arrangement agreed',
      body: `${dollars(input.catchUpCents)} to clear by ${dueAt.toDateString()}.`,
      data: { agreementId, catchUpCents: input.catchUpCents, dueAt },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.arrangement_agreed',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { catchUpCents: input.catchUpCents, dueAt },
    });
    return this.dashboardOf(updated ?? agreement);
  },

  /**
   * §50 "pause the agreement" — stop the clock. The installment sweep skips a paused agreement, so
   * no charge is attempted and no delinquency accrues while it holds.
   *
   * Deliberately time-boxed: an open-ended pause is a cancellation nobody wrote down, and the
   * customer deserves to know when payments restart.
   */
  async pauseAgreement(principal: Principal, agreementId: string, untilISO: string) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    this.assertLive(agreement);

    const until = new Date(untilISO);
    const updated = await repo.applyRemedy(agreementId, {
      status: 'paused',
      paused_at: new Date(),
      pause_until: until,
      // Payments resume the day the pause ends, not the day it started.
      next_due_at: until,
    });
    this.notifyBoth(agreement, {
      title: 'Payments paused',
      body: `Nothing is due until ${until.toDateString()}.`,
      data: { agreementId, pauseUntil: until },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.paused',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { until },
    });
    return this.dashboardOf(updated ?? agreement);
  },

  /** §50 "reinstate the agreement after payment" — back to active from paused/arrangement/cancelled. */
  async reinstateAgreement(principal: Principal, agreementId: string) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    if (agreement.status === 'completed') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'This agreement is already complete');
    }
    if (agreement.status === 'cancelled' && !agreement.listing_terms?.reinstatement_allowed) {
      // The customer was told at acceptance that a cancelled agreement stays cancelled; honouring
      // that is the point of having disclosed it.
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This agreement’s terms do not allow reinstatement after cancellation',
      );
    }
    const updated = await repo.applyRemedy(agreementId, {
      status: 'active',
      paused_at: null,
      pause_until: null,
      reinstated_at: new Date(),
      next_due_at: new Date(Date.now() + agreement.interval_days * 86_400_000),
    });
    this.notifyBoth(agreement, {
      title: 'Agreement back on track',
      body: 'Payments have resumed on the original schedule.',
      data: { agreementId },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.reinstated',
      entityType: 'rto_agreement',
      entityId: agreementId,
    });
    return this.dashboardOf(updated ?? agreement);
  },

  // ─── §51 voluntary return ─────────────────────────────────────────────────────────────────
  /**
   * What handing the goods back would actually mean — shown BEFORE the customer decides.
   *
   * Read-only and computed from the agreement's own snapshotted terms, so the answer cannot drift
   * from what they were told at acceptance, and cannot be softened at the moment it matters most.
   */
  async previewReturn(principal: Principal, agreementId: string) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertParticipant(principal, agreement);
    return computeRtoReturn(this.returnInputFor(agreement));
  },

  /**
   * §50 "request return of the product" (seller) / §51 voluntary return (customer).
   *
   * Either party may start it: the spec gives the seller a right to ask for the goods back and the
   * customer a right to hand them back. Requesting only moves it to `return_pending` — the money
   * is settled when the goods are actually received, because a return that never arrives should not
   * refund anything.
   */
  async requestReturn(principal: Principal, agreementId: string) {
    const agreement = await this.loadAgreement(agreementId);
    const isCustomer = agreement.customer_id === principal.userId;
    const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
    const isSeller = owner === principal.userId;
    if (!isCustomer && !isSeller) {
      throw ForbiddenError('Not a party to this agreement', ERROR_CODES.NOT_OWNER);
    }
    this.assertLive(agreement);

    const quote = computeRtoReturn(this.returnInputFor(agreement));
    // A CUSTOMER may only return when the agreement offers it. A SELLER may always ask for their
    // goods back — that is a recovery right, not a return right, and §50 lists it as a remedy.
    if (isCustomer && !quote.allowed) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This agreement does not offer a voluntary return. You can pay it off early instead.',
      );
    }

    const updated = await repo.applyRemedy(agreementId, {
      status: 'return_pending',
      return_requested_at: new Date(),
      return_requested_by: isCustomer ? 'customer' : 'seller',
    });
    this.notifyBoth(agreement, {
      title: isCustomer ? 'Return requested' : 'The seller has asked for the item back',
      body: quote.disclosure,
      data: { agreementId, ...quote },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.return_requested',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { by: isCustomer ? 'customer' : 'seller', refundCents: quote.refundCents },
    });
    return { ...this.dashboardOf(updated ?? agreement), returnQuote: quote };
  },

  /**
   * The goods came back. Records the §52 return condition report, settles the §51 outcome, and
   * closes the agreement.
   *
   * The refund is computed from the terms, never passed in — otherwise the number would be whoever
   * processed the return's opinion rather than what the customer was promised.
   */
  async completeReturn(
    principal: Principal,
    agreementId: string,
    condition: ConditionReportInput,
    idempotencyKey: string,
  ) {
    const agreement = await this.loadAgreement(agreementId);
    await this.assertSellerOf(principal, agreement);
    if (agreement.status !== 'return_pending') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'No return is in progress for this agreement',
      );
    }

    const quote = computeRtoReturn(this.returnInputFor(agreement));
    if (quote.refundCents > 0) {
      /**
       * Refunds land on the ledger as a negative-signed `refund` entry rather than being netted off
       * a total somewhere: the ledger is the reconcilable record, and money that moved must appear
       * in it as an event, not as an adjustment to a number.
       */
      await repo.appendLedger({
        agreement_id: agreementId,
        entry_type: 'refund',
        installment_number: null,
        amount_cents: -quote.refundCents,
        fee_cents: 0,
        ownership_credit_cents: 0,
        transaction_id: null,
        idempotency_key: `rto_return_refund_${agreementId}_${idempotencyKey}`,
      });
    }

    const updated = await repo.applyRemedy(agreementId, {
      status: 'cancelled',
      returned_at: new Date(),
      cancelled_at: new Date(),
      cancelled_reason: 'returned',
      return_refund_cents: quote.refundCents,
      return_restocking_fee_cents: quote.restockingFeeCents,
      return_credit_preserved_cents: quote.creditPreservedCents,
      return_disclosure: quote.disclosure,
      condition_return: conditionReportToDoc(condition, { sellerAck: true }),
      next_due_at: null,
    });
    // Stop the clock: nothing further is owed on an agreement whose goods have gone back.
    await repo.cancelScheduledInstallments(agreementId);

    /**
     * 7.1 — §51's return outcome is a contractual notice, not a status update. The disclosure says
     * what was refunded and what was not, and "your payments are not refunded" is exactly the
     * sentence a customer must be able to produce later. In-app alone would leave a customer who
     * declined push with no record of the terms they were returned under.
     */
    await noticesService.send({
      userId: agreement.customer_id,
      type: 'rto_return_confirmed',
      entityType: 'rto_agreement',
      entityId: agreementId,
      subject: 'Item returned',
      body: quote.disclosure,
      category: 'rto',
      data: { agreementId },
      idempotencyKey: `rto_return_confirmed_${agreementId}`,
    });
    // The seller hears about it too, in-app — they are the one who took the goods back.
    void vendorsService.getBusinessOwner(agreement.seller_id).then((owner) => {
      if (owner) {
        notificationsService.notify(owner, {
          category: 'rto',
          title: 'Item returned',
          body: quote.disclosure,
          data: { audience: 'seller', agreementId },
        });
      }
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'rto.returned',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: {
        refundCents: quote.refundCents,
        restockingFeeCents: quote.restockingFeeCents,
        creditPreservedCents: quote.creditPreservedCents,
      },
    });
    return { ...this.dashboardOf(updated ?? agreement), returnQuote: quote };
  },

  // ─── §52 condition reports ────────────────────────────────────────────────────────────────
  /**
   * Acknowledge a condition report. §52 asks for BOTH parties on both reports, and the second
   * signature is the one that matters: a report only the seller signed is the seller's account of
   * the condition, not an agreed fact.
   */
  async acknowledgeCondition(
    principal: Principal,
    agreementId: string,
    which: 'delivery' | 'return',
  ) {
    const agreement = await this.loadAgreement(agreementId);
    const isCustomer = agreement.customer_id === principal.userId;
    const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
    const isSeller = owner === principal.userId;
    if (!isCustomer && !isSeller) {
      throw ForbiddenError('Not a party to this agreement', ERROR_CODES.NOT_OWNER);
    }
    const field = which === 'delivery' ? 'condition_delivery' : 'condition_return';
    const key = isCustomer ? 'customer_ack_at' : 'seller_ack_at';
    const updated = await repo.applyRemedy(agreementId, {
      [`${field}.${key}`]: new Date(),
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'rto.condition_acknowledged',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { report: which, by: isCustomer ? 'customer' : 'seller' },
    });
    return this.dashboardOf(updated ?? agreement);
  },

  // ─── shared helpers ───────────────────────────────────────────────────────────────────────
  async loadAgreement(agreementId: string): Promise<AgreementDoc> {
    const agreement = (await repo.findAgreementById(agreementId)) as AgreementDoc | null;
    if (!agreement) throw NotFoundError('Agreement not found');
    return agreement;
  },

  async assertParticipant(principal: Principal, agreement: AgreementDoc): Promise<void> {
    if (agreement.customer_id === principal.userId) return;
    const owner = await vendorsService.getBusinessOwner(agreement.seller_id);
    if (owner !== principal.userId) {
      throw ForbiddenError('Not a party to this agreement', ERROR_CODES.NOT_OWNER);
    }
  },

  /** A remedy only applies to an agreement still running — not a completed or returned one. */
  assertLive(agreement: AgreementDoc): void {
    if (['completed', 'cancelled'].includes(agreement.status)) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `This agreement is ${agreement.status}`,
      );
    }
  },

  returnInputFor(agreement: AgreementDoc) {
    const lt = agreement.listing_terms;
    return {
      // Everything the customer has actually handed over: the initial payment, the instalments they
      // completed, and any part-payments credited against arrears.
      paidToOwnCents:
        (agreement.initial_payment_cents ?? 0) +
        (agreement.installments_paid ?? 0) * (agreement.installment_amount_cents ?? 0) +
        (agreement.arrears_paid_cents ?? 0),
      ownershipCreditedCents: agreement.ownership_credited_cents ?? 0,
      terms: {
        returnAllowed: lt?.return_allowed ?? false,
        returnTransportResponsibility: lt?.return_transport_responsibility ?? 'customer',
        restockingFeeCents: lt?.restocking_fee_cents ?? 0,
        paymentsRefundableOnReturn: lt?.payments_refundable_on_return ?? false,
        ownershipCreditPreservedOnReturn: lt?.ownership_credit_preserved_on_return ?? false,
        reinstatementAllowed: lt?.reinstatement_allowed ?? true,
      },
    };
  },

  /** Both parties hear about a lifecycle change — each one changes what the other has to plan for. */
  notifyBoth(
    agreement: AgreementDoc,
    msg: { title: string; body: string; data: Record<string, unknown> },
  ): void {
    notificationsService.notify(agreement.customer_id, {
      category: 'payments',
      title: msg.title,
      body: msg.body,
      data: { audience: 'customer', ...msg.data },
    });
    void vendorsService.getBusinessOwner(agreement.seller_id).then((owner) => {
      if (owner) {
        notificationsService.notify(owner, {
          category: 'payments',
          title: msg.title,
          body: msg.body,
          data: { audience: 'seller', ...msg.data },
        });
      }
    });
  },

  dashboardOf(agreement: AgreementDoc) {
    return this.summaryView(agreement);
  },

  listingView(l: RtoListingDoc & { _id?: unknown }) {
    const terms = listingTermsFromDoc(l.listing_terms);
    return {
      id: String(l._id),
      sellerId: l.seller_id,
      productName: l.product_name,
      description: l.description ?? null,
      photos: l.photos ?? [],
      categoryId: String(l.category_id),
      citySlug: l.city_slug,
      cashPriceCents: l.cash_price_cents,
      initialPaymentCents: l.initial_payment_cents,
      installmentCount: l.installment_count,
      frequency: l.frequency,
      markupBps: l.markup_bps,
      setupFeeCents: l.setup_fee_cents ?? 0,
      lateFeeCents: l.late_fee_cents ?? 0,
      listingTerms: terms,
      obligations: describeListingTerms(terms),
      quantityAvailable: l.quantity_available,
      status: l.status,
      /**
       * §54 — a customer looking at a three-party offer should be able to see that the item belongs
       * to someone other than the business selling it, and who handles what. Hiding the arrangement
       * would make "who do I call when it breaks?" unanswerable from the offer itself.
       */
      isConsignment: l.is_consignment ?? false,
      consignmentObligations: l.consignment_terms?.owner_during_term
        ? describeConsignmentTerms({
            ownerDuringTerm: l.consignment_terms.owner_during_term,
            deliveryBy: l.consignment_terms.delivery_by!,
            returnsManagedBy: l.consignment_terms.returns_managed_by!,
            customerSupportBy: l.consignment_terms.customer_support_by!,
            damageResponsibility: l.consignment_terms.damage_responsibility!,
            missedPaymentsHandledBy: l.consignment_terms.missed_payments_handled_by!,
            earlyPayoffApprovedBy: l.consignment_terms.early_payoff_approved_by!,
            onCustomerReturn: l.consignment_terms.on_customer_return!,
            ownershipTransfersAt: l.consignment_terms.ownership_transfers_at!,
            paymentDivisionNote: l.consignment_terms.payment_division_note ?? '',
          })
        : [],
    };
  },

  /** Plain-language obligations for this agreement, from its own snapshotted terms. */
  obligationsView(a: AgreementDoc): string[] {
    const lt = a.listing_terms;
    const lines = lt
      ? describeListingTerms({
          maintenanceResponsibility: lt.maintenance_responsibility,
          damageResponsibility: lt.damage_responsibility,
          returnAllowed: lt.return_allowed,
          returnTransportResponsibility: lt.return_transport_responsibility,
          restockingFeeCents: lt.restocking_fee_cents,
          paymentsRefundableOnReturn: lt.payments_refundable_on_return,
          ownershipCreditPreservedOnReturn: lt.ownership_credit_preserved_on_return,
          reinstatementAllowed: lt.reinstatement_allowed,
          cancellationNoticeDays: lt.cancellation_notice_days,
          deliveryFeeCents: lt.delivery_fee_cents,
          taxBps: lt.tax_bps,
        })
      : [];
    const ct = a.consignment_terms;
    if (a.is_consignment && ct?.owner_during_term) {
      lines.push(
        ...describeConsignmentTerms({
          ownerDuringTerm: ct.owner_during_term,
          deliveryBy: ct.delivery_by!,
          returnsManagedBy: ct.returns_managed_by!,
          customerSupportBy: ct.customer_support_by!,
          damageResponsibility: ct.damage_responsibility!,
          missedPaymentsHandledBy: ct.missed_payments_handled_by!,
          earlyPayoffApprovedBy: ct.early_payoff_approved_by!,
          onCustomerReturn: ct.on_customer_return!,
          ownershipTransfersAt: ct.ownership_transfers_at!,
          paymentDivisionNote: ct.payment_division_note ?? '',
        }),
      );
    }
    return lines;
  },
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
