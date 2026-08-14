import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { identityController } from './identity.controller';
import { AddRoleBody, UpdateProfileBody } from './identity.schema';

export const usersRouter = Router();

usersRouter.get(
  '/me',
  rateLimit('read'),
  authenticate,
  requirePermission('users:read_self'),
  asyncHandler(identityController.getMe),
);

usersRouter.patch(
  '/me',
  rateLimit('write'),
  authenticate,
  requirePermission('users:update_self'),
  validate({ body: UpdateProfileBody }),
  asyncHandler(identityController.updateMe),
);

// Additive-role endpoint (customer → seller/vendor/hub). Mounted under /auth in app.ts.
export const authRouter = Router();

authRouter.post(
  '/roles',
  rateLimit('auth'),
  authenticate,
  requirePermission('roles:add_self'),
  validate({ body: AddRoleBody }),
  asyncHandler(identityController.addRole),
);
