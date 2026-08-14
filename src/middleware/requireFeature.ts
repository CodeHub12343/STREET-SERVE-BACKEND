import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../config/env';
import { platformService } from '../modules/platform/platform.service';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError } from '../shared/errors/AppError';
import { asyncHandler } from './asyncHandler';

/**
 * Gate a route behind a city-scoped feature flag (e.g. the consignment layer is enabled per launch
 * city). Defaults to the pilot city; expansion is a config change. See DEPLOYMENT_STRATEGY.md §8.
 */
export function requireFeature(
  feature: string,
  citySlug: string = env.DEFAULT_CITY,
): RequestHandler {
  return asyncHandler(async (_req: Request, _res: Response, next: NextFunction) => {
    const enabled = await platformService.isFeatureEnabled(citySlug, feature);
    if (!enabled) {
      throw ForbiddenError(
        `Feature "${feature}" is not available in your city yet`,
        ERROR_CODES.FEATURE_DISABLED,
      );
    }
    next();
  });
}
