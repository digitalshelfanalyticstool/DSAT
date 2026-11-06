/**
 * Express middleware that records request count + duration into the
 * Prometheus registry. Mount it as the very first route-level middleware
 * so the timer starts before any heavy work.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
} from '../services/prom-metrics';

/**
 * Resolve the route template the request matched (e.g. `/api/jobs/:id`)
 * rather than the literal URL with substituted params, so per-route
 * cardinality stays bounded. Falls back to a fixed sentinel for 404s.
 */
function resolveRouteLabel(req: Request): string {
  if (req.route?.path) {
    const base = req.baseUrl ?? '';
    return `${base}${String(req.route.path)}`;
  }
  return '<unmatched>';
}

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startNs = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
    const labels = {
      method: req.method,
      route: resolveRouteLabel(req),
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });
  next();
}
