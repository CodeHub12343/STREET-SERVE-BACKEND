import { Router, type Request, type Response } from 'express';

import { mongoReady } from '../../config/db';
import { asyncHandler } from '../../middleware/asyncHandler';
import { kv } from '../../shared/kv';

/**
 * Liveness and readiness probes. `/healthz` = the process is up; `/readyz` = dependencies are
 * reachable and the instance should receive traffic. See LOGGING_AND_MONITORING.md §5.
 */
export const healthRouter = Router();

healthRouter.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

healthRouter.get(
  '/readyz',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: Record<string, boolean> = {};
    checks.mongo = mongoReady();
    try {
      checks.kv = await kv().ping();
    } catch {
      checks.kv = false;
    }
    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
  }),
);
