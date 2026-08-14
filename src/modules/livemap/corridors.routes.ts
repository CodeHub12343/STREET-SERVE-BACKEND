import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { Latitude, Longitude } from '../../shared/geo';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { MAX_CORRIDOR_POINTS, corridorsService } from './corridors.service';
import { mileageService } from './mileage.service';

/**
 * 7.7 / 7.8 — mileage and corridor alerts.
 *
 * Both are private by construction. A corridor is a description of where someone travels every day,
 * and a mileage log is a movement history — between them they are the most sensitive data this
 * platform holds about a person, so every query is scoped to the caller and there is no
 * cross-user read at any privilege level.
 */
export const corridorsRouter = Router();

const objectId = z.string().length(24);
const CorridorIdParam = z.object({ id: objectId }).strict();

const CreateCorridorBody = z
  .object({
    label: z.string().min(1).max(60),
    path: z
      .array(z.tuple([Longitude, Latitude]))
      .min(2)
      .max(MAX_CORRIDOR_POINTS),
    radiusM: z.number().int().min(100).max(2000).optional(),
    categories: z.array(z.string().min(1).max(64)).max(10).optional(),
  })
  .strict();
const SetActiveBody = z.object({ active: z.boolean() }).strict();

corridorsRouter.get(
  '/me/corridors',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await corridorsService.list(req.principal));
  }),
);

corridorsRouter.post(
  '/me/corridors',
  rateLimit('write'),
  authenticate,
  validate({ body: CreateCorridorBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const input = body<z.infer<typeof CreateCorridorBody>>(req);
    created(res, await corridorsService.create(req.principal, input));
  }),
);

corridorsRouter.patch(
  '/me/corridors/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: CorridorIdParam, body: SetActiveBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof CorridorIdParam>>(req);
    const { active } = body<z.infer<typeof SetActiveBody>>(req);
    ok(res, await corridorsService.setActive(req.principal, id, active));
  }),
);

corridorsRouter.delete(
  '/me/corridors/:id',
  rateLimit('write'),
  authenticate,
  validate({ params: CorridorIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof CorridorIdParam>>(req);
    ok(res, await corridorsService.remove(req.principal, id));
  }),
);

// ─── Mileage ───────────────────────────────────────────────────────────────────────────────

export const mileageRouter = Router();

const MileageQuery = z
  .object({
    actorType: z.enum(['business', 'seller']),
    actorId: z.string().min(1).max(64),
    days: z.coerce.number().int().min(1).max(366).optional(),
  })
  .strict();

/**
 * The vendor's own mileage. `live:broadcast` because the person who can put a pin on the map is the
 * person whose track this is; the service additionally checks ownership of the specific actor.
 */
mileageRouter.get(
  '/mileage',
  rateLimit('read'),
  authenticate,
  requirePermission('live:broadcast'),
  validate({ query: MileageQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const q = query<z.infer<typeof MileageQuery>>(req);
    ok(
      res,
      await mileageService.summary(req.principal, q.actorType, q.actorId, {
        ...(q.days ? { days: q.days } : {}),
      }),
    );
  }),
);
