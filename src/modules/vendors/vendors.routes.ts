import { Router } from 'express';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { requireModule } from '../../middleware/requireModule';
import { validate } from '../../middleware/validate';
import { paymentsController } from '../payments/payments.controller';
import { queueController } from '../queue/queue.controller';
import { ownsBusiness, ownsSuggestedBusiness, vendorsController } from './vendors.controller';
import {
  BusinessIdParam,
  CategorySuggestionBody,
  CreateBusinessBody,
  CreateMenuItemBody,
  LicenseDocumentBody,
  MenuItemParams,
  SetModulesBody,
  UpdateBusinessBody,
  UpdateMenuItemBody,
} from './vendors.schema';

export const businessesRouter = Router();

// Create a business (vendor/hub role).
businessesRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('business:create'),
  validate({ body: CreateBusinessBody }),
  asyncHandler(vendorsController.createBusiness),
);

// The caller's own businesses (vendor dashboard resolves its active business here).
// MUST be declared before '/:id' — Express matches in order, so otherwise 'mine' would bind
// to :id and fail the 24-char ObjectId validation with a 400.
businessesRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  asyncHandler(vendorsController.listMyBusinesses),
);

// Public read; optionalAuth so a signed-in viewer gets their `following` flag.
businessesRouter.get(
  '/:id',
  rateLimit('read'),
  optionalAuth,
  validate({ params: BusinessIdParam }),
  asyncHandler(vendorsController.getBusiness),
);

// Resolved module set. Public: the customer profile uses it to pick its primary action
// (Book / Order / Wave), so it must not require the owner's session.
businessesRouter.get(
  '/:id/modules',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(vendorsController.getModules),
);

businessesRouter.put(
  '/:id/modules',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: SetModulesBody }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(vendorsController.setModules),
);

// Owner-only mutations.
businessesRouter.patch(
  '/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: UpdateBusinessBody }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(vendorsController.updateBusiness),
);

businessesRouter.post(
  '/:id/register-hub',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(vendorsController.registerHub),
);

businessesRouter.post(
  '/:id/payouts/onboard',
  rateLimit('money'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(vendorsController.onboardPayouts),
);

// The vendor's payouts screen: connection status, Stripe balance, and the real earnings ledger.
businessesRouter.get(
  '/:id/payouts',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(paymentsController.businessPayouts),
);

// The vendor's queue-management view (the live line, with names — owner-only).
businessesRouter.get(
  '/:id/queue',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(queueController.getManageView),
);

// Serve the front of the line — advances the queue (owner-only).
businessesRouter.post(
  '/:id/queue/serve-next',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('business:manage_own', ownsBusiness),
  asyncHandler(queueController.serveNext),
);

// Menu — public read, owner write.
businessesRouter.get(
  '/:id/menu',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(vendorsController.listMenu),
);

/** 7.5 / P-14 — the pickup times a customer can choose. Public: it is part of deciding to order. */
businessesRouter.get(
  '/:id/pickup-slots',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(vendorsController.pickupSlots),
);

businessesRouter.post(
  '/:id/menu',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: CreateMenuItemBody }),
  requirePermission('menu:manage_own', ownsBusiness),
  requireModule('menu'),
  asyncHandler(vendorsController.addMenuItem),
);

businessesRouter.patch(
  '/:id/menu/:itemId',
  rateLimit('write'),
  authenticate,
  validate({ params: MenuItemParams, body: UpdateMenuItemBody }),
  requirePermission('menu:manage_own', ownsBusiness),
  requireModule('menu'),
  asyncHandler(vendorsController.updateMenuItem),
);

// Hard delete is safe: order line items snapshot name + unit price, so receipts survive it.
businessesRouter.delete(
  '/:id/menu/:itemId',
  rateLimit('write'),
  authenticate,
  validate({ params: MenuItemParams }),
  requirePermission('menu:manage_own', ownsBusiness),
  requireModule('menu'),
  asyncHandler(vendorsController.removeMenuItem),
);

// The owner's incoming wave-down inbox (V-03). Read stays open of requireModule per the gate-writes
// -only rule; the service still asserts ownership so only the owner sees their waves.
businessesRouter.get(
  '/:id/wave-downs',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('wave:respond', ownsBusiness),
  asyncHandler(queueController.listIncomingWaveDowns),
);

// License document submission (owner).
businessesRouter.post(
  '/:id/license-documents',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdParam, body: LicenseDocumentBody }),
  requirePermission('license:submit_own', ownsBusiness),
  asyncHandler(vendorsController.submitLicenseDocument),
);

// The owner's own licence documents + review status (drives the "why can't I go live" view).
businessesRouter.get(
  '/:id/license-documents',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('license:submit_own', ownsBusiness),
  asyncHandler(vendorsController.listLicenseDocuments),
);

// Category suggestions (vendor/hub; must own the submitting business).
export const categorySuggestionsRouter = Router();
categorySuggestionsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  validate({ body: CategorySuggestionBody }),
  requirePermission('category_suggestion:create', ownsSuggestedBusiness),
  asyncHandler(vendorsController.submitCategorySuggestion),
);
