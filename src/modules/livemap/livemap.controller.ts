import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  BBoxQuery,
  BusinessIdParam,
  CurrentSessionQuery,
  LocationBody,
  NearbyQuery,
  SessionIdParam,
  StartSessionBody,
  StatusBody,
  TrendingQuery,
} from './livemap.schema';
import { livemapService } from './livemap.service';
import { mapLayersService } from './maplayers.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/** Phase C viewport queries all share the same bbox shape. */
function bboxOf(q: z.infer<typeof BBoxQuery>) {
  return { swLng: q.swLng, swLat: q.swLat, neLng: q.neLng, neLat: q.neLat };
}

export const livemapController = {
  // ─── Phase C map layers ───────────────────────────────────────────────────────────────────
  hubs: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof BBoxQuery>>(req);
    ok(
      res,
      await mapLayersService.hubsInView({
        bbox: bboxOf(q),
        category: q.category,
        limit: q.limit,
      }),
    );
  },

  demand: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof BBoxQuery>>(req);
    ok(res, await mapLayersService.demandTiles({ bbox: bboxOf(q), windowHours: q.windowHours }));
  },

  start: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof StartSessionBody>>(req);
    created(res, await livemapService.startSession(principal(req), input));
  },

  currentSession: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof CurrentSessionQuery>>(req);
    ok(res, await livemapService.getCurrentSession(principal(req), q.actorType, q.actorId));
  },

  location: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SessionIdParam>>(req);
    const { lng, lat } = body<z.infer<typeof LocationBody>>(req);
    ok(res, await livemapService.updateLocation(principal(req), id, lng, lat));
  },

  setStatus: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SessionIdParam>>(req);
    const { status } = body<z.infer<typeof StatusBody>>(req);
    ok(res, await livemapService.setStatus(principal(req), id, status));
  },

  popUp: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SessionIdParam>>(req);
    ok(res, await livemapService.triggerPopUp(principal(req), id));
  },

  heartbeat: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SessionIdParam>>(req);
    ok(res, await livemapService.heartbeat(principal(req), id));
  },

  stop: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SessionIdParam>>(req);
    ok(res, await livemapService.stopSession(principal(req), id));
  },

  nearby: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof NearbyQuery>>(req);
    ok(res, await livemapService.nearby(q));
  },

  trending: async (req: Request, res: Response): Promise<void> => {
    const q = query<z.infer<typeof TrendingQuery>>(req);
    ok(res, await livemapService.trending(q));
  },

  follow: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await livemapService.follow(principal(req), id));
  },
  unfollow: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await livemapService.unfollow(principal(req), id));
  },
  notifyMe: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    created(res, await livemapService.notifyMe(principal(req), id));
  },
  favorites: async (req: Request, res: Response): Promise<void> => {
    ok(res, await livemapService.listFavorites(principal(req)));
  },
};
