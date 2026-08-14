import {
  AD_CPM_CENTS,
  AD_DURATION_TIERS,
  AD_IMPRESSION_BATCH,
  AD_MAX_SHARE_OF_FEED,
  AD_PLACEMENTS,
  AD_PROMO_DISCLOSURE,
  FEATURED_HUB_BOOST,
  FEATURED_LABEL,
  FEATURED_MAX_SLOTS_PER_CITY,
  FEATURED_PRODUCT_BOOST,
  type AdPlacement,
} from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { stripe } from '../../integrations/stripe';
import { writeAudit } from '../../shared/audit';
import { distanceMeters } from '../../shared/geo';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { vendorsService } from '../vendors/vendors.service';
import { PlacementModel } from './ads.model';

/**
 * Resolve what a purchase costs and how long it runs. Either a flat tier (spec §32) or a raw CPM
 * budget — never both, because two prices on one purchase is how a customer ends up charged the one
 * they did not read.
 */
function resolvePurchase(input: { tierDays?: number; budgetCents?: number; endsAt?: string }): {
  budgetCents: number;
  endsAt: Date | null;
  tierDays: number | null;
} {
  if (input.tierDays != null) {
    const tier = AD_DURATION_TIERS.find((t) => t.days === input.tierDays);
    if (!tier) throw ValidationError('Unknown promotion length');
    return {
      budgetCents: tier.priceCents,
      endsAt: new Date(Date.now() + tier.days * 86_400_000),
      tierDays: tier.days,
    };
  }
  if (input.budgetCents == null || input.budgetCents <= 0) {
    throw ValidationError('Choose a promotion length or set a budget');
  }
  return {
    budgetCents: input.budgetCents,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    tierDays: null,
  };
}

export interface ServedAd {
  placementId: string;
  headline: string;
  body: string | null;
  imageUrl: string | null;
  clickUrl: string | null;
  /** Always present, always shown. Non-negotiable — see the module comment. */
  label: string;
}

/**
 * ═══ F-1 / F-3 — PAID PLACEMENT ═══
 *
 * The rule that governs this whole module: **paid placement is disclosed and additive.** It boosts
 * something's rank within results it already qualifies for, and it never exceeds
 * `AD_MAX_SHARE_OF_FEED` of a feed. It cannot remove, demote or outrank organic results into
 * invisibility.
 *
 * That is a commercial decision as much as an ethical one. Discovery that can be bought outright
 * stops being a signal, sellers stop trusting the feed, and the placement inventory becomes
 * worthless precisely because it worked too well.
 */
