import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ConflictError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { PreregistrationModel, SponsorModel } from './sponsors.model';

export const sponsorsService = {
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
