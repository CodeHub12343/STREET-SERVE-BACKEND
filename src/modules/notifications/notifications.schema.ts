import { z } from 'zod';

import { NOTIFICATION_PREF_CATEGORIES } from '../../config/constants';

/** Web Push subscription payload — the browser's PushSubscription.toJSON() shape (GAP-4). */
export const PushSubscriptionBody = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      })
      .strict(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;

export const RemovePushBody = z.object({ endpoint: z.string().url().max(2048) }).strict();
export type RemovePushBody = z.infer<typeof RemovePushBody>;

export const NotificationIdParam = z.object({ id: z.string().length(24) }).strict();
export type NotificationIdParam = z.infer<typeof NotificationIdParam>;

/**
 * Partial patch of per-category notification switches. Built from the shared category list and
 * `.strict()`, so an unknown category is a 400 rather than a silently ignored write that leaves
 * the user believing they changed something.
 */
export const NotificationPrefsBody = z
  .object(
    Object.fromEntries(NOTIFICATION_PREF_CATEGORIES.map((c) => [c, z.boolean().optional()])) as {
      [K in (typeof NOTIFICATION_PREF_CATEGORIES)[number]]: z.ZodOptional<z.ZodBoolean>;
    },
  )
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one category' });
export type NotificationPrefsBody = z.infer<typeof NotificationPrefsBody>;
