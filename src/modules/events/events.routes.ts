import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { optionalAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { CreateEventBody, FestivalsQuery, NearbyEventsQuery } from '../ai/ai.schema';
import { eventsService } from './events.service';

export const eventsRouter = Router();

const EventIdParam = z.object({ id: z.string().length(24) }).strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/**
 * E-4 — nearby events. Public: an event is public information, and a seller deciding whether the
 * platform is worth signing up for benefits from seeing there's a market this weekend.
 */
eventsRouter.get(
  '/nearby',
  rateLimit('read'),
  optionalAuth,
  validate({ query: NearbyEventsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof NearbyEventsQuery>>(req);
    ok(res, await eventsService.nearby(q));
  }),
);

/**
 * 7.9 / P-21 — the festivals directory: further out, further ahead, grouped by date. Public for the
 * same reason `nearby` is — a seller deciding whether the platform is worth signing up for benefits
 * from seeing there is a market this month.
 */
eventsRouter.get(
  '/festivals',
  rateLimit('read'),
  optionalAuth,
  validate({ query: FestivalsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof FestivalsQuery>>(req);
    ok(res, await eventsService.festivals(q));
  }),
);

/**
 * Admin/manual entry — the pilot's PRIMARY source, not a fallback. A local farmers market isn't in
 * any ticketing feed, and it's exactly the event a street seller most wants to know about.
 */
eventsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_events'),
  validate({ body: CreateEventBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await eventsService.create(principal(req), body<z.infer<typeof CreateEventBody>>(req)));
  }),
);

eventsRouter.post(
  '/:id/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_events'),
  validate({ params: EventIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await eventsService.cancel(principal(req), params<z.infer<typeof EventIdParam>>(req).id));
  }),
);
