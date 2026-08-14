import { z } from 'zod';

import { ARCHETYPES, CATEGORY_TABS, MODULES } from '../../config/constants';
import { NonNegativeCents } from '../../shared/money';
import { HttpUrl } from '../../shared/url';

const objectId = z.string().length(24);

export const CreateBusinessBody = z
  .object({
    name: z.string().min(1).max(160),
    categoryId: objectId,
    description: z.string().max(2000).optional(),
    logoUrl: HttpUrl.optional(),
    isHub: z.boolean().optional(),
  })
  .strict();

/** Weekly opening hours. `day` is 0=Sun..6=Sat; times are "HH:MM" 24h in the business's locale. */
const HoursEntry = z
  .object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  })
  .strict();

export const UpdateBusinessBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).optional(),
    logoUrl: HttpUrl.optional(),
    coverPhotoUrl: HttpUrl.optional(),
    // Nullable so the vendor can clear the current Today's Special (send null), not only set it.
    todaySpecialMenuItemId: objectId.nullable().optional(),
    // ─── BP-3: registration finally persists what it asks for ─────────────────────────────
    hours: z.array(HoursEntry).max(14).optional(),
    /** Centre of the service area, [lng, lat] — paired with serviceRadiusM. */
    serviceArea: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
    serviceRadiusM: z.number().int().positive().max(200_000).nullable().optional(),
    travelFeeCents: NonNegativeCents.nullable().optional(),
    /** 7.5 / P-14 — scheduled pickup. Opt-in, with the vendor's own notice period and horizon. */
    scheduledPickup: z
      .object({
        enabled: z.boolean(),
        minLeadMinutes: z.number().int().min(5).max(1440).optional(),
        maxDaysAhead: z.number().int().min(1).max(30).optional(),
        slotMinutes: z.number().int().min(5).max(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const BusinessIdParam = z.object({ id: objectId }).strict();

/**
 * The owner's chosen module set. Core/auto modules may be present (they're enforced server-side
 * regardless) — the service rejects anything outside the archetype's available set.
 */
export const SetModulesBody = z
  .object({ enabled: z.array(z.enum(MODULES)).max(MODULES.length) })
  .strict();

export const CreateMenuItemBody = z
  .object({
    name: z.string().min(1).max(160),
    priceCents: NonNegativeCents,
    description: z.string().max(1000).optional(),
    photoUrl: HttpUrl.optional(),
  })
  .strict();

export const UpdateMenuItemBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    priceCents: NonNegativeCents.optional(),
    isAvailable: z.boolean().optional(),
    // `null` removes the photo; omitted leaves it untouched. Without this a vendor could set a
    // photo at create and never fix a bad one.
    photoUrl: HttpUrl.nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
  })
  .strict();

export const MenuItemParams = z.object({ id: objectId, itemId: objectId }).strict();

export const CategorySuggestionBody = z
  .object({
    businessId: objectId,
    proposedName: z.string().min(2).max(120),
    justification: z.string().max(1000).optional(),
    proposedParentCategoryId: objectId.optional(),
  })
  .strict();

export const ReviewCategorySuggestionBody = z
  .object({
    approve: z.boolean(),
    requiresLicense: z.boolean().optional(),
    regulatedBy: z.string().max(200).optional(),
    topLevelTab: z.enum(CATEGORY_TABS).optional(),
    /**
     * What the approved category behaves like (BP-5). Optional: omitted falls back to the tab's
     * default, so an obvious approval stays one click. This is the field that lets a brand-new
     * category inherit a complete product with no code change.
     */
    archetype: z.enum(ARCHETYPES).optional(),
  })
  .strict();

/** Admin governance of an existing category — fix an archetype or licence flag without a migration. */
export const UpdateCategoryBody = z
  .object({
    archetype: z.enum(ARCHETYPES).optional(),
    requiresLicense: z.boolean().optional(),
    regulatedBy: z.string().max(200).nullable().optional(),
    active: z.boolean().optional(),
    topLevelTab: z.enum(CATEGORY_TABS).optional(),
    /** §43 — open this category for Rent-to-Own. Default-deny; hard prohibitions still win. */
    rtoEligible: z.boolean().optional(),
  })
  .strict();

export const ReviewQueueQuery = z
  .object({ status: z.enum(['pending', 'approved', 'rejected']).optional() })
  .strict();

export const LicenseDocumentBody = z
  .object({
    categoryId: objectId,
    documentUrl: z.string().url().max(2048),
  })
  .strict();

export const ReviewLicenseBody = z.object({ approve: z.boolean() }).strict();

export const IdParam = z.object({ id: objectId }).strict();
