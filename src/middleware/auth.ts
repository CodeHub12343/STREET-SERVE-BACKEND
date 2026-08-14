import type { NextFunction, Request, Response } from 'express';

import { verifyToken } from '../integrations/auth/verifier';
import { identityService } from '../modules/identity/identity.service';
import { getContext } from '../shared/context';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError, UnauthenticatedError } from '../shared/errors/AppError';
import { asyncHandler } from './asyncHandler';

function extractBearer(req: Request): string {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw UnauthenticatedError('Missing bearer token');
  }
  return header.slice('Bearer '.length).trim();
}

async function loadPrincipal(req: Request): Promise<void> {
  const token = extractBearer(req);
  const claims = await verifyToken(token);
  const principal = await identityService.resolvePrincipal(claims);

  // A suspended account is rejected here even with a valid token
  // (AUTHENTICATION_AND_AUTHORIZATION.md §4).
  if (principal.status === 'suspended') {
    throw ForbiddenError('Account suspended', ERROR_CODES.ACCOUNT_SUSPENDED);
  }
  if (principal.status === 'deleted') {
    throw UnauthenticatedError('Account no longer active');
  }

  req.principal = principal;
  const ctx = getContext();
  if (ctx) ctx.principal = principal;
}

/** Require a valid, active authenticated principal. */
export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    await loadPrincipal(req);
    next();
  },
);

/** Attach a principal if a token is present, but do not require one (public+enriched routes). */
export const optionalAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    if (req.header('authorization')) {
      await loadPrincipal(req);
    }
    next();
  },
);
