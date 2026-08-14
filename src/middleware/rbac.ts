import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Role } from '../config/constants';
import { getContext } from '../shared/context';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError, UnauthenticatedError } from '../shared/errors/AppError';
import { can, type Action } from '../shared/permissions';
import type { Principal } from '../shared/types/principal';
import { asyncHandler } from './asyncHandler';

/**
 * Three-layer authorization enforcement (role → tier → ownership), driven by the central
 * permission matrix. This is the mitigation for the product's highest-risk area.
 * See AUTHENTICATION_AND_AUTHORIZATION.md §3.
 */

/** Resolves whether the principal owns the resource this request targets. */
export type OwnershipResolver = (principal: Principal, req: Request) => Promise<boolean> | boolean;

function requirePrincipal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError('Authentication required');
  return req.principal;
}

/**
 * Primary guard: checks the action's role + tier rule, then (if provided) resource ownership.
 * A route whose matrix rule sets `requiresOwnership` MUST pass an ownership resolver.
 */
export function requirePermission(action: Action, ownership?: OwnershipResolver): RequestHandler {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const principal = requirePrincipal(req);
    const result = can(principal, action);
    if (!result.ok) {
      if (result.reason === 'tier') {
        throw ForbiddenError('Verification tier too low for this action', ERROR_CODES.TIER_TOO_LOW);
      }
      throw ForbiddenError('Your role cannot perform this action', ERROR_CODES.ROLE_REQUIRED);
    }
    if (ownership) {
      const owns = await ownership(principal, req);
      if (!owns) throw ForbiddenError('You do not own this resource', ERROR_CODES.NOT_OWNER);
    }
    // Record the authorized action on the trace.
    const ctx = getContext();
    if (ctx) (ctx as { action?: string }).action = action;
    next();
  });
}

/** Coarse role gate for routes not modeled as a matrix action. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const principal = requirePrincipal(req);
    if (!principal.roles.some((r) => roles.includes(r))) {
      throw ForbiddenError('Your role cannot perform this action', ERROR_CODES.ROLE_REQUIRED);
    }
    next();
  };
}
