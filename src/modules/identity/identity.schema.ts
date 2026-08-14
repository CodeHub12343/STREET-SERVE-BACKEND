import { z } from 'zod';

import { ROLES } from '../../config/constants';
import { GeoPoint } from '../../shared/geo';

export const UpdateProfileBody = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    photoUrl: z.string().url().max(2048).optional(),
    locationPrecision: z.enum(['exact', 'fuzzed']).optional(),
    fuzzRadiusM: z.number().int().min(0).max(5000).optional(),
    homeLocation: GeoPoint.optional(),
  })
  .strict();
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

// Accept any role at the edge; the service enforces which roles are self-grantable so that an
// attempt to self-grant `admin` yields a 403 CANNOT_SELF_GRANT_ROLE, not a 400.
export const AddRoleBody = z
  .object({
    role: z.enum(ROLES),
  })
  .strict();
export type AddRoleBody = z.infer<typeof AddRoleBody>;
