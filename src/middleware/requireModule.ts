import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Module } from '../config/constants';
import { ERROR_CODES } from '../shared/errors/codes';
import { BusinessRuleError } from '../shared/errors/AppError';
import { resolveModules } from '../modules/vendors/modules.service';
import { asyncHandler } from './asyncHandler';

/**
 * Module gate (BUSINESS_MODULE_SYSTEM.md §4). The dashboard hiding a tab is presentation, not
 * access control — this is the enforcement. Same posture as the licence gate on go-live.
 *
 * Applied to WRITES only. Disabling `booking` must never 404 a customer's existing appointment,
 * so reads stay open by design; only creating new state is gated.
 *
 * `businessIdFrom` defaults to `:id`; pass a resolver for routes that carry the business id
 * elsewhere (body, a different param).
 */
export function requireModule(
  module: Module,
  businessIdFrom: (req: Request) => string | undefined = (req) => req.params.id,
): RequestHandler {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const businessId = businessIdFrom(req);
    // No business in scope → nothing to gate; the route's own validation owns that error.
    if (!businessId) return next();

    const { enabled } = await resolveModules(businessId);
    if (!enabled.includes(module)) {
      throw BusinessRuleError(
        ERROR_CODES.MODULE_DISABLED,
        `The ${module} module is not enabled for this business`,
      );
    }
    next();
  });
}
