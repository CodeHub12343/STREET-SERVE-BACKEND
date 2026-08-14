import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, validate } from '../../middleware/validate';
import { isAllowedUploadType, storage } from '../../integrations/storage';
import { ok } from '../../shared/respond';
import { BusinessRuleError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';

/**
 * Presigned-upload endpoint. Any authenticated user can request an upload URL for condition/
 * evidence/product photos; the client PUTs bytes directly to R2. Server validates content type.
 */
export const storageRouter = Router();

const UploadUrlBody = z
  .object({
    purpose: z.enum([
      'condition_photo',
      'product_photo',
      'dispute_evidence',
      'profile',
      'proof',
      'review_photo', // CU-30
      'rto_condition', // §52 delivery/return condition reports, including video
    ]),
    contentType: z.string().min(1).max(100),
  })
  .strict();

storageRouter.post(
  '/upload-url',
  rateLimit('write'),
  authenticate,
  requirePermission('storage:upload'),
  validate({ body: UploadUrlBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<z.infer<typeof UploadUrlBody>>(req);
    if (!isAllowedUploadType(input.purpose, input.contentType)) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Unsupported image content type');
    }
    const target = await storage().createUploadUrl({
      prefix: input.purpose,
      contentType: input.contentType,
    });
    ok(res, target);
  }),
);
