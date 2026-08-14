import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';

import { env } from '../config/env';

/**
 * Prometheus metrics. RED (rate/errors/duration) per route plus default process metrics, exposed
 * at /metrics (internal-only). Business/SLA metrics are added per feature in later phases.
 * See LOGGING_AND_MONITORING.md §3.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'streetserve-backend' });
client.collectDefaultMetrics({ register: registry });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 0.8, 1, 2, 5],
  registers: [registry],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!env.METRICS_ENABLED) return next();
  const endTimer = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // Prefer the matched route pattern to keep label cardinality bounded.
    const routePath = (req.route as { path?: string } | undefined)?.path;
    const route = routePath ? `${req.baseUrl}${routePath}` : req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    endTimer(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
