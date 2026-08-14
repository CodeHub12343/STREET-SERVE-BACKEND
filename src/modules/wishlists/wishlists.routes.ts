import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { WISHLIST_SUBJECTS, wishlistsService } from './wishlists.service';

/**
 * 7.2 / M-16 — wish lists.
 *
 * No permission gate beyond authentication: a wish list is the user's own, scoped to their id in
 * every query. There is no role that grants "manage someone else's wish list", so there is nothing
 * for the RBAC matrix to say.
 */
export const wishlistsRouter = Router();

const AddBody = z
  .object({
    subjectType: z.enum(WISHLIST_SUBJECTS),
    subjectId: z.string().length(24),
  })
  .strict();
const ItemIdParam = z.object({ id: z.string().length(24) }).strict();

wishlistsRouter.get(
  '/me/wishlist',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await wishlistsService.list(req.principal));
  }),
);

wishlistsRouter.post(
  '/me/wishlist',
  rateLimit('write'),
  authenticate,
  validate({ body: AddBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const input = body<z.infer<typeof AddBody>>(req);
    created(res, await wishlistsService.add(req.principal, input));
  }),
);

wishlistsRouter.delete(
  '/me/wishlist/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: ItemIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof ItemIdParam>>(req);
    ok(res, await wishlistsService.remove(req.principal, id));
  }),
);
