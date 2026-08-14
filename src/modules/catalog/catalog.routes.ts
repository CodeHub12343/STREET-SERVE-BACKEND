import { Router, type Request, type Response } from 'express';

import { rateLimit } from '../../middleware/rateLimit';
import { ok } from '../../shared/respond';
import { asyncHandler } from '../../middleware/asyncHandler';
import { CategoryModel } from './catalog.model';

/**
 * Public reference data. The curated category taxonomy backs the client's map filter tabs. This
 * is a read-only, cacheable, low-write hot read (SECURITY_GUIDELINES.md §7).
 */
export const catalogRouter = Router();

catalogRouter.get(
  '/categories',
  rateLimit('read'),
  asyncHandler(async (_req: Request, res: Response) => {
    const categories = await CategoryModel.find({ active: true })
      .select('slug name top_level_tab requires_license parent_category_id')
      .sort({ top_level_tab: 1, name: 1 })
      .lean()
      .exec();
    ok(res, categories);
  }),
);