export const adsService = {
  /**
   * The price list, served rather than hardcoded in the client — a promotion whose price differs
   * between the screen and the charge is the one bug this product cannot afford.
   */
  pricing() {
    return {
      tiers: AD_DURATION_TIERS.map((t) => ({
        days: t.days,
        label: t.label,
        priceCents: t.priceCents,
        priceLabel: formatCents(t.priceCents),
      })),
      cpm: AD_PLACEMENTS.map((p) => ({
        placement: p,
        cpmCents: AD_CPM_CENTS[p],
        cpmLabel: `${formatCents(AD_CPM_CENTS[p])} per 1,000 views`,
      })),
      disclosure: AD_PROMO_DISCLOSURE,
      label: FEATURED_LABEL,
      maxShareOfFeed: AD_MAX_SHARE_OF_FEED,
    };
  },

  /**
   * Open the charge for a placement. Money first, delivery second.
   *
   * The placement row already exists in `pending_payment`; this attaches an intent and hands back a
   * client secret. `activateByPaymentIntent` is what actually turns delivery on, so an abandoned
   * checkout leaves an unpaid row that never serves rather than free inventory.
   */
  async openCharge(placementId: string, amountCents: number, principal: Principal) {
    const charge = await stripe().createPlatformCharge({
      amountCents,
      currency: env.PLATFORM_CURRENCY,
      transferGroup: `placement_${placementId}`,
      metadata: { kind: 'placement', placementId },
      idempotencyKey: `placement_${placementId}`,
      ...(principal.email ? { receiptEmail: principal.email } : {}),
    });
    await PlacementModel.updateOne(
      { _id: placementId },
      { $set: { payment_intent_ref: charge.paymentIntentId } },
    ).exec();
    return charge;
  },

  /**
   * The charge settled — the money exists, so the placement may start delivering. Idempotent: a
   * redelivered webhook finds it already active and does nothing.
   *
   * The window starts NOW rather than at creation. A buyer who takes ten minutes to finish checkout
   * must not lose ten minutes of the day they paid for.
   */
  async activateByPaymentIntent(paymentIntentId: string): Promise<{ handled: boolean }> {
    const doc = await PlacementModel.findOne({ payment_intent_ref: paymentIntentId }).lean().exec();
    if (!doc) return { handled: false }; // not a placement charge — let other handlers try
    if (doc.status !== 'pending_payment') return { handled: true };

    const now = new Date();
    const endsAt = doc.tier_days ? new Date(now.getTime() + doc.tier_days * 86_400_000) : doc.ends_at;
    const activated = await PlacementModel.findOneAndUpdate(
      { _id: doc._id, status: 'pending_payment' },
      { $set: { status: 'active', paid_at: now, starts_at: now, ends_at: endsAt ?? null } },
      { new: true },
    ).exec();
    if (!activated) return { handled: true }; // lost the race to a duplicate webhook

    await writeAudit({
      actorId: doc.owner_id,
      action: 'placement.activated',
      entityType: 'placement',
      entityId: String(doc._id),
      metadata: { paymentIntentId, budgetCents: doc.budget_cents, tierDays: doc.tier_days ?? null },
    });
    await publish('placement.activated', { placementId: String(doc._id) });
    return { handled: true };
  },

  // ─── F-1: featured products & hubs ────────────────────────────────────────────────────────
  /**
   * Buy featured placement for a product or hub the caller owns.
   *
   * Slots are scarce per city (`FEATURED_MAX_SLOTS_PER_CITY`) — not an artificial constraint but
   * the thing that makes the product worth buying. Unlimited featured slots is just a tax where
   * everyone pays and nobody rises.
   */
  async feature(
    principal: Principal,
    input: {
      kind: 'featured_product' | 'featured_hub';
      subjectId: string;
      citySlug?: string;
      /** Flat tier (spec §32) — 1, 7 or 30 days. Mutually exclusive with `budgetCents`. */
      tierDays?: number;
      budgetCents?: number;
      endsAt?: string;
    },
  ) {
    await this.assertOwnsSubject(principal, input.kind, input.subjectId);
    const purchase = resolvePurchase(input);

    if (input.citySlug) {
      // Unpaid rows are counted too: a slot held by a checkout in flight is not available to sell
      // twice, and the sweep releases it if the payment never lands.
      const taken = await PlacementModel.countDocuments({
        kind: input.kind,
        city_slug: input.citySlug,
        status: { $in: ['active', 'pending_payment'] },
      }).exec();
      if (taken >= FEATURED_MAX_SLOTS_PER_CITY) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          `All ${FEATURED_MAX_SLOTS_PER_CITY} featured slots in ${input.citySlug} are taken right now. Slots free up as campaigns end.`,
        );
      }
    }

    const doc = await PlacementModel.create({
      /**
       * Featured placement is always owned by the PERSON who bought it, even when the subject is a
       * hub. `assertOwnsSubject` above has already established they control it, and keying the row
       * to the buyer means one consistent "my placements" read rather than a user/business split
       * that would leave a hub owner's featured hub invisible on their own dashboard.
       */
      owner_type: 'user',
      owner_id: principal.userId,
      kind: input.kind,
      subject_id: input.subjectId,
      city_slug: input.citySlug ?? null,
      budget_cents: purchase.budgetCents,
      cpm_cents: 0, // featured placement is flat-rate, not impression-billed
      tier_days: purchase.tierDays,
      ends_at: purchase.endsAt,
    });

    const charge = await this.openCharge(String(doc._id), purchase.budgetCents, principal);
    await writeAudit({
      actorId: principal.userId,
      action: 'placement.created',
      entityType: 'placement',
      entityId: String(doc._id),
      metadata: { kind: input.kind, subjectId: input.subjectId, tierDays: purchase.tierDays },
    });
    return {
      ...this.view({ ...doc.toObject(), payment_intent_ref: charge.paymentIntentId }),
      clientSecret: charge.clientSecret,
    };
  },

  /**
   * The boost map consumed by ranking code: subject id → additive score.
   *
   * Returned as a map rather than applied here so the ranking engines stay the single place a score
   * is computed — a boost applied in two places is a boost that eventually gets applied twice.
   */
  async featuredBoosts(kind: 'featured_product' | 'featured_hub'): Promise<Map<string, number>> {
    const now = new Date();
    const rows = await PlacementModel.find(
      {
        kind,
        status: 'active',
        starts_at: { $lte: now },
        $or: [{ ends_at: null }, { ends_at: { $gte: now } }],
      },
      { subject_id: 1 },
    )
      .lean()
      .exec();

    const boost = kind === 'featured_hub' ? FEATURED_HUB_BOOST : FEATURED_PRODUCT_BOOST;
    return new Map(
      rows
        .filter((r) => typeof r.subject_id === 'string')
        .map((r) => [String(r.subject_id), boost]),
    );
  },

  // ─── F-3: ad inventory ────────────────────────────────────────────────────────────────────
  /** Create a CPM campaign. Budget is prepaid and spent down. */
  async createCampaign(
    principal: Principal,
    input: {
      placement: AdPlacement;
      headline: string;
      body?: string;
      imageUrl?: string;
      clickUrl?: string;
      /** Flat tier (spec §32) — 1, 7 or 30 days. Mutually exclusive with `budgetCents`. */
      tierDays?: number;
      budgetCents?: number;
      citySlug?: string;
      categories?: string[];
      lng?: number;
      lat?: number;
      radiusM?: number;
      businessId?: string;
      endsAt?: string;
    },
  ) {
    let ownerType: 'user' | 'business' = 'user';
    let ownerId = principal.userId;
    if (input.businessId) {
      const owner = await vendorsService.getBusinessOwner(input.businessId);
      if (!owner) throw NotFoundError('Business not found');
      if (owner !== principal.userId) {
        throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
      }
      ownerType = 'business';
      ownerId = input.businessId;
    }

    /**
     * An ad with nowhere to go cannot be worth buying.
     *
     * `serve()` falls back to `/business/<id>` when `click_url` is absent — but ONLY for a
     * business-owned placement. A user-owned ad with no link resolves to `clickUrl: null`, and
     * AdSlot deliberately renders a non-interactive card for that. So a promoter without a business
     * who left the (optional) link blank paid in full, had impressions served, and shipped an advert
     * nobody could click: a structurally zero click-through that nothing surfaced until they read
     * their own analytics.
     *
     * Refused here rather than only in the form, because the form is not the only way in and this
     * one costs the buyer real money.
     */
    if (ownerType === 'user' && !input.clickUrl) {
      throw ValidationError(
        'Add a link for this promotion. Without a business profile to send people to, an ad with no link cannot be clicked.',
      );
    }

    const purchase = resolvePurchase(input);

    const doc = await PlacementModel.create({
      owner_type: ownerType,
      owner_id: ownerId,
      kind: 'ad',
      placement: input.placement,
      headline: input.headline,
      body: input.body ?? null,
      image_url: input.imageUrl ?? null,
      click_url: input.clickUrl ?? null,
      budget_cents: purchase.budgetCents,
      cpm_cents: AD_CPM_CENTS[input.placement],
      tier_days: purchase.tierDays,
      city_slug: input.citySlug ?? null,
      categories: input.categories ?? [],
      ...(input.lng !== undefined && input.lat !== undefined
        ? { location: { type: 'Point', coordinates: [input.lng, input.lat] }, radius_m: input.radiusM ?? 20_000 }
        : {}),
      ends_at: purchase.endsAt,
    });

    const charge = await this.openCharge(String(doc._id), purchase.budgetCents, principal);
    await writeAudit({
      actorId: principal.userId,
      action: 'campaign.created',
      entityType: 'placement',
      entityId: String(doc._id),
      metadata: { placement: input.placement, budgetCents: purchase.budgetCents },
    });
    return {
      ...this.view({ ...doc.toObject(), payment_intent_ref: charge.paymentIntentId }),
      clientSecret: charge.clientSecret,
    };
  },

  /**
   * Serve ads for a surface.
   *
   * `feedSize` caps how many can be returned — an ad never occupies more than
   * `AD_MAX_SHARE_OF_FEED` of what the user is looking at, regardless of how many advertisers want
   * the slot.
   */
  async serve(input: {
    placement: AdPlacement;
    citySlug?: string;
    category?: string;
    lng?: number;
    lat?: number;
    feedSize?: number;
  }): Promise<ServedAd[]> {
    const maxAds = Math.max(1, Math.floor((input.feedSize ?? 10) * AD_MAX_SHARE_OF_FEED));
    const now = new Date();

    const rows = await PlacementModel.find({
      kind: 'ad',
      placement: input.placement,
      status: 'active',
      starts_at: { $lte: now },
      $or: [{ ends_at: null }, { ends_at: { $gte: now } }],
      // Budget exhaustion is enforced in the query, not just by the sweep — an over-delivered
      // campaign is money we cannot bill for.
      $expr: { $lt: ['$spent_cents', '$budget_cents'] },
      ...(input.citySlug ? { $and: [{ $or: [{ city_slug: null }, { city_slug: input.citySlug }] }] } : {}),
    })
      .limit(50)
      .lean()
      .exec();

    const eligible = rows.filter((r) => {
      if (input.category && r.categories.length > 0 && !r.categories.includes(input.category)) {
        return false;
      }
      const coords = r.location?.coordinates as [number, number] | undefined;
      if (coords?.length === 2 && r.radius_m && input.lng !== undefined && input.lat !== undefined) {
        return distanceMeters([input.lng, input.lat], coords) <= r.radius_m;
      }
      return true;
    });

    // Highest CPM first — the honest auction. Ties break on remaining budget.
    const chosen = eligible
      .sort((a, b) => b.cpm_cents - a.cpm_cents || (b.budget_cents - b.spent_cents) - (a.budget_cents - a.spent_cents))
      .slice(0, maxAds);

    // Impressions are counted here and billed in batches (see `settleImpressions`).
    if (chosen.length > 0) {
      await PlacementModel.updateMany(
        { _id: { $in: chosen.map((c) => c._id) } },
        { $inc: { impressions: 1, unbilled_impressions: 1 } },
      ).exec();
    }

    return chosen.map((r) => ({
      placementId: String(r._id),
      headline: r.headline ?? '',
      body: r.body ?? null,
      imageUrl: r.image_url ?? null,
      /**
       * Fall back to the advertiser's own profile when no destination was given.
       *
       * The purchase flow does not ask for a link, so every business-bought ad arrived with
       * `click_url: null` — and `AdSlot` renders a non-interactive card when there is nowhere to
       * go. The result was a vendor paying for a promotion that could not be tapped, which is the
       * worst thing an ad product can sell.
       *
       * Their own profile is what they meant: the ad says "Fresh Birria, corner of 9th" and the
       * only sensible destination is the truck selling it. A user-owned campaign has no profile to
       * fall back to, so it stays null and renders as a plain card rather than linking somewhere
       * arbitrary.
       */
      clickUrl: r.click_url ?? (r.owner_type === 'business' ? `/business/${r.owner_id}` : null),
      /** Always disclosed. There is no configuration that turns this off. */
      label: FEATURED_LABEL,
    }));
  },

  async recordClick(placementId: string) {
    await PlacementModel.updateOne({ _id: placementId }, { $inc: { clicks: 1 } }).exec();
    return { placementId, recorded: true };
  },

  /**
   * Bill accumulated impressions and retire exhausted campaigns.
   *
   * Batched because a feed render must not be a write per ad — at map-scroll frequency that would
   * be the highest-write path in the system, for the least important data in it.
   */
  async settleImpressions(): Promise<{
    billed: number;
    exhausted: number;
    ended: number;
    abandoned: number;
  }> {
    const now = new Date();

    /**
     * Close campaigns whose window has passed. A flat tier is a promise about TIME as much as
     * volume (spec §32), so it has to stop on the day it said it would — even with budget left.
     */
    const endedRes = await PlacementModel.updateMany(
      { status: 'active', ends_at: { $ne: null, $lte: now } },
      { $set: { status: 'ended' } },
    ).exec();

    /**
     * Release slots held by a checkout that was never completed. Without this an abandoned purchase
     * would hold a scarce city slot forever — the buyer never paid, and nobody else could buy it.
     */
    const abandonedRes = await PlacementModel.updateMany(
      { status: 'pending_payment', created_at: { $lte: new Date(now.getTime() - 3_600_000) } },
      { $set: { status: 'ended' } },
    ).exec();

    const pending = await PlacementModel.find({
      kind: 'ad',
      unbilled_impressions: { $gte: AD_IMPRESSION_BATCH },
    })
      .limit(200)
      .exec();

    let billed = 0;
    let exhausted = 0;
    for (const p of pending) {
      const cost = Math.round((p.unbilled_impressions / 1000) * p.cpm_cents);
      const spent = Math.min(p.budget_cents, p.spent_cents + cost);
      const isExhausted = spent >= p.budget_cents;

      await PlacementModel.updateOne(
        { _id: p._id },
        {
          $set: {
            spent_cents: spent,
            unbilled_impressions: 0,
            ...(isExhausted ? { status: 'exhausted' } : {}),
          },
        },
      ).exec();
      billed += 1;
      if (isExhausted) {
        exhausted += 1;
        await publish('campaign.exhausted', {
          placementId: String(p._id),
          spentCents: spent,
        });
      }
    }
    const ended = endedRes.modifiedCount ?? 0;
    const abandoned = abandonedRes.modifiedCount ?? 0;
    if (billed > 0 || ended > 0 || abandoned > 0) {
      logger.info({ billed, exhausted, ended, abandoned }, 'ad impression settlement');
    }
    return { billed, exhausted, ended, abandoned };
  },

  /** The advertiser's own campaigns, with real delivery numbers — replaces manual reporting. */
  async mine(principal: Principal, businessId?: string) {
    const rows = await PlacementModel.find({
      owner_id: businessId ?? principal.userId,
    })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    return rows.map((r) => this.view(r));
  },

  /**
   * Activate placements whose charge settled but whose webhook never arrived.
   *
   * ## Why this exists
   *
   * `activateByPaymentIntent` is driven by `payment_intent.succeeded`, and a webhook is a delivery
   * PROMISE, not a guarantee: the forwarder is down in local dev, the endpoint 500s, Stripe retries
   * lapse. When one is missed the money is taken and the placement sits at `pending_payment` for
   * ever — the buyer has paid and has nothing running, and no amount of retrying on their side
   * fixes it because from their point of view they already paid.
   *
   * That was not hypothetical: two real placements were charged ($15 and $5) and stayed pending.
   *
   * **Stripe is authoritative.** This asks Stripe what actually happened rather than trusting our
   * own row, and it only ever moves a placement forward when Stripe says the money is there.
   * Idempotent by construction — it reuses `activateByPaymentIntent`, which no-ops on anything that
   * is not still `pending_payment`.
   */
  async reconcilePendingPayments(limit = 50): Promise<{ checked: number; activated: number }> {
    const pending = await PlacementModel.find({
      status: 'pending_payment',
      payment_intent_ref: { $ne: null },
    })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let activated = 0;
    for (const doc of pending) {
      const pi = String(doc.payment_intent_ref);
      try {
        const intent = await stripe().retrievePaymentIntent(pi);
        if (intent.status !== 'succeeded') continue;

        const res = await this.activateByPaymentIntent(pi);
        if (res.handled) {
          activated++;
          logger.warn(
            { placementId: String(doc._id), paymentIntentId: pi },
            'activated a paid placement whose webhook never arrived — check webhook delivery',
          );
        }
      } catch (err) {
        // One unreadable intent must not stop the others from being rescued.
        logger.error({ err, placementId: String(doc._id) }, 'could not reconcile placement payment');
      }
    }

    return { checked: pending.length, activated };
  },

  /**
   * Hand back the client secret for a placement that was created but never paid for.
   *
   * Without this a buyer who closed the tab mid-checkout is stranded permanently: the secret is
   * only returned at creation, so their placement sits at `pending_payment` for ever — holding a
   * city slot it will never use — and the only way out is for someone to delete the row.
   *
   * Safe to call repeatedly. `openCharge` passes `placement_<id>` as the Stripe idempotency key, so
   * Stripe returns the SAME PaymentIntent rather than opening a second one; a buyer cannot end up
   * with two charges for one promotion by refreshing.
   */
  async resumePayment(principal: Principal, placementId: string) {
    const doc = await this.assertOwnsPlacement(principal, placementId);

    if (doc.status !== 'pending_payment') {
      // Already paid, cancelled or expired — re-opening a charge for it would take money for
      // something that is not waiting on money.
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This promotion is not waiting for payment.',
      );
    }

    const charge = await this.openCharge(placementId, doc.budget_cents, principal);
    return {
      ...this.view({ ...doc, payment_intent_ref: charge.paymentIntentId }),
      clientSecret: charge.clientSecret,
    };
  },

  /** Shared ownership check: a user-owned row against the caller, a business-owned one via its owner. */
  async assertOwnsPlacement(principal: Principal, placementId: string) {
    const doc = await PlacementModel.findById(placementId).lean().exec();
    if (!doc) throw NotFoundError('Placement not found');
    if (doc.owner_type === 'user' && doc.owner_id !== principal.userId) {
      throw ForbiddenError('Not your placement', ERROR_CODES.NOT_OWNER);
    }
    if (doc.owner_type === 'business') {
      const owner = await vendorsService.getBusinessOwner(doc.owner_id);
      if (owner !== principal.userId) {
        throw ForbiddenError('Not your placement', ERROR_CODES.NOT_OWNER);
      }
    }
    return doc;
  },

  async pause(principal: Principal, placementId: string, paused: boolean) {
    const doc = await PlacementModel.findById(placementId).lean().exec();
    if (!doc) throw NotFoundError('Placement not found');
    // A business-owned placement is checked against its owner, a user-owned one against the caller.
    if (doc.owner_type === 'user' && doc.owner_id !== principal.userId) {
      throw ForbiddenError('Not your placement', ERROR_CODES.NOT_OWNER);
    }
    if (doc.owner_type === 'business') {
      const owner = await vendorsService.getBusinessOwner(doc.owner_id);
      if (owner !== principal.userId) {
        throw ForbiddenError('Not your placement', ERROR_CODES.NOT_OWNER);
      }
    }
    const updated = await PlacementModel.findByIdAndUpdate(
      placementId,
      { $set: { status: paused ? 'paused' : 'active' } },
      { new: true },
    ).exec();
    return this.view(updated!.toObject());
  },

  /** Ownership check for a featured subject — you may only promote what you control. */
  async assertOwnsSubject(
    principal: Principal,
    kind: 'featured_product' | 'featured_hub',
    subjectId: string,
  ) {
    const { consignmentRepository } = await import('../consignment/consignment.repository');
    if (kind === 'featured_hub') {
      const hub = await consignmentRepository.findHubById(subjectId);
      if (!hub) throw NotFoundError('Hub not found');
      if (hub.owner_user_id !== principal.userId) {
        throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
      }
      return;
    }
    const product = await consignmentRepository.findProductById(subjectId);
    if (!product) throw NotFoundError('Product not found');
    const hub = await consignmentRepository.findHubById(product.hub_id);
    if (!hub || hub.owner_user_id !== principal.userId) {
      throw ForbiddenError('You do not own this product', ERROR_CODES.NOT_OWNER);
    }
  },

  view(p: {
    _id: unknown;
    kind: string;
    subject_id?: string | null;
    placement?: string | null;
    headline?: string | null;
    budget_cents: number;
    spent_cents: number;
    cpm_cents: number;
    impressions: number;
    clicks: number;
    status: string;
    city_slug?: string | null;
    starts_at: Date;
    ends_at?: Date | null;
    tier_days?: number | null;
    payment_intent_ref?: string | null;
  }) {
    const tier = p.tier_days ? AD_DURATION_TIERS.find((t) => t.days === p.tier_days) : undefined;
    return {
      id: String(p._id),
      kind: p.kind,
      subjectId: p.subject_id ?? null,
      placement: p.placement ?? null,
      headline: p.headline ?? null,
      budgetCents: p.budget_cents,
      spentCents: p.spent_cents,
      remainingCents: Math.max(0, p.budget_cents - p.spent_cents),
      cpmCents: p.cpm_cents,
      impressions: p.impressions,
      clicks: p.clicks,
      /** Reported, not inferred by the client — one definition of CTR across every surface. */
      clickThroughRate:
        p.impressions > 0 ? Number((p.clicks / p.impressions).toFixed(4)) : 0,
      status: p.status,
      citySlug: p.city_slug ?? null,
      startsAt: p.starts_at,
      endsAt: p.ends_at ?? null,
      tierDays: p.tier_days ?? null,
      tierLabel: tier?.label ?? null,
      /** True until the charge settles — the dashboard must not present an unpaid row as running. */
      awaitingPayment: p.status === 'pending_payment',
      label: FEATURED_LABEL,
      spendLabel: `${formatCents(p.spent_cents)} of ${formatCents(p.budget_cents)}`,
      /**
       * What the buyer actually gets, in their words rather than ours. A flat tier bought time; a
       * CPM campaign bought volume. Saying "$4.20 of $15.00" to someone who bought "one week" is a
       * true sentence that answers a question they did not ask.
       */
      deliveryLabel: tier
        ? `${tier.label} — ${formatCents(p.budget_cents)}`
        : `${formatCents(p.spent_cents)} of ${formatCents(p.budget_cents)} spent`,
    };
  },
};
