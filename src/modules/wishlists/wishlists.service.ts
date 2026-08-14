import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { logger } from '../../config/logger';
import { NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { MenuItemModel } from '../vendors/vendors.model';
import { ProductModel } from '../consignment/consignment.model';

/**
 * 7.2 / M-16 — wish lists with back-in-stock notification.
 *
 * ## Two kinds of "out of stock"
 *
 * A menu item goes unavailable when a vendor flips `is_available` — the birria sold out at 1pm and
 * is back tomorrow. A consignment product goes unavailable when `quantity_available` hits zero —
 * genuinely gone until someone restocks. Both are worth waiting for, and a customer does not
 * distinguish them, so one wish list covers both with a `subject_type`.
 *
 * ## Why this is not `favorites`
 *
 * Favourites are businesses you like. A wish list is a specific thing you want and cannot have yet.
 * The difference matters because only the second one creates an obligation to tell you when it
 * changes — and that notification is the entire feature. A wish list with no alert is a bookmark.
 *
 * ## The restraint that makes it usable
 *
 * An alert fires **once per wish**, and the wish is marked notified. Without that, an item that
 * flickers in and out of availability — which is exactly what a food menu does across a service —
 * would notify the same person every time a vendor toggled a switch. The customer can re-arm by
 * removing and re-adding, which is a deliberate act rather than a default.
 */

export const WISHLIST_SUBJECTS = ['menu_item', 'product'] as const;
export type WishlistSubject = (typeof WISHLIST_SUBJECTS)[number];

const WishlistItemSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    subject_type: { type: String, enum: WISHLIST_SUBJECTS, required: true },
    subject_id: { type: String, required: true },
    /** Denormalised so the list renders without N lookups, and still reads sensibly if the item is deleted. */
    label: { type: String, required: true },
    business_id: { type: String, default: null },
    /** Set when the back-in-stock alert fired. Non-null = this wish has been served. */
    notified_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'wishlist_items' },
);
WishlistItemSchema.index({ user_id: 1, subject_type: 1, subject_id: 1 }, { unique: true });
// The alert query: "who is waiting for this thing, and has not been told yet".
WishlistItemSchema.index({ subject_type: 1, subject_id: 1, notified_at: 1 });

export type WishlistItemDoc = InferSchemaType<typeof WishlistItemSchema>;
export const WishlistItemModel = defineModel('WishlistItem', WishlistItemSchema);

function view(doc: WishlistItemDoc & { _id: unknown }) {
  return {
    id: String(doc._id),
    subjectType: doc.subject_type,
    subjectId: doc.subject_id,
    label: doc.label,
    businessId: doc.business_id ?? null,
    notified: Boolean(doc.notified_at),
    createdAt: doc.created_at,
  };
}

export const wishlistsService = {
  async add(
    principal: Principal,
    input: { subjectType: WishlistSubject; subjectId: string },
  ) {
    // Resolve the label at add time so the list survives the item being renamed or removed — a wish
    // list that shows "(deleted item)" is worse than one showing what the customer actually wanted.
    let label: string;
    let businessId: string | null = null;

    if (input.subjectType === 'menu_item') {
      const item = await MenuItemModel.findById(input.subjectId).lean();
      if (!item) throw NotFoundError('Menu item not found');
      label = item.name;
      businessId = String(item.business_id);
    } else {
      const product = await ProductModel.findById(input.subjectId).lean();
      if (!product) throw NotFoundError('Product not found');
      label = product.name;
      businessId = null;
    }

    try {
      const doc = await WishlistItemModel.create({
        user_id: principal.userId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        label,
        business_id: businessId,
      });
      return view(doc.toObject());
    } catch (err) {
      // Already on the list. Adding twice is not an error a user should see — it is what they
      // wanted, and it is already true.
      const existing = await WishlistItemModel.findOne({
        user_id: principal.userId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
      }).lean();
      if (existing) return view(existing);
      throw err;
    }
  },

  async remove(principal: Principal, id: string) {
    const deleted = await WishlistItemModel.findOneAndDelete({
      _id: id,
      user_id: principal.userId,
    }).lean();
    if (!deleted) throw NotFoundError('Wish list item not found');
    return { removed: true };
  },

  async list(principal: Principal) {
    const items = await WishlistItemModel.find({ user_id: principal.userId })
      .sort({ created_at: -1 })
      .limit(200)
      .lean();
    return items.map(view);
  },

  /**
   * Fire the back-in-stock alert for one subject.
   *
   * Called from the two places availability can rise: a vendor marking a menu item available again,
   * and consignment stock being returned or restocked. **Not** a sweep — polling for "did anything
   * come back?" would be a scan of every wish on every tick, and the write that changes
   * availability already knows it happened.
   *
   * Never throws. A vendor restocking their menu must not fail because a notification did.
   */
  async notifyBackInStock(
    subjectType: WishlistSubject,
    subjectId: string,
    context: { label?: string; businessId?: string | null } = {},
  ): Promise<number> {
    try {
      const waiting = await WishlistItemModel.find({
        subject_type: subjectType,
        subject_id: subjectId,
        notified_at: null,
      })
        .limit(500)
        .lean();
      if (waiting.length === 0) return 0;

      const now = new Date();
      await WishlistItemModel.updateMany(
        { _id: { $in: waiting.map((w) => w._id) } },
        { $set: { notified_at: now } },
      );

      for (const wish of waiting) {
        notificationsService.notify(wish.user_id, {
          category: 'wishlist',
          title: 'Back in stock',
          body: `${context.label ?? wish.label} is available again.`,
          data: {
            subjectType,
            subjectId,
            businessId: context.businessId ?? wish.business_id ?? null,
          },
        });
      }
      return waiting.length;
    } catch (err) {
      logger.error({ err, subjectType, subjectId }, 'back-in-stock notification failed');
      return 0;
    }
  },

  /** How many people are waiting — shown to the vendor, because it is a reason to restock. */
  async waitingCount(subjectType: WishlistSubject, subjectId: string): Promise<number> {
    return WishlistItemModel.countDocuments({
      subject_type: subjectType,
      subject_id: subjectId,
      notified_at: null,
    });
  },
};
