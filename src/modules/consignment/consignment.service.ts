import { randomUUID } from 'node:crypto';
import { SWEEP_BATCH_LIMIT, reportSweepBatch } from '../../jobs/sweepBatch';
import { applyBps, applyPercent, assertReconciles } from '../../shared/money';
import {
  staticQrAccepted,
  staticQrDaysRemaining,
  staticQrExpiresAt,
  staticQrNotice,
} from './staticQrSunset';

import {
  CONSIGNMENT_EXPIRY_NOTICE_DAYS,
  CONSIGNMENT_RENEWAL_NOTICE_DAYS,
  DEFAULT_ABANDONMENT_AFTER_DAYS,
  DEFAULT_AUTO_APPROVE_MIN_TRUST,
  FOOD_CATEGORY_SLUGS,
  FOOD_SALES_FEATURE_FLAG,
  KYC_REQUIREMENT_BY_VALUE,
  LISTING_TYPE_LABELS,
  TIER_RANK,
  DEFAULT_CONSIGNMENT_TERM_DAYS,
  DEFAULT_RETURN_WINDOW_DAYS,
  RETURN_GRACE_HOURS,
  SELLER_AGREEMENT_VERSION,
  SELLER_PLUS_FEE_DISCOUNT_BPS,
  isSupportedListingType,
  terminationNoticeDaysFor,
  trustBandFor,
  type ConsignmentRenewalTerm,
  type ListingType,
  type RtoFrequency,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { formatCents } from '../../shared/money';
import { distanceMeters } from '../../shared/geo';
import { raiseFraudFlag } from '../../shared/fraud';
import { bizMetrics } from '../../observability/bizMetrics';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { agreementsService } from '../agreements/agreements.service';
import { feeService } from '../payments/fees';
import { computeOrderBreakdown } from '../orders/pricing';
import { computePayoff, computeRtoQuote } from '../rto/rto.pricing';
import { notificationsService } from '../notifications/notifications.service';
import { noticesService } from '../notifications/notices.service';
import { wishlistsService } from '../wishlists/wishlists.service';
import { paymentsService } from '../payments/payments.service';
import { trustService } from '../trust/trust.service';
import { shelterService } from '../shelter/shelter.service';
import { outcomesService } from '../ai/outcomes.service';
import { vendorsService } from '../vendors/vendors.service';
import { BusinessModel } from '../vendors/vendors.model';
import { UserModel } from '../identity/identity.model';
import { ledgerService } from '../ledger/ledger.service';
import { debtService } from '../debt/debt.service';
import { disputesRepository } from '../disputes/disputes.repository';
// Repository only (never the service) — salePaymentsService imports this module, so a service-level
// import would close an require cycle.
import { salePaymentsRepository as salePaymentsRepo } from '../salepayments/salepayments.repository';
import { jobsService } from '../jobs/jobs.service';
import { enqueueOrRun } from '../../jobs/queues';
import { currentQrToken, isRotatingToken, verifyQrToken } from './hubQr';
import { fraudSignalsService } from './fraudSignals.service';
import { consignmentRepository as repo } from './consignment.repository';
import type { InventoryCheckoutDoc } from './consignment.model';

async function assertBusinessOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId)
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
}

/**
 * A-1. Only listing types whose money path actually exists may be created or checked out. Applied
 * at BOTH ends deliberately: creation stops new bad rows, and checkout stops rows that predate the
 * gate (or arrive by import/migration) from ever reaching `settle()`, which would treat them as
 * consignment sales and move money on terms nobody agreed to.
 */
function assertSupportedListingType(listingType: string | null | undefined): void {
  if (isSupportedListingType(listingType)) return;
  const label = LISTING_TYPE_LABELS[(listingType ?? 'consignment') as ListingType] ?? listingType;
  throw BusinessRuleError(
    ERROR_CODES.LISTING_TYPE_UNSUPPORTED,
    `${label} listings aren't supported yet — only consignment listings can be created or taken out.`,
  );
}

/**
 * A-6. Food, drink and produce carry health-department and cottage-food requirements that vary by
 * county, so the jurisdiction must be explicitly cleared before a hub may list them. Default-deny:
 * a hub with no `city_slug`, or in a city nobody has reviewed, is refused (see
 * `platformService.isFeatureExplicitlyEnabled`).
 */
async function assertCategoryPermittedInJurisdiction(
  category: string | null | undefined,
  hub: { city_slug?: string | null },
): Promise<void> {
  if (!category) return;
  if (!(FOOD_CATEGORY_SLUGS as readonly string[]).includes(category)) return;

  const { platformService } = await import('../platform/platform.service');
  const permitted = await platformService.isFeatureExplicitlyEnabled(
    hub.city_slug,
    FOOD_SALES_FEATURE_FLAG,
  );
  if (permitted) return;

  throw ForbiddenError(
    hub.city_slug
      ? `Food and drink listings aren't cleared for ${hub.city_slug} yet — local health permits have to be confirmed first.`
      : 'Set your hub’s city before listing food or drink — local health permits are checked per jurisdiction.',
    ERROR_CODES.CATEGORY_NOT_PERMITTED,
  );
}

async function assertHubOwner(principal: Principal, hubId: string) {
  const hub = await repo.findHubById(hubId);
  if (!hub) throw NotFoundError('Hub not found');
  if (hub.owner_user_id !== principal.userId) {
    throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
  }
  return hub;
}

