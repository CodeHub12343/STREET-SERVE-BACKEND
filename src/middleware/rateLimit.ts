import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { RATE_LIMITS } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { kv } from '../shared/kv';
import { RateLimitError } from '../shared/errors/AppError';
import { asyncHandler } from './asyncHandler';

type Tier = keyof typeof RATE_LIMITS;

/**
 * Redis-backed (KV) rate limiter, tuned per route tier — tighter on money/auth than on reads
 * (SECURITY_GUIDELINES.md §4). Keyed per account when authenticated, else per IP, and scoped to
 * the route so one hot endpoint cannot exhaust another's budget. Degrades open if the store is
 * unavailable — we never block a request purely because the limiter backend is down.
 */
export function rateLimit(tier: Tier): RequestHandler {
  const { windowSec, max } = RATE_LIMITS[tier];

  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!env.RATE_LIMIT_ENABLED) return next();

    const identity = req.principal?.userId ?? req.ip ?? 'anonymous';
    const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const scope = `${req.method}:${req.baseUrl}${routePath}`;
    const key = `rl:${tier}:${identity}:${scope}`;

    let count: number;
    try {
      count = await kv().incrWithTtl(key, windowSec);
    } catch (err) {
      logger.warn({ err }, 'rate limiter backend unavailable — allowing request');
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));

    if (count > max) {
      res.setHeader('Retry-After', String(windowSec));
      throw RateLimitError('Rate limit exceeded', { details: { tier, limit: max, windowSec } });
    }
    next();
  });
}
