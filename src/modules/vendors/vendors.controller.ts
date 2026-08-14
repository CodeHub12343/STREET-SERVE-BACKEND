import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { ForbiddenError, UnauthenticatedError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import type {
  BusinessIdParam,
  CategorySuggestionBody,
  CreateBusinessBody,
  CreateMenuItemBody,
  IdParam,
  LicenseDocumentBody,
  MenuItemParams,
  ReviewCategorySuggestionBody,
  ReviewLicenseBody,
  SetModulesBody,
  UpdateBusinessBody,
  UpdateCategoryBody,
  UpdateMenuItemBody,
} from './vendors.schema';
import { resolveModules, setEnabledModules } from './modules.service';
import { vendorsService } from './vendors.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/** Ownership resolver: the principal must own the business named by :id. */
export async function ownsBusiness(p: Principal, req: Request): Promise<boolean> {
  const owner = await vendorsService.getBusinessOwner(req.params.id ?? '');
  return owner === p.userId;
}

/** Ownership resolver for a suggestion body carrying businessId. */
export async function ownsSuggestedBusiness(p: Principal, req: Request): Promise<boolean> {
  const businessId = (req.body as { businessId?: string }).businessId;
  if (!businessId) return false;
  const owner = await vendorsService.getBusinessOwner(businessId);
  return owner === p.userId;
}

export const vendorsController = {
  /** 7.5 / P-14 — bookable pickup slots, generated from the vendor's settings. */
  pickupSlots: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await vendorsService.pickupSlots(id));
  },
  createBusiness: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateBusinessBody>>(req);
    const result = await vendorsService.createBusiness(principal(req), input);
    created(res, result);
  },

  /** Self-scoped: returns only the caller's own businesses, so no extra permission is needed. */
  listMyBusinesses: async (req: Request, res: Response): Promise<void> => {
    ok(res, await vendorsService.listMyBusinesses(principal(req)));
  },

  getBusiness: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    // Public read, but a signed-in viewer (optionalAuth) also gets their `following` flag.
    ok(res, await vendorsService.getBusiness(id, req.principal?.userId));
  },

  updateBusiness: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const patch = body<z.infer<typeof UpdateBusinessBody>>(req);
    ok(res, await vendorsService.updateBusiness(id, patch));
  },

  registerHub: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await vendorsService.registerHub(id));
  },

  onboardPayouts: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await vendorsService.onboardBusinessPayouts(principal(req), id));
  },

  listMenu: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await vendorsService.listMenu(id));
  },

  addMenuItem: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateMenuItemBody>>(req);
    created(res, await vendorsService.addMenuItem(id, input));
  },

  updateMenuItem: async (req: Request, res: Response): Promise<void> => {
    const { id, itemId } = params<z.infer<typeof MenuItemParams>>(req);
    // Defense in depth: ensure the item belongs to the business in the path.
    const owningBusiness = await vendorsService.getMenuItemBusiness(itemId);
    if (owningBusiness !== id)
      throw ForbiddenError('Item not in this business', ERROR_CODES.NOT_OWNER);
    const patch = body<z.infer<typeof UpdateMenuItemBody>>(req);
    ok(res, await vendorsService.updateMenuItem(itemId, patch));
  },

  submitCategorySuggestion: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CategorySuggestionBody>>(req);
    created(res, await vendorsService.submitCategorySuggestion(input.businessId, input));
  },

  submitLicenseDocument: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof LicenseDocumentBody>>(req);
    created(
      res,
      await vendorsService.submitLicenseDocument(id, input.categoryId, input.documentUrl),
    );
  },

  /** Public: the customer profile reads this too, to choose Book vs Order vs Wave. */
  getModules: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await resolveModules(id));
  },

  setModules: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const { enabled } = body<z.infer<typeof SetModulesBody>>(req);
    ok(res, await setEnabledModules(id, enabled));
  },

  removeMenuItem: async (req: Request, res: Response): Promise<void> => {
    const { itemId } = params<z.infer<typeof MenuItemParams>>(req);
    ok(res, await vendorsService.removeMenuItem(itemId));
  },

  listLicenseDocuments: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await vendorsService.listLicenseDocuments(id));
  },

  // ─── Admin review ───────────────────────────────────────────────────────────────────────
  listCategorySuggestionsForReview: async (req: Request, res: Response): Promise<void> => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    ok(res, await vendorsService.listCategorySuggestionsForReview(status));
  },

  listCategoriesForAdmin: async (_req: Request, res: Response): Promise<void> => {
    ok(res, await vendorsService.listCategoriesForAdmin());
  },

  updateCategory: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    const patch = body<z.infer<typeof UpdateCategoryBody>>(req);
    ok(res, await vendorsService.updateCategory(principal(req).userId, id, patch));
  },

  listLicenseDocumentsForReview: async (req: Request, res: Response): Promise<void> => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    ok(res, await vendorsService.listLicenseDocumentsForReview(status));
  },

  reviewCategorySuggestion: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    const decision = body<z.infer<typeof ReviewCategorySuggestionBody>>(req);
    ok(res, await vendorsService.reviewCategorySuggestion(principal(req).userId, id, decision));
  },

  reviewLicenseDocument: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    const { approve } = body<z.infer<typeof ReviewLicenseBody>>(req);
    ok(res, await vendorsService.reviewLicenseDocument(principal(req).userId, id, approve));
  },
};
