import { randomUUID } from 'node:crypto';

import {
  DEFAULT_SPONSOR_PROGRAM,
  GIVEAWAY_SPONSOR_TIERS,
  SPONSOR_PROGRAMS,
  SPONSOR_TERM_MONTHS,
  SPONSOR_TIERS,
  type SponsorProgram,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { formatCents } from '../../shared/money';
import { notificationsService } from '../notifications/notifications.service';
import { stripe } from '../../integrations/stripe';
import { notifyOps } from '../../integrations/messaging';
import { paymentsService } from '../payments/payments.service';
import { agreementsService } from '../agreements/agreements.service';
import { isAgreementReviewed } from '../agreements/agreements.registry';
import { sponsorFulfillmentService } from '../sponsorFulfillment/sponsorFulfillment.service';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { PreregistrationModel, SponsorModel } from './sponsors.model';

/** A UTM code a human can read in a link, unique enough not to collide. */
function utmCodeFor(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'sponsor'}-${randomUUID().slice(0, 6)}`;
}

/**
 * Slug for the public profile URL. Collisions get a short suffix so renames are safe and the
 * failure mode is a longer slug, not a 500. The sparse unique index on `slug` is the real
 * backstop — this just makes the collision rare.
 */
function slugFor(name: string, suffix?: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!base) return `sponsor-${randomUUID().slice(0, 8)}`;
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * Tiers whose rate card includes "featured sponsor profile". A Silver sponsor can set profile
 * fields but their profile page is not public, because they didn't buy that benefit.
 */
const PROFILE_ENABLED_TIERS: Record<string, Set<string>> = {
  platform: new Set(['launch', 'founding']),
  ice_cream_giveaway: new Set(['gold', 'platinum', 'diamond']),
};
function tierHasPublicProfile(program: string, tier: string): boolean {
  return PROFILE_ENABLED_TIERS[program]?.has(tier) ?? false;
}

function resolveProgram(input: string | null | undefined): SponsorProgram {
  if (!input) return DEFAULT_SPONSOR_PROGRAM;
  return (SPONSOR_PROGRAMS as readonly string[]).includes(input)
    ? (input as SponsorProgram)
    : DEFAULT_SPONSOR_PROGRAM;
}

export const sponsorsService = {
  /**
   * The public rate card. Prices live in code so a fee-schedule edit cannot move them.
   *
   * Returns a program-shaped payload: `priceMode` is `monthly` for the long-running platform
   * sponsorships (price = `monthlyCents` × months) and `one_time` for the Ice Cream Giveaway
   * campaign (price = `priceCents`, term fixed at 3 months). The checkout UI branches on this
   * one field — no second mental model needed per program.
   */
  listTiers(programInput?: string | null) {
    const program = resolveProgram(programInput);
    if (program === 'ice_cream_giveaway') {
      /**
       * The CHECKOUT rate card: self-serve tiers only. Diamond is advertised on the landing page
       * as a Contact-us tier, so hiding it here is what makes the contact flow authoritative —
       * if a client renders the giveaway checkout from this response alone, it cannot accidentally
       * show a Buy button for Diamond. The landing page reads tier content from a separate
       * display catalogue (`giveawayProgram` on the frontend).
       */
      return {
        program,
        priceMode: 'one_time' as const,
        tiers: GIVEAWAY_SPONSOR_TIERS.filter((t) => t.selfServe).map((t) => ({ ...t })),
        /** Term is fixed to 90 days for this program; the checkout hides the term chip. */
        termMonths: [GIVEAWAY_SPONSOR_TIERS[0].termMonths],
      };
    }
    return {
      program,
      priceMode: 'monthly' as const,
      tiers: SPONSOR_TIERS.map((t) => ({ ...t })),
      termMonths: [...SPONSOR_TERM_MONTHS],
    };
  },

  /**
   * BUY A PLACEMENT. Opens a charge; publishes nothing.
   *
   * The sponsor is recorded `pending_payment` with `active: false`, so a logo cannot reach the
   * landing page and the UTM code cannot attribute a signup until the money has actually arrived —
   * and then not even then, because a person still has to look at the image.
   *
   * The price is re-derived from the tier table. A client that could name its own price could
   * sponsor the platform for a cent.
   */
  async purchase(
    principal: Principal,
    dto: {
      name: string;
      tier: string;
      termMonths: number;
      logoUrl?: string;
      contactEmail: string;
      launchCitySlug?: string;
      program?: string;
    },
    idempotencyKey: string,
  ) {
    const program = resolveProgram(dto.program);

    /**
     * ═══ §60 LAUNCH GATE. ═══
     *
     * No real sponsor pays under unreviewed terms, period. RTO uses the same gate; copying its
     * mechanism rather than inventing one keeps the "has counsel signed off" question a single
     * answer per agreement type. In production this fails outright; in test, `setAgreementReviewedForTest`
     * lets flows be exercised without pretending the gate is off.
     */
    if (!isAgreementReviewed('sponsorship')) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Sponsorship purchases are temporarily unavailable while the agreement is being finalised. Please check back shortly.',
      );
    }

    /**
     * ═══ Agreement gate. ═══
     *
     * The sponsorship agreement is accepted BEFORE the card is charged. Our own landing-page
     * disclaimer says terms are "documented before any payment is accepted"; taking a card first
     * and surfacing the terms later would be a copy-vs-flow mismatch worth money. Enforced
     * server-side rather than in the UI: a client that skipped the step would otherwise reach
     * `chargeToPlatform` with no acceptance on record.
     */
    await agreementsService.assertAccepted(principal.userId, 'sponsorship');

    /**
     * Pricing branches on program. For `platform`, price = monthlyCents × months and the term is
     * a chosen value from SPONSOR_TERM_MONTHS. For `ice_cream_giveaway`, price is the one-time
     * `priceCents` and the term is fixed to the tier's own `termMonths` — any client-supplied
     * `termMonths` for a giveaway tier is ignored, so a sponsor cannot pay for Silver and claim
     * a 12-month campaign.
     */
    let tierSlug: string;
    let amountCents: number;
    let termMonths: number;

    if (program === 'ice_cream_giveaway') {
      const tier = GIVEAWAY_SPONSOR_TIERS.find((t) => t.slug === dto.tier);
      if (!tier) throw NotFoundError('No such sponsorship tier');
      /**
       * Diamond is not self-serve. The rate card hides it from checkout; this is the server-side
       * backstop that stops a client posting `tier: "diamond"` anyway. Hand-recorded Diamond
       * deals go through the existing admin create endpoint, which has no selfServe guard.
       */
      if (!tier.selfServe) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'This tier is only available through a direct conversation — please contact us to arrange it.',
        );
      }
      tierSlug = tier.slug;
      amountCents = tier.priceCents;
      termMonths = tier.termMonths;
    } else {
      const tier = SPONSOR_TIERS.find((t) => t.slug === dto.tier);
      if (!tier) throw NotFoundError('No such sponsorship tier');
      if (!(SPONSOR_TERM_MONTHS as readonly number[]).includes(dto.termMonths)) {
        throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Choose one of the available terms');
      }
      tierSlug = tier.slug;
      amountCents = tier.monthlyCents * dto.termMonths;
      termMonths = dto.termMonths;
    }

    const utmCode = utmCodeFor(dto.name);
    /**
     * Slug uses the UTM suffix as its collision-breaker. Both are generated from the name but the
     * UTM already carries a random suffix, so reusing the last 6 chars of it both guarantees
     * uniqueness and keeps the slug deterministic from a single randomness source.
     */
    const slug = slugFor(dto.name, utmCode.slice(-6));

    const sponsor = await SponsorModel.create({
      name: dto.name,
      utm_code: utmCode,
      slug,
      logo_url: dto.logoUrl ?? null,
      tier: tierSlug,
      program,
      launch_city_slug: dto.launchCitySlug ?? null,
      status: 'pending_payment',
      /** Not live — and not live on payment either. See the model. */
      active: false,
      owner_user_id: principal.userId,
      contact_email: dto.contactEmail,
      term_months: termMonths,
    });
    const sponsorId = String(sponsor._id);

    /**
     * Custodial: the platform is the merchant, because a sponsorship is bought FROM the platform
     * rather than from any vendor. Same rail as Pay It Forward and Boost contributions.
     */
    const charge = await paymentsService.chargeToPlatform({
      amountCents,
      transferGroup: `sponsor_${sponsorId}`,
      metadata: { kind: 'sponsorship', sponsorId, tier: tierSlug, program },
      idempotencyKey: `sponsor_${idempotencyKey}`,
      ...(dto.contactEmail ? { receiptEmail: dto.contactEmail } : {}),
    });
    await SponsorModel.updateOne(
      { _id: sponsorId },
      { $set: { pending_intent_ref: charge.paymentIntentId } },
    ).exec();

    return {
      id: sponsorId,
      name: sponsor.name,
      program,
      tier: tierSlug,
      termMonths,
      amountCents,
      clientSecret: charge.clientSecret,
      /** Said plainly, so the client never renders "you are live". */
      status: 'pending_payment' as const,
    };
  },

  /**
   * The money arrived. Moves to `pending_review` — NOT live.
   *
   * Driven by `payment_intent.succeeded`. Clearing the pending ref is the claim, so a duplicate
   * webhook delivery does nothing.
   */
  async activateByPaymentIntent(paymentIntentId: string): Promise<{ handled: boolean }> {
    const found = await SponsorModel.findOne({ pending_intent_ref: paymentIntentId }).lean().exec();
    if (!found) return { handled: false }; // not ours — let the next handler try

    const sponsorId = String(found._id);
    /**
     * Re-derive what was actually owed from the tier table — same guard as `purchase`. Branches
     * on program because platform is monthly × term, giveaway is a one-time package price.
     */
    const sponsorProgram = resolveProgram(found.program);
    const paidCents =
      sponsorProgram === 'ice_cream_giveaway'
        ? (GIVEAWAY_SPONSOR_TIERS.find((t) => t.slug === found.tier)?.priceCents ?? 0)
        : (found.term_months ?? 1) *
          (SPONSOR_TIERS.find((t) => t.slug === found.tier)?.monthlyCents ?? 0);

    const claimed = await SponsorModel.findOneAndUpdate(
      { _id: sponsorId, pending_intent_ref: paymentIntentId },
      {
        $set: {
          pending_intent_ref: null,
          /** Kept so a refusal has something to refund — the pending ref is cleared as the claim. */
          paid_intent_ref: paymentIntentId,
          status: 'pending_review',
          paid_cents: paidCents,
        },
      },
      { new: true },
    ).exec();
    if (!claimed) return { handled: true }; // a concurrent delivery won the race

    if (found.owner_user_id) {
      notificationsService.notify(found.owner_user_id, {
        category: 'system',
        title: 'Sponsorship payment received',
        body: `Thanks — we have your ${formatCents(paidCents)} sponsorship. We check every logo by hand before it goes live, so it will appear shortly.`,
        data: { sponsorId },
      });
    }
    await writeAudit({
      action: 'sponsor.paid',
      entityType: 'sponsor',
      entityId: sponsorId,
      metadata: { paymentIntentId, paidCents },
    });
    /**
     * Tell the operator, because at this point a paid sponsorship is blocked on a person. The
     * sponsor has been promised their logo is checked by hand and refunded if refused; that
     * promise is only as good as somebody knowing there is something to check. Best-effort and
     * deliberately after the audit write — a mail failure must not undo a recorded payment.
     */
    void notifyOps(
      `Sponsorship paid — logo awaiting review (${claimed.name})`,
      [
        `${claimed.name} has paid ${formatCents(paidCents)} for a ${claimed.term_months ?? 1}-month ${claimed.tier} placement.`,
        claimed.logo_url ? `Logo: ${claimed.logo_url}` : 'No logo supplied — this will run as a text lockup.',
        claimed.contact_email ? `Contact: ${claimed.contact_email}` : '',
        '',
        'It is NOT live. Approve or reject it in the admin sponsors screen; a rejection refunds in full.',
      ]
        .filter(Boolean)
        .join('\n'),
      `sponsor_paid_${sponsorId}`,
    );
    return { handled: true };
  },

  /** The payment failed — say so, rather than leaving a placement pending for ever. */
  async failByPaymentIntent(paymentIntentId: string, reason: string): Promise<{ handled: boolean }> {
    const sponsor = await SponsorModel.findOneAndUpdate(
      { pending_intent_ref: paymentIntentId },
      { $set: { pending_intent_ref: null, status: 'rejected', rejected_reason: reason } },
      { new: true },
    ).exec();
    if (!sponsor) return { handled: false };
    if (sponsor.owner_user_id) {
      notificationsService.notify(sponsor.owner_user_id, {
        category: 'system',
        title: 'Sponsorship payment did not go through',
        body: 'Your card was declined, so the sponsorship has not started. Nothing has been charged — you can try again.',
        data: { sponsorId: String(sponsor._id) },
      });
    }
    return { handled: true };
  },

  /**
   * A person has looked at the logo. THIS is what puts it on the landing page.
   *
   * The term starts now rather than at payment: a placement reviewed two days after purchase would
   * otherwise silently lose two days of the term the sponsor paid for.
   */
  async approve(admin: Principal, sponsorId: string) {
    const sponsor = await SponsorModel.findById(sponsorId).lean().exec();
    if (!sponsor) throw NotFoundError('Sponsor not found');
    if (sponsor.status !== 'pending_review') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        sponsor.status === 'pending_payment'
          ? 'This sponsorship has not been paid for yet'
          : `This sponsorship is ${sponsor.status}`,
      );
    }
    const now = new Date();
    const ends = new Date(now);
    ends.setMonth(ends.getMonth() + (sponsor.term_months ?? 1));

    await SponsorModel.updateOne(
      { _id: sponsorId },
      { $set: { status: 'active', active: true, starts_at: now, ends_at: ends } },
    ).exec();

    /**
     * Seed the fulfilment tracker. The committed counts for the tier (shout-outs, promotional
     * videos, postcards, spotlight videos) are what the sponsor paid for, so they are frozen on
     * approval rather than resolved from the tier table at report time: a later tier edit must
     * not change what an existing sponsor was promised. Idempotent — a repeat approval does not
     * reset counts a logger already pushed.
     */
    try {
      await sponsorFulfillmentService.seedForSponsor({
        sponsorId,
        tier: sponsor.tier,
        program: resolveProgram(sponsor.program),
        startedAt: now,
        endsAt: ends,
      });
    } catch (err) {
      logger.error(
        { err, sponsorId },
        'sponsor approved but fulfilment seed failed — seed it by hand',
      );
    }

    if (sponsor.owner_user_id) {
      notificationsService.notify(sponsor.owner_user_id, {
        category: 'system',
        title: 'Your sponsorship is live',
        body: `Your logo is on the StreetServe landing page until ${ends.toDateString()}. Anyone arriving through your link is attributed to you.`,
        data: { sponsorId, utmCode: sponsor.utm_code },
      });
    }
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'sponsor.approved',
      entityType: 'sponsor',
      entityId: sponsorId,
      metadata: { endsAt: ends },
    });
    return { id: sponsorId, active: true, startsAt: now, endsAt: ends, utmCode: sponsor.utm_code };
  },

  /**
   * Rejected — and refunded, in that order of importance.
   *
   * Turning down a logo while keeping the money would be indefensible, so the refund is attempted
   * here rather than left as an operational chore someone might forget. A refund failure does NOT
   * block the rejection: the logo must still not go live, and the money is then chased by hand
   * (logged loudly, so it is never silently dropped).
   */
  async reject(admin: Principal, sponsorId: string, reason: string) {
    const sponsor = await SponsorModel.findById(sponsorId).lean().exec();
    if (!sponsor) throw NotFoundError('Sponsor not found');
    if (!['pending_review', 'active'].includes(sponsor.status ?? '')) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `This sponsorship is ${sponsor.status}`,
      );
    }

    /**
     * Refunded against the INTENT, not a transaction row: a platform charge goes straight to the
     * platform balance and creates no Transaction, so the intent id is the only handle there is.
     * Same mechanism Pay It Forward uses to give a contribution back.
     */
    let refunded = false;
    if (sponsor.paid_intent_ref) {
      try {
        await stripe().createRefund({
          paymentIntentId: sponsor.paid_intent_ref,
          amountCents: sponsor.paid_cents ?? 0,
          idempotencyKey: `sponsor_refund_${sponsorId}`,
        });
        refunded = true;
      } catch (err) {
        logger.error(
          { err, sponsorId, paidIntentRef: sponsor.paid_intent_ref },
          'sponsorship rejected but the refund failed — refund this by hand',
        );
      }
    }

    await SponsorModel.updateOne(
      { _id: sponsorId },
      { $set: { status: 'rejected', active: false, rejected_reason: reason } },
    ).exec();

    if (sponsor.owner_user_id) {
      notificationsService.notify(sponsor.owner_user_id, {
        category: 'system',
        title: 'Sponsorship not approved',
        body: refunded
          ? `We could not run this placement: ${reason}. Your payment has been refunded in full.`
          : `We could not run this placement: ${reason}. We are processing your refund — it may take a few days.`,
        data: { sponsorId },
      });
    }
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'sponsor.rejected',
      entityType: 'sponsor',
      entityId: sponsorId,
      reason,
      metadata: { refunded },
    });
    return { id: sponsorId, active: false, refunded };
  },

  /**
   * End the terms that have run out. Without this a paid placement stays on the landing page for
   * ever and keeps attributing signups — the same defect `active` had when nothing could set it.
   */
  async expireFinishedSponsorships(): Promise<number> {
    const due = await SponsorModel.find({ status: 'active', ends_at: { $lte: new Date() } })
      .limit(200)
      .lean()
      .exec();
    let expired = 0;
    for (const s of due) {
      const done = await SponsorModel.findOneAndUpdate(
        { _id: s._id, status: 'active' },
        { $set: { status: 'expired', active: false } },
      ).exec();
      if (!done) continue;
      if (s.owner_user_id) {
        notificationsService.notify(s.owner_user_id, {
          category: 'system',
          title: 'Your sponsorship has ended',
          body: `Your placement ran its full term and has come down. It finished with ${(s.impressions_count ?? 0).toLocaleString()} logo views and ${s.attributed_signups_count ?? 0} signups. Renew any time.`,
          data: { sponsorId: String(s._id) },
        });
      }
      expired += 1;
    }
    return expired;
  },

  /**
   * THE WAITLIST, WHICH NOBODY COULD READ.
   *
   * Pre-registrations were writable by the public and readable by nothing: the only endpoint was a
   * bare count. Someone raising their hand as a would-be sponsor, seller or hub landed in a
   * collection no screen exposed, so every lead the landing page collected was invisible.
   */
  async listPreregistrations(filter: { intendedRole?: string } = {}, limit = 200) {
    const rows = await PreregistrationModel.find(
      filter.intendedRole ? { intended_role: filter.intendedRole } : {},
    )
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();

    const sponsorIds = [...new Set(rows.map((r) => r.sponsor_id).filter(Boolean))] as string[];
    const sponsors = sponsorIds.length
      ? await SponsorModel.find({ _id: { $in: sponsorIds } }, { name: 1 }).lean().exec()
      : [];
    const sponsorName = new Map(sponsors.map((s) => [String(s._id), s.name]));

    return rows.map((r) => ({
      id: String(r._id),
      fullName: r.full_name,
      email: r.email,
      phone: r.phone ?? null,
      intendedRole: r.intended_role ?? 'customer',
      citySlug: r.city_slug ?? null,
      utmCode: r.utm_code ?? null,
      /** Which sponsor sent them, by NAME — a raw id tells an operator nothing. */
      sponsorName: r.sponsor_id ? (sponsorName.get(r.sponsor_id) ?? null) : null,
      createdAt: r.created_at,
    }));
  },

  async create(
    admin: Principal,
    dto: {
      name: string;
      utmCode: string;
      logoUrl?: string;
      tier?: string;
      program?: string;
      launchCitySlug?: string;
      contractedCents?: number;
      note?: string;
    },
  ) {
    const program = resolveProgram(dto.program);
    try {
      const sponsor = await SponsorModel.create({
        name: dto.name,
        utm_code: dto.utmCode,
        slug: slugFor(dto.name, dto.utmCode.slice(-6)),
        logo_url: dto.logoUrl ?? null,
        tier: dto.tier ?? 'launch',
        program,
        launch_city_slug: dto.launchCitySlug ?? null,
        contracted_cents: dto.contractedCents ?? 0,
        note: dto.note ?? null,
      });
      await writeAudit({
        actorId: admin.userId,
        actorRole: 'admin',
        action: 'sponsor.created',
        entityType: 'sponsor',
        entityId: String(sponsor._id),
        metadata: { name: dto.name, utmCode: dto.utmCode },
      });
      return { id: String(sponsor._id), name: sponsor.name, utmCode: sponsor.utm_code };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw ConflictError(ERROR_CODES.DUPLICATE, 'A sponsor with that UTM code already exists');
      }
      throw err;
    }
  },

  /**
   * ═══ The admin roster. ═══
   *
   * There was no list endpoint at all, so the admin screen called `GET /admin/sponsors`, got a 404,
   * and rendered its loading skeleton for ever — a page that could only ever be blank. Every figure
   * here is a real stored counter, unlike the demo fixture the screen fell back to describing.
   *
   * Includes inactive sponsors: a finished sponsorship is exactly the record an operator goes
   * looking for, and hiding it would make the roster useless the moment a term ended.
   */
  async listAll(filter: { program?: string | null } = {}, limit = 200) {
    const program = filter.program ? resolveProgram(filter.program) : null;
    const query: Record<string, unknown> = {};
    if (program) {
      query.program = program === DEFAULT_SPONSOR_PROGRAM ? { $in: [program, null] } : program;
    }
    const sponsors = await SponsorModel.find(query)
      .sort({ active: -1, created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    return sponsors.map((s) => ({
      id: String(s._id),
      name: s.name,
      logoUrl: s.logo_url ?? null,
      tier: s.tier,
      program: s.program ?? DEFAULT_SPONSOR_PROGRAM,
      utmCode: s.utm_code,
      launchCitySlug: s.launch_city_slug ?? null,
      active: s.active !== false,
      impressions: s.impressions_count ?? 0,
      attributedSignups: s.attributed_signups_count ?? 0,
      /** Recorded by hand, never collected — see the model. */
      contractedCents: s.contracted_cents ?? 0,
      note: s.note ?? null,
      createdAt: s.created_at ?? null,
      /**
       * The self-serve half. `status` is what separates a placement waiting for review from one
       * already running — the review queue is the whole reason paying does not publish a logo.
       */
      status: s.status ?? 'manual',
      paidCents: s.paid_cents ?? 0,
      contactEmail: s.contact_email ?? null,
      termMonths: s.term_months ?? null,
      startsAt: s.starts_at ?? null,
      endsAt: s.ends_at ?? null,
    }));
  },

  /**
   * Edit a sponsorship, including ending one.
   *
   * `active` was in the model and reachable by nothing, so a sponsorship could be created and never
   * ended — the logo would sit on the landing page after the term expired, and the UTM code would
   * keep attributing signups to a partner who had stopped paying.
   */
  async update(
    admin: Principal,
    sponsorId: string,
    patch: {
      name?: string;
      logoUrl?: string | null;
      tier?: string;
      program?: string;
      launchCitySlug?: string | null;
      contractedCents?: number;
      note?: string | null;
      active?: boolean;
    },
  ) {
    const $set: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.logoUrl !== undefined) $set.logo_url = patch.logoUrl;
    if (patch.tier !== undefined) $set.tier = patch.tier;
    if (patch.program !== undefined) $set.program = resolveProgram(patch.program);
    if (patch.launchCitySlug !== undefined) $set.launch_city_slug = patch.launchCitySlug;
    if (patch.contractedCents !== undefined) $set.contracted_cents = patch.contractedCents;
    if (patch.note !== undefined) $set.note = patch.note;
    if (patch.active !== undefined) $set.active = patch.active;

    const sponsor = await SponsorModel.findByIdAndUpdate(sponsorId, { $set }, { new: true })
      .lean()
      .exec();
    if (!sponsor) throw NotFoundError('Sponsor not found');

    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: patch.active === false ? 'sponsor.deactivated' : 'sponsor.updated',
      entityType: 'sponsor',
      entityId: sponsorId,
      metadata: patch as Record<string, unknown>,
    });
    return {
      id: sponsorId,
      name: sponsor.name,
      active: sponsor.active !== false,
      /**
       * Reported back because deactivating stops BOTH the logo and the attribution, and an admin
       * ending a term should see what that partner finished with rather than watching it vanish.
       */
      impressions: sponsor.impressions_count ?? 0,
      attributedSignups: sponsor.attributed_signups_count ?? 0,
    };
  },

  /**
   * Public list for logo placement — no internal counters exposed.
   *
   * Optional `program` filter: the Great Ice Cream Giveaway page shows ONLY its own sponsors,
   * and the main landing page shows ONLY platform sponsors. Without the filter the two rosters
   * would collide — a Silver $3K giveaway sponsor would appear next to the long-running platform
   * partners, which is not what either side agreed to.
   */
  async listActive(programInput?: string | null) {
    const program = programInput ? resolveProgram(programInput) : null;
    const query: Record<string, unknown> = { active: true };
    if (program) {
      /** `$in [program, null]` picks up pre-field rows that implicitly belong to `platform`. */
      query.program = program === DEFAULT_SPONSOR_PROGRAM ? { $in: [program, null] } : program;
    }
    const sponsors = await SponsorModel.find(query)
      .select('name logo_url tier utm_code program')
      .lean()
      .exec();
    return sponsors.map((s) => ({
      id: String(s._id),
      name: s.name,
      logoUrl: s.logo_url,
      tier: s.tier,
      program: s.program ?? DEFAULT_SPONSOR_PROGRAM,
      /**
       * Returned so the page that renders the logo can also report the impression — the endpoint
       * keys on the UTM code, and without it the caller had nothing to send. Not a secret: it is
       * the `?utm=` parameter in the sponsor's own public marketing links.
       *
       * The internal counters (`impressions_count`, `attributed_signups_count`) stay off this
       * response, which is what the public/admin split actually protects.
       */
      utmCode: s.utm_code,
    }));
  },

  async recordImpression(utmCode: string) {
    await SponsorModel.updateOne(
      { utm_code: utmCode, active: true },
      { $inc: { impressions_count: 1 } },
    ).exec();
    return { recorded: true };
  },

  /** Public pre-registration with optional UTM attribution to a sponsor. */
  async preregister(dto: {
    fullName: string;
    email: string;
    phone?: string;
    intendedRole?: string;
    citySlug?: string;
    utmCode?: string;
  }) {
    let sponsorId: string | null = null;
    if (dto.utmCode) {
      const sponsor = await SponsorModel.findOneAndUpdate(
        { utm_code: dto.utmCode, active: true },
        { $inc: { attributed_signups_count: 1 } },
        { new: true },
      ).exec();
      sponsorId = sponsor ? String(sponsor._id) : null;
    }
    try {
      const prereg = await PreregistrationModel.create({
        full_name: dto.fullName,
        email: dto.email,
        phone: dto.phone ?? null,
        intended_role: dto.intendedRole ?? 'customer',
        city_slug: dto.citySlug ?? null,
        utm_code: dto.utmCode ?? null,
        sponsor_id: sponsorId,
      });
      /**
       * The public site's only contact channel that reaches a database rather than a mail client.
       * A lead that lands solely in a collection nobody queries is a lead nobody answers, so the
       * operator inbox gets it too. Best-effort: a mail failure must not fail the sign-up.
       */
      void notifyOps(
        `New StreetServe pre-registration — ${dto.fullName}`,
        [
          `Name: ${dto.fullName}`,
          `Email: ${dto.email}`,
          dto.phone ? `Phone: ${dto.phone}` : '',
          `Interested as: ${dto.intendedRole ?? 'customer'}`,
          dto.citySlug ? `City: ${dto.citySlug}` : '',
          sponsorId ? `Attributed to sponsor: ${sponsorId}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        `prereg_${String(prereg._id)}`,
      );
      return { id: String(prereg._id), attributedToSponsor: Boolean(sponsorId) };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // One spot per email — the landing page turns this into "you're already in line".
        throw ConflictError(ERROR_CODES.DUPLICATE, 'This email is already on the waitlist');
      }
      throw err;
    }
  },

  /** Public waitlist size for the landing page's metrics strip — a bare count, no PII. */
  async preregistrationCount() {
    return { count: await PreregistrationModel.estimatedDocumentCount().exec() };
  },

  /**
   * ═══ Public sponsor profile. ═══
   *
   * Resolved by slug (which may be the UTM code as a legacy fallback), returns only safe fields
   * for anonymous viewing. Hard-gated on tier: a Silver sponsor who set website_url + about
   * does not get a public page, because they didn't buy that benefit.
   *
   * Impressions on the sponsor profile fall under the SAME counter as logo-placement impressions
   * — a view is a view. Recording that is left to the frontend's existing `recordImpression`
   * flow, keyed by UTM, which stays the single counter the sponsor sees in their dashboard.
   */
  async getPublicProfile(slugOrId: string) {
    const sponsor = await SponsorModel.findOne({
      active: true,
      $or: [{ slug: slugOrId }, { utm_code: slugOrId }],
    })
      .select('name logo_url tier program blurb website_url about utm_code slug')
      .lean()
      .exec();
    if (!sponsor) throw NotFoundError('No such sponsor profile');

    const program = sponsor.program ?? DEFAULT_SPONSOR_PROGRAM;
    if (!tierHasPublicProfile(program, sponsor.tier ?? '')) {
      /**
       * Deliberately a 404, not a 403: a profile that isn't published shouldn't advertise its own
       * existence. The sponsor still gets their roster logo everywhere else.
       */
      throw NotFoundError('No such sponsor profile');
    }
    return {
      name: sponsor.name,
      logoUrl: sponsor.logo_url ?? null,
      tier: sponsor.tier,
      program,
      websiteUrl: sponsor.website_url ?? null,
      about: sponsor.about ?? null,
      utmCode: sponsor.utm_code,
      slug: sponsor.slug ?? sponsor.utm_code,
    };
  },

  /**
   * Owner self-service: update profile fields on the sponsor THEY own. Only website_url + about
   * are writable — tier, logo, slug, status are not. A sponsor cannot change what they bought
   * from their own dashboard; those stay admin-controlled.
   */
  async updateOwnProfile(
    principal: Principal,
    patch: { websiteUrl?: string | null; about?: string | null },
  ) {
    const $set: Record<string, unknown> = {};
    if (patch.websiteUrl !== undefined) $set.website_url = patch.websiteUrl;
    if (patch.about !== undefined) $set.about = patch.about;
    const sponsor = await SponsorModel.findOneAndUpdate(
      { owner_user_id: principal.userId, active: true },
      { $set },
      { new: true },
    )
      .lean()
      .exec();
    if (!sponsor) throw NotFoundError('No active sponsorship to update');
    await writeAudit({
      actorId: principal.userId,
      action: 'sponsor.profile.updated',
      entityType: 'sponsor',
      entityId: String(sponsor._id),
      metadata: patch as Record<string, unknown>,
    });
    return {
      websiteUrl: sponsor.website_url ?? null,
      about: sponsor.about ?? null,
      slug: sponsor.slug ?? null,
      /** The signed-in sponsor's own public profile URL (if their tier qualifies). */
      hasPublicProfile: tierHasPublicProfile(
        sponsor.program ?? DEFAULT_SPONSOR_PROGRAM,
        sponsor.tier ?? '',
      ),
    };
  },

  /**
   * Reach + attribution for the signed-in sponsor's own campaign — the figures the sponsor's
   * dashboard shows alongside the fulfilment counts. Same shape as the admin report, scoped by
   * owner_user_id so a sponsor can only ever see their own.
   */
  async getOwnStats(principal: Principal) {
    const sponsor = await SponsorModel.findOne({
      owner_user_id: principal.userId,
      active: true,
    })
      .sort({ created_at: -1 })
      .lean()
      .exec();
    if (!sponsor) return null;
    const impressions = sponsor.impressions_count ?? 0;
    const attributedSignups = sponsor.attributed_signups_count ?? 0;
    return {
      impressions,
      attributedSignups,
      utmCode: sponsor.utm_code,
      /** Null when there are no impressions yet — a rate on zero would be a lie. */
      signupRatePercent:
        impressions > 0
          ? Math.round((attributedSignups / impressions) * 1000) / 10
          : null,
      websiteUrl: sponsor.website_url ?? null,
      about: sponsor.about ?? null,
      slug: sponsor.slug ?? null,
      hasPublicProfile: tierHasPublicProfile(
        sponsor.program ?? DEFAULT_SPONSOR_PROGRAM,
        sponsor.tier ?? '',
      ),
    };
  },

  async report(_admin: Principal, sponsorId: string) {
    const sponsor = await SponsorModel.findById(sponsorId).lean().exec();
    if (!sponsor) throw NotFoundError('Sponsor not found');
    return {
      id: sponsorId,
      name: sponsor.name,
      utmCode: sponsor.utm_code,
      impressions: sponsor.impressions_count ?? 0,
      attributedSignups: sponsor.attributed_signups_count ?? 0,
      contractedCents: sponsor.contracted_cents ?? 0,
      active: sponsor.active !== false,
      /**
       * The number a sponsor actually asks about. Guarded rather than computed blind: a brand-new
       * sponsorship has no impressions, and dividing by zero would report a rate on nothing.
       */
      signupRatePercent:
        (sponsor.impressions_count ?? 0) > 0
          ? Math.round(
              ((sponsor.attributed_signups_count ?? 0) / (sponsor.impressions_count ?? 1)) * 1000,
            ) / 10
          : null,
    };
  },
};
