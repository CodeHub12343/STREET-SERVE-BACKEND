import { Router } from 'express';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { livemapController } from './livemap.controller';
import {
  BusinessIdParam,
  CurrentSessionQuery,
  LocationBody,
  BBoxQuery,
  NearbyQuery,
  SessionIdParam,
  StartSessionBody,
  StatusBody,
  TrendingQuery,
} from './livemap.schema';

// ─── /live-sessions (vendor/seller broadcast; service asserts actor control) ────────────────
export const liveSessionsRouter = Router();

liveSessionsRouter.post(
  '/start',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ body: StartSessionBody }),
  asyncHandler(livemapController.start),
);
// Read the actor's current live session so the dashboard can rehydrate after a reload.
liveSessionsRouter.get(
  '/current',
  rateLimit('read'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ query: CurrentSessionQuery }),
  asyncHandler(livemapController.currentSession),
);
liveSessionsRouter.patch(
  '/:id/location',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ params: SessionIdParam, body: LocationBody }),
  asyncHandler(livemapController.location),
);
liveSessionsRouter.patch(
  '/:id/status',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ params: SessionIdParam, body: StatusBody }),
  asyncHandler(livemapController.setStatus),
);
liveSessionsRouter.post(
  '/:id/pop-up',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ params: SessionIdParam }),
  asyncHandler(livemapController.popUp),
);
// Keep-alive ping from an open vendor dashboard — refreshes last_ping_at so the stale-session sweep
// only reaps sessions whose tab has actually closed.
liveSessionsRouter.post(
  '/:id/heartbeat',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ params: SessionIdParam }),
  asyncHandler(livemapController.heartbeat),
);
liveSessionsRouter.post(
  '/:id/stop',
  rateLimit('write'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ params: SessionIdParam }),
  asyncHandler(livemapController.stop),
);

// ─── /map (public discovery) ────────────────────────────────────────────────────────────────
export const mapRouter = Router();
mapRouter.get(
  '/nearby',
  rateLimit('read'),
  optionalAuth,
  validate({ query: NearbyQuery }),
  asyncHandler(livemapController.nearby),
);
// Trending (R1b) — public discovery row that rewards discounting vendors.
mapRouter.get(
  '/trending',
  rateLimit('read'),
  optionalAuth,
  validate({ query: TrendingQuery }),
  asyncHandler(livemapController.trending),
);

/**
 * C-1/C-2 — consignment hubs in the viewport, with what's checkoutable there. Public: hub locations
 * are shopfronts, and a seller deciding whether to sign up needs to see supply exists near them.
 */
mapRouter.get(
  '/hubs',
  rateLimit('read'),
  optionalAuth,
  validate({ query: BBoxQuery }),
  asyncHandler(livemapController.hubs),
);

/**
 * C-3 — demand tiles. Aggregate only, floored at `DEMAND_MIN_TILE_WEIGHT`, and never carries an
 * actor id: this shows WHERE demand is, never WHO is asking. Authenticated because it is a
 * commercial signal for vendors deciding where to go, not public discovery.
 */
mapRouter.get(
  '/demand',
  rateLimit('read'),
  authenticate,
  validate({ query: BBoxQuery }),
  asyncHandler(livemapController.demand),
);

// ─── Follow / Notify-Me on /businesses (mounted alongside vendors' businessesRouter) ────────
export const engagementRouter = Router();
engagementRouter.post(
  '/:id/follow',
  rateLimit('write'),
  authenticate,
  requirePermission('follow:manage'),
  validate({ params: BusinessIdParam }),
  asyncHandler(livemapController.follow),
);
engagementRouter.delete(
  '/:id/follow',
  rateLimit('write'),
  authenticate,
  requirePermission('follow:manage'),
  validate({ params: BusinessIdParam }),
  asyncHandler(livemapController.unfollow),
);
engagementRouter.post(
  '/:id/notify-me',
  rateLimit('write'),
  authenticate,
  requirePermission('follow:manage'),
  validate({ params: BusinessIdParam }),
  asyncHandler(livemapController.notifyMe),
);

// ─── Favorites on /users ─────────────────────────────────────────────────────────────────────
export const favoritesRouter = Router();
favoritesRouter.get(
  '/me/favorites',
  rateLimit('read'),
  authenticate,
  requirePermission('follow:manage'),
  asyncHandler(livemapController.favorites),
);
