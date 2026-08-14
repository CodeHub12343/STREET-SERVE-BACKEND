import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { postcardsController } from './postcards.controller';
import {
  AssetIdParam,
  BusinessIdParam,
  CreateUploadBody,
  ModerateBody,
  PilotAddBody,
  PilotRemoveBody,
  QueueQuery,
  SkuParam,
  ValidateArtworkBody,
  CancelOrderBody,
  ConfigureOrderBody,
  CreateAudienceBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderIdParam,
  RefundOrderBody,
  SettlementIdParam,
  ConfirmSettlementBody,
  VoidSettlementBody,
  SettlementListQuery,
} from './postcards.schema';

/**
 * Postcard Marketing (ADR-007). Mounted at `/postcards`.
 *
 * Unlike Boost, **nothing here is public**. A Boost campaign is public because a campaign nobody
 * can see raises nothing; a business's own mailing plan is commercial information — which areas it
 * is targeting and what it is spending — and is readable only by the business that owns it. Every
 * order route re-checks ownership in the service; the permission only establishes the role.
 *
 * Phase 3 has no money path, so nothing here carries `rateLimit('money')` or `idempotency` yet.
 * Both arrive with checkout.
 */
export const postcardsRouter = Router();

/** The catalogue. Public and cacheable — it is a price list. */
postcardsRouter.get('/products', rateLimit('read'), postcardsController.products);

/** Exact artwork requirements (4.4). Public alongside the catalogue — a designer may not have a login. */
postcardsRouter.get(
  '/products/:sku/artwork-spec',
  rateLimit('read'),
  validate({ params: SkuParam }),
  postcardsController.artworkSpec,
);

// ─── Artwork (PC-1, NF-2) ───────────────────────────────────────────────────────────────────
/**
 * Issues a presigned upload URL. The storage key is generated server-side and recorded against the
 * new asset, so the client never names a path — "no user-controlled paths" enforced structurally
 * rather than by validating a string it sends back.
 */
postcardsRouter.post(
  '/business/:businessId/artwork',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: BusinessIdParam, body: CreateUploadBody }),
  asyncHandler(postcardsController.createUploadTarget),
);

/** Fetches the uploaded header and runs pre-press. `write` — it costs a storage read. */
postcardsRouter.post(
  '/artwork/:assetId/validate',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: AssetIdParam, body: ValidateArtworkBody }),
  asyncHandler(postcardsController.validateArtwork),
);

postcardsRouter.get(
  '/artwork/:assetId',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: AssetIdParam }),
  asyncHandler(postcardsController.getArtwork),
);

// ─── Money (Phase 5) ────────────────────────────────────────────────────────────────────────
/**
 * Checkout. `rateLimit('money')` and the `Idempotency-Key` middleware, as on every charge path.
 *
 * The order is NOT advanced here — only the Stripe webhook may mark it paid.
 */
postcardsRouter.post(
  '/orders/:orderId/pay',
  rateLimit('money'),
  authenticate,
  requirePermission('postcards:order'),
  idempotency,
  validate({ params: OrderIdParam }),
  asyncHandler(postcardsController.pay),
);

/** Full refund, allowed only while nothing has been printed (audit F-4). */
postcardsRouter.post(
  '/orders/:orderId/refund',
  rateLimit('money'),
  authenticate,
  requirePermission('postcards:order'),
  idempotency,
  validate({ params: OrderIdParam, body: RefundOrderBody }),
  asyncHandler(postcardsController.refund),
);

// ─── Vendor settlement (finance only) ───────────────────────────────────────────────────────
postcardsRouter.get(
  '/settlements',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:settle'),
  validate({ query: SettlementListQuery }),
  asyncHandler(postcardsController.listSettlements),
);

/** What we owe the vendor right now, and what they say our retainer holds. */
postcardsRouter.get(
  '/settlements/exposure',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:settle'),
  asyncHandler(postcardsController.exposure),
);

