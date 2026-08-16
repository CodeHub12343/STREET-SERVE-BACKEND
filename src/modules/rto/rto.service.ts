import { randomUUID } from 'node:crypto';
import { SWEEP_BATCH_LIMIT, reportSweepBatch } from '../../jobs/sweepBatch';

import {
  DEFAULT_CONSIGNMENT_FEE_BPS,
  RTO_PRE_RECOVERY_DAYS,
  RTO_PROHIBITED_CATEGORY_SLUGS,
  RTO_RECONCILE_AFTER_MS,
  RTO_REMINDER_LEAD_DAYS,
  type RtoReminderStage,
} from '../../config/constants';
import { env, isProd } from '../../config/env';
import { logger } from '../../config/logger';
import { stripe } from '../../integrations/stripe';
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
  if (isAgreementReviewed(type)) return;

  /**
   * The one way past this, and it cannot reach a real customer.
   *
   * The lifecycle has to be walkable end to end before launch — approval, offer, acceptance,
   * instalments, payoff — and every step after acceptance was untestable while this refused. The
   * escape is therefore scoped to where the harm cannot occur rather than removed: `isProd` is
   * checked HERE, so setting the flag in production changes nothing at all. A real customer still
   * cannot clickwrap placeholder terms, which is the whole thing this gate protects.
   *
   * Logged at warn on every use, because "we tested with the bypass on" is a fact someone will need
   * when the real text lands and the early acceptances are audited.
   */
  if (!isProd && env.RTO_ALLOW_UNREVIEWED_AGREEMENT) {
    logger.warn(
      { type },
      'RTO_ALLOW_UNREVIEWED_AGREEMENT is on — accepting a PLACEHOLDER agreement. ' +
        'These acceptance records are not enforceable and must be re-collected once the reviewed text lands.',
    );
    return;
  }

  throw BusinessRuleError(
    ERROR_CODES.BUSINESS_RULE,
    'Rent-to-Own is not open yet — the agreement is still in legal review.',
  );
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
      /**
       * **Zero, until a card has actually been confirmed.**
       *
       * This was seeded with the initial payment's ownership credit at the moment the agreement was
       * written — before any money moved, and in practice before any money EVER moved, because the
       * charge below only opened a PaymentIntent. A customer could accept and immediately own 20% of
       * a laptop they had not paid a cent for. Ownership is credited in `creditByPaymentIntent`,
       * off the `payment_intent.succeeded` webhook, and nowhere else.
       */
      ownership_credited_cents: 0,
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

    /**
     * ═══ OPEN the charge for everything due today. Do not pretend it settled. ═══
     *
     * **One intent, not two.** The initial payment and the set-up fee were charged as separate
     * PaymentIntents, which was survivable only while nothing collected a card: the moment a real
     * customer is asked to confirm, two intents means two card forms for one "accept" — and a
     * customer who confirms the first and abandons the second leaves an agreement that is half paid
     * for, with no screen that can finish it. They are one payment because they are one decision.
     *
     * The set-up fee rides in `serviceFeeCents` so it is excluded from the RTO fee base. That
     * reproduces the previous economics exactly — `setup` carries no platform rate, and the
     * `rto_installment` fee applied to the initial payment alone — while charging a fee on a fee is
     * avoided by the same rule that governs every other customer-paid fee component (R8/R10).
     *
     * Nothing is written to the ledger here and no ownership is credited. The ledger is the money
     * record; appending to it for money that is still sitting behind an unconfirmed card is how the
     * books came to disagree with Stripe in the first place.
     */
    const dueNowCents = quote.initialPaymentCents + quote.setupFeeCents;
    let clientSecret: string | null = null;
    let paymentIntentRef: string | null = null;
    if (dueNowCents > 0) {
      const charge = await paymentsService.charge({
        customerId: principal.userId,
        counterpartyType: 'business',
        counterpartyId: sellerId,
        amountCents: dueNowCents,
        ...(quote.setupFeeCents > 0 ? { serviceFeeCents: quote.setupFeeCents } : {}),
        feeType: 'rto_installment',
        idempotencyKey: `${idempotencyKey}_acceptance`,
        /**
         * ═══ Keep the card. This is the only moment we can. ═══
         *
         * An agreement is twelve scheduled payments, and every one of them falls due when nobody is
         * looking at a screen. Acceptance is the single point where the customer is present and
         * entering a card, so if it is not saved here the instalment sweep has nothing to charge
         * and the whole schedule is decorative.
         *
         * The acceptance screen discloses this before they pay.
         */
        savePaymentMethod: true,
        ...(principal.email ? { customerEmail: principal.email } : {}),
      });
      clientSecret = charge.clientSecret ?? null;
      paymentIntentRef = charge.paymentIntentRef ?? null;
      await repo.updateAgreement(agreementId, {
        pending_intent_ref: paymentIntentRef,
        pending_intent_kind: 'acceptance',
      });
      agreement.pending_intent_ref = paymentIntentRef;
      agreement.pending_intent_kind = 'acceptance';
    } else {
      /**
       * Nothing due today, but the schedule still needs a card.
       *
       * An agreement with no deposit and no set-up fee has no charge to attach the stored
       * credential to — and without one, every instalment after it is uncollectable. Stripe will
       * not create a zero-amount PaymentIntent, so a SetupIntent asks for the card at the one
       * moment the customer is present, taking nothing.
       */
      const setup = await stripe().createSetupIntent({
        customerRef: principal.userId,
        metadata: { kind: 'rto_card_setup', agreementId },
        idempotencyKey: `${idempotencyKey}_setup_intent`,
      });
      clientSecret = setup.clientSecret;
      await repo.updateAgreement(agreementId, {
        pending_intent_ref: setup.setupIntentId,
        pending_intent_kind: 'card_setup',
      });
      agreement.pending_intent_ref = setup.setupIntentId;
      agreement.pending_intent_kind = 'card_setup';
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'rto.agreement_accepted',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { sellerId: sellerId, totalToOwnCents: quote.totalToOwnCents, dueNowCents },
    });
    await publish('rto.agreement_accepted', { agreementId, customerId: principal.userId });
    return {
      ...this.dashboardFrom(agreement, quote),
      /**
       * The client secret the acceptance screen needs to actually collect the card. Null only when
       * there is genuinely nothing to pay today (no initial payment, no set-up fee) — the screen
       * distinguishes the two, because "no card needed" and "we could not start your payment" look
       * identical to a customer and only one of them is fine.
       */
      clientSecret,
      paymentIntentRef,
      amountDueNowCents: dueNowCents,
    };
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
      /**
       * The deposit has not cleared yet. Billing instalment #1 against a customer whose very first
       * payment is still unconfirmed would charge them for an agreement they have not actually
       * entered — and a decline here would put them straight into Grace for a schedule that never
       * legitimately started.
       */
      if (agreement.pending_intent_kind === 'acceptance') continue;
      /**
       * An intent for THIS instalment is already open and waiting on the customer (an SCA challenge,
       * or a "pay it now" they have not finished). Charging again would put two intents on one
       * instalment; the ledger key would stop the double credit, but not the double charge.
       */
      if (
        agreement.pending_intent_kind === 'installment' &&
        agreement.pending_intent_installment === n
      ) {
        continue;
      }

      /**
       * ═══ No card on file — say so, do not punish them for it. ═══
       *
       * An agreement accepted before stored credentials existed, or one whose acceptance settled
       * without a reusable card, has nothing to charge. Marking that "missed" would drop the
       * customer into Grace, start the late-fee clock and eventually threaten recovery of the goods
       * — all for a failure that is entirely ours. Skipped and surfaced instead.
       */
      if (!agreement.payment_method_ref) {
        await this.requestPaymentMethod(agreement as AgreementDoc, n);
        continue;
      }

      try {
        /**
         * OFF-SESSION. The customer is asleep; the card was saved at acceptance for exactly this.
         * Previously this opened an ordinary on-session intent and immediately declared it complete,
         * so the schedule the seller set could never collect anything at all.
         */
        const charge = await paymentsService.charge({
          customerId: agreement.customer_id,
          counterpartyType: 'business',
          counterpartyId: agreement.seller_id,
          amountCents: inst.amount_cents,
          feeType: 'rto_installment',
          idempotencyKey: `rto_${agreementId}_${n}`,
          paymentMethodId: agreement.payment_method_ref,
          offSession: true,
        });

        /**
         * The bank wants the customer to authenticate (SCA / 3-D Secure). **Not a decline.** Their
         * card is fine and they have done nothing wrong, so this must not touch the delinquency
         * machinery — it needs them to open the app and confirm, once. Treating it as a failure
         * would put someone into Grace, and eventually into recovery, for their bank's security
         * policy.
         */
        if (charge.status === 'requires_action') {
          await repo.updateAgreement(agreementId, {
            pending_intent_ref: charge.paymentIntentRef,
            pending_intent_kind: 'installment',
            pending_intent_installment: n,
            action_required_installment: n,
          });
          notificationsService.notify(agreement.customer_id, {
            category: 'rto',
            title: 'Your bank needs you to confirm a payment',
            body: `Your bank asked you to approve the ${formatCents(inst.amount_cents)} payment for your ${agreement.product_name}. Nothing is wrong with your card — open the app to confirm it.`,
            data: { agreementId, installmentNumber: n, actions: ['confirm_payment'] },
          });
          continue; // neither charged nor missed — it is waiting on the customer
        }

        if (charge.status !== 'succeeded') {
          // An off-session intent that is neither succeeded nor requires_action has not collected.
          // Fall into the missed path rather than crediting ownership against nothing.
          throw new Error(`off-session charge status ${charge.status}`);
        }

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
        /**
         * Settled here rather than waiting on the webhook, and legitimately so: an off-session
         * confirm returns a TERMINAL status, so `succeeded` above is Stripe telling us the money
         * moved. That is the opposite of the acceptance path, where the status is
         * `requires_payment_method` and nothing has happened yet. The webhook still arrives and is
         * a harmless no-op, because these transitions are all pending-guarded.
         */
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
   * There is no card to charge. Ask for one — do NOT mark the customer late.
   *
   * Notified once per agreement rather than on every sweep pass: an hourly reminder about the same
   * missing card is nagging, and the instalment stays `scheduled` so it collects the moment a card
   * is added. The `expiry_notice`-style guard is the agreement's own `action_required_installment`,
   * reused here because "we need something from you before this can be paid" is the same state.
   */
  async requestPaymentMethod(agreement: AgreementDoc, installmentNumber: number): Promise<void> {
    const agreementId = String(agreement._id);
    if (agreement.action_required_installment === installmentNumber) return; // already asked

    await repo.updateAgreement(agreementId, { action_required_installment: installmentNumber });
    logger.warn(
      { agreementId, installmentNumber },
      'RTO instalment due with no saved card — cannot collect',
    );
    notificationsService.notify(agreement.customer_id, {
      category: 'rto',
      title: 'We need a payment method',
      body: `We don't have a card saved for your ${agreement.product_name}, so we couldn't take this payment. Add one in the app — you are not late, and no fee has been added.`,
      data: { agreementId, installmentNumber, actions: ['update_payment'] },
    });
  },

  /**
   * ═══ Pay an instalment with the customer present. ═══
   *
   * One path for three situations that are one problem to the person holding the phone — "I want to
   * pay this now":
   *
   *  • an SCA challenge, where an intent already exists and only needs confirming;
   *  • no saved card, where a fresh on-session charge is opened AND the card is kept, so the
   *    schedule can run itself again afterwards;
   *  • simply wanting to pay ahead of the due date, which the product had no way to do at all —
   *    the screen showed "0/12 payments made, next due 23 Aug" and offered nothing but a full
   *    payoff, so a customer who wanted to clear one instalment early could not.
   *
   * The intent goes on `pending_intent_ref` with kind `installment`, which is what makes the
   * webhook credit it. It previously went on a field of its own that `creditByPaymentIntent` never
   * read, so a manually paid instalment was charged and then never credited.
   */
  async payInstallment(principal: Principal, agreementId: string, idempotencyKey: string) {
    const agreement = (await repo.findAgreementById(agreementId)) as AgreementDoc | null;
    if (!agreement) throw NotFoundError('Agreement not found');
    if (agreement.customer_id !== principal.userId) {
      throw ForbiddenError('Not your agreement', ERROR_CODES.NOT_PARTICIPANT);
    }
    if (['completed', 'cancelled'].includes(agreement.status)) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Agreement is ${agreement.status}`);
    }
    if (agreement.pending_intent_kind === 'acceptance') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Your first payment is still going through.',
      );
    }

    /**
     * An intent already exists for this instalment (an SCA challenge, or a tap they abandoned).
     * Hand back THAT secret rather than opening a second charge — a new one would take the payment
     * twice if the first is later confirmed.
     */
    if (agreement.pending_intent_kind === 'installment' && agreement.pending_intent_ref) {
      const ref = agreement.pending_intent_ref;
      const n = agreement.pending_intent_installment ?? agreement.action_required_installment ?? 0;
      const intent = await stripe().retrievePaymentIntent(ref);
      if (intent.status === 'succeeded') {
        // It cleared in the meantime. Let the webhook/reconcile credit it; just report the truth.
        return { agreementId, installmentNumber: n, clientSecret: null, alreadyPaid: true };
      }
      const txn = await paymentsService.findTransactionByPaymentIntent(ref);
      return {
        agreementId,
        installmentNumber: n,
        amountCents: txn?.amount_cents ?? null,
        clientSecret: intent.clientSecret ?? null,
        alreadyPaid: false,
      };
    }

    /**
     * Otherwise: the instalment they owe. The one flagged as needing them if there is one, else the
     * next scheduled — which is what "pay ahead" means.
     */
    const schedule = await repo.installmentsForAgreement(agreementId);
    const target =
      (agreement.action_required_installment
        ? schedule.find((s) => s.installment_number === agreement.action_required_installment)
        : null) ?? schedule.find((s) => s.status === 'scheduled' || s.status === 'missed');

    if (!target) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Every payment on this agreement is settled. Nothing is due.',
      );
    }

    const charge = await paymentsService.charge({
      customerId: principal.userId,
      counterpartyType: 'business',
      counterpartyId: agreement.seller_id,
      amountCents: target.amount_cents,
      feeType: 'rto_installment',
      idempotencyKey: `${idempotencyKey}_inst_${target.installment_number}`,
      /**
       * Kept, always. If there was no card this is how the schedule starts running by itself; if
       * there already was one, Stripe simply reuses it rather than storing a duplicate.
       */
      savePaymentMethod: true,
      ...(principal.email ? { customerEmail: principal.email } : {}),
    });

    await repo.updateAgreement(agreementId, {
      pending_intent_ref: charge.paymentIntentRef ?? null,
      pending_intent_kind: 'installment',
      pending_intent_installment: target.installment_number,
    });

    return {
      agreementId,
      installmentNumber: target.installment_number,
      amountCents: target.amount_cents,
      clientSecret: charge.clientSecret ?? null,
      alreadyPaid: false,
    };
  },

  /**
   * ═══ Rescue an agreement whose settling webhook never arrived. ═══
   *
   * Ownership, the immutable ledger, the consignment split and the ownership TRANSFER are all
   * driven by `payment_intent.succeeded` — which is the right design, and which makes a lost
   * webhook expensive in a way it never was before. The failure modes:
   *
   *  • an ACCEPTANCE settles at Stripe and the event is dropped → the customer has paid their
   *    deposit, owns nothing, and their instalment schedule stays frozen by the sweep guard;
   *  • a PAYOFF settles and the event is dropped → they have paid off the item in full and the
   *    system still says it is not theirs;
   *  • a CARD SETUP completes and the event is dropped → no saved card, so every instalment on the
   *    agreement is uncollectable.
   *
   * All three are silent: the customer's money is gone and nothing on any screen changes. Stripe is
   * authoritative here, so this asks what actually happened rather than trusting our own row, and
   * moves nothing forward unless Stripe says the money is there. Idempotent by construction — it
   * reuses the webhook handlers, which no-op on anything no longer pending.
   */
  async reconcilePendingIntents(limit = SWEEP_BATCH_LIMIT): Promise<{
    checked: number;
    settled: number;
  }> {
    const cutoff = new Date(Date.now() - RTO_RECONCILE_AFTER_MS);
    const { RtoAgreementModel } = await import('./rto.model');
    const stuck = await RtoAgreementModel.find({
      pending_intent_ref: { $ne: null },
      updated_at: { $lte: cutoff },
    })
      .sort({ updated_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let settled = 0;
    for (const a of stuck) {
      const ref = String(a.pending_intent_ref);
      const agreementId = String(a._id);
      try {
        if (a.pending_intent_kind === 'card_setup') {
          const intent = await stripe().retrieveSetupIntent(ref);
          if (intent.status !== 'succeeded') continue;
          const res = await this.attachCardBySetupIntent(ref);
          if (res.handled) settled += 1;
        } else {
          const intent = await stripe().retrievePaymentIntent(ref);
          if (intent.status !== 'succeeded') continue;
          const res = await this.creditByPaymentIntent(ref);
          if (res.handled) settled += 1;
        }
        logger.warn(
          { agreementId, intentRef: ref, kind: a.pending_intent_kind },
          'settled a paid Rent-to-Own agreement whose webhook never arrived — check webhook delivery',
        );
      } catch (err) {
        // One unreadable intent must not stop the others being rescued.
        logger.error({ err, agreementId }, 'could not reconcile a Rent-to-Own payment');
      }
    }

    reportSweepBatch('rto-reconcile', stuck.length);
    return { checked: stuck.length, settled };
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
    /**
     * An acceptance payment still in flight blocks a payoff. Paying off an agreement whose deposit
     * has not cleared would credit ownership to full against an unconfirmed card — the same defect
     * this whole path exists to close, reached by a different door.
     */
    if (agreement.pending_intent_kind === 'acceptance') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Your first payment is still going through. Once it clears you can pay this off early.',
      );
    }

    const payoffCents = computePayoff(agreement.cash_price_cents, agreement.ownership_credited_cents ?? 0);
    if (payoffCents <= 0) {
      // Nothing left to collect — every cent of the cash price is already credited, so ownership
      // transfers here rather than waiting on a webhook for a charge that will never be opened.
      await this.completeAndTransfer(agreement);
      return { agreementId, payoffCents: 0, completed: true, clientSecret: null, paymentIntentRef: null };
    }

    /**
     * ═══ Open the charge. Ownership transfers in the webhook, not here. ═══
     *
     * This used to append the payoff to the immutable ledger, credit ownership to the full cash
     * price, and issue a proof-of-ownership reference — all off a PaymentIntent that had only just
     * been created and that nobody had confirmed. The customer walked away owning the item outright,
     * having paid nothing, with a signed record saying they had. Of every place the missing capture
     * bit, this was the expensive one.
     *
     * `creditByPaymentIntent` does all four of those things now, on `payment_intent.succeeded`.
     */
    const charge = await paymentsService.charge({
      customerId: principal.userId,
      counterpartyType: 'business',
      counterpartyId: agreement.seller_id,
      amountCents: payoffCents,
      feeType: 'rto_installment',
      idempotencyKey: `${idempotencyKey}_payoff`,
    });
    await repo.updateAgreement(agreementId, {
      pending_intent_ref: charge.paymentIntentRef ?? null,
      pending_intent_kind: 'payoff',
    });
    return {
      agreementId,
      payoffCents,
      /**
       * False, and said plainly. The old `completed: true` was returned before the card had been
       * seen, so the screen congratulated the customer on owning something they had not bought.
       */
      completed: false,
      clientSecret: charge.clientSecret ?? null,
      paymentIntentRef: charge.paymentIntentRef ?? null,
    };
  },

  /**
   * ═══ SETTLEMENT. The one place a Rent-to-Own payment becomes real. ═══
   *
   * Driven by `payment_intent.succeeded`. Everything that used to happen optimistically at the
   * moment a charge was OPENED happens here instead, once Stripe says the money exists: the
   * immutable ledger entry, the ownership credit, the consignment split, and — on a payoff — the
   * ownership transfer itself.
   *
   * Returns `{ handled: false }` for an intent that is not ours, so the webhook's chain of handlers
   * falls through to the next one exactly as the other modules' credit paths do.
   */
  /**
   * The customer entered a card on an agreement that owed nothing on day one. No money moved and
   * none should have — this only attaches the credential the schedule will be charged against.
   *
   * Driven by `setup_intent.succeeded`. Separate from `creditByPaymentIntent` because there is
   * nothing to credit: no ledger entry, no ownership, no split. Conflating the two would mean a
   * card-collection event walking the money path.
   */
  async attachCardBySetupIntent(setupIntentRef: string): Promise<{ handled: boolean }> {
    const found = await repo.findAgreementByPendingIntent(setupIntentRef);
    if (!found || found.pending_intent_kind !== 'card_setup') return { handled: false };

    const agreementId = String(found._id);
    const claimed = await repo.claimPendingIntent(agreementId, setupIntentRef);
    if (!claimed) return { handled: true }; // a duplicate delivery lost the race

    let paymentMethodRef: string | null = null;
    try {
      const intent = await stripe().retrieveSetupIntent(setupIntentRef);
      paymentMethodRef = intent.paymentMethodId ?? null;
    } catch (err) {
      logger.error({ err, agreementId }, 'could not read the RTO setup intent');
    }

    if (!paymentMethodRef) {
      logger.warn(
        { agreementId, setupIntentRef },
        'RTO card setup completed with no reusable card — instalments cannot be collected',
      );
      return { handled: true };
    }

    await repo.updateAgreement(agreementId, { payment_method_ref: paymentMethodRef });
    await writeAudit({
      action: 'rto.card_saved',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { setupIntentRef },
    });
    return { handled: true };
  },

  /**
   * The card a settled intent used, as fields ready to persist — including brand and last four, so
   * the schedule can say "your Visa ending 4242" rather than "your saved card". A customer agreeing
   * to eleven more automatic payments is entitled to know which card they come off.
   *
   * Never throws: the money has already arrived and the customer owns their share of it, so a
   * failure to read the card must not lose the credit. A missing card is recoverable — they are
   * asked for one — where a thrown webhook is not.
   */
  async captureCard(
    agreementId: string,
    paymentIntentRef: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const intent = await stripe().retrievePaymentIntent(paymentIntentRef);
      const pm = intent.paymentMethodId ?? null;
      if (!pm) return null;
      const card = await stripe().retrievePaymentMethod(pm);
      return {
        payment_method_ref: pm,
        payment_method_brand: card?.brand ?? null,
        payment_method_last4: card?.last4 ?? null,
      };
    } catch (err) {
      logger.error({ err, agreementId }, 'could not capture the RTO payment method');
      return null;
    }
  },

  async creditByPaymentIntent(paymentIntentRef: string): Promise<{ handled: boolean }> {
    const found = await repo.findAgreementByPendingIntent(paymentIntentRef);
    if (!found) return { handled: false }; // not an RTO payment — let the next handler try

    const agreementId = String(found._id);
    const kind = found.pending_intent_kind;

    /**
     * Claim it. Stripe delivers at least once, and crediting twice would hand the customer double
     * the ownership they paid for; the ledger's unique keys would catch the duplicate entry, but
     * the ownership write is a `$set` that would happily run again.
     */
    const agreement = (await repo.claimPendingIntent(agreementId, paymentIntentRef)) as AgreementDoc | null;
    if (!agreement) return { handled: true }; // a concurrent delivery won the race

    /**
     * The fee that was actually taken, read back from the transaction rather than recomputed. A fee
     * rule can change between opening the charge and the customer confirming their card, and the
     * ledger must record what Stripe took, not what today's schedule would have taken.
     */
    const txn = await paymentsService.findTransactionByPaymentIntent(paymentIntentRef);
    const transactionId = txn ? String(txn._id) : null;
    const platformFeeCents = txn?.platform_fee_cents ?? 0;

    if (kind === 'acceptance') {
      /**
       * The initial payment and the set-up fee arrived on ONE intent but are TWO ledger entries,
       * because they are two different kinds of money: the initial payment is 100% equity and the
       * set-up fee buys the customer nothing. Folding them together would make the set-up fee look
       * like progress toward ownership.
       *
       * The platform fee sits entirely on the initial-payment line — it was levied on that base
       * alone (the set-up fee rode in as `serviceFeeCents`), so attributing any of it to the set-up
       * line would misstate both.
       */
      const initialCents = agreement.initial_payment_cents ?? 0;
      const setupCents = agreement.setup_fee_cents ?? 0;

      if (initialCents > 0) {
        await repo.appendLedger({
          agreement_id: agreementId,
          entry_type: 'initial',
          installment_number: null,
          amount_cents: initialCents,
          fee_cents: platformFeeCents,
          // The initial payment is 100% equity (rto.pricing) — credit equals amount.
          ownership_credit_cents: initialCents,
          transaction_id: transactionId,
          idempotency_key: `rto_initial_${agreementId}`,
        });
      }
      if (setupCents > 0) {
        await repo.appendLedger({
          agreement_id: agreementId,
          entry_type: 'setup_fee',
          installment_number: null,
          amount_cents: setupCents,
          fee_cents: 0,
          ownership_credit_cents: 0, // a set-up fee is a cost, never equity
          transaction_id: transactionId,
          idempotency_key: `rto_setup_${agreementId}`,
        });
      }

      /**
       * Capture the card the customer just used. Read back from Stripe rather than remembered from
       * the charge call, because the payment method only exists once they have actually confirmed —
       * at charge time there is no card yet, which is the whole reason this happens here.
       *
       * Every later instalment is charged against this. Without it the schedule cannot collect.
       */
      const card = await this.captureCard(agreementId, paymentIntentRef);
      if (!card) {
        logger.warn(
          { agreementId, paymentIntentRef },
          'RTO acceptance settled with no reusable card — instalments cannot be collected until one is added',
        );
      }

      const credited = await repo.updateAgreement(agreementId, {
        ownership_credited_cents: initialCents,
        ...(card ?? {}),
      });
      // Split from the CREDITED doc: the consignment split reads the running ownership credit, so
      // it must see the payment it is dividing, not the state from before it landed.
      if (initialCents > 0) {
        await this.recordSplit((credited ?? agreement) as AgreementDoc, null, 'initial', initialCents);
      }
    } else if (kind === 'installment') {
      /**
       * An instalment the CUSTOMER paid on-session — an SCA challenge they confirmed, a card they
       * added, or one they chose to pay ahead of its due date. Credited here for the same reason
       * everything else is: the sweep's own off-session charges settle synchronously, but this one
       * only becomes real when the customer finishes it.
       *
       * Every write is idempotent, so a duplicate delivery or a late webhook after the reconcile
       * sweep is a no-op rather than a second instalment.
       */
      const n = found.pending_intent_installment ?? 0;
      const schedule = await repo.installmentsForAgreement(agreementId);
      const inst = schedule.find((s) => s.installment_number === n);
      if (!inst) {
        logger.warn({ agreementId, n }, 'RTO instalment payment settled for an unknown instalment');
        return { handled: true };
      }

      const ledger = await repo.appendLedger({
        agreement_id: agreementId,
        entry_type: 'installment',
        installment_number: n,
        amount_cents: inst.amount_cents,
        fee_cents: platformFeeCents,
        ownership_credit_cents: inst.ownership_credit_cents,
        transaction_id: transactionId,
        idempotency_key: `rto_ledger_${agreementId}_${n}`,
      });
      if (ledger) {
        await repo.claimInstallment(agreementId, n);
        if (transactionId) await repo.setInstallmentTxn(agreementId, n, transactionId);
        await this.recordSplit(agreement, n, String(n), inst.amount_cents);
        await this.applyPaidInstallment(agreement, inst.ownership_credit_cents);
      }

      /**
       * Whatever was blocking is now unblocked, and a card is on file either way — the charge asked
       * to keep it, so the schedule can run itself from here.
       */
      const patch: Record<string, unknown> = {
        action_required_installment: null,
        pending_intent_installment: null,
      };
      if (!agreement.payment_method_ref) {
        const saved = await this.captureCard(agreementId, paymentIntentRef);
        if (saved) Object.assign(patch, saved);
      }
      await repo.updateAgreement(agreementId, patch);
    } else if (kind === 'payoff') {
      const payoffCents = computePayoff(
        agreement.cash_price_cents,
        agreement.ownership_credited_cents ?? 0,
      );
      await repo.appendLedger({
        agreement_id: agreementId,
        entry_type: 'payoff',
        installment_number: null,
        amount_cents: payoffCents,
        fee_cents: platformFeeCents,
        ownership_credit_cents: payoffCents,
        transaction_id: transactionId,
        idempotency_key: `rto_payoff_${agreementId}`,
      });
      const credited = await repo.updateAgreement(agreementId, {
        ownership_credited_cents: agreement.cash_price_cents,
      });
      /**
       * The payoff was never split. On a consignment agreement that meant the owner was paid their
       * share of every instalment and nothing at all of the payment that bought the item outright —
       * and `getStatements` reconciliation reported the shortfall as drift with no explanation.
       */
      if (payoffCents > 0) {
        await this.recordSplit((credited ?? agreement) as AgreementDoc, null, 'payoff', payoffCents);
      }
      await this.completeAndTransfer({
        _id: agreement._id,
        customer_id: agreement.customer_id,
        product_name: agreement.product_name,
        seller_id: agreement.seller_id,
      });
    } else {
      logger.warn({ agreementId, paymentIntentRef }, 'RTO payment settled with no pending kind');
      return { handled: true };
    }

    // Settle the transaction itself. This handler `break`s the webhook's chain before the generic
    // fallthrough, so nothing else will do it and the charge would otherwise stay `pending` forever.
    await paymentsService.completeByPaymentIntent(paymentIntentRef);
    await writeAudit({
      action: kind === 'payoff' ? 'rto.payoff_settled' : 'rto.acceptance_settled',
      entityType: 'rto_agreement',
      entityId: agreementId,
      metadata: { paymentIntentRef, transactionId },
    });
    return { handled: true };
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
  dashboard(
    agreement: AgreementDoc,
    schedule: { status: string; due_at: Date; amount_cents: number; installment_number: number }[],
  ) {
    const cash = agreement.cash_price_cents;
    const credited = agreement.ownership_credited_cents ?? 0;
    const paid = agreement.installments_paid ?? 0;
    return {
      ...this.summaryView(agreement),
      nextDueAt: agreement.next_due_at,
      installmentsRemaining: Math.max(0, agreement.installment_count - paid),
      ownershipPercent: cash > 0 ? Math.min(100, Math.round((credited / cash) * 100)) : 0,
      payoffCents: computePayoff(cash, credited),
      /**
       * The very next payment, as one object rather than three loose fields. The screen needs to say
       * "£18.34 on 23 Aug, taken automatically" in one sentence, and assembling that from a date
       * stat and an amount stat is how the two drift apart.
       */
      nextInstallment: (() => {
        const next = schedule.find((s) => s.status === 'scheduled' || s.status === 'missed');
        return next
          ? {
              installmentNumber: next.installment_number,
              amountCents: next.amount_cents,
              dueAt: next.due_at,
              /** Already late. The screen says so plainly rather than showing a past date. */
              overdue: next.status === 'missed' || next.due_at.getTime() < Date.now(),
            }
          : null;
      })(),
      schedule: schedule.map((s) => ({ dueAt: s.due_at, amountCents: s.amount_cents, status: s.status })),
    };
  },

  dashboardFrom(agreement: AgreementDoc, quote: ReturnType<typeof computeRtoQuote>) {
    /**
     * Ownership comes from the AGREEMENT, not the quote. The quote says what the initial payment
     * WOULD credit; the agreement says what has actually been credited, which is nothing until the
     * card clears. Reading the quote here would put "you own 20%" on the screen at the exact moment
     * the customer had paid nothing — the same lie the stored field used to tell.
     */
    const credited = agreement.ownership_credited_cents ?? 0;
    return {
      ...this.summaryView(agreement),
      nextDueAt: agreement.next_due_at,
      installmentsRemaining: agreement.installment_count,
      ownershipPercent:
        quote.cashPriceCents > 0 ? Math.round((credited / quote.cashPriceCents) * 100) : 0,
      payoffCents: computePayoff(quote.cashPriceCents, credited),
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
      /**
       * A scheduled payment that could not be taken automatically and is now waiting on the
       * customer — either the bank asked them to authenticate it, or we have no card saved. Neither
       * is delinquency and neither is their fault, so it is reported as its own state rather than
       * being folded into Grace. `hasSavedCard` is what tells the screen which of the two it is.
       */
      paymentActionRequired: a.action_required_installment
        ? {
            installmentNumber: a.action_required_installment,
            reason:
              a.pending_intent_kind === 'installment'
                ? ('authenticate' as const)
                : ('no_card' as const),
          }
        : null,
      /**
       * ═══ How the twelve payments actually happen. ═══
       *
       * The dashboard showed "0/12 payments made · next due 23 Aug" and nothing else, so a customer
       * had no idea whether the schedule ran itself or whether they were supposed to do something —
       * and the only button on the screen was a full payoff. Naming the card is the point: agreeing
       * to eleven more automatic charges without being told which card they come off is not
       * informed consent, it is a surprise waiting to happen.
       */
      hasSavedCard: Boolean(a.payment_method_ref),
      savedCard: a.payment_method_last4
        ? { brand: a.payment_method_brand ?? null, last4: a.payment_method_last4 }
        : null,
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
