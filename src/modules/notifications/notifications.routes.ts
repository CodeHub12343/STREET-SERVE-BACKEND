import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { notificationsController } from './notifications.controller';
import {
  NotificationIdParam,
  NotificationPrefsBody,
  PushSubscriptionBody,
  RemovePushBody,
} from './notifications.schema';

/**
 * User-scoped notification inbox (GAP-3) + web-push subscriptions (GAP-4). Mounted at `/users`
 * so paths resolve to `/users/me/notifications` and `/users/me/push-tokens`.
 */
export const notificationsRouter = Router();

// ─── Inbox (GAP-3) ────────────────────────────────────────────────────────────────────────────
notificationsRouter.get(
  '/me/notifications',
  rateLimit('read'),
  authenticate,
  requirePermission('notifications:read_self'),
  validate({ query: PaginationQuery }),
  asyncHandler(notificationsController.list),
);

notificationsRouter.post(
  '/me/notifications/read-all',
  rateLimit('write'),
  authenticate,
  requirePermission('notifications:manage_self'),
  asyncHandler(notificationsController.markAllRead),
);

notificationsRouter.post(
  '/me/notifications/:id/read',
  rateLimit('write'),
  authenticate,
  requirePermission('notifications:manage_self'),
  validate({ params: NotificationIdParam }),
  asyncHandler(notificationsController.markRead),
);

// ─── Web Push subscriptions (GAP-4) ────────────────────────────────────────────────────────────
notificationsRouter.post(
  '/me/push-tokens',
  rateLimit('write'),
  authenticate,
  requirePermission('notifications:manage_self'),
  validate({ body: PushSubscriptionBody }),
  asyncHandler(notificationsController.registerPush),
);

notificationsRouter.delete(
  '/me/push-tokens',
  rateLimit('write'),
  authenticate,
  requirePermission('notifications:manage_self'),
  validate({ body: RemovePushBody }),
  asyncHandler(notificationsController.removePush),
);

// ─── Per-category preferences (C-37 Settings) ──────────────────────────────────────────────────
// The Settings screen has always called these two; they were never implemented, so all six
// switches read a 404 and wrote to nothing while appearing to work.
notificationsRouter.get(
  '/me/notification-preferences',
  rateLimit('read'),
  authenticate,
  requirePermission('notifications:read_self'),
  asyncHandler(notificationsController.getPreferences),
);

notificationsRouter.patch(
  '/me/notification-preferences',
  rateLimit('write'),
  authenticate,
  requirePermission('notifications:manage_self'),
  validate({ body: NotificationPrefsBody }),
  asyncHandler(notificationsController.updatePreferences),
);