export const consignmentService = {
  // ─── Hubs ─────────────────────────────────────────────────────────────────────────────────
  /** The hubs this user operates — used by the hub dashboard to resolve the real hub (or send a
   * brand-new hub operator to registration). QR secret is intentionally NOT returned here. */
  async listMyHubs(principal: Principal) {
    const hubs = await repo.listHubsByOwner(principal.userId);
    return hubs.map((h) => ({
      id: String(h._id),
      businessId: h.business_id,
      address: h.address ?? null,
    }));
  },

  async registerHub(principal: Principal, businessId: string, address?: string, citySlug?: string) {
    await assertBusinessOwner(principal, businessId);
    const existing = await repo.findHubByBusiness(businessId);
    if (existing) throw ConflictError(ERROR_CODES.DUPLICATE, 'Business is already a hub');
    await vendorsService.registerHub(businessId);
    const hub = await repo.createHub({
      business_id: businessId,
      owner_user_id: principal.userId,
      checkout_qr_secret: randomUUID(),
      address: address ?? null,
      city_slug: citySlug ?? null,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'hub.registered',
      entityType: 'hub',
      entityId: String(hub._id),
      metadata: { businessId },
    });
    /**
     * Phase 6: the raw secret is a SIGNING KEY and is no longer handed out — a printed static code
     * could be photographed once and reused forever. The station fetches a rotating token instead
     * (GET /hubs/:id/qr). The first token is returned here so registration can show it immediately.
     */
    return {
      id: String(hub._id),
      businessId,
      ...currentQrToken(hub.checkout_qr_secret, String(hub._id)),
    };
  },

  // ─── Products ─────────────────────────────────────────────────────────────────────────────
  async addProduct(
    principal: Principal,
    hubId: string,
    dto: {
      name: string;
      unitValueCents: number;
      consignmentSplitPercent: number;
      returnWindowHours: number;
      quantityAvailable: number;
      photos?: string[];
      category?: string;
      listingType?: string;
      conditionRequirements?: string;
      categoryId?: string;
      termDays?: number | 'no_limit';
      minimumAuthorizedPriceCents?: number;
      requiredCertification?: string | null;
      sellerPermissions?: Partial<{
        may_discount: boolean;
        may_bundle: boolean;
        may_accept_offers: boolean;
        may_sell_below_min: boolean;
      }>;
      returnResponsibility?: 'seller' | 'hub';
      returnWindowDays?: number;
      storageFeeCentsPerDay?: number;
      abandonmentAfterDays?: number;
      /** §37 notice override; §39 renewal opt-in. */
      terminationNoticeDays?: number;
      autoRenew?: boolean;
      autoRenewTerm?: number | 'until_sold';
      minSellerTrustScore?: number;
    },
  ) {
    const hub = await assertHubOwner(principal, hubId);
    // A-1: refuse listing types with no settlement path before any row is written.
    assertSupportedListingType(dto.listingType);
    // A-6: food/drink needs an explicitly cleared jurisdiction.
    await assertCategoryPermittedInJurisdiction(dto.category, hub);
    // R14: term is one of the allowed durations or `no_limit` (stored as null); default 30 days.
    const termDays =
      dto.termDays === 'no_limit' ? null : (dto.termDays ?? DEFAULT_CONSIGNMENT_TERM_DAYS);
    const p = await repo.createProduct({
      hub_id: hubId,
      name: dto.name,
      unit_value_cents: dto.unitValueCents,
      consignment_split_percent: dto.consignmentSplitPercent,
      return_window_hours: dto.returnWindowHours,
      photos: dto.photos ?? [],
      category: dto.category ?? null,
      listing_type: dto.listingType ?? 'consignment',
      quantity_available: dto.quantityAvailable,
      condition_requirements: dto.conditionRequirements ?? null,
      category_id: dto.categoryId ?? null,
      term_days: termDays,
      minimum_authorized_price_cents: dto.minimumAuthorizedPriceCents ?? null,
      seller_permissions: {
        may_discount: dto.sellerPermissions?.may_discount ?? true,
        may_bundle: dto.sellerPermissions?.may_bundle ?? true,
        may_accept_offers: dto.sellerPermissions?.may_accept_offers ?? true,
        may_sell_below_min: dto.sellerPermissions?.may_sell_below_min ?? false,
      },
      return_responsibility: dto.returnResponsibility ?? 'seller',
      return_window_days: dto.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS,
      storage_fee_cents_per_day: dto.storageFeeCentsPerDay ?? 0,
      // §37/§39 — owner-authored, and null/false means "use the default", never "unspecified".
      termination_notice_days: dto.terminationNoticeDays ?? null,
      auto_renew: dto.autoRenew ?? false,
      auto_renew_term: dto.autoRenewTerm ?? null,
      abandonment_after_days: dto.abandonmentAfterDays ?? DEFAULT_ABANDONMENT_AFTER_DAYS,
      min_seller_trust_score: dto.minSellerTrustScore ?? null,
      required_certification: dto.requiredCertification ?? null,
    });
    return this.productView(p);
  },

  async listHubProducts(hubId: string) {
    const hub = await repo.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    const [products, outByProduct] = await Promise.all([
      repo.listProductsByHub(hubId),
      repo.outQuantityByProduct(hubId),
    ]);
    return products.map((p) => this.productView(p, outByProduct.get(String(p._id)) ?? 0));
  },

  // ─── Seller-side discovery (S-01 browse → GET /products/nearby, GET /products/:id) ────────
  async listNearbyProducts(input: {
    category?: string;
    lng?: number;
    lat?: number;
    radiusM?: number;
    cursor?: string;
    limit?: number;
  }) {
    const limit = input.limit ?? 50;
    // A location narrows to hubs within range first — that's what makes "nearby" true.
    const hubIds =
      input.lng !== undefined && input.lat !== undefined
        ? await repo.hubIdsNear(input.lng, input.lat, input.radiusM ?? 20_000)
        : undefined;
    // No hub in range means no inventory in range — not "show everything".
    if (hubIds && hubIds.length === 0) return { items: [], nextCursor: null };

    const products = await repo.listAvailableProducts({
      category: input.category,
      hubIds,
      before: input.cursor ? new Date(input.cursor) : undefined,
      limit,
    });
    const items = await this.discoveryViews(products);
    const last = products[products.length - 1] as { created_at?: Date } | undefined;
    return {
      items,
      nextCursor:
        products.length === limit ? (last?.created_at?.toISOString() ?? null) : null,
    };
  },

  async getDiscoveryProduct(productId: string) {
    const product = await repo.findProductById(productId);
    if (!product) throw NotFoundError('Product not found');
    const [view] = await this.discoveryViews([product.toObject()]);
    return view;
  },

  /** Joins products → hubs → businesses into the seller-facing browse shape. */
  async discoveryViews(
    products: Array<{
      _id: unknown;
      hub_id: string;
      name: string;
      category?: string | null;
      unit_value_cents: number;
      consignment_split_percent: number;
      return_window_hours: number;
      quantity_available: number;
      condition_requirements?: string | null;
      photos?: string[];
      min_seller_trust_score?: number | null;
      required_certification?: string | null;
    }>,
  ) {
    const hubIds = [...new Set(products.map((p) => String(p.hub_id)))];
    const hubs = await repo.hubsByIds(hubIds);
    const hubById = new Map(hubs.map((h) => [String(h._id), h]));
    const businessIds = [...new Set(hubs.map((h) => String(h.business_id)))];
    const businesses = await BusinessModel.find(
      { _id: { $in: businessIds } },
      { name: 1, service_area: 1 },
    )
      .lean()
      .exec();
    const bizById = new Map(businesses.map((b) => [String(b._id), b]));

    return products.map((p) => {
      const hub = hubById.get(String(p.hub_id));
      const biz = hub ? bizById.get(String(hub.business_id)) : undefined;
      const coords = biz?.service_area?.coordinates;
      return {
        id: String(p._id),
        hubId: String(p.hub_id),
        hubName: biz?.name ?? 'Consignment hub',
        name: p.name,
        category: p.category ?? 'shopping',
        // The browse UI derives per-unit price as declaredValue / quantityAvailable.
        declaredValueCents: p.unit_value_cents * p.quantity_available,
        sellerSplitPercent: p.consignment_split_percent,
        returnWindowDays: Math.round(p.return_window_hours / 24),
        quantityAvailable: p.quantity_available,
        conditionNotes: p.condition_requirements ?? '',
        distanceLabel: hub?.address ?? 'Nearby',
        lngLat: coords && coords.length === 2 ? [coords[0], coords[1]] : [0, 0],
        photos: p.photos ?? [],
        // A-3: surfaced so browse can mark premium stock as locked with the score needed to earn it.
        minSellerTrustScore: p.min_seller_trust_score ?? null,
        // D-5: a certification lock is ACTIONABLE today, unlike a Trust shortfall — so browse shows it.
        requiredCertification: p.required_certification ?? null,
      };
    });
  },

  // ─── Seller agreement (clickwrap bailment — FR-8.6) ────────────────────────────────────────
  // Back-compat wrapper over the generalized agreements framework (R28): the legacy
  // POST /seller-agreement/accept still works, now recording a tamper-evident `bailment` acceptance.
  async acceptAgreement(principal: Principal, version: string) {
    const result = await agreementsService.accept(principal, 'bailment', { version });
    return { accepted: true, version: result.version };
  },

  // ─── Checkout (QR + condition photo + Seller Agreement + reservation) ──────────────────────
  async checkout(
    principal: Principal,
    input: { productId: string; quantity: number; conditionPhotoUrl: string; qrToken: string },
  ) {
    const product = await repo.findProductById(input.productId);
    if (!product) throw NotFoundError('Product not found');
    const hub = await repo.findHubById(product.hub_id);
    if (!hub) throw NotFoundError('Hub not found');

    /**
     * A-1: the last line of defence. Creation is gated too, but rows written before that gate — or
     * imported, or migrated — must not reach `settle()`, which would treat a rental or a donation
     * as a consignment sale and split money on terms nobody agreed to.
     */
    assertSupportedListingType(product.listing_type);
    // A-6: re-checked here, not just at listing time, so a jurisdiction that loses its clearance
    // stops new checkouts immediately rather than only stopping new listings.
    await assertCategoryPermittedInJurisdiction(product.category, hub);

    // QR scan: the token must match the hub's checkout secret.
    /**
     * Phase 6: the QR proves physical presence, so it must be time-bound. A rotating token is
     * always accepted; the raw static secret only for grandfathered hubs that printed the old
     * poster. All failures return the same message — never tell a caller WHY a token was rejected.
     */
    const usedStaticQr =
      !isRotatingToken(input.qrToken) &&
      staticQrAccepted(hub) &&
      input.qrToken === hub.checkout_qr_secret;
    const qrOk = isRotatingToken(input.qrToken)
      ? verifyQrToken(hub.checkout_qr_secret, String(hub._id), input.qrToken)
      : usedStaticQr;
    if (!qrOk) {
      throw ForbiddenError('Invalid or expired hub QR token', ERROR_CODES.FORBIDDEN);
    }
    if (usedStaticQr) {
      // 6.5: you cannot phase out what you cannot count. Every remaining static acceptance is
      // recorded, so "which hubs still depend on the poster" is a query rather than a guess — and
      // so the switch-off is a decision made against evidence instead of a hopeful deadline.
      await writeAudit({
        actorId: principal.userId,
        action: 'hub.static_qr_used',
        entityType: 'hub',
        entityId: String(hub._id),
        metadata: {
          hubId: String(hub._id),
          daysRemaining: staticQrDaysRemaining(hub),
          expiresAt: staticQrExpiresAt(hub)?.toISOString() ?? null,
        },
      });
    }
    // Bailment agreement must be accepted at the current version (FR-8.6 / R28).
    await agreementsService.assertAccepted(principal.userId, 'bailment');

    /**
     * A-3. The Trust Score is read ONCE here and then does three jobs: it gates premium inventory,
     * scales the credit ceiling, and (further down) decides auto-approval. Previously it was fetched
     * only for the last of those.
     */
    const { score: trustScore } = await trustService.getScore('seller', principal.userId);
    const trustBand = trustBandFor(trustScore);
    // F-2: Seller Plus raises the ceiling and discounts the fee. Resolved once, used in both places.
    const { subscriptionsService } = await import('../subscriptions/subscriptions.service');
    const sellerPlus = await subscriptionsService.hasSellerPlus(principal.userId);

    /**
     * A-3 PREMIUM INVENTORY. A hub may reserve a product for sellers who have earned it. Checked
     * before the credit maths so the seller gets the real reason, not a confusing limit message.
     */
    if (
      product.min_seller_trust_score !== null &&
      product.min_seller_trust_score !== undefined &&
      trustScore < product.min_seller_trust_score
    ) {
      throw ForbiddenError(
        `This item needs a Trust Score of ${product.min_seller_trust_score}. You're at ${trustScore} — return stock on time and keep your reviews up to unlock it.`,
        ERROR_CODES.TRUST_TOO_LOW,
      );
    }

    /**
     * D-5 CERTIFICATION GATE. Distinct from the Trust gate above and checked separately so the
     * refusal names the right remedy: a Trust shortfall takes weeks of good behaviour, where a
     * missing certification is a ten-minute course the seller can finish right now. Telling someone
     * to "build trust" when a course would unlock it today is the difference between a door and a
     * wall.
     */
    if (product.required_certification) {
      const { academyService } = await import('../academy/academy.service');
      const held = await academyService.heldCertifications(principal.userId);
      if (!held.has(product.required_certification)) {
        const { courseForCertification } = await import('../academy/academy.catalog');
        const course = courseForCertification(product.required_certification);
        throw ForbiddenError(
          course
            ? `This item needs the ${course.certification!.label} certification. Finish “${course.title}” in the Academy — about ${course.estimatedMinutes} minutes — and you can take it straight away.`
            : 'This item requires a certification you don’t hold yet.',
          ERROR_CODES.CERTIFICATION_REQUIRED,
        );
      }
    }

    /**
     * CREDIT LIMITS (Phase 3). Trust is the seller's credit rating: it caps how much
     * uncollateralised stock they may hold and how much cash debt they may carry. This bounds the
     * risk the platform and hub cannot otherwise control, and it is what makes the cash rail safe.
     *
     * A-3: the tier sets the base ceiling, the Trust band scales it. Both still bind — and the KYC
     * ladder below binds independently, so a well-behaved seller with a thin identity file gets a
     * bigger allowance from their band and is still stopped by KYC at the value thresholds.
     */
    const requestedValue = product.unit_value_cents * input.quantity;
    const heldValue = await repo.sumActiveInventoryValue(principal.userId);

    /**
     * ═══ B-2: SHELTER-COSIGNED RESIDENT GUARDS ═══
     *
     * A resident is verified by a named staff member's word and a capped sum a partner org agreed
     * to stand behind — not by an ID document. `cosigned_allocation_cents` was documented in the
     * schema as "the HARD cap on the shelter's liability (FR-12.4)" and enforced NOWHERE, so a
     * shelter that cosigned $50 was silently exposed to the full Bronze $200.
     *
     * These run BEFORE the ordinary credit maths so the resident gets the real reason. All three
     * ordinary gates (credit, KYC, Trust) still apply underneath — this only ever narrows.
     */
    const resident = await shelterService.residentCapabilities(principal.userId);
    if (resident) {
      // B-5: training first. Not a hurdle — handing someone stock without telling them the return
      // window and the cash rules is how a well-meaning program creates its first debt spiral.
      if (!resident.trainingComplete) {
        throw ForbiddenError(
          'Finish the short starter course first — it takes a few minutes and covers returns, cash and getting paid.',
          ERROR_CODES.TRAINING_REQUIRED,
        );
      }

      // B-2: hub proximity. Practical, not restrictive — a resident travelling across the county
      // spends their earnings on transport, and their shelter can't help resolve a problem there.
      if (resident.maxHubDistanceM !== null && resident.shelterLocation) {
        const hubCoords = hub.location?.coordinates;
        if (hubCoords?.length === 2) {
          const away = distanceMeters(resident.shelterLocation, [hubCoords[0]!, hubCoords[1]!]);
          if (away > resident.maxHubDistanceM) {
            throw ForbiddenError(
              `This hub is too far from ${resident.organizationName} to collect from. Look for inventory closer to where you're staying.`,
              ERROR_CODES.FORBIDDEN,
            );
          }
        }
      }

      // B-2: the cosign is a ceiling on CONCURRENT exposure — what the shelter is standing behind
      // right now, not a lifetime total. Returned stock frees it up again.
      if (requestedValue > resident.allocationRemainingCents) {
        const maxUnits = Math.floor(
          resident.allocationRemainingCents / Math.max(1, product.unit_value_cents),
        );
        throw ForbiddenError(
          maxUnits > 0
            ? `${resident.organizationName} has cosigned ${formatCents(resident.cosignedAllocationCents)} of stock for you and you're holding ${formatCents(resident.allocationUsedCents)}. You can take up to ${maxUnits} more of this item, or return stock to free up room.`
            : `You're holding all ${formatCents(resident.cosignedAllocationCents)} of stock ${resident.organizationName} has cosigned for you. Return what you have — or ask them to raise it — to take more.`,
          ERROR_CODES.ALLOCATION_EXCEEDED,
        );
      }
    }

    const credit = await debtService.creditStatus(
      principal.userId,
      principal.verificationTier,
      heldValue,
      trustScore,
      // B-2: a resident's ceilings are the tighter of the ordinary rules and their cosign.
      resident
        ? {
            maxInventoryValueCents: resident.maxInventoryValueCents,
            maxCashDebtCents: resident.maxCashDebtCents,
          }
        : undefined,
      sellerPlus,
    );
    if (credit.overDebtLimit) {
      throw ForbiddenError(
        `Clear ${formatCents(credit.outstandingDebtCents - credit.maxCashDebtCents)} of your balance before taking more stock`,
        ERROR_CODES.FORBIDDEN,
      );
    }
    if (requestedValue > credit.availableInventoryCents) {
      // Tell the seller how to proceed, not just that they're over: how many units fit right now,
      // and that verifying raises the ceiling. Otherwise "$4,000,000 of stock" reads as a mystery.
      const tierLabel =
        principal.verificationTier.charAt(0).toUpperCase() + principal.verificationTier.slice(1);
      const maxUnits = Math.floor(
        credit.availableInventoryCents / Math.max(1, product.unit_value_cents),
      );
      // Two levers raise this ceiling now, so name both: identity (tier) and behaviour (Trust band).
      const raiseHint =
        principal.verificationTier === 'gold'
          ? trustBand.key === 'elite'
            ? ''
            : ' Keep returning stock on time to raise it further.'
          : ' Verify your identity — or build your Trust Score — to raise your limit.';
      throw ForbiddenError(
        maxUnits > 0
          ? `This is ${formatCents(requestedValue)} of stock, over your ${formatCents(credit.maxInventoryValueCents)} ${tierLabel}/${trustBand.label} limit. Take up to ${maxUnits} unit${maxUnits === 1 ? '' : 's'} of this item for now.${raiseHint}`
          : `This item is ${formatCents(product.unit_value_cents)}/unit — more than the ${formatCents(credit.availableInventoryCents)} of stock you can still hold at ${tierLabel}/${trustBand.label}, so you can't take even one yet.${raiseHint}`,
        ERROR_CODES.FORBIDDEN,
      );
    }

    /**
     * KYC SCALED TO VALUE (Phase 5). Identity assurance should be proportional to what someone is
     * trusted with. The tier caps the value; this states plainly what identity that value requires,
     * so the seller is told how to unlock more rather than just being refused.
     */
    const totalAtRisk = heldValue + requestedValue;
    const kycRule = [...KYC_REQUIREMENT_BY_VALUE]
      .reverse()
      .find((r) => totalAtRisk > r.aboveCents);
    if (kycRule && TIER_RANK[principal.verificationTier] < TIER_RANK[kycRule.minTier]) {
      throw ForbiddenError(
        `Holding over ${formatCents(kycRule.aboveCents)} of stock needs ${kycRule.requires}`,
        ERROR_CODES.TIER_TOO_LOW,
      );
    }

    // Atomically reserve inventory (guards against reserving more than available). Stock is held
    // from the moment of request — a reservation the hub hasn't answered yet must not be sellable
    // to someone else, or the hub could approve two claims on the same unit.
    const reserved = await repo.reserveProduct(input.productId, input.quantity);
    if (!reserved) throw ConflictError(ERROR_CODES.CONFLICT, 'Insufficient inventory available');

    /**
     * H-03 approval gate (FR-8.4). The hub is accepting real liability — goods physically leaving
     * on someone's word — so a reservation becomes a live checkout only via auto-approve or an
     * explicit hub decision. Auto-approve requires BOTH a trusted seller and a value within the
     * hub's cap; either miss sends it to the manual queue.
     */
    const declaredValueCents = product.unit_value_cents * input.quantity;
    const minTrust = hub.auto_approve_min_trust ?? DEFAULT_AUTO_APPROVE_MIN_TRUST;
    const maxValue = hub.auto_approve_max_value_cents ?? null;
    const autoApproved =
      trustScore >= minTrust && (maxValue === null || declaredValueCents <= maxValue);

    const now = Date.now();
    const expectedReturnAt = new Date(now + product.return_window_hours * 60 * 60 * 1000);
    // R14: snapshot the owner's term onto the checkout and derive expires_at (null = no-limit).
    const termDays = product.term_days ?? DEFAULT_CONSIGNMENT_TERM_DAYS;
    const expiresAt =
      product.term_days === null ? null : new Date(now + termDays * 24 * 60 * 60 * 1000);
    const perms = product.seller_permissions;
    const checkout = await repo.createCheckout({
      seller_id: principal.userId,
      product_id: input.productId,
      hub_id: product.hub_id,
      quantity: input.quantity,
      unit_value_cents: product.unit_value_cents,
      consignment_split_percent: product.consignment_split_percent,
      condition_photo_url: input.conditionPhotoUrl,
      seller_agreement_version: SELLER_AGREEMENT_VERSION,
      expected_return_at: expectedReturnAt,
      term_days: product.term_days === null ? null : termDays,
      expires_at: expiresAt,
      current_unit_price_cents: product.unit_value_cents,
      minimum_authorized_price_cents: product.minimum_authorized_price_cents ?? null,
      seller_permissions: {
        may_discount: perms?.may_discount ?? true,
        may_bundle: perms?.may_bundle ?? true,
        may_accept_offers: perms?.may_accept_offers ?? true,
        may_sell_below_min: perms?.may_sell_below_min ?? false,
      },
      return_responsibility: (product.return_responsibility) ?? 'seller',
      return_window_days: product.return_window_days ?? DEFAULT_RETURN_WINDOW_DAYS,
      storage_fee_cents_per_day: product.storage_fee_cents_per_day ?? 0,
      abandonment_after_days: product.abandonment_after_days ?? DEFAULT_ABANDONMENT_AFTER_DAYS,
      /**
       * §37 — the notice either party must give to end this early, snapshotted for the same reason
       * as every other term here. Derived from the TOTAL declared value when the owner hasn't set
       * one: recalling a crate of candles and recalling a commercial oven are not the same ask.
       */
      termination_notice_days:
        product.termination_notice_days ??
        terminationNoticeDaysFor(product.unit_value_cents * input.quantity),
      // §39 — renewal is opt-in and snapshotted; a mid-term change to the product must not
      // silently start renewing a consignment somebody already agreed to.
      auto_renew: product.auto_renew ?? false,
      // `auto_renew_term` is a Mixed schema field, so it arrives untyped — narrow it here
      // rather than letting `any` travel onto a snapshotted checkout term.
      auto_renew_term: (product.auto_renew_term as number | null) ?? null,
      // A-3: lock in the band the seller earned at pickup — settlement reads these, not a live score.
      trust_score_at_checkout: trustScore,
      trust_band: trustBand.key,
      trust_fee_discount_bps: trustBand.feeDiscountBps,
      // F-2: snapshotted for the same reason as the Trust band — the terms in force are the ones
      // the seller was shown when they took the stock, not whatever their plan says at settlement.
      seller_plus_at_checkout: sellerPlus,
      status: autoApproved ? 'active' : 'pending_approval',
      approved_at: autoApproved ? new Date() : null,
      approved_by: autoApproved ? 'auto' : null,
    });
    const checkoutId = String(checkout._id);

    /**
     * E-1: snapshot the decision-time features for the outcome dataset. Fire-and-forget — a
     * dataset is worth a lot, but never worth failing someone's pickup for.
     */
    void outcomesService.recordCheckout({
      checkoutId,
      sellerId: principal.userId,
      productId: input.productId,
      hubId: product.hub_id,
      unitValueCents: product.unit_value_cents,
      quantity: input.quantity,
    });

    /**
     * B-4 STARTER GRANT. A resident's first pickup carries zero downside: if it doesn't sell, the
     * shelter's cosign absorbs it and no debt is written against the person.
     *
     * This is the "begin earning the same day" promise made real. Someone with nothing cannot be
     * asked to accept downside on day one — the downside is the exact thing that put them there.
     * Recorded on the checkout so the return path knows not to charge them, and so the shelter can
     * see what its cosign actually absorbed.
     */
    if (resident?.starterGrantAvailable) {
      const granted = await shelterService.consumeStarterGrant(principal.userId, requestedValue);
      if (granted) {
        await repo.markStarterGrant(checkoutId, resident.partnerId);
        notificationsService.notify(principal.userId, {
          category: 'consignment',
          title: 'Your first pickup is covered',
          body: `${resident.organizationName} is covering this one. If it doesn't sell, bring it back — you won't owe anything.`,
          data: { checkoutId, starterGrant: true },
        });
      }
    }

    if (autoApproved) {
      await publish('inventory.checked_out', {
        checkoutId,
        sellerId: principal.userId,
        hubId: product.hub_id,
      });
      // The owner still needs to know stock walked out the door, even when no decision was asked of them.
      notificationsService.notify(hub.owner_user_id, {
        category: 'consignment',
        title: 'Inventory checked out',
        body: `${input.quantity} × ${product.name} auto-approved (Trust ${trustScore}).`,
        data: { audience: 'hub', checkoutId, hubId: product.hub_id, productId: input.productId, auto: true },
      });
    } else {
      await publish('inventory.approval_requested', {
        checkoutId,
        sellerId: principal.userId,
        hubId: product.hub_id,
      });
      notificationsService.notify(hub.owner_user_id, {
        category: 'consignment',
        title: 'Checkout needs your approval',
        body: `A seller requested ${input.quantity} × ${product.name}. Review it before the goods leave.`,
        data: {
          audience: 'hub',
          checkoutId,
          hubId: product.hub_id,
          productId: input.productId,
          trustScore,
          declaredValueCents,
        },
      });
    }

    await writeAudit({
      actorId: principal.userId,
      action: autoApproved ? 'checkout.auto_approved' : 'checkout.approval_requested',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { hubId: product.hub_id, trustScore, declaredValueCents, minTrust, maxValue },
    });

    return { ...this.checkoutView(checkout), autoApproved };
  },

  // ─── Hub approval gate (H-03) ───────────────────────────────────────────────────────────────
  async approveCheckout(principal: Principal, checkoutId: string) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    await assertHubOwner(principal, checkout.hub_id);
    const updated = await repo.approveCheckout(checkoutId, principal.userId);
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `Checkout is ${checkout.status} — only a pending reservation can be approved`,
      );
    }
    await publish('inventory.checked_out', {
      checkoutId,
      sellerId: updated.seller_id,
      hubId: updated.hub_id,
    });
    notificationsService.notify(updated.seller_id, {
      category: 'consignment',
      title: 'Checkout approved',
      body: 'The hub approved your reservation — you can collect the inventory.',
      data: { audience: 'seller', checkoutId },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'checkout.approved',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { hubId: updated.hub_id, sellerId: updated.seller_id },
    });
    return this.checkoutView(updated);
  },

  async declineCheckout(principal: Principal, checkoutId: string, reason?: string) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    await assertHubOwner(principal, checkout.hub_id);
    const updated = await repo.declineCheckout(checkoutId, reason ?? null);
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `Checkout is ${checkout.status} — only a pending reservation can be declined`,
      );
    }
    // The hold is released: nothing left the building, so the units go back on the shelf.
    const restocked = await repo.restockProduct(updated.product_id, updated.quantity);
    if (restocked.cameBackInStock) {
      void wishlistsService.notifyBackInStock('product', updated.product_id, {
        label: restocked.name,
      });
    }
    await publish('inventory.approval_declined', {
      checkoutId,
      sellerId: updated.seller_id,
      hubId: updated.hub_id,
    });
    notificationsService.notify(updated.seller_id, {
      category: 'consignment',
      title: 'Checkout declined',
      body: reason
        ? `The hub declined your reservation: ${reason}`
        : 'The hub declined your reservation.',
      data: { audience: 'seller', checkoutId, reason: reason ?? null },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'checkout.declined',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { hubId: updated.hub_id, sellerId: updated.seller_id, reason: reason ?? null },
    });
    return this.checkoutView(updated);
  },

  /**
   * The token the hub's check-in station should display right now (Phase 6). Rotates every 30s,
   * so a photographed code is worthless within a minute. Owner-only.
   */
  async stationToken(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
    const hub = await repo.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    const { token, expiresAt, rotateSeconds } = currentQrToken(
      hub.checkout_qr_secret,
      String(hub._id),
    );
    return {
      token,
      expiresAt,
      rotateSeconds,
      /** True while the old printed poster still works — a prompt to reprint and turn this off. */
      staticQrStillAccepted: staticQrAccepted(hub),
      /** 6.5 — when it stops working. `null` when this hub never accepted the static code. */
      staticQrExpiresAt: staticQrExpiresAt(hub)?.toISOString() ?? null,
      staticQrDaysRemaining: staticQrDaysRemaining(hub),
      /** Plain-language warning for the station screen; null when there is nothing to say. */
      staticQrNotice: staticQrNotice(hub),
    };
  },

  /** The hub's live auto-approve rule — shown on H-03 so the stated policy is the real one. */
  async getApprovalPolicy(principal: Principal, hubId: string) {
    const hub = await repo.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    if (hub.owner_user_id !== principal.userId)
      throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
    return {
      autoApproveMinTrust: hub.auto_approve_min_trust ?? DEFAULT_AUTO_APPROVE_MIN_TRUST,
      autoApproveMaxValueCents: hub.auto_approve_max_value_cents ?? null,
    };
  },

  async setApprovalPolicy(
    principal: Principal,
    hubId: string,
    patch: {
      autoApproveMinTrust?: number;
      autoApproveMaxValueCents?: number | null;
      citySlug?: string | null;
    },
  ) {
    await assertHubOwner(principal, hubId);
    const updated = await repo.updateHubApprovalPolicy(hubId, {
      ...(patch.autoApproveMinTrust !== undefined && {
        auto_approve_min_trust: patch.autoApproveMinTrust,
      }),
      ...(patch.autoApproveMaxValueCents !== undefined && {
        auto_approve_max_value_cents: patch.autoApproveMaxValueCents,
      }),
      // A-6: this is how a hub owner makes the food gate actionable rather than a dead end.
      ...(patch.citySlug !== undefined && { city_slug: patch.citySlug }),
    });
    if (!updated) throw NotFoundError('Hub not found');
    await writeAudit({
      actorId: principal.userId,
      action: 'hub.approval_policy_updated',
      entityType: 'hub',
      entityId: hubId,
      metadata: { ...patch },
    });
    return {
      autoApproveMinTrust: updated.auto_approve_min_trust ?? DEFAULT_AUTO_APPROVE_MIN_TRUST,
      autoApproveMaxValueCents: updated.auto_approve_max_value_cents ?? null,
    };
  },

  /** The hub's pending-approval queue (H-03), enriched with the signals the decision needs. */
  async pendingApprovals(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
    const checkouts = await repo.listCheckoutsByHub(hubId, ['pending_approval']);
    const rows = await this.hubCheckoutRows(checkouts);
    const rowByCheckout = new Map(rows.map((r) => [r.checkoutId, r]));
    // One batched lookup rather than a query per pending item (Phase 6).
    const scores = await trustService.getScores(
      'seller',
      checkouts.map((c) => c.seller_id),
    );
    return Promise.all(
      checkouts.map((c) => {
        const row = rowByCheckout.get(String(c._id))!;
        const score = scores.get(c.seller_id) ?? 0;
        return {
          id: String(c._id),
          sellerName: row.sellerName,
          productName: row.productName,
          quantity: c.quantity,
          trustScore: score,
          declaredValueCents: (c.unit_value_cents ?? 0) * c.quantity,
          requestedAt: c.checked_out_at ?? c.created_at ?? null,
          // Cosign status is a shelter-programme signal not yet modelled on the checkout.
          shelterCosigned: false,
        };
      }),
    );
  },

  // ─── Sales (oversell guard — FR-8.3) ────────────────────────────────────────────────────────
  async logSale(
    principal: Principal,
    checkoutId: string,
    input: {
      quantitySold: number;
      saleAmountCents: number;
      paymentRail?: 'cash' | 'digital';
      loggedVia?: string;
      proofPhotoUrl?: string;
    },
  ) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    if (checkout.seller_id !== principal.userId)
      throw ForbiddenError('Not your checkout', ERROR_CODES.NOT_OWNER);

    // R18: honor the owner's minimum authorized price. A per-unit sale below the floor is blocked
    // unless the seller was granted `may_sell_below_min` (otherwise it needs owner approval).
    const min = checkout.minimum_authorized_price_cents;
    if (min != null && input.quantitySold > 0) {
      const unitPrice = Math.floor(input.saleAmountCents / input.quantitySold);
      if (unitPrice < min && !checkout.seller_permissions?.may_sell_below_min) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          `Sale price is below the owner's minimum authorized price — owner approval is required to sell below it`,
        );
      }
    }

    // THE oversell guard: race-safe atomic conditional update.
    const updated = await repo.applySaleGuarded(checkoutId, input.quantitySold);
    if (!updated) {
      if (checkout.status !== 'active') {
        throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Checkout is ${checkout.status}`);
      }
      await raiseFraudFlag({
        type: 'oversell',
        subjectId: principal.userId,
        signals: {
          checkoutId,
          attempted: input.quantitySold,
          quantity: checkout.quantity,
          sold: checkout.quantity_sold,
        },
      });
      bizMetrics.oversellReject.inc();
      throw ConflictError(ERROR_CODES.OVERSELL, 'Reported sale exceeds checked-out quantity');
    }

    const rail = input.paymentRail ?? 'cash';
    const sale = await repo.createSale({
      checkout_id: checkoutId,
      quantity_sold: input.quantitySold,
      sale_amount_cents: input.saleAmountCents,
      proof_photo_url: input.proofPhotoUrl ?? null,
      logged_via: input.loggedVia ?? 'manual',
      payment_rail: rail,
    });
    await publish('inventory.sold', { checkoutId, sellerId: principal.userId });

    /**
     * CASH RAIL (Phase 3). The customer handed the money to the seller, so the seller is now
     * holding the hub's share and the platform's fee. Recording that as a debt is what makes cash
     * honest — previously the obligation simply vanished and the platform paid the hub itself.
     */
    let debtCents = 0;
    if (rail === 'cash' && input.saleAmountCents > 0) {
      const gross = input.saleAmountCents;
      const baseFee = await feeService.resolveFee('consignment_cash', gross);
      /**
       * A-3: the same Trust discount `settle()` applies, applied here too. On the cash rail the
       * seller already holds every dollar, so the reward shows up as a SMALLER DEBT rather than a
       * bigger payout. Charging the full fee here and the discounted fee at settlement would leave
       * the debt and the settlement disagreeing about the same sale.
       */
      const trustDiscount = applyBps(baseFee, checkout.trust_fee_discount_bps ?? 0);
      const platformFee = baseFee - trustDiscount;
      // Hub share is computed from the undiscounted fee — the hub is owed what its split entitles it
      // to, and the platform's reward never comes out of the hub's pocket.
      const distributable = gross - baseFee;
      const sellerNet = applyPercent(distributable, checkout.consignment_split_percent);
      const hubShare = distributable - sellerNet;
      const hub = await repo.findHubById(checkout.hub_id);

      await debtService.createDebt({
        sellerId: principal.userId,
        originType: 'cash_sale',
        originRefId: String(sale._id),
        hubId: checkout.hub_id,
        hubBusinessId: hub?.business_id ?? null,
        hubShareCents: hubShare,
        platformFeeCents: platformFee,
        memo: `Cash sale ${formatCents(gross)}`,
      });
      debtCents = hubShare + platformFee;

      notificationsService.notify(principal.userId, {
        category: 'payments',
        title: 'Cash sale recorded',
        body: `You keep the ${formatCents(gross)} cash. ${formatCents(debtCents)} (hub share + fee) comes out of your next card sale.`,
        // What the seller actually keeps = their split plus the Trust discount they earned.
        data: { checkoutId, debtCents, sellerNetCents: sellerNet + trustDiscount },
      });
    }

    // Sold out → nothing left to return, settle immediately (idempotent). The return flow still
    // settles partially-sold checkouts.
    if (updated.quantity_sold >= updated.quantity) {
      await this.settle(updated);
    }

    return {
      checkoutId,
      quantitySold: updated.quantity_sold,
      quantity: updated.quantity,
      remaining: updated.quantity - updated.quantity_sold,
      settled: updated.quantity_sold >= updated.quantity,
      paymentRail: rail,
      /** What this cash sale added to the seller's balance (0 for digital). */
      debtCents,
    };
  },

  /** Total declared value of stock a seller is currently holding — the credit-limit numerator. */
  async activeInventoryValue(sellerId: string): Promise<number> {
    return repo.sumActiveInventoryValue(sellerId);
  },

  // ─── Return + settle ─────────────────────────────────────────────────────────────────────────
  async returnAndSettle(
    principal: Principal,
    checkoutId: string,
    input: { quantityReturned: number; conditionPhotoUrl?: string; conditionAssessment?: string },
  ) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    if (checkout.seller_id !== principal.userId)
      throw ForbiddenError('Not your checkout', ERROR_CODES.NOT_OWNER);
    if (!['active', 'overdue', 'return_pending'].includes(checkout.status)) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Checkout is ${checkout.status}`);
    }

    await repo.createReturn({
      checkout_id: checkoutId,
      quantity_returned: input.quantityReturned,
      condition_photo_url: input.conditionPhotoUrl ?? null,
      condition_assessment: input.conditionAssessment ?? 'good',
    });
    const assessment = input.conditionAssessment ?? 'good';
    // Unsold, good-condition units go back into hub inventory.
    if (input.quantityReturned > 0 && assessment === 'good') {
      const restocked = await repo.restockProduct(checkout.product_id, input.quantityReturned);
      if (restocked.cameBackInStock) {
        void wishlistsService.notifyBackInStock('product', checkout.product_id, {
          label: restocked.name,
        });
      }
    }

    /**
     * LOST / DAMAGED LIABILITY (Phase 4). Previously these assessments were recorded and then
     * nothing happened — a seller could report all stock "lost" and owe nothing, which is a
     * free-inventory exploit. The hub loses real property, so the seller carries the value as debt
     * and takes a trust penalty proportional to it.
     */
    if (input.quantityReturned > 0 && (assessment === 'lost' || assessment === 'damaged')) {
      const hub = await repo.findHubById(checkout.hub_id);
      // Damaged goods retain some value; lost goods retain none.
      const rate = assessment === 'lost' ? 1 : 0.5;
      const valueCents = Math.round(
        (checkout.unit_value_cents ?? 0) * input.quantityReturned * rate,
      );

      /**
       * B-4: a starter-grant checkout writes NO debt against the resident. The cosigning shelter
       * agreed to absorb exactly this, and charging the person anyway would make the grant a lie —
       * the whole promise is that their first pickup cannot leave them worse off than they started.
       *
       * The hub is still made whole: the loss is recorded against the shelter's cosigned allocation
       * for its own reporting, and the trust penalty below still applies, because a resident who
       * loses stock has still demonstrated something the score should reflect.
       */
      const starterGrantPartnerId = checkout.starter_grant_partner_id ?? null;
      if (starterGrantPartnerId) {
        logger.info(
          { checkoutId, valueCents, partnerId: starterGrantPartnerId, assessment },
          'starter-grant loss absorbed by shelter cosign — no resident debt written',
        );
        await publish('resident.starter_grant_loss', {
          residentUserId: checkout.seller_id,
          partnerId: starterGrantPartnerId,
          checkoutId,
          valueCents,
        });
        notificationsService.notify(checkout.seller_id, {
          category: 'consignment',
          title: 'You don’t owe anything for this',
          body: 'Your first pickup was covered. Nothing has been charged to you — come back when you’re ready to try again.',
          data: { checkoutId, starterGrant: true },
        });
      } else {
        await debtService.chargeInventoryLiability({
          sellerId: checkout.seller_id,
          checkoutId,
          hubId: checkout.hub_id,
          hubBusinessId: hub?.business_id ?? null,
          valueCents,
          kind: assessment === 'lost' ? 'lost_inventory' : 'damaged_inventory',
        });
      }
      await writeAudit({
        actorId: principal.userId,
        action: `inventory.${assessment}`,
        entityType: 'checkout',
        entityId: checkoutId,
        metadata: { quantity: input.quantityReturned, valueCents, starterGrantPartnerId },
      });
    }

    return this.settle(checkout);
  },

  /**
   * Settlement (FR-8.4): gross − platform fee − hub share = seller net. Itemized, immutable, and
   * disbursed via split transfers to the seller and hub connected accounts (tiered payout timing
   * governed by each account's schedule). Recomputes the seller's Trust Score.
   */
  async settle(checkout: InventoryCheckoutDoc & { _id: unknown }) {
    const checkoutId = String(checkout._id);
    const existing = await repo.findSettlementByCheckout(checkoutId);
    if (existing) return existing; // idempotent

    /**
     * DISPUTE HOLD (Phase 4). Money must not leave while its ownership is actively contested —
     * settlements are immutable and post-settlement clawback is unreliable, so the only safe moment
     * to stop is before. Settlement resumes once the dispute resolves.
     */
    const openDispute = await disputesRepository.openForRef('checkout', checkoutId);
    if (openDispute) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Settlement is on hold while this checkout is disputed',
      );
    }

    const agg = await repo.sumSales(checkoutId);
    const gross = agg[0]?.gross ?? 0;
    /**
     * Fee per rail, not a flat rate. A digital sale already paid 8% at capture and a cash sale 10%;
     * charging a single blended rate here would make this record contradict the transfers that
     * actually executed — the hub would see a different share than it was paid.
     */
    const byRail = await repo.sumSalesByRail(checkoutId);
    let baseFee = 0;
    for (const row of byRail) {
      const code =
        row._id === 'digital'
          ? 'consignment_digital'
          : row._id === 'cash'
            ? 'consignment_cash'
            : 'consignment'; // legacy rows predate the rail split
      baseFee += await feeService.resolveFee(code, row.gross);
    }

    /**
     * A-3 TRUST REWARD. The discount comes out of the PLATFORM'S fee and goes entirely to the
     * seller. The hub's share is deliberately computed from the UNDISCOUNTED fee, so the hub is
     * paid exactly what its authored split entitles it to either way — the platform funds its own
     * loyalty programme rather than quietly redirecting someone else's money.
     *
     * The band is read from the checkout snapshot, not from the seller's current score: the terms
     * in force are the ones they were shown when they took the stock.
     */
    const trustDiscountBps = checkout.trust_fee_discount_bps ?? 0;
    /**
     * F-2: Seller Plus stacks with the A-3 Trust band, and is funded identically — out of the
     * PLATFORM's fee, never the hub's share. Capped at the whole fee so the platform can discount
     * itself to zero but never past it into paying for the privilege.
     */
    const plusBps = checkout.seller_plus_at_checkout ? SELLER_PLUS_FEE_DISCOUNT_BPS : 0;
    const totalDiscountBps = Math.min(10_000, trustDiscountBps + plusBps);
    const trustDiscount = applyBps(baseFee, totalDiscountBps);
    const platformFee = baseFee - trustDiscount;

    const baseDistributable = gross - baseFee;
    const sellerBase = applyPercent(baseDistributable, checkout.consignment_split_percent);
    const hubShare = baseDistributable - sellerBase;
    const sellerNet = sellerBase + trustDiscount;

    // A-5: the three legs must account for every cent of the sale. The discount moves money from the
    // platform's fee to the seller's payout, so it cancels out — if it ever stopped cancelling, this
    // throws at the site that caused it rather than surfacing as an unexplained ledger drift later.
    assertReconciles(gross, [platformFee, sellerNet, hubShare], 'consignment settlement');

    const hub = await repo.findHubById(checkout.hub_id);
    const transferGroup = `settle_${checkoutId}`;

    /**
     * SOLVENCY GUARD (Phase 0). A payout may only be funded by money the platform actually
     * collected. Cash sales are handed straight to the seller and never reach the platform balance,
     * so transferring against them would spend platform capital on a sale that generated none —
     * previously this drained real money on every settlement.
     *
     * The split is still calculated and recorded in full: the amounts are genuinely OWED, they are
     * simply not yet PAYABLE. When the digital rail lands, `payment_rail: 'digital'` sales make
     * `collected` non-zero and the same code disburses normally.
     */
    const collected = await repo.sumCollectedSales(checkoutId);
    const fundingSource: 'collected' | 'unfunded' | 'mixed' | 'none' =
      gross === 0 ? 'none' : collected >= gross ? 'collected' : collected > 0 ? 'mixed' : 'unfunded';

    /**
     * DIGITAL PROCEEDS ARE ALREADY DISBURSED. Each in-app payment splits to the seller and hub at
     * the moment the customer pays (`salePaymentsService.onPaymentSucceeded`), so settlement must
     * NOT transfer again — that would pay both parties twice. For a digital checkout, settlement is
     * the reconciliation record, not a disbursement event.
     *
     * Tier-based payout timing is enforced by the connected account's Stripe payout SCHEDULE (set
     * at verification), so an instant transfer still respects a Bronze seller's hold before the
     * money reaches their bank.
     *
     * Cash proceeds never reached the platform, so nothing can be paid from them (Phase 0 guard).
     * `mixed` is deliberately withheld rather than part-paid: over-paying is unrecoverable while
     * under-paying is merely delayed.
     */
    const alreadyDisbursed = fundingSource === 'collected';

    /**
     * A leg is only `paid` if a transfer REALLY executed. "The platform collected the money" is not
     * the same as "the counterparty received it" — a party with no Connect account gets no transfer,
     * and the proceeds stay on the platform balance as a payable.
     *
     * Recording that leg as `paid` was doubly wrong: it told the hub it had been paid when it hadn't,
     * and it hid the debt from `findUnpaidSettlements`, whose whole job is to retry `no_account` legs
     * once onboarding completes. So read the real transfer ids off the sale payments.
     */
    const payments = alreadyDisbursed ? await salePaymentsRepo.listByCheckout(checkoutId) : [];
    const anyTransfer = (key: 'seller_transfer_id' | 'hub_transfer_id'): boolean =>
      payments.some((p) => Boolean((p.split as Record<string, unknown> | undefined)?.[key]));
    const sellerPayout: string | null = null;
    const hubPayout: string | null = null;

    const legStatus = (
      amount: number,
      key: 'seller_transfer_id' | 'hub_transfer_id',
    ): 'paid' | 'awaiting_funds' | 'no_account' | 'not_applicable' => {
      if (amount <= 0) return 'not_applicable';
      if (!alreadyDisbursed) return 'awaiting_funds';
      // Collected, but the transfer never went out → the payee has no usable Connect account.
      return anyTransfer(key) ? 'paid' : 'no_account';
    };
    void transferGroup;

    const settlement = await repo.createSettlement({
      checkout_id: checkoutId,
      gross_sales_cents: gross,
      platform_fee_cents: platformFee,
      hub_share_cents: hubShare,
      seller_net_cents: sellerNet,
      // Transfer refs live on the per-sale payment records now (digital splits at payment time);
      // settlement no longer issues transfers of its own.
      seller_payout_ref: sellerPayout,
      hub_payout_ref: hubPayout,
      funding_source: fundingSource,
      collected_cents: collected,
      trust_fee_discount_cents: trustDiscount,
      trust_band: checkout.trust_band ?? null,
      seller_payout_status: legStatus(sellerNet, 'seller_transfer_id'),
      hub_payout_status: legStatus(hubShare, 'hub_transfer_id'),
    });
    await repo.setCheckoutStatus(checkoutId, checkout.status, 'settled');

    if (!alreadyDisbursed && gross > 0) {
      // Both parties are owed money that cannot move yet. Saying nothing here is what previously
      // let a seller read "settled $528.25" while no payment existed.
      logger.warn(
        { checkoutId, gross, collected, sellerNet, hubShare },
        'settlement recorded without collected funds — payouts withheld',
      );
      if (sellerNet > 0) {
        notificationsService.notify(checkout.seller_id, {
          category: 'payments',
          title: 'Your share is recorded',
          body: `You earned ${formatCents(sellerNet)} on this consignment. It's recorded as owed — in-app payment collection is coming soon.`,
          data: { checkoutId, sellerNetCents: sellerNet, reason: 'awaiting_funds' },
        });
      }
      if (hub && hubShare > 0) {
        notificationsService.notify(hub.owner_user_id, {
          category: 'payments',
          title: 'Hub share recorded',
          body: `${formatCents(hubShare)} is owed to your hub from a cash sale. Collect it directly from the seller for now.`,
          data: { audience: 'hub', checkoutId, hubShareCents: hubShare, reason: 'awaiting_funds' },
        });
      }
    } else if (sellerNet > 0 && !sellerPayout) {
      // Funded, but the seller has no payout-enabled Connect account.
      notificationsService.notify(checkout.seller_id, {
        category: 'payments',
        title: 'Payout on hold',
        body: `Your ${formatCents(sellerNet)} payout is waiting — connect a payout account to receive it.`,
        data: { checkoutId, sellerNetCents: sellerNet, reason: 'no_payout_account' },
      });
    }

    bizMetrics.settlements.inc();
    bizMetrics.settlementGrossCents.inc(gross);
    bizMetrics.settlementLatency.observe(
      Math.max(0, (Date.now() - (checkout.checked_out_at?.getTime() ?? Date.now())) / 1000),
    );

    await writeAudit({
      actorId: checkout.seller_id,
      action: 'inventory.settled',
      entityType: 'settlement',
      entityId: checkoutId,
      metadata: { gross, platformFee, hubShare, sellerNet },
    });
    await publish('inventory.settled', { checkoutId, sellerId: checkout.seller_id });

    /**
     * Phase 6: the Trust recompute reads a seller's whole history, so it does not belong in the
     * request that closed the sale. Queued where a queue exists; run inline otherwise so nothing
     * is ever silently skipped.
     */
    await enqueueOrRun(
      'settlement',
      'settlement-followup',
      { checkoutId, sellerId: checkout.seller_id },
      async () => {
        await trustService.recompute('seller', checkout.seller_id);
        await fraudSignalsService.evaluateSeller(checkout.seller_id);
      },
    );

    return {
      checkoutId,
      grossSalesCents: gross,
      platformFeeCents: platformFee,
      hubShareCents: hubShare,
      sellerNetCents: sellerNet,
      settledAt: settlement.settled_at,
      fundingSource,
      collectedCents: collected,
      sellerPayoutStatus: legStatus(sellerNet, 'seller_transfer_id'),
      hubPayoutStatus: legStatus(hubShare, 'hub_transfer_id'),
    };
  },

  async getSettlement(principal: Principal, checkoutId: string) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    const hub = await repo.findHubById(checkout.hub_id);
    const isSeller = checkout.seller_id === principal.userId;
    const isHubOwner = hub?.owner_user_id === principal.userId;
    if (!isSeller && !isHubOwner)
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);
    const settlement = await repo.findSettlementByCheckout(checkoutId);
    if (!settlement) throw NotFoundError('Not yet settled');
    const returnedQty = await repo.sumReturns(checkoutId);
    const fundingSource = settlement.funding_source ?? 'legacy_unfunded';
    const sellerPayoutStatus = settlement.seller_payout_status ?? 'awaiting_funds';
    const isPaid = sellerPayoutStatus === 'paid';
    // Tier-based payout timing (Flow 1b) only describes money that can actually move. Quoting a
    // payout schedule for funds the platform never collected is what made "settled" misleading.
    const tier = principal.verificationTier;
    const payoutTiming = !isPaid
      ? 'Not yet payable — awaiting in-app payment collection'
      : tier === 'gold'
        ? 'Gold — instant payout'
        : tier === 'silver'
          ? 'Silver — payout in 1 day'
          : 'Bronze — payout held 3 days';
    return {
      checkoutId,
      soldQty: checkout.quantity_sold ?? 0,
      returnedQty,
      grossCents: settlement.gross_sales_cents,
      platformFeeCents: settlement.platform_fee_cents,
      hubShareCents: settlement.hub_share_cents,
      sellerNetCents: settlement.seller_net_cents,
      settledAt: settlement.settled_at,
      payoutTiming,
      fundingSource,
      collectedCents: settlement.collected_cents ?? 0,
      sellerPayoutStatus,
      hubPayoutStatus: settlement.hub_payout_status ?? 'awaiting_funds',
      /**
       * A-3: show the seller the reward they actually earned. A discount they never see is a
       * discount that changes no behaviour — and `platformFeeCents` above is already net of it, so
       * without this the arithmetic on the screen doesn't visibly add up.
       */
      trustFeeDiscountCents: settlement.trust_fee_discount_cents ?? 0,
      trustBand: settlement.trust_band ?? null,
      // Nominal on-time-settlement credit; the full Trust Score recompute runs asynchronously.
      trustDelta: 2,
    };
  },

  /**
   * Retry payout legs that never completed (Phase 2). A digital sale splits at payment time, but a
   * leg fails when the payee has no payout-enabled Connect account yet. Without this the money is
   * stuck forever — settlements are immutable and nothing else revisits them.
   *
   * The ledger is the source of truth for what is still owed: an outstanding `payable` balance IS
   * the unpaid obligation, so paying it down and posting the matching entries closes the loop.
   */
  async retryFailedPayouts(): Promise<{ attempted: number; paid: number }> {
    const stuck = await repo.findUnpaidSettlements();
    let attempted = 0;
    let paid = 0;

    for (const s of stuck) {
      const checkout = await repo.findCheckoutById(s.checkout_id);
      if (!checkout) continue;
      const hub = await repo.findHubById(checkout.hub_id);

      const legs: Array<{
        key: 'seller' | 'hub';
        ownerType: 'user' | 'business';
        ownerId: string;
        accountType: 'payable';
      }> = [
        { key: 'seller', ownerType: 'user', ownerId: checkout.seller_id, accountType: 'payable' },
        ...(hub
          ? [{ key: 'hub' as const, ownerType: 'business' as const, ownerId: hub.business_id, accountType: 'payable' as const }]
          : []),
      ];

      for (const leg of legs) {
        const owed = await ledgerService.balanceOf({
          ownerType: leg.ownerType,
          ownerId: leg.ownerId,
          accountType: 'payable',
        });
        if (owed <= 0) continue;
        attempted += 1;

        const payout = await paymentsService.payoutTransfer({
          ownerType: leg.ownerType,
          ownerId: leg.ownerId,
          amountCents: owed,
          transferGroup: `retry_${s.checkout_id}`,
          idempotencyKey: `retry_${leg.key}_${s.checkout_id}_${owed}`,
          // B-3: this sweep is exactly where residents' money accumulated as permanently unpayable.
          // With custody available, the seller leg now discharges to their shelter instead.
          ...(leg.key === 'seller'
            ? {
                custodySource: {
                  type: 'consignment_settlement' as const,
                  refId: s.checkout_id,
                },
              }
            : {}),
        });
        if (!payout) continue; // still no payout account — try again next run

        await ledgerService.post({
          transactionId: `retry_payout_${leg.key}_${s.checkout_id}_${owed}`,
          refType: 'settlement',
          refId: s.checkout_id,
          memo: 'Retried payout',
          entries: [
            { ownerType: leg.ownerType, ownerId: leg.ownerId, accountType: 'payable', direction: 'debit', amountCents: owed, entryType: 'payout' },
            { ownerType: 'platform', accountType: 'cash', direction: 'credit', amountCents: owed, entryType: 'payout' },
          ],
        });
        // Write the outcome back to the settlement, otherwise this row keeps reporting the leg as
        // unpaid and the sweep keeps revisiting it even though the money has left.
        await repo.markSettlementLegPaid(s.checkout_id, leg.key, payout.transferId);
        paid += 1;
        notificationsService.notify(leg.ownerType === 'user' ? leg.ownerId : (hub?.owner_user_id ?? leg.ownerId), {
          category: 'payments',
          title: 'Payout sent',
          body: `${formatCents(owed)} is on its way to your account.`,
          data: { audience: leg.ownerType === 'user' ? 'seller' : 'hub', checkoutId: s.checkout_id },
        });
      }
    }

    if (attempted > 0) logger.info({ attempted, paid }, 'payout retry sweep');
    return { attempted, paid };
  },

  // ─── Hub reconciliation surfaces (H-04 live inventory, H-05 settlements) ────────────────────
  async hubHolders(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
    const checkouts = await repo.listCheckoutsByHub(hubId, ['active', 'overdue', 'return_pending']);
    return this.hubCheckoutRows(checkouts);
  },

  /**
   * C-5 — the hub's live inventory map. Ownership is asserted here; the projection itself lives in
   * `mapLayersService` alongside the other map layers, so all the viewport-shaped reads stay
   * together rather than being scattered across the modules that happen to own the data.
   */
  async hubInventoryMap(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
    const { mapLayersService } = await import('../livemap/maplayers.service');
    return mapLayersService.hubInventoryMap(hubId);
  },

  /** E-10: expose the ownership assertion so sibling modules can gate hub-scoped reads. */
  async assertHubOwnerFor(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
  },

  async hubSettlements(principal: Principal, hubId: string) {
    await assertHubOwner(principal, hubId);
    const checkouts = await repo.listCheckoutsByHub(hubId);
    const settlements = await repo.settlementsByCheckoutIds(checkouts.map((c) => String(c._id)));
    const checkoutById = new Map(checkouts.map((c) => [String(c._id), c]));
    const rows = await this.hubCheckoutRows(
      settlements
        .map((s) => checkoutById.get(s.checkout_id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c)),
    );
    const rowByCheckout = new Map(rows.map((r) => [r.checkoutId, r]));
    return settlements.map((s) => ({
      ...rowByCheckout.get(s.checkout_id)!,
      grossCents: s.gross_sales_cents,
      hubShareCents: s.hub_share_cents,
      settledAt: s.settled_at,
      fundingSource: s.funding_source ?? 'legacy_unfunded',
      hubPayoutStatus: s.hub_payout_status ?? 'awaiting_funds',
    }));
  },

  /** Shared row shape: checkout + seller display name + product name. */
  async hubCheckoutRows(
    checkouts: Array<{
      _id: unknown;
      seller_id: string;
      product_id: string;
      quantity: number;
      quantity_sold?: number | null;
      expected_return_at: Date;
    }>,
  ) {
    const products = await repo.productsByIds([...new Set(checkouts.map((c) => String(c.product_id)))]);
    const productNameById = new Map(products.map((p) => [String(p._id), p.name]));
    const sellerIds = [...new Set(checkouts.map((c) => c.seller_id))];
    const sellers = await UserModel.find({ _id: { $in: sellerIds } }, { display_name: 1 })
      .lean()
      .exec();
    const sellerNameById = new Map(sellers.map((u) => [String(u._id), u.display_name]));
    return checkouts.map((c) => ({
      checkoutId: String(c._id),
      sellerName: sellerNameById.get(c.seller_id) ?? 'Seller',
      productName: productNameById.get(String(c.product_id)) ?? 'Product',
      quantity: c.quantity,
      soldQty: c.quantity_sold ?? 0,
      returnDeadline: c.expected_return_at,
    }));
  },

  async listMyCheckouts(sellerId: string, limit: number) {
    const checkouts = await repo.listCheckoutsBySeller(sellerId, limit);
    // Join product + hub-business names so the seller's inventory list is self-describing.
    const productIds = [...new Set(checkouts.map((c) => String(c.product_id)))];
    const products = await repo.productsByIds(productIds);
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const hubIds = [...new Set(checkouts.map((c) => String(c.hub_id)))];
    const hubs = await repo.hubsByIds(hubIds);
    const bizIdByHub = new Map(hubs.map((h) => [String(h._id), String(h.business_id)]));
    const businesses = await BusinessModel.find(
      { _id: { $in: [...new Set([...bizIdByHub.values()])] } },
      { name: 1 },
    )
      .lean()
      .exec();
    const bizNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return checkouts.map((c) => ({
      ...this.checkoutView(c),
      productName: productById.get(String(c.product_id))?.name ?? null,
      hubName: bizNameById.get(bizIdByHub.get(String(c.hub_id)) ?? '') ?? null,
    }));
  },

  /**
   * Seller earnings feed (GAP-6, S-13): settled-payout history + a recent daily gross series +
   * pending totals for sales awaiting settlement. Aggregated across the seller's own checkouts.
   */
  async sellerEarnings(sellerId: string, windowDays = 14) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const data = await repo.sellerEarnings(sellerId, since);
    const settledNetCents = data.settlements.reduce((sum, s) => sum + s.sellerNetCents, 0);
    // Split "earned" from "actually paid". Cash sales never reached the platform, so their share is
    // owed but not payable — reporting it as a payout is what made this screen misleading.
    const paidNetCents = data.settlements
      .filter((s) => s.payoutStatus === 'paid')
      .reduce((sum, s) => sum + s.sellerNetCents, 0);
    const awaitingFundsCents = data.settlements
      .filter((s) => s.payoutStatus === 'awaiting_funds')
      .reduce((sum, s) => sum + s.sellerNetCents, 0);
    const noAccountCents = data.settlements
      .filter((s) => s.payoutStatus === 'no_account')
      .reduce((sum, s) => sum + s.sellerNetCents, 0);
    return {
      totals: {
        lifetimeGrossCents: data.lifetimeGrossCents,
        settledNetCents,
        paidNetCents,
        awaitingFundsCents,
        noAccountCents,
        settledCount: data.settlements.length,
        paidCount: data.settlements.filter((s) => s.payoutStatus === 'paid').length,
        pendingGrossCents: data.pendingGrossCents,
        pendingCheckoutCount: data.pendingCheckoutCount,
      },
      windowDays,
      dailyGross: data.dailyGross,
      payouts: data.settlements,
      /**
       * Gig payouts belong in the same feed (docs/13 §308): a seller who works a shift and sells
       * consignment stock has ONE income, and splitting it across two screens hides half of it.
       * Kept as its own array so the client can label the source rather than pretending a gig is a
       * settlement.
       */
      jobPayouts: await jobsService.payoutsForWorker(sellerId, since),
    };
  },

  /**
   * Pre-publish fee calculator (R12, U5): "if I price this at $X with a Y% split, what do I take
   * home, and what does the customer pay?" Every number is resolved SERVER-SIDE from the same
   * registry + settlement math the real sale uses, so the preview matches the eventual payout:
   *   gross − consignment platform fee (10%) = distributable; seller = split%, hub = the rest.
   * The customer-facing side reuses `computeOrderBreakdown` (service/processing/tax honor the launch
   * flags — $0 today). RTO installment slots are reserved for Phase 3.
   */
  async feePreview(input: {
    unitPriceCents: number;
    splitPercent: number;
    quantity: number;
    /** §57.2 — optional RTO terms. When present, the calculator also prices the rent-to-own deal. */
    rtoInstallmentCount?: number;
    rtoFrequency?: RtoFrequency;
    rtoMarkupBps?: number;
    rtoInitialPaymentCents?: number;
  }) {
    const grossCents = input.unitPriceCents * input.quantity;
    const platformFeeCents = await feeService.resolveFee('consignment', grossCents);
    const distributableCents = grossCents - platformFeeCents;
    const sellerNetCents = applyPercent(distributableCents, input.splitPercent);
    const hubShareCents = distributableCents - sellerNetCents;

    // Customer-facing estimate, identical to what checkout would itemize for this amount.
    const rates = await feeService.resolveOrderFeeRates();
    const cust = computeOrderBreakdown({ subtotalCents: grossCents, rates });

    // §57.2 — only priced when the seller asked for it; a plain consignment listing has no RTO deal.
    const rtoRule = await feeService.resolveFeeRule('rto_installment');
    const rtoFeeBpsValue = rtoRule?.rate_bps ?? 1000;
    const rtoQuote = input.rtoInstallmentCount
      ? computeRtoQuote({
          cashPriceCents: grossCents,
          initialPaymentCents: input.rtoInitialPaymentCents ?? 0,
          installmentCount: input.rtoInstallmentCount,
          frequency: input.rtoFrequency ?? 'monthly',
          markupBps: input.rtoMarkupBps ?? 0,
          feeBps: rtoFeeBpsValue,
        })
      : null;

    return {
      input,
      grossCents,
      platformFeeCents,
      sellerNetCents,
      hubShareCents,
      customer: {
        subtotalCents: grossCents,
        serviceFeeCents: cust.serviceFeeCents,
        processingFeeCents: cust.processingFeeCents,
        taxCents: cust.taxCents,
        totalCents: cust.totalCents,
      },
      /**
       * §57.2 — the rent-to-own half of the calculator. Every row the spec names: what the customer
       * pays up front and per instalment, how many there are, the total to own, the early-payoff
       * amount, the platform's fee per payment, and what the seller actually ends up with.
       *
       * Computed from the SAME `computeRtoQuote` the disclosure and the agreement use, so a seller
       * pricing a deal here sees the number their customer will be charged — a calculator that
       * approximates is worse than none, because it will be believed.
       */
      rto: rtoQuote
        ? {
            initialPaymentCents: rtoQuote.initialPaymentCents,
            installmentAmountCents: rtoQuote.installmentAmountCents,
            installmentCount: rtoQuote.installmentCount,
            totalToOwnCents: rtoQuote.totalToOwnCents,
            costOverCashCents: rtoQuote.costOverCashCents,
            /** Payoff on day one — before any instalment has built equity. */
            earlyPayoffCents: computePayoff(
              rtoQuote.cashPriceCents,
              rtoQuote.initialOwnershipCreditCents,
            ),
            platformFeePerPaymentCents: rtoQuote.schedule[0]?.feeCents ?? 0,
            /** What the seller keeps across the whole agreement, after the platform's cut. */
            sellerTotalEarningsCents:
              rtoQuote.totalToOwnCents -
              rtoQuote.schedule.reduce((sum, r) => sum + r.feeCents, 0) -
              applyBps(rtoQuote.initialPaymentCents, rtoFeeBpsValue),
          }
        : null,
      estimated: true,
    };
  },

  // ─── Consignment agreement lifecycle actions (R15/R17/R18) ──────────────────────────────────
  /** Extend the term (R15 "Extend"): reset expiry from now by the new term; re-arm expiry notices. */
  async extendTerm(
    principal: Principal,
    checkoutId: string,
    input: { termDays?: number | 'no_limit'; endDate?: string },
  ) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    if (checkout.seller_id !== principal.userId)
      throw ForbiddenError('Not your checkout', ERROR_CODES.NOT_OWNER);

    /**
     * §35.2 — a custom end date. Stored as the expiry with a derived `term_days` so the notice
     * ladder and the renewal sweep, which both reason in days, keep working unchanged.
     */
    let days: number | null;
    let expiresAt: Date | null;
    if (input.endDate !== undefined) {
      expiresAt = new Date(input.endDate);
      if (expiresAt.getTime() <= Date.now()) {
        throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'The end date must be in the future');
      }
      days = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000));
    } else {
      const termDays = input.termDays ?? DEFAULT_CONSIGNMENT_TERM_DAYS;
      days = termDays === 'no_limit' ? null : termDays;
      expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }
    const updated = await repo.extendCheckout(
      checkoutId,
      ['active', 'overdue', 'return_pending'],
      expiresAt,
      days,
    );
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Checkout cannot be extended');
    await writeAudit({
      actorId: principal.userId,
      action: 'consignment.term_extended',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { termDays: days, expiresAt },
    });
    return this.checkoutView(updated);
  },

  /**
   * Reduce the seller's asking price (R15 "Reduce Price" / R18). Blocked below the owner's minimum
   * unless the seller may sell below it — otherwise it needs owner approval.
   */
  async reducePrice(principal: Principal, checkoutId: string, unitPriceCents: number) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    if (checkout.seller_id !== principal.userId)
      throw ForbiddenError('Not your checkout', ERROR_CODES.NOT_OWNER);
    if (!checkout.seller_permissions?.may_discount) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'You are not permitted to change the price');
    }
    const currentPrice = checkout.current_unit_price_cents ?? checkout.unit_value_cents;
    if (unitPriceCents >= currentPrice) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Reduce Price can only lower the price');
    }
    const min = checkout.minimum_authorized_price_cents;
    if (min != null && unitPriceCents < min && !checkout.seller_permissions?.may_sell_below_min) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Price is below the owner's minimum authorized price — owner approval is required`,
      );
    }
    const updated = await repo.setCurrentPrice(checkoutId, ['active', 'overdue', 'return_pending'], unitPriceCents);
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Checkout price cannot be changed');
    await writeAudit({
      actorId: principal.userId,
      action: 'consignment.price_reduced',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { unitPriceCents },
    });
    return this.checkoutView(updated);
  },

  /**
   * End the consignment (R15 "End" / spec §37) — by giving NOTICE, not instantly.
   *
   * Termination is MUTUAL: the seller may hand the goods back, and the hub owner — whose property
   * these are — may recall them. Restricting it to the seller left an owner with no exit at all
   * from a no-limit term, so their stock could be held indefinitely by someone who simply never
   * acted.
   *
   * But it is also not immediate. §37 requires advance notice — 3 days for low-value goods, 7 for
   * standard, 14–30 for expensive or specialised — because the other side has stock on a shelf or
   * goods in a van. The checkout carries the period it agreed to; this schedules the end date and
   * the sweep completes it. Ending on the spot would let either party strand the other.
   *
   * Both parties are notified whoever gives notice: "your goods are coming back" and "your stock has
   * been recalled" are each news the other side needs, on the same day.
   */
  async endConsignment(principal: Principal, checkoutId: string) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');

    const isSeller = checkout.seller_id === principal.userId;
    const hub = await repo.findHubById(checkout.hub_id);
    const isHubOwner = hub?.owner_user_id === principal.userId;
    if (!isSeller && !isHubOwner) {
      throw ForbiddenError(
        'Only the seller or the hub that owns this inventory can end the consignment',
        ERROR_CODES.NOT_OWNER,
      );
    }
    const endedBy: 'seller' | 'hub' = isSeller ? 'seller' : 'hub';

    const noticeDays =
      checkout.termination_notice_days ??
      terminationNoticeDaysFor(checkout.unit_value_cents * checkout.quantity);
    const now = new Date();
    const effectiveAt = new Date(now.getTime() + noticeDays * 24 * 60 * 60 * 1000);

    /**
     * Notice also cancels any pending renewal. Serving notice and then auto-renewing the very term
     * being ended would be absurd, and is exactly the kind of thing that only shows up in production.
     */
    const updated = await repo.giveTerminationNotice(checkoutId, {
      endedBy,
      noticeDays,
      noticeAt: now,
      effectiveAt,
    });
    if (!updated) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Checkout cannot be ended — it may already be ending or settled',
      );
    }

    const notice = {
      checkoutId,
      endedBy,
      noticeDays,
      effectiveAt,
      ...this.returnTerms(updated),
    };
    const when = `in ${noticeDays} day${noticeDays === 1 ? '' : 's'}`;
    notificationsService.notify(checkout.seller_id, {
      category: 'consignment',
      title: 'Consignment ending',
      body: isSeller
        ? `You ended this consignment. Unsold items are due back ${when}.`
        : `The hub has recalled this stock. Please return unsold items ${when}.`,
      data: { audience: 'seller', ...notice },
    });
    if (hub?.owner_user_id) {
      notificationsService.notify(hub.owner_user_id, {
        category: 'consignment',
        title: isSeller ? 'Seller is ending a consignment' : 'Consignment ending',
        body: `Unsold stock is due back ${when}.`,
        data: { audience: 'hub', ...notice },
      });
    }
    await writeAudit({
      actorId: principal.userId,
      action: 'consignment.termination_notice',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: {
        endedBy,
        noticeDays,
        effectiveAt,
        hubId: checkout.hub_id,
        sellerId: checkout.seller_id,
      },
    });
    return this.checkoutView(updated);
  },

  /**
   * §39 — turn automatic renewal on or off. EITHER party may, at any point before it fires: the
   * spec's requirement is not merely that renewal is announced but that it can still be stopped
   * after the announcement, which is the difference between a notice and a formality.
   */
  async setAutoRenew(
    principal: Principal,
    checkoutId: string,
    input: { enabled: boolean; term?: ConsignmentRenewalTerm },
  ) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    const isSeller = checkout.seller_id === principal.userId;
    const hub = await repo.findHubById(checkout.hub_id);
    const isHubOwner = hub?.owner_user_id === principal.userId;
    if (!isSeller && !isHubOwner) {
      throw ForbiddenError('Not a party to this consignment', ERROR_CODES.NOT_OWNER);
    }
    if (input.enabled && !input.term) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Choose how long each renewal should run for',
      );
    }
    const actor: 'seller' | 'hub' = isSeller ? 'seller' : 'hub';
    const updated = await repo.setAutoRenew(checkoutId, {
      enabled: input.enabled,
      term: input.enabled ? (input.term ?? null) : null,
      cancelledBy: input.enabled ? null : actor,
    });
    if (!updated) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Checkout cannot be changed');
    }

    // The other party is told: a renewal they were expecting no longer happening changes what they
    // need to plan for just as much as one they were not expecting.
    const other = isSeller ? hub?.owner_user_id : checkout.seller_id;
    if (other) {
      notificationsService.notify(other, {
        category: 'consignment',
        title: input.enabled ? 'Automatic renewal turned on' : 'Automatic renewal turned off',
        body: input.enabled
          ? 'This consignment will now renew automatically at the end of its term.'
          : 'This consignment will now end at the end of its term unless it is extended.',
        data: { audience: isSeller ? 'hub' : 'seller', checkoutId, autoRenew: input.enabled },
      });
    }
    await writeAudit({
      actorId: principal.userId,
      action: input.enabled ? 'consignment.auto_renew_on' : 'consignment.auto_renew_off',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { by: actor, term: input.term ?? null },
    });
    return this.checkoutView(updated);
  },

  /**
   * §36 — change the commission at term end. The spec lists it alongside extend and reduce-price as
   * one of the things the parties may do when a term runs out, and it was the only one with no path.
   *
   * The HUB owner sets it, because the split is the owner's offer for holding and selling their
   * goods. It takes effect from now and never retroactively: re-splitting sales that already
   * happened would rewrite money both sides have already counted, so a consignment with units
   * already sold has to be settled and re-taken instead.
   */
  async changeCommission(principal: Principal, checkoutId: string, splitPercent: number) {
    const checkout = await repo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    const hub = await repo.findHubById(checkout.hub_id);
    if (hub?.owner_user_id !== principal.userId) {
      throw ForbiddenError('Only the hub can change the commission', ERROR_CODES.NOT_OWNER);
    }
    if ((checkout.quantity_sold ?? 0) > 0) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This consignment has already sold units at the agreed split. Settle it and start a new term to change the commission.',
      );
    }
    const updated = await repo.setSplitPercent(checkoutId, splitPercent);
    if (!updated) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Commission cannot be changed');
    }
    notificationsService.notify(checkout.seller_id, {
      category: 'consignment',
      title: 'Your split changed',
      body: `The hub set your share to ${splitPercent}% for this consignment.`,
      data: { audience: 'seller', checkoutId, splitPercent },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'consignment.commission_changed',
      entityType: 'checkout',
      entityId: checkoutId,
      metadata: { from: checkout.consignment_split_percent, to: splitPercent },
    });
    return this.checkoutView(updated);
  },

  /**
   * Both sides of a consignment, as `[audience, userId]`. Notices that concern the agreement itself
   * — renewal, termination — go to both parties, because either one acting on it changes what the
   * other has to plan for.
   */
  async partiesOf(c: { seller_id: string; hub_id: string }): Promise<['seller' | 'hub', string][]> {
    const hub = await repo.findHubById(c.hub_id);
    const out: ['seller' | 'hub', string][] = [['seller', c.seller_id]];
    if (hub?.owner_user_id) out.push(['hub', hub.owner_user_id]);
    return out;
  },

  /**
   * Expiry-notice sweep (R15): send the seller notices at 14/7/3 days before expiry and on the
   * expiry date; on expiry, unsold checkouts move to Return-Pending (R17 — never auto-keep). Idempotent
   * via `notices_sent`. Also flags Return-Pending checkouts past their abandonment window for review.
   */
  async sweepExpiryNotices(): Promise<{
    noticed: number;
    returnPending: number;
    abandonment: number;
    renewed: number;
    terminated: number;
  }> {
    const now = new Date();
    let renewed = 0;
    let terminated = 0;

    /**
     * §37 — complete terminations whose notice period has elapsed. Done FIRST so a consignment
     * under notice is never renewed or re-noticed on its way out.
     */
    for (const c of await repo.dueForTermination(now, 200)) {
      const checkoutId = String(c._id);
      const moved = await repo.moveToReturnPending(checkoutId);
      if (!moved) continue;
      terminated += 1;
      const unsold = c.quantity - (c.quantity_sold ?? 0);
      /**
       * 7.1 — §37 termination is a contractual notice: the notice period has run and the seller now
       * owes the goods back. In-app alone would leave a seller who declined push discovering an
       * obligation only when someone chases them for stock.
       */
      await noticesService.send({
        userId: c.seller_id,
        type: 'consignment_terminated',
        entityType: 'checkout',
        entityId: checkoutId,
        subject: 'Consignment ended — return pending',
        body: `The notice period has passed. ${unsold} unsold item(s) are now due back.`,
        category: 'consignment',
        data: { audience: 'seller', checkoutId, ...this.returnTerms(moved) },
        idempotencyKey: `consignment_terminated_${checkoutId}`,
      });
      const hub = await repo.findHubById(c.hub_id);
      if (hub?.owner_user_id) {
        notificationsService.notify(hub.owner_user_id, {
          category: 'consignment',
          title: 'Consignment ended',
          body: `${unsold} unsold item(s) are due back.`,
          data: { audience: 'hub', checkoutId },
        });
      }
      await writeAudit({
        action: 'consignment.terminated',
        entityType: 'checkout',
        entityId: checkoutId,
        metadata: { endedBy: c.terminated_by, unsold },
      });
    }

    const due = await repo.dueForExpiryNotice(now, SWEEP_BATCH_LIMIT);
    let noticed = 0;
    let returnPending = 0;

    for (const c of due) {
      if (!c.expires_at) continue;
      const checkoutId = String(c._id);
      const msLeft = c.expires_at.getTime() - now.getTime();
      const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      const sent = new Set(c.notices_sent ?? []);

      /**
       * §39 — renewal, handled before the expiry branch so an auto-renewing consignment never
       * touches Return-Pending on its way round.
       *
       * `until_sold` renews only while stock remains: a renewal term that outlives the goods is a
       * subscription nobody agreed to.
       */
      if (c.auto_renew && c.auto_renew_term != null && !c.termination_notice_at) {
        const unsoldNow = c.quantity - (c.quantity_sold ?? 0);
        const term = c.auto_renew_term as number | 'until_sold';

        // The pre-renewal notice: announced before it happens, and still cancellable after (§39).
        if (
          msLeft > 0 &&
          daysLeft <= CONSIGNMENT_RENEWAL_NOTICE_DAYS &&
          c.renewal_notice_sent_for?.getTime() !== c.expires_at.getTime()
        ) {
          await repo.markRenewalNoticed(checkoutId, c.expires_at);
          const label = term === 'until_sold' ? 'until the stock sells' : `for another ${term} days`;
          for (const [audience, userId] of await this.partiesOf(c)) {
            notificationsService.notify(userId, {
              category: 'consignment',
              title: 'This consignment will renew',
              body: `It renews ${label} on ${c.expires_at.toDateString()}. You can turn that off before then.`,
              data: { audience, checkoutId, autoRenewTerm: term, expiresAt: c.expires_at },
            });
          }
          noticed += 1;
        }

        if (msLeft <= 0 && unsoldNow > 0) {
          const days = term === 'until_sold' ? (c.term_days ?? DEFAULT_CONSIGNMENT_TERM_DAYS) : term;
          const nextExpiry = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
          const renewedDoc = await repo.renewCheckout(checkoutId, nextExpiry, days);
          if (renewedDoc) {
            renewed += 1;
            for (const [audience, userId] of await this.partiesOf(c)) {
              notificationsService.notify(userId, {
                category: 'consignment',
                title: 'Consignment renewed',
                body: `It now runs until ${nextExpiry.toDateString()}.`,
                data: { audience, checkoutId, expiresAt: nextExpiry },
              });
            }
            await writeAudit({
              action: 'consignment.renewed',
              entityType: 'checkout',
              entityId: checkoutId,
              metadata: { term, expiresAt: nextExpiry },
            });
            continue;
          }
        }
      }

      if (msLeft <= 0) {
        // On/after expiry: fire the on-date notice once, then move unsold units to Return-Pending.
        if (!sent.has(0)) {
          await repo.recordNoticesSent(checkoutId, [0]);
          await this.notifyExpiry(c, 0);
          noticed += 1;
        }
        const unsold = c.quantity - (c.quantity_sold ?? 0);
        if (unsold > 0) {
          const moved = await repo.moveToReturnPending(checkoutId);
          if (moved) {
            returnPending += 1;
            notificationsService.notify(c.seller_id, {
              category: 'consignment',
              title: 'Consignment expired — return pending',
              body: `${unsold} unsold item(s) are now pending return.`,
              data: { audience: 'seller', checkoutId, ...this.returnTerms(moved) },
            });
          }
        }
        continue;
      }

      // Approaching expiry: fire every not-yet-sent threshold at or above the days remaining.
      const crossed = CONSIGNMENT_EXPIRY_NOTICE_DAYS.filter(
        (t) => t > 0 && daysLeft <= t && !sent.has(t),
      );
      if (crossed.length > 0) {
        await repo.recordNoticesSent(checkoutId, crossed);
        await this.notifyExpiry(c, Math.min(...crossed)); // one notice for the most urgent crossed threshold
        noticed += 1;
      }
    }

    // Abandonment review (R17): Return-Pending past the cutoff → flag for lawful review, never auto-keep.
    const abandoned = await repo.dueForAbandonmentReview(now, 200);
    for (const c of abandoned) {
      await raiseFraudFlag({
        type: 'other',
        subjectId: c.seller_id,
        signals: {
          reason: 'consignment_abandonment_review',
          checkoutId: String(c._id),
          returnPendingAt: c.return_pending_at,
        },
      });
    }

    // 5.3: 500/day is the tightest capacity of any sweep here, against expiries that cluster (a hub
    // onboarding 600 products in a week produces >500 expiries on one day, a month later). A §38
    // notice that arrives after the term ended is worthless, so saturation here needs to be loud.
    reportSweepBatch('consignment-expiry-notices', due.length);
    return { noticed, returnPending, abandonment: abandoned.length, renewed, terminated };
  },

  /**
   * 7.1 / A-9 — §38 requires an expiry NOTICE, and a notice that arrives only in an app the seller
   * has not opened is not one. This goes out on every channel the seller has and the attempt is
   * recorded, so "were they told the term was ending?" is a row you can produce rather than an
   * inference from a log.
   *
   * Async now, where it used to be fire-and-forget. Callers await it: the sweep records
   * `notices_sent` immediately afterwards, and marking a notice sent before knowing whether it went
   * is precisely the bookkeeping error that makes the record worthless.
   */
  async notifyExpiry(
    c: { _id: unknown; seller_id: string; expires_at?: Date | null },
    daysLeft: number,
  ): Promise<void> {
    const body =
      daysLeft === 0
        ? 'Your consignment term ends today. Choose what happens to unsold items: extend the term, reduce the price, or arrange the return of anything unsold.'
        : `Your consignment term ends in ${daysLeft} day(s). You can extend it, reduce the price, or arrange the return of unsold items.`;
    await noticesService.send({
      userId: c.seller_id,
      type: 'consignment_expiry',
      entityType: 'checkout',
      entityId: String(c._id),
      subject: 'Consignment term ending',
      body,
      category: 'consignment',
      // The actions the seller can take from the notice (R15).
      data: {
        audience: 'seller',
        checkoutId: String(c._id),
        daysLeft,
        actions: ['extend', 'reduce_price', 'return', 'continue', 'end'],
      },
      idempotencyKey: `consignment_expiry_${String(c._id)}_${daysLeft}`,
    });
  },

  /** The Return-Pending terms disclosed to the seller (R17). */
  returnTerms(c: {
    return_responsibility?: string | null;
    return_window_days?: number | null;
    storage_fee_cents_per_day?: number | null;
    abandonment_after_days?: number | null;
  }) {
    return {
      returnResponsibility: c.return_responsibility ?? 'seller',
      returnWindowDays: c.return_window_days ?? DEFAULT_RETURN_WINDOW_DAYS,
      storageFeeCentsPerDay: c.storage_fee_cents_per_day ?? 0,
      abandonmentAfterDays: c.abandonment_after_days ?? DEFAULT_ABANDONMENT_AFTER_DAYS,
    };
  },

  // ─── Overdue sweep (FR-8.5) ──────────────────────────────────────────────────────────────────
  async sweepOverdue(): Promise<number> {
    const cutoff = new Date(Date.now() - RETURN_GRACE_HOURS * 60 * 60 * 1000);
    const due = await repo.dueOverdue(cutoff, SWEEP_BATCH_LIMIT);
    let flagged = 0;
    for (const c of due) {
      const moved = await repo.setCheckoutStatus(String(c._id), 'active', 'overdue');
      if (!moved) continue;
      notificationsService.notify(c.seller_id, {
        category: 'dispute',
        title: 'Overdue consignment return',
        body: 'Please return or settle your checked-out inventory',
        data: { checkoutId: String(c._id) },
      });
      await publish('inventory.overdue', { checkoutId: String(c._id), sellerId: c.seller_id });
      await trustService.recompute('seller', c.seller_id);
      flagged += 1;
    }
    reportSweepBatch('overdue-return-sweep', due.length);
    return flagged;
  },

  productView(
    p: {
      _id: unknown;
      hub_id: string;
      name: string;
      unit_value_cents: number;
      consignment_split_percent: number;
      return_window_hours: number;
      quantity_available: number;
      photos?: string[];
      category?: string | null;
      listing_type?: string | null;
      min_seller_trust_score?: number | null;
      required_certification?: string | null;
    },
    quantityOut = 0,
  ) {
    return {
      id: String(p._id),
      hubId: p.hub_id,
      name: p.name,
      category: p.category ?? null,
      listingType: p.listing_type ?? 'consignment',
      unitValueCents: p.unit_value_cents,
      consignmentSplitPercent: p.consignment_split_percent,
      returnWindowHours: p.return_window_hours,
      quantityAvailable: p.quantity_available,
      quantityOut,
      photos: p.photos ?? [],
      // A-3: the client renders a locked state rather than letting the seller reach the QR screen
      // and get refused there. The server still enforces it at checkout regardless.
      minSellerTrustScore: p.min_seller_trust_score ?? null,
      // D-5: surfaced so browse can show the course that unlocks it rather than a bare refusal.
      requiredCertification: p.required_certification ?? null,
    };
  },

  checkoutView(c: {
    _id: unknown;
    seller_id: string;
    product_id: string;
    hub_id: string;
    quantity: number;
    quantity_sold?: number | null;
    status: string;
    expected_return_at: Date;
    checked_out_at?: Date | null;
    unit_value_cents?: number | null;
    consignment_split_percent?: number | null;
    term_days?: number | null;
    expires_at?: Date | null;
    current_unit_price_cents?: number | null;
    minimum_authorized_price_cents?: number | null;
    seller_permissions?: {
      may_discount?: boolean;
      may_bundle?: boolean;
      may_accept_offers?: boolean;
      may_sell_below_min?: boolean;
    } | null;
    return_responsibility?: string | null;
    return_window_days?: number | null;
    storage_fee_cents_per_day?: number | null;
    abandonment_after_days?: number | null;
    termination_notice_days?: number | null;
    terminated_by?: string | null;
    termination_effective_at?: Date | null;
    auto_renew?: boolean | null;
    auto_renew_term?: unknown;
    renewal_count?: number | null;
  }) {
    return {
      id: String(c._id),
      sellerId: c.seller_id,
      productId: c.product_id,
      hubId: c.hub_id,
      quantity: c.quantity,
      quantitySold: c.quantity_sold ?? 0,
      status: c.status,
      expectedReturnAt: c.expected_return_at,
      checkedOutAt: c.checked_out_at ?? null,
      consignmentSplitPercent: c.consignment_split_percent ?? null,
      // R14/R17/R18 lifecycle fields for the inventory + action surfaces.
      termDays: c.term_days ?? null,
      expiresAt: c.expires_at ?? null,
      /**
       * §37/§39 — a termination in flight and the renewal setting. Both belong on the row the
       * seller looks at: a notice that isn't visible is not a notice, and a renewal you can't see
       * is one you can't stop.
       */
      terminationNoticeDays: c.termination_notice_days ?? null,
      terminatedBy: (c.terminated_by as 'seller' | 'hub' | null) ?? null,
      terminationEffectiveAt: c.termination_effective_at ?? null,
      autoRenew: c.auto_renew ?? false,
      autoRenewTerm: (c.auto_renew_term as number | 'until_sold' | null) ?? null,
      renewalCount: c.renewal_count ?? 0,
      currentUnitPriceCents: c.current_unit_price_cents ?? c.unit_value_cents ?? null,
      minimumAuthorizedPriceCents: c.minimum_authorized_price_cents ?? null,
      sellerPermissions: {
        mayDiscount: c.seller_permissions?.may_discount ?? true,
        mayBundle: c.seller_permissions?.may_bundle ?? true,
        mayAcceptOffers: c.seller_permissions?.may_accept_offers ?? true,
        maySellBelowMin: c.seller_permissions?.may_sell_below_min ?? false,
      },
      returnTerms: this.returnTerms(c),
    };
  },
};
