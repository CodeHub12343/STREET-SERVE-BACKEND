import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { vendorsController } from './vendors.controller';
import {
  IdParam,
  ReviewCategorySuggestionBody,
  ReviewLicenseBody,
  ReviewQueueQuery,
  UpdateCategoryBody,
} from './vendors.schema';

/**
 * Admin review surface for Trust & Safety. Mounted under /api/v1/admin alongside the admin module.
 */
export const vendorsAdminRouter = Router();

// Review queue (A-03). `?status=` defaults to pending. Until BP-5 the client had no listing
// endpoint at all and rendered demo data.
vendorsAdminRouter.get(
  '/category-suggestions',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:review_category_suggestion'),
  validate({ query: ReviewQueueQuery }),
  asyncHandler(vendorsController.listCategorySuggestionsForReview),
);

vendorsAdminRouter.post(
  '/category-suggestions/:id/review',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:review_category_suggestion'),
  validate({ params: IdParam, body: ReviewCategorySuggestionBody }),
  asyncHandler(vendorsController.reviewCategorySuggestion),
);

// Taxonomy governance: the full list (incl. inactive) + correcting archetype/licence metadata.
vendorsAdminRouter.get(
  '/categories',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_categories'),
  asyncHandler(vendorsController.listCategoriesForAdmin),
);

vendorsAdminRouter.patch(
  '/categories/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_categories'),
  validate({ params: IdParam, body: UpdateCategoryBody }),
  asyncHandler(vendorsController.updateCategory),
);

// Review queue (A-03). `?status=` defaults to pending.
vendorsAdminRouter.get(
  '/license-documents',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:review_license'),
  asyncHandler(vendorsController.listLicenseDocumentsForReview),
);

vendorsAdminRouter.post(
  '/license-documents/:id/review',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:review_license'),
  validate({ params: IdParam, body: ReviewLicenseBody }),
  asyncHandler(vendorsController.reviewLicenseDocument),
);
