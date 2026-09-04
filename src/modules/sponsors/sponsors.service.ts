import { randomUUID } from 'node:crypto';

import { SPONSOR_TERM_MONTHS, SPONSOR_TIERS } from '../../config/constants';
import { logger } from '../../config/logger';
import { formatCents } from '../../shared/money';
import { notificationsService } from '../notifications/notifications.service';
import { stripe } from '../../integrations/stripe';
import { notifyOps } from '../../integrations/messaging';
import { paymentsService } from '../payments/payments.service';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ConflictError, NotFoundError } from '../../shared/errors/AppError';
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

export const sponsorsService = {
  /** The public rate card. Prices live in code so a fee-schedule edit cannot move them. */
  listTiers() {
    return {
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
    },
    idempotencyKey: string,
  ) {
    const tier = SPONSOR_TIERS.find((t) => t.slug === dto.tier);
    if (!tier) throw NotFoundError('No such sponsorship tier');
    if (!(SPONSOR_TERM_MONTHS as readonly number[]).includes(dto.termMonths)) {
      throw ConflictError(ERROR_CODES.BUSINESS_RULE, 'Choose one of the available terms');
    }
    const amountCents = tier.monthlyCents * dto.termMonths;

    const sponsor = await SponsorModel.create({
      name: dto.name,
      utm_code: utmCodeFor(dto.name),
      logo_url: dto.logoUrl ?? null,
      tier: tier.slug,
      launch_city_slug: dto.launchCitySlug ?? null,
      status: 'pending_payment',
      /** Not live — and not live on payment either. See the model. */
      active: false,
      owner_user_id: principal.userId,
      contact_email: dto.contactEmail,
      term_months: dto.termMonths,
    });
    const sponsorId = String(sponsor._id);

    /**
     * Custodial: the platform is the merchant, because a sponsorship is bought FROM the platform
     * rather than from any vendor. Same rail as Pay It Forward and Boost contributions.
     */
    const charge = await paymentsService.chargeToPlatform({
      amountCents,
      transferGroup: `sponsor_${sponsorId}`,
      metadata: { kind: 'sponsorship', sponsorId, tier: tier.slug },
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
      tier: tier.slug,
      termMonths: dto.termMonths,
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
    const paidCents =
      (found.term_months ?? 1) *
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
      launchCitySlug?: string;
      contractedCents?: number;
      note?: string;
    },
  ) {
    try {
      const sponsor = await SponsorModel.create({
        name: dto.name,
        utm_code: dto.utmCode,
        logo_url: dto.logoUrl ?? null,
        tier: dto.tier ?? 'launch',
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
  async listAll(limit = 200) {
    const sponsors = await SponsorModel.find()
      .sort({ active: -1, created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    return sponsors.map((s) => ({
      id: String(s._id),
      name: s.name,
      logoUrl: s.logo_url ?? null,
      tier: s.tier,
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

  /** Public list for logo placement — no internal counters exposed. */
  async listActive() {
    const sponsors = await SponsorModel.find({ active: true })
      .select('name logo_url tier utm_code')
      .lean()
      .exec();
    return sponsors.map((s) => ({
      id: String(s._id),
      name: s.name,
      logoUrl: s.logo_url,
      tier: s.tier,
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
