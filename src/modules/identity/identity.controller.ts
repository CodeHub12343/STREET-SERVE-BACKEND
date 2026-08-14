import type { Request, Response } from 'express';

import { body } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { UpdateProfileBody, AddRoleBody } from './identity.schema';
import { identityService } from './identity.service';

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const identityController = {
  getMe: async (req: Request, res: Response): Promise<void> => {
    const me = await identityService.getMe(principal(req).userId);
    ok(res, me);
  },

  updateMe: async (req: Request, res: Response): Promise<void> => {
    const input = body<UpdateProfileBody>(req);
    const updated = await identityService.updateMe(principal(req).userId, {
      display_name: input.displayName,
      photo_url: input.photoUrl,
      location_precision: input.locationPrecision,
      fuzz_radius_m: input.fuzzRadiusM,
      home_location: input.homeLocation,
    });
    ok(res, updated);
  },

  addRole: async (req: Request, res: Response): Promise<void> => {
    const { role } = body<AddRoleBody>(req);
    const updated = await identityService.addRoleSelf(principal(req), role);
    ok(res, updated);
  },
};
