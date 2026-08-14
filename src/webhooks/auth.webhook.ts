import express, { Router, type Request, type Response } from 'express';

import { logger } from '../config/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { parseUserSyncEvent, verifyWebhookSignature } from '../integrations/auth/webhook';
import { identityService } from '../modules/identity/identity.service';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError } from '../shared/errors/AppError';
import { ok } from '../shared/respond';

/**
 * Managed-auth user lifecycle sync. Signature-verified on the RAW body, exempt from bearer auth
 * but never from verification (THIRD_PARTY_INTEGRATIONS.md §9). Uses express.raw so the exact
 * bytes are available to the HMAC check.
 */
export const authWebhookRouter = Router();

authWebhookRouter.post(
  '/clerk',
  rateLimit('write'),
  express.raw({ type: '*/*', limit: '256kb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const signature =
      req.header('svix-signature') ?? req.header('x-signature') ?? req.header('webhook-signature');

    if (!verifyWebhookSignature(raw, signature)) {
      throw ForbiddenError('Invalid webhook signature', ERROR_CODES.WEBHOOK_SIGNATURE_INVALID);
    }

    const payload: unknown = JSON.parse(raw.toString('utf8'));
    const event = parseUserSyncEvent(payload);
    if (!event) {
      // Acknowledge unrecognized events so the provider stops retrying.
      logger.info('ignored unrecognized user-sync webhook event');
      return ok(res, { received: true, applied: false });
    }

    await identityService.applyUserSyncEvent(event);
    logger.info({ type: event.type, authProviderId: event.authProviderId }, 'user-sync applied');
    ok(res, { received: true, applied: true });
  }),
);
