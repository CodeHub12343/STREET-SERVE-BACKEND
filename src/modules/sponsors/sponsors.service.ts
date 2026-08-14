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
    },
  ) {
    try {
      const sponsor = await SponsorModel.create({
        name: dto.name,
        utm_code: dto.utmCode,
        logo_url: dto.logoUrl ?? null,
        tier: dto.tier ?? 'launch',
        launch_city_slug: dto.launchCitySlug ?? null,
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

  /** Public list for logo placement — no internal counters exposed. */
  async listActive() {
    const sponsors = await SponsorModel.find({ active: true })
      .select('name logo_url tier')
      .lean()
      .exec();
    return sponsors.map((s) => ({
      id: String(s._id),
      name: s.name,
      logoUrl: s.logo_url,
      tier: s.tier,
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
      impressions: sponsor.impressions_count,
      attributedSignups: sponsor.attributed_signups_count,
    };
  },
};
