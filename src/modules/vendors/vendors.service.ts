import {
  DEFAULT_ARCHETYPE_BY_TAB,
  RTO_PROHIBITED_CATEGORY_SLUGS,
  type Archetype,
  type CategoryTab,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { CategoryModel } from '../catalog/catalog.model';
import { FollowModel } from '../livemap/livemap.model';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { LiveSessionModel } from '../livemap/livemap.model';
import { BusinessModel, MenuItemModel } from './vendors.model';
import { vendorsRepository as repo } from './vendors.repository';
import { wishlistsService } from '../wishlists/wishlists.service';
import { availableSlots, scheduledPickupView } from '../orders/scheduling';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const vendorsService = {
  // ─── Businesses ────────────────────────────────────────────────────────────────────────
  async createBusiness(
    principal: Principal,
    dto: {
      name: string;
      categoryId: string;
      description?: string;
      logoUrl?: string;
      isHub?: boolean;
    },
  ) {
    const category = await CategoryModel.findById(dto.categoryId).lean().exec();
    if (!category || !category.active) throw NotFoundError('Category not found');

    // NB: `enabled_modules` is deliberately left undefined = INHERIT the archetype's defaults.
    // Seeding a concrete set here would freeze the business at creation-time defaults, so
    // improving an archetype default would never reach it (BUSINESS_MODULE_SYSTEM.md §2).
    // Registration derives modules from the category rather than asking, so there is no explicit
    // owner choice to record — that only happens when they customise via PUT /modules.
    const business = await repo.createBusiness({
      owner_user_id: principal.userId,
      name: dto.name,
      category_id: category._id,
      description: dto.description ?? null,
      logo_url: dto.logoUrl ?? null,
      is_hub: dto.isHub ?? false,
    });
    await publish('business.created', {
      businessId: String(business._id),
      ownerId: principal.userId,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'business.created',
      entityType: 'business',
      entityId: String(business._id),
      metadata: { requiresLicense: category.requires_license },
    });
    return this.getBusiness(String(business._id));
  },

  async getBusiness(id: string, viewerUserId?: string) {
    const b = await repo.findBusinessById(id);
    if (!b) throw NotFoundError('Business not found');
    const licensed = await this.isBusinessLicensedForLiveOps(id);
    // The current live status (driving/parked/away_closed) or null when offline — customers need
    // this to know if the business is open for orders. `status` is the ACCOUNT state, not this.
    const session = await LiveSessionModel.findOne(
      { actor_type: 'business', actor_id: id, ended_at: null },
      { status: 1 },
    )
      .lean()
      .exec();
    // Whether the SIGNED-IN viewer follows this business. Without it the Follow button can only
    // guess: the client's optimistic flip reverted to "Follow" on every reload.
    const following = viewerUserId
      ? Boolean(await FollowModel.exists({ follower_user_id: viewerUserId, business_id: id }).exec())
      : false;
    return {
      following,
      id: String(b._id),
      ownerId: b.owner_user_id,
      name: b.name,
      categoryId: String(b.category_id),
      description: b.description,
      logoUrl: b.logo_url,
      coverPhotoUrl: b.cover_photo_url,
      /**
       * Mapped field-by-field rather than passed through.
       *
       * `hours` is an array of subdocuments, so Mongoose stamps each entry with its own `_id`.
       * Returning them raw put that `_id` in the API response, and the settings screen sends the
       * hours it was given straight back — into `UpdateBusinessBody`, which is `.strict()`. Saving
       * business settings therefore always failed with 400 "Unrecognized key(s) in object: '_id'",
       * and the id served no purpose to any client in the first place.
       *
       * The model no longer generates these ids, but existing rows still carry them, so the
       * projection stays explicit rather than relying on the schema change alone.
       */
      hours: (b.hours ?? []).map((h) => ({ day: h.day, open: h.open, close: h.close })),
      todaySpecialMenuItemId: b.today_special_menu_item_id
        ? String(b.today_special_menu_item_id)
        : null,
      // Registration asks for these (BP-3), so they have to be readable back — the old wizard
      // collected a service area and silently dropped it.
      serviceArea: b.service_area?.coordinates ?? null,
      serviceRadiusM: b.service_radius_m,
      travelFeeCents: b.travel_fee_cents,
      /** 7.5 — so the customer's order screen can offer a time picker, or not. */
      scheduledPickup: scheduledPickupView(b.scheduled_pickup),
      isHub: b.is_hub,
      status: b.status,
      liveStatus: session?.status ?? null,
      payoutAccountLinked: Boolean(b.payout_account_ref),
      canGoLive: licensed,
      /**
       * P-19 — the paid Verified Badge. It was purchasable at $9.99/mo and rendered nowhere, which
       * makes it a subscription with no product attached.
       */
      verified: await (async () => {
        const { subscriptionsService } = await import('../subscriptions/subscriptions.service');
        return (await subscriptionsService.activeVerifiedSet([id])).has(id);
      })(),
    };
  },

  /**
   * Businesses owned by the caller. The vendor dashboard resolves its active business here
   * (a vendor with none yet gets an empty list → the client sends them to registration).
   * Deliberately a light projection: no per-business license lookup like getBusiness does.
   */
  async listMyBusinesses(principal: Principal) {
    const list = await repo.listBusinessesByOwner(principal.userId);
    return list.map((b) => ({
      id: String(b._id),
      name: b.name,
      categoryId: String(b.category_id),
      logoUrl: b.logo_url,
      isHub: b.is_hub,
      status: b.status,
    }));
  },

  async getBusinessOwner(id: string): Promise<string | null> {
    const b = await repo.findBusinessById(id);
    return b ? b.owner_user_id : null;
  },

  /**
   * What this business charges to travel to a customer (spec §32.4). Read at wave-down time so the
   * fee can be snapshotted onto the request; `null`/unset means the vendor charges nothing.
   */
  async getTravelFeeCents(id: string): Promise<number | null> {
    const b = await repo.findBusinessById(id);
    const fee = b?.travel_fee_cents ?? null;
    return fee != null && fee > 0 ? fee : null;
  },

  async updateBusiness(
    id: string,
    patch: {
      name?: string;
      description?: string;
      logoUrl?: string;
      coverPhotoUrl?: string;
      todaySpecialMenuItemId?: string | null;
      hours?: { day: number; open: string; close: string }[];
      serviceArea?: [number, number];
      serviceRadiusM?: number | null;
      travelFeeCents?: number | null;
      scheduledPickup?: {
        enabled: boolean;
        minLeadMinutes?: number;
        maxDaysAhead?: number;
        slotMinutes?: number;
      };
    },
  ) {
    if (patch.todaySpecialMenuItemId) {
      const item = await repo.findMenuItemById(patch.todaySpecialMenuItemId);
      if (!item || String(item.business_id) !== id) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          "Today's Special must reference a menu item of this business",
        );
      }
    }
    if (patch.hours) {
      for (const h of patch.hours) {
        if (h.close <= h.open) {
          throw BusinessRuleError(
            ERROR_CODES.BUSINESS_RULE,
            `Closing time must be after opening time (day ${h.day})`,
          );
        }
      }
    }
    const updated = await repo.updateBusiness(id, {
      name: patch.name,
      description: patch.description,
      logo_url: patch.logoUrl,
      cover_photo_url: patch.coverPhotoUrl,
      today_special_menu_item_id: patch.todaySpecialMenuItemId,
      hours: patch.hours,
      // Only touch geo when a centre is supplied — a partial patch must not wipe the area.
      ...(patch.serviceArea
        ? { service_area: { type: 'Point' as const, coordinates: patch.serviceArea } }
        : {}),
      service_radius_m: patch.serviceRadiusM,
      travel_fee_cents: patch.travelFeeCents,
      // 7.5 — only written when supplied, so a partial patch cannot silently disable a vendor's
      // scheduled pickup and strand orders customers have already placed.
      ...(patch.scheduledPickup
        ? {
            scheduled_pickup: {
              enabled: patch.scheduledPickup.enabled,
              ...(patch.scheduledPickup.minLeadMinutes != null
                ? { min_lead_minutes: patch.scheduledPickup.minLeadMinutes }
                : {}),
              ...(patch.scheduledPickup.maxDaysAhead != null
                ? { max_days_ahead: patch.scheduledPickup.maxDaysAhead }
                : {}),
              ...(patch.scheduledPickup.slotMinutes != null
                ? { slot_minutes: patch.scheduledPickup.slotMinutes }
                : {}),
            },
          }
        : {}),
    });
    if (!updated) throw NotFoundError('Business not found');
    return this.getBusiness(id);
  },

  /**
   * 7.5 — the bookable slots for a business, generated on read.
   *
   * Not stored: a slot is a computed consequence of "now" plus the vendor's settings, and storing
   * them would need a nightly job to create tomorrow's — plus a bug on the morning it did not run.
   */
  async pickupSlots(businessId: string, horizonHours = 24) {
    const business = await BusinessModel.findById(businessId).select('scheduled_pickup').lean();
    if (!business) throw NotFoundError('Business not found');
    const settings = scheduledPickupView(business.scheduled_pickup);
    return {
      ...settings,
      slots: availableSlots(business.scheduled_pickup, { horizonHours }).map((d) => d.toISOString()),
    };
  },

  async registerHub(id: string) {
    const updated = await repo.updateBusiness(id, { is_hub: true });
    if (!updated) throw NotFoundError('Business not found');
    return this.getBusiness(id);
  },

  async onboardBusinessPayouts(principal: Principal, businessId: string) {
    const link = await paymentsService.createOnboardingLink(
      'business',
      businessId,
      principal.email,
    );
    await repo.updateBusiness(businessId, { payout_account_ref: link.stripeAccountId });
    return { url: link.url };
  },

  // ─── Menu ─────────────────────────────────────────────────────────────────────────────
  async addMenuItem(
    businessId: string,
    dto: { name: string; priceCents: number; description?: string; photoUrl?: string },
  ) {
    const item = await repo.createMenuItem({
      business_id: businessId,
      name: dto.name,
      price_cents: dto.priceCents,
      description: dto.description ?? null,
      photo_url: dto.photoUrl ?? null,
    });
    // Same shape as listMenu — create and list disagreeing is how the client ends up guessing.
    return {
      id: String(item._id),
      businessId: String(item.business_id),
      name: item.name,
      description: item.description,
      photoUrl: item.photo_url,
      priceCents: item.price_cents,
      available: item.is_available,
    };
  },

  async updateMenuItem(
    itemId: string,
    patch: {
      name?: string;
      priceCents?: number;
      isAvailable?: boolean;
      photoUrl?: string | null;
      description?: string | null;
    },
  ) {
    // 7.2: read the prior state BEFORE the write, so the back-in-stock alert fires on the
    // false → true edge rather than on every save of an already-available item.
    const before =
      patch.isAvailable === true
        ? await MenuItemModel.findById(itemId).select('is_available').lean()
        : null;
    const wasUnavailable = before ? before.is_available === false : false;

    // Mongoose strips `undefined` from $set but keeps `null`, so "omitted" and "explicitly
    // cleared" stay distinct all the way down to the document.
    const updated = await repo.updateMenuItem(itemId, {
      name: patch.name,
      price_cents: patch.priceCents,
      is_available: patch.isAvailable,
      photo_url: patch.photoUrl,
      description: patch.description,
    });
    if (!updated) throw NotFoundError('Menu item not found');

    /**
     * 7.2 — fire the back-in-stock alert here rather than from a sweep. The write that changed
     * availability already knows it happened; polling for "did anything come back?" would scan
     * every wish on every tick to rediscover it.
     *
     * Only on the false → true edge: `patch.isAvailable === true` alone would re-alert on every
     * unrelated edit to an item that was already available.
     */
    if (patch.isAvailable === true && wasUnavailable) {
      void wishlistsService.notifyBackInStock('menu_item', itemId, {
        label: updated.name,
        businessId: String(updated.business_id),
      });
    }

    return {
      id: String(updated._id),
      businessId: String(updated.business_id),
      name: updated.name,
      description: updated.description,
      photoUrl: updated.photo_url,
      priceCents: updated.price_cents,
      available: updated.is_available,
    };
  },

  /**
   * Remove a menu item for good. A HARD delete is safe here (unlike services): order line items
   * snapshot `name` + `unit_price_cents` alongside `menu_item_id`, so historical receipts still
   * read correctly once the item is gone.
   */
  async removeMenuItem(itemId: string) {
    const deleted = await repo.deleteMenuItem(itemId);
    if (!deleted) throw NotFoundError('Menu item not found');
    // Clearing Today's Special would otherwise dangle at a deleted item on the customer profile.
    const businessId = String(deleted.business_id);
    const business = await repo.findBusinessById(businessId);
    if (business && String(business.today_special_menu_item_id) === itemId) {
      await repo.updateBusiness(businessId, { today_special_menu_item_id: null });
    }
    return { id: itemId, removed: true };
  },

  async getMenuItemBusiness(itemId: string): Promise<string | null> {
    const item = await repo.findMenuItemById(itemId);
    return item ? String(item.business_id) : null;
  },

  /**
   * Map to the API contract. This previously returned raw lean docs (`_id`, `price_cents`,
   * `is_available`), so every consumer read `undefined`: the vendor's menu rendered "$NaN" and
   * delete hit /menu/undefined, and the customer's order screen was equally broken. It only ever
   * looked fine because those screens are usually exercised in demo mode.
   */
  async listMenu(businessId: string) {
    const items = await repo.listMenu(businessId);
    return items.map((m) => ({
      id: String(m._id),
      businessId: String(m.business_id),
      name: m.name,
      description: m.description,
      photoUrl: m.photo_url,
      priceCents: m.price_cents,
      available: m.is_available,
    }));
  },

  /** Menu items for an order, scoped to the business (used by the orders module). */
  async getMenuItemsByIds(businessId: string, ids: string[]) {
    const items = await MenuItemModel.find({ _id: { $in: ids }, business_id: businessId })
      .lean()
      .exec();
    return items.map((i) => ({
      id: String(i._id),
      name: i.name,
      priceCents: i.price_cents,
      isAvailable: i.is_available,
    }));
  },

  // ─── Category suggestions (admin-reviewed) ──────────────────────────────────────────────
  async submitCategorySuggestion(
    businessId: string,
    dto: { proposedName: string; justification?: string; proposedParentCategoryId?: string },
  ) {
    const s = await repo.createSuggestion({
      submitted_by_business_id: businessId,
      proposed_name: dto.proposedName,
      justification: dto.justification,
      proposed_parent_category_id: dto.proposedParentCategoryId ?? null,
    });
    return { id: String(s._id), status: s.status };
  },

  async reviewCategorySuggestion(
    adminId: string,
    suggestionId: string,
    decision: {
      approve: boolean;
      requiresLicense?: boolean;
      regulatedBy?: string;
      topLevelTab?: string;
      archetype?: Archetype;
    },
  ): Promise<{ id: string; approved: boolean; createdCategoryId: string | null }> {
    const s = await repo.findSuggestionById(suggestionId);
    if (!s) throw NotFoundError('Suggestion not found');
    if (s.status !== 'pending') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Suggestion already reviewed');
    }

    let createdCategoryId: string | null = null;
    if (decision.approve) {
      // Admin (not the submitter) sets the compliance metadata.
      const tab = (decision.topLevelTab ?? 'more') as CategoryTab;
      const category = await CategoryModel.create({
        slug: slugify(s.proposed_name),
        name: s.proposed_name,
        parent_category_id: s.proposed_parent_category_id,
        top_level_tab: tab,
        // The archetype is what gives the new category a complete product with no code change
        // (BP-5). Falling back to the tab's default keeps approval one click when it's obvious.
        archetype: decision.archetype ?? DEFAULT_ARCHETYPE_BY_TAB[tab],
        requires_license: decision.requiresLicense ?? false,
        regulated_by: decision.regulatedBy ?? null,
        active: true,
      });
      createdCategoryId = String(category._id);
    }
    await repo.updateSuggestion(suggestionId, {
      status: decision.approve ? 'approved' : 'rejected',
      reviewed_by: adminId,
      reviewed_at: new Date(),
    });
    await writeAudit({
      actorId: adminId,
      actorRole: 'admin',
      action: `category_suggestion.${decision.approve ? 'approved' : 'rejected'}`,
      entityType: 'category_suggestion',
      entityId: suggestionId,
      metadata: { createdCategoryId },
    });
    return { id: suggestionId, approved: decision.approve, createdCategoryId };
  },

  /**
   * Admin review queue for taxonomy suggestions (A-03). Joins the submitting business so the
   * reviewer sees who asked, mirroring listLicenseDocumentsForReview.
   */
  async listCategorySuggestionsForReview(status = 'pending') {
    const suggestions = await repo.listSuggestionsByStatus(status);
    if (suggestions.length === 0) return [];
    const businesses = await BusinessModel.find({
      _id: { $in: suggestions.map((s) => s.submitted_by_business_id) },
    })
      .lean()
      .exec();
    const bizById = new Map(businesses.map((b) => [String(b._id), b]));
    return suggestions.map((s) => ({
      id: String(s._id),
      proposedName: s.proposed_name,
      businessId: String(s.submitted_by_business_id),
      businessName: bizById.get(String(s.submitted_by_business_id))?.name ?? 'Unknown business',
      justification: s.justification,
      status: s.status,
      createdAt: s.created_at,
    }));
  },

  /** The full taxonomy for admins — includes inactive rows, which the public catalog hides. */
  async listCategoriesForAdmin() {
    const categories = await CategoryModel.find().sort({ top_level_tab: 1, name: 1 }).lean().exec();
    return categories.map((c) => ({
      id: String(c._id),
      slug: c.slug,
      name: c.name,
      topLevelTab: c.top_level_tab,
      // Null means the resolver falls back to the tab default — surfaced so admins can see the gap.
      archetype: c.archetype ?? null,
      requiresLicense: c.requires_license,
      regulatedBy: c.regulated_by,
      active: c.active,
    }));
  },

  /**
   * Correct a category's governance metadata without a migration — e.g. a wrong archetype after
   * approval, or a category that turns out to be regulated.
   */
  async updateCategory(
    adminId: string,
    categoryId: string,
    patch: {
      archetype?: Archetype;
      requiresLicense?: boolean;
      regulatedBy?: string | null;
      active?: boolean;
      topLevelTab?: CategoryTab;
      rtoEligible?: boolean;
    },
  ) {
    /**
     * §43 — a hard prohibition cannot be ticked away. Vehicles and regulated goods need a separately
     * reviewed programme, and a compliance rule that one mis-click disables is not a compliance rule.
     */
    if (patch.rtoEligible === true) {
      const cat = await CategoryModel.findById(categoryId).lean().exec();
      if (!cat) throw NotFoundError('Category not found');
      if (
        (RTO_PROHIBITED_CATEGORY_SLUGS as readonly string[]).includes(cat.slug) ||
        cat.requires_license ||
        cat.regulated_by
      ) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'This category can never be opened for Rent-to-Own — vehicles and regulated goods need a separate programme',
        );
      }
    }
    const updated = await CategoryModel.findByIdAndUpdate(
      categoryId,
      {
        $set: {
          ...(patch.archetype !== undefined ? { archetype: patch.archetype } : {}),
          ...(patch.requiresLicense !== undefined
            ? { requires_license: patch.requiresLicense }
            : {}),
          ...(patch.regulatedBy !== undefined ? { regulated_by: patch.regulatedBy } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.topLevelTab !== undefined ? { top_level_tab: patch.topLevelTab } : {}),
          ...(patch.rtoEligible !== undefined ? { rto_eligible: patch.rtoEligible } : {}),
        },
      },
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) throw NotFoundError('Category not found');

    await writeAudit({
      actorId: adminId,
      actorRole: 'admin',
      action: 'category.updated',
      entityType: 'category',
      entityId: categoryId,
      metadata: { ...patch },
    });
    return {
      id: String(updated._id),
      slug: updated.slug,
      name: updated.name,
      topLevelTab: updated.top_level_tab,
      archetype: updated.archetype ?? null,
      requiresLicense: updated.requires_license,
      regulatedBy: updated.regulated_by,
      active: updated.active,
    };
  },

  // ─── License documents + gating ─────────────────────────────────────────────────────────
  async submitLicenseDocument(businessId: string, categoryId: string, documentUrl: string) {
    const doc = await repo.createLicenseDocument({
      business_id: businessId,
      category_id: categoryId,
      document_url: documentUrl,
    });
    return { id: String(doc._id), status: doc.status };
  },

  /** The owner's licence documents for a business — drives the vendor's "why can't I go live" view. */
  async listLicenseDocuments(businessId: string) {
    const docs = await repo.listLicensesByBusiness(businessId);
    const categories = await CategoryModel.find({
      _id: { $in: docs.map((d) => d.category_id) },
    })
      .lean()
      .exec();
    const nameById = new Map(categories.map((c) => [String(c._id), c.name]));
    return docs.map((d) => ({
      id: String(d._id),
      businessId: String(d.business_id),
      categoryId: String(d.category_id),
      categoryName: nameById.get(String(d.category_id)) ?? 'Category',
      documentUrl: d.document_url,
      status: d.status,
      reviewedAt: d.reviewed_at,
      createdAt: d.created_at,
    }));
  },

  /**
   * Admin review queue (A-03). Joins business + category names so the reviewer sees who and what
   * without an N+1 from the client.
   */
  async listLicenseDocumentsForReview(status = 'pending') {
    const docs = await repo.listLicensesByStatus(status);
    if (docs.length === 0) return [];
    const [businesses, categories] = await Promise.all([
      BusinessModel.find({ _id: { $in: docs.map((d) => d.business_id) } })
        .lean()
        .exec(),
      CategoryModel.find({ _id: { $in: docs.map((d) => d.category_id) } })
        .lean()
        .exec(),
    ]);
    const bizById = new Map(businesses.map((b) => [String(b._id), b]));
    const catById = new Map(categories.map((c) => [String(c._id), c]));
    return docs.map((d) => {
      const cat = catById.get(String(d.category_id));
      return {
        id: String(d._id),
        businessId: String(d.business_id),
        businessName: bizById.get(String(d.business_id))?.name ?? 'Unknown business',
        categoryId: String(d.category_id),
        categoryName: cat?.name ?? 'Category',
        regulatedBy: cat?.regulated_by ?? null,
        documentUrl: d.document_url,
        status: d.status,
        createdAt: d.created_at,
      };
    });
  },

  async reviewLicenseDocument(adminId: string, licenseId: string, approve: boolean) {
    const doc = await repo.findLicenseById(licenseId);
    if (!doc) throw NotFoundError('License document not found');
    if (doc.status !== 'pending') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'License already reviewed');
    }
    await repo.updateLicense(licenseId, {
      status: approve ? 'approved' : 'rejected',
      reviewed_by: adminId,
      reviewed_at: new Date(),
    });
    await writeAudit({
      actorId: adminId,
      actorRole: 'admin',
      action: `license.${approve ? 'approved' : 'rejected'}`,
      entityType: 'license_document',
      entityId: licenseId,
      metadata: { businessId: String(doc.business_id), categoryId: String(doc.category_id) },
    });
    if (approve) {
      await publish('license.approved', {
        businessId: String(doc.business_id),
        categoryId: String(doc.category_id),
      });
    }
    // Tell the vendor the decision — inbox + realtime. Without this the owner only discovers the
    // outcome by re-opening the license screen.
    const owner = await this.getBusinessOwner(String(doc.business_id));
    if (owner) {
      const business = await repo.findBusinessById(String(doc.business_id));
      notificationsService.notify(owner, {
        category: 'license',
        title: approve ? 'License approved' : 'License rejected',
        body: approve
          ? `Your license for ${business?.name ?? 'your business'} was approved — you can now go live.`
          : `Your license for ${business?.name ?? 'your business'} was rejected. Upload a corrected document to try again.`,
        data: { businessId: String(doc.business_id), licenseId, approved: approve, audience: 'vendor' },
      });
    }
    return { id: licenseId, approved: approve };
  },

  /**
   * License gate: a business in a `requires_license` category cannot go live (Phase 2 broadcast)
   * until an approved license document exists for that category. FR / DB validation rules.
   */
  async isBusinessLicensedForLiveOps(businessId: string): Promise<boolean> {
    const business = await repo.findBusinessById(businessId);
    if (!business) return false;
    const category = await CategoryModel.findById(business.category_id).lean().exec();
    if (!category?.requires_license) return true;
    return repo.hasApprovedLicense(businessId, String(business.category_id));
  },
};