/** Manual close, for the same period the weekly sweep would have closed. */
postcardsRouter.post(
  '/settlements/close',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:settle'),
  asyncHandler(postcardsController.closeSettlement),
);

/**
 * Records that the vendor was actually paid, and discharges the liability in the ledger. This is
 * the step no cron performs: it asserts money left the company.
 */
postcardsRouter.post(
  '/settlements/:settlementId/confirm',
  rateLimit('money'),
  authenticate,
  requirePermission('postcards:settle'),
  idempotency,
  validate({ params: SettlementIdParam, body: ConfirmSettlementBody }),
  asyncHandler(postcardsController.confirmSettlement),
);

postcardsRouter.post(
  '/settlements/:settlementId/void',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:settle'),
  validate({ params: SettlementIdParam, body: VoidSettlementBody }),
  asyncHandler(postcardsController.voidSettlement),
);

// ─── Moderation (F-7) — staff only ──────────────────────────────────────────────────────────
postcardsRouter.get(
  '/moderation/queue',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:moderate'),
  validate({ query: QueueQuery }),
  asyncHandler(postcardsController.moderationQueue),
);

postcardsRouter.post(
  '/moderation/:assetId',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:moderate'),
  validate({ params: AssetIdParam, body: ModerateBody }),
  asyncHandler(postcardsController.moderateArtwork),
);

// ─── Pilot administration (Phase 8) ─────────────────────────────────────────────────────────
/**
 * Who is in the pilot, and the review that decides whether it ends.
 *
 * `postcards:administer` rather than `postcards:moderate`: reviewing one design and deciding which
 * businesses may spend money on printing are different powers, and the person doing the first all
 * day should not automatically hold the second.
 */
postcardsRouter.get(
  '/pilot',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:administer'),
  asyncHandler(postcardsController.pilotRoster),
);

postcardsRouter.post(
  '/pilot',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:administer'),
  validate({ body: PilotAddBody }),
  asyncHandler(postcardsController.pilotAdd),
);

postcardsRouter.post(
  '/pilot/remove',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:administer'),
  validate({ body: PilotRemoveBody }),
  asyncHandler(postcardsController.pilotRemove),
);

postcardsRouter.get(
  '/pilot/review',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:administer'),
  asyncHandler(postcardsController.pilotReview),
);

/** Vendor list types. Authenticated: it is a live upstream call, not a public catalogue. */
postcardsRouter.get(
  '/list-types',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:order'),
  asyncHandler(postcardsController.listTypes),
);

/**
 * Resolving an area costs a vendor call, so it is a `write` limit rather than a `read` one — this
 * is the one endpoint a bored client could use to hammer someone else's API on our credentials.
 */
postcardsRouter.post(
  '/business/:businessId/audiences',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: BusinessIdParam, body: CreateAudienceBody }),
  asyncHandler(postcardsController.createAudience),
);

postcardsRouter.post(
  '/business/:businessId/orders',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: BusinessIdParam, body: CreateOrderBody }),
  asyncHandler(postcardsController.createOrder),
);

postcardsRouter.get(
  '/business/:businessId/orders',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: BusinessIdParam, query: ListOrdersQuery }),
  asyncHandler(postcardsController.listOrders),
);

postcardsRouter.get(
  '/orders/:orderId',
  rateLimit('read'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: OrderIdParam }),
  asyncHandler(postcardsController.getOrder),
);

postcardsRouter.patch(
  '/orders/:orderId',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: OrderIdParam, body: ConfigureOrderBody }),
  asyncHandler(postcardsController.configureOrder),
);

/** Pricing hits the vendor, so `write` rather than `read`. */
postcardsRouter.post(
  '/orders/:orderId/quote',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: OrderIdParam }),
  asyncHandler(postcardsController.quoteOrder),
);

postcardsRouter.post(
  '/orders/:orderId/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('postcards:order'),
  validate({ params: OrderIdParam, body: CancelOrderBody }),
  asyncHandler(postcardsController.cancelOrder),
);
