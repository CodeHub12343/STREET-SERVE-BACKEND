import {
  SELLER_INFERENCE_CONFIDENCE_SALES,
  TRANSPORT_CAPACITY_CENTS,
  type SellerSkill,
  type SellerTransport,
  type SellerVenue,
} from '../../config/constants';
import { publish } from '../../events/bus';
import type { Principal } from '../../shared/types/principal';
import { consignmentRepository } from '../consignment/consignment.repository';
import { CategoryModel } from '../catalog/catalog.model';
import { SellerProfileModel } from './sellers.model';

/**
 * ═══ D-2 — THE SELLER PROFILE ═══
 *
 * The missing input for the brief's promised product↔person matching. See `sellers.model.ts` for
 * why self-declared and inferred signals are kept in separate fields.
 */
export const sellersService = {
  /** The caller's own profile, created empty on first read so the client never handles a 404. */
  async getMine(userId: string) {
    const existing = await SellerProfileModel.findOne({ user_id: userId }).lean().exec();
    if (existing) return this.view(existing);
    const created = await SellerProfileModel.create({ user_id: userId });
    return this.view(created.toObject());
  },

  /**
   * Update the self-declared half. Inferred fields are deliberately NOT patchable here — they are
   * conclusions, and a conclusion someone can edit is not evidence of anything.
   */
  async updateMine(
    principal: Principal,
    patch: {
      skills?: SellerSkill[];
      venues?: SellerVenue[];
      transport?: SellerTransport | null;
      availableHours?: number[];
      bio?: string | null;
    },
  ) {
    const updated = await SellerProfileModel.findOneAndUpdate(
      { user_id: principal.userId },
      {
        $set: {
          ...(patch.skills !== undefined && { skills: patch.skills }),
          ...(patch.venues !== undefined && { venues: patch.venues }),
          ...(patch.transport !== undefined && { transport: patch.transport }),
          ...(patch.availableHours !== undefined && {
            // De-duplicated and sorted so the stored shape is stable regardless of tap order.
            available_hours: [...new Set(patch.availableHours)].sort((a, b) => a - b),
          }),
          ...(patch.bio !== undefined && { bio: patch.bio }),
        },
      },
      { new: true, upsert: true },
    )
      .lean()
      .exec();

    await publish('seller_profile.updated', { userId: principal.userId });
    return this.view(updated);
  },

  /**
   * Recompute the inferred half from real outcomes.
   *
   * Cheap enough to run on demand (it reads one seller's own history), so it runs when the profile
   * is read rather than on a schedule — a nightly job would mean a seller's first week of evidence
   * is invisible for a day, which is exactly the week it matters most.
   */
  async recomputeInferred(userId: string) {
    const checkoutIds = await consignmentRepository.sellerCheckoutIds(userId);
    if (checkoutIds.length === 0) return null;

    const sales = await consignmentRepository.salesForCheckouts(checkoutIds);
    if (sales.length === 0) return null;

    // Which categories they actually sell, ranked by units moved.
    const productIds = [...new Set(await consignmentRepository.sellerProductIds(userId))];
    const products = await consignmentRepository.productsByIds(productIds);
    const catIds = [
      ...new Set(products.map((p) => (p.category_id ? String(p.category_id) : null)).filter(Boolean)),
    ] as string[];
    const cats = catIds.length
      ? await CategoryModel.find({ _id: { $in: catIds } })
          .lean()
          .exec()
      : [];
    const slugByCat = new Map(cats.map((c) => [String(c._id), c.slug]));

    const unitsByCategory = new Map<string, number>();
    const productById = new Map(products.map((p) => [String(p._id), p]));
    const hourCounts = new Map<number, number>();
    let totalUnits = 0;

    for (const s of sales) {
      totalUnits += s.quantity_sold;
      const hour = new Date(s.sold_at).getUTCHours();
      hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);

      const product = productById.get(String(s.product_id ?? ''));
      const slug = product?.category_id ? slugByCat.get(String(product.category_id)) : null;
      const key = slug ?? product?.category ?? null;
      if (key) unitsByCategory.set(key, (unitsByCategory.get(key) ?? 0) + s.quantity_sold);
    }

    const inferredCategories = [...unitsByCategory]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([slug]) => slug);

    // Hours carrying at least a fifth of their sales — a working window, not every hour they ever sold.
    const maxHour = Math.max(1, ...hourCounts.values());
    const activeHours = [...hourCounts]
      .filter(([, n]) => n >= maxHour * 0.2)
      .map(([h]) => h)
      .sort((a, b) => a - b);

    const patch = {
      inferred_categories: inferredCategories,
      inferred_sell_through: Number((totalUnits / checkoutIds.length).toFixed(2)),
      inferred_active_hours: activeHours,
      inferred_at: new Date(),
      inferred_sample_size: sales.length,
    };
    await SellerProfileModel.updateOne({ user_id: userId }, { $set: patch }, { upsert: true }).exec();
    return patch;
  },

  /**
   * The shape the ranking engine consumes (A-4/E-7). Returns null for a seller who has told us
   * nothing and done nothing — the engine treats that as "no personalisation available" rather than
   * inventing preferences from an empty profile.
   */
  async matchingContext(userId: string): Promise<{
    skills: string[];
    venues: string[];
    categories: string[];
    activeHours: number[];
    capacityCents: number | null;
    /** 0–1: how far to trust inferred signals over self-declared ones. */
    inferenceConfidence: number;
  } | null> {
    const profile = await SellerProfileModel.findOne({ user_id: userId }).lean().exec();
    if (!profile) return null;

    const declared = profile.skills.length + profile.venues.length;
    const sample = profile.inferred_sample_size ?? 0;
    if (declared === 0 && sample === 0) return null;

    return {
      skills: profile.skills,
      venues: profile.venues,
      /**
       * Inferred categories lead: what someone has actually sold beats what they said they'd be
       * good at. Self-declared skills still follow, which is what carries a brand-new seller.
       */
      categories: profile.inferred_categories,
      activeHours:
        profile.inferred_active_hours.length > 0
          ? profile.inferred_active_hours
          : profile.available_hours,
      capacityCents: profile.transport
        ? TRANSPORT_CAPACITY_CENTS[profile.transport]
        : null,
      inferenceConfidence: Math.min(1, sample / SELLER_INFERENCE_CONFIDENCE_SALES),
    };
  },

  view(p: {
    user_id: string;
    skills: string[];
    venues: string[];
    transport?: string | null;
    available_hours: number[];
    bio?: string | null;
    inferred_categories: string[];
    inferred_sell_through?: number | null;
    inferred_active_hours: number[];
    inferred_at?: Date | null;
    inferred_sample_size?: number | null;
  }) {
    return {
      userId: p.user_id,
      skills: p.skills,
      venues: p.venues,
      transport: p.transport ?? null,
      availableHours: p.available_hours,
      bio: p.bio ?? null,
      /**
       * Shown to the seller separately from what they declared. Someone should always be able to
       * see what we concluded about them, and how much of it we're relying on.
       */
      inferred: {
        categories: p.inferred_categories,
        sellThrough: p.inferred_sell_through ?? null,
        activeHours: p.inferred_active_hours,
        computedAt: p.inferred_at ?? null,
        sampleSize: p.inferred_sample_size ?? 0,
        confidence: Math.min(1, (p.inferred_sample_size ?? 0) / SELLER_INFERENCE_CONFIDENCE_SALES),
      },
      /** Drives the "finish your profile" nudge — a blank profile is the cold-start problem. */
      complete: p.skills.length > 0 && Boolean(p.transport),
    };
  },
};
