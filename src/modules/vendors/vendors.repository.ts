import type { Types, UpdateQuery } from 'mongoose';

import {
  BusinessModel,
  CategorySuggestionModel,
  LicenseDocumentModel,
  MenuItemModel,
  type BusinessDoc,
  type MenuItemDoc,
} from './vendors.model';

/**
 * Explicit input types (not Partial<XDoc>) — InferSchemaType with custom timestamp field names
 * emits a `[x: string]: NativeDate` index signature that poisons Partial typing. Update payloads
 * are cast to UpdateQuery at the Mongoose boundary so ObjectId paths accept string ids (Mongoose
 * casts them at runtime).
 */
export interface NewBusiness {
  owner_user_id: string;
  name: string;
  category_id: Types.ObjectId | string;
  description?: string | null;
  logo_url?: string | null;
  is_hub?: boolean;
}
export interface BusinessPatch {
  name?: string;
  description?: string | null;
  logo_url?: string | null;
  cover_photo_url?: string | null;
  today_special_menu_item_id?: string | null;
  is_hub?: boolean;
  payout_account_ref?: string;
  /** The owner's explicit module set; `undefined` on the doc means inherit archetype defaults. */
  enabled_modules?: string[];
  hours?: { day: number; open: string; close: string }[];
  service_area?: { type: 'Point'; coordinates: [number, number] };
  service_radius_m?: number | null;
  travel_fee_cents?: number | null;
}
export interface NewMenuItem {
  business_id: string;
  name: string;
  price_cents: number;
  description?: string | null;
  photo_url?: string | null;
}
export interface MenuItemPatch {
  name?: string;
  price_cents?: number;
  is_available?: boolean;
  /** `null` clears the photo; `undefined` leaves it untouched (Mongoose strips undefined from $set). */
  photo_url?: string | null;
  description?: string | null;
}

export const vendorsRepository = {
  createBusiness(data: NewBusiness) {
    return BusinessModel.create(data);
  },
  findBusinessById(id: string) {
    return BusinessModel.findById(id).exec();
  },
  updateBusiness(id: string, patch: BusinessPatch) {
    return BusinessModel.findByIdAndUpdate(id, { $set: patch } as UpdateQuery<BusinessDoc>, {
      new: true,
    }).exec();
  },
  listBusinessesByOwner(ownerUserId: string) {
    return BusinessModel.find({ owner_user_id: ownerUserId }).lean().exec();
  },

  createMenuItem(data: NewMenuItem) {
    return MenuItemModel.create(data);
  },
  findMenuItemById(id: string) {
    return MenuItemModel.findById(id).exec();
  },
  updateMenuItem(id: string, patch: MenuItemPatch) {
    return MenuItemModel.findByIdAndUpdate(id, { $set: patch } as UpdateQuery<MenuItemDoc>, {
      new: true,
    }).exec();
  },
  listMenu(businessId: string) {
    return MenuItemModel.find({ business_id: businessId }).sort({ created_at: 1 }).lean().exec();
  },

  createSuggestion(data: {
    submitted_by_business_id: string;
    proposed_name: string;
    proposed_parent_category_id?: string | null;
    justification?: string;
  }) {
    return CategorySuggestionModel.create(data);
  },
  findSuggestionById(id: string) {
    return CategorySuggestionModel.findById(id).exec();
  },
  listSuggestionsByStatus(status: string) {
    return CategorySuggestionModel.find({ status }).sort({ created_at: 1 }).lean().exec();
  },
  updateSuggestion(id: string, patch: Record<string, unknown>) {
    return CategorySuggestionModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  createLicenseDocument(data: { business_id: string; category_id: string; document_url: string }) {
    return LicenseDocumentModel.create(data);
  },
  findLicenseById(id: string) {
    return LicenseDocumentModel.findById(id).exec();
  },
  updateLicense(id: string, patch: Record<string, unknown>) {
    return LicenseDocumentModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },
  hasApprovedLicense(businessId: string, categoryId: string) {
    return LicenseDocumentModel.exists({
      business_id: businessId,
      category_id: categoryId,
      status: 'approved',
    }).then(Boolean);
  },
  deleteMenuItem(id: string) {
    return MenuItemModel.findByIdAndDelete(id).exec();
  },
  listLicensesByBusiness(businessId: string) {
    return LicenseDocumentModel.find({ business_id: businessId })
      .sort({ created_at: -1 })
      .lean()
      .exec();
  },
  listLicensesByStatus(status: string) {
    return LicenseDocumentModel.find({ status }).sort({ created_at: 1 }).lean().exec();
  },
};
