import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requireFeature } from '../../middleware/requireFeature';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ownsSuggestedBusiness } from '../vendors/vendors.controller';
import { consignmentController } from './consignment.controller';
import {
  AcceptAgreementBody,
  AddProductBody,
  ApprovalPolicyBody,
  CheckoutBody,
  CheckoutIdParam,
  DeclineCheckoutBody,
  AutoRenewBody,
  CommissionBody,
  ExtendTermBody,
  FeePreviewQuery,
  HubIdParam,
  LogSaleBody,
  NearbyProductsQuery,
  ProductIdParam,
  ReducePriceBody,
  RegisterHubBody,
  ReturnBody,
} from './consignment.schema';

// Seller-side discovery: browse available consignment inventory across hubs (S-01).
export const productsRouter = Router();
productsRouter.get(
  '/nearby',
  rateLimit('read'),
  requireFeature('consignment'),
  authenticate,
  validate({ query: NearbyProductsQuery }),
  asyncHandler(consignmentController.nearbyProducts),
);
productsRouter.get(
  '/:id',
  rateLimit('read'),
  requireFeature('consignment'),
  authenticate,
  validate({ params: ProductIdParam }),
  asyncHandler(consignmentController.discoveryProduct),
);

// Hubs + products.
export const hubsRouter = Router();

// The current operator's hubs (static path — must precede the `/:id/*` routes below).
hubsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  asyncHandler(consignmentController.myHubs),
);
hubsRouter.post(
  '/',
  rateLimit('write'),
  requireFeature('consignment'),
  authenticate,
  validate({ body: RegisterHubBody }),
  requirePermission('hub:register', ownsSuggestedBusiness),
  asyncHandler(consignmentController.registerHub),
);
hubsRouter.post(
  '/:id/products',
  rateLimit('write'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam, body: AddProductBody }),
  asyncHandler(consignmentController.addProduct),
);
hubsRouter.get(
  '/:id/products',
  rateLimit('read'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.listHubProducts),
);
// H-08 hub analytics — consignment performance for the hub the caller owns.
hubsRouter.get(
  '/:id/analytics',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.hubAnalytics),
);
// The station's rotating check-in token (Phase 6). Owner-only, never cached.
hubsRouter.get(
  '/:id/qr',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.stationToken),
);
// H-03 approval queue + the auto-approve rule that governs it (owner-only).
hubsRouter.get(
  '/:id/approvals',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.pendingApprovals),
);
hubsRouter.get(
  '/:id/approval-policy',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.getApprovalPolicy),
);
hubsRouter.patch(
  '/:id/approval-policy',
  rateLimit('write'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam, body: ApprovalPolicyBody }),
  asyncHandler(consignmentController.setApprovalPolicy),
);
// Owner-only reconciliation surfaces (H-04 live holders, H-05 settlements).
hubsRouter.get(
  '/:id/products/holders',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.hubHolders),
);
/**
 * C-5 — the same holders, plotted. A hub owner hands stock to people who walk away with it; this is
 * the only surface that answers "where is my inventory right now". Owner-only: it discloses the live
 * positions of specific sellers, which nobody else has any business seeing.
 */
hubsRouter.get(
  '/:id/inventory-map',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.hubInventoryMap),
);
hubsRouter.get(
  '/:id/settlements',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(consignmentController.hubSettlements),
);

// Seller agreement.
export const sellerAgreementRouter = Router();
sellerAgreementRouter.post(
  '/accept',
  rateLimit('write'),
  authenticate,
  requirePermission('seller:agreement'),
  validate({ body: AcceptAgreementBody }),
  asyncHandler(consignmentController.acceptAgreement),
);

// Checkouts (seller lifecycle).
export const checkoutsRouter = Router();

checkoutsRouter.post(
  '/',
  rateLimit('money'),
  requireFeature('consignment'),
  authenticate,
  requirePermission('checkout:create'), // seller + Bronze tier
  validate({ body: CheckoutBody }),
  asyncHandler(consignmentController.checkout),
);
checkoutsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  asyncHandler(consignmentController.listMine),
);
// Seller earnings feed (GAP-6, S-13). Static path — must precede the `/:id/*` routes below.
checkoutsRouter.get(
  '/earnings',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  asyncHandler(consignmentController.earnings),
);
// S-15 seller analytics — what sells, where, and how fast. Static path, before `/:id/*`.
checkoutsRouter.get(
  '/analytics',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  asyncHandler(consignmentController.sellerAnalytics),
);
// Pre-publish fee calculator (R12, S-13). Static path — must precede the `/:id/*` routes below.
checkoutsRouter.get(
  '/fee-preview',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ query: FeePreviewQuery }),
  asyncHandler(consignmentController.feePreview),
);
checkoutsRouter.post(
  '/:id/sales',
  rateLimit('money'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam, body: LogSaleBody }),
  asyncHandler(consignmentController.logSale),
);
checkoutsRouter.post(
  '/:id/return',
  rateLimit('money'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam, body: ReturnBody }),
  asyncHandler(consignmentController.returnInventory),
);
checkoutsRouter.get(
  '/:id/settlement',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam }),
  asyncHandler(consignmentController.getSettlement),
);
// ─── Consignment lifecycle actions (R15/R18) ──
checkoutsRouter.post(
  '/:id/extend',
  rateLimit('write'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam, body: ExtendTermBody }),
  asyncHandler(consignmentController.extendTerm),
);
checkoutsRouter.post(
  '/:id/reduce-price',
  rateLimit('write'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam, body: ReducePriceBody }),
  asyncHandler(consignmentController.reducePrice),
);
// H-03: the hub owner's decision on a pending reservation. Gated on hub:manage; the service
// additionally asserts the caller owns the hub the checkout belongs to.
checkoutsRouter.post(
  '/:id/approve',
  rateLimit('write'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: CheckoutIdParam }),
  asyncHandler(consignmentController.approveCheckout),
);
checkoutsRouter.post(
  '/:id/decline',
  rateLimit('write'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: CheckoutIdParam, body: DeclineCheckoutBody }),
  asyncHandler(consignmentController.declineCheckout),
);
// §39 — either party may switch automatic renewal on or off, right up until it fires.
checkoutsRouter.post(
  '/:id/auto-renew',
  rateLimit('write'),
  authenticate,
  requirePermission('checkout:end'),
  validate({ params: CheckoutIdParam, body: AutoRenewBody }),
  asyncHandler(consignmentController.setAutoRenew),
);
// §36 — the hub changes the seller's share going forward (never retroactively).
checkoutsRouter.post(
  '/:id/commission',
  rateLimit('write'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: CheckoutIdParam, body: CommissionBody }),
  asyncHandler(consignmentController.changeCommission),
);

// Mutual termination (spec §37): seller OR hub owner. The service resolves which, and rejects
// anyone who is neither party to the consignment.
checkoutsRouter.post(
  '/:id/end',
  rateLimit('write'),
  authenticate,
  requirePermission('checkout:end'),
  validate({ params: CheckoutIdParam }),
  asyncHandler(consignmentController.endConsignment),
);
