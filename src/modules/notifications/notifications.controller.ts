import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  NotificationIdParam,
  NotificationPrefsBody,
  PushSubscriptionBody,
  RemovePushBody,
} from './notifications.schema';
import { PaginationQuery } from '../../shared/pagination';
import { notificationsService } from './notifications.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const notificationsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof PaginationQuery>>(req);
    const page = await notificationsService.list(principal(req).userId, {
      cursor: q.cursor,
      limit: q.limit,
    });
    const unread = await notificationsService.unreadCount(principal(req).userId);
    ok(res, page.items, { nextCursor: page.nextCursor, unread });
  },

  markRead: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof NotificationIdParam>>(req);
    ok(res, await notificationsService.markRead(principal(req).userId, id));
  },

  markAllRead: async (req: Request, res: Response): Promise<void> => {
    ok(res, await notificationsService.markAllRead(principal(req).userId));
  },

  registerPush: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof PushSubscriptionBody>>(req);
    created(
      res,
      await notificationsService.registerPushSubscription(principal(req).userId, {
        endpoint: input.endpoint,
        keys: input.keys,
        userAgent: input.userAgent,
      }),
    );
  },

  removePush: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof RemovePushBody>>(req);
    ok(res, await notificationsService.removePushSubscription(principal(req).userId, input.endpoint));
  },

  getPreferences: async (req: Request, res: Response): Promise<void> => {
    ok(res, await notificationsService.getPreferences(principal(req).userId));
  },

  updatePreferences: async (req: Request, res: Response): Promise<void> => {
    const patch = body<z.infer<typeof NotificationPrefsBody>>(req);
    // Echo the full resulting state, so the client renders what the server actually stored
    // rather than assuming its optimistic guess was accepted.
    ok(
      res,
      await notificationsService.updatePreferences(
        principal(req).userId,
        patch as Record<string, boolean>,
      ),
    );
  },
};
