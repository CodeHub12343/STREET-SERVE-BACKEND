import { Router, type Request, type Response } from 'express';

import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { ok } from '../../shared/respond';
import { platformService } from './platform.service';

/** Public launch status — live cities + enabled features (drives client "coming soon" gating). */
export const platformRouter = Router();

platformRouter.get(
  '/launch',
  rateLimit('read'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await platformService.launchStatus());
  }),
);
