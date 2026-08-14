import express, { Router, type Request, type Response } from 'express';

import { logger } from '../config/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { kyc } from '../integrations/kyc';
import { verificationService } from '../modules/identity/verification.service';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError } from '../shared/errors/AppError';
import { ok } from '../shared/respond';

/**
 * KYC provider webhook (Persona-style HMAC). Stripe Identity events arrive via the Stripe webhook;
 * this endpoint serves providers with their own signed webhook. Signature-verified on raw body.
 */
export const kycWebhookRouter = Router();

kycWebhookRouter.post(
  '/kyc',
  express.raw({ type: '*/*', limit: '256kb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const signature =
      req.header('persona-signature') ??
      req.header('x-signature') ??
      req.header('webhook-signature');
    const result = kyc().parseWebhook(req.body as Buffer, signature);
    if (!result) {
      throw ForbiddenError(
        'Invalid or unrecognized KYC webhook',
        ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
      );
    }
    await verificationService.applyKycResult(result.providerReference, result.status);
    logger.info({ status: result.status }, 'kyc webhook applied');
    ok(res, { received: true, applied: true });
  }),
);
