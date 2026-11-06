/**
 * Real User Monitoring (RUM) ingestion endpoint.
 *
 * Mounted at /api/metrics. Public — RUM beacons fire from public pages
 * (e.g. /login) too, so requiring auth would silently drop the most
 * interesting samples (cold load, unauthenticated landing). The endpoint
 * is rate-limited per IP and aggressively validates input to keep cost
 * bounded.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { DatabaseService } from '../services/database';
import { getRedisClient } from '../services/redis-client';
import { errorResponse } from '../utils/error-response';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { promRegistry, recordWebVital } from '../services/prom-metrics';
import { validate, type ValidatedRequest } from '../middleware/validate';

const logger = createLogger('metrics-routes');
const router = Router();

// Generous bounds — anything past these is either a bug or an attempt to
// abuse the unauthenticated endpoint. CWV values are bounded in seconds-
// to-tens-of-seconds at most.
const MAX_VALUE = 600_000; // 10 minutes in ms
const MAX_ROUTE_LEN = 256;
const MAX_ID_LEN = 64;

// Reuse the Redis-backed rate-limit pattern from app.ts so multiple API
// processes share a single bucket per IP.
function createRedisStore(prefix: string) {
  try {
    const redis = getRedisClient().getQueueConnection();
    return new RedisStore({
      sendCommand: ((...args: string[]) =>
        redis.call(args[0], ...args.slice(1))) as (
        ...args: string[]
      ) => Promise<boolean | number | string | (boolean | number | string)[]>,
      prefix: `rl:${prefix}:`,
    });
  } catch {
    return undefined;
  }
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = config.rateLimits.metricsMax;

const metricsLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('metrics'),
  message: errorResponse('Too many metric submissions', 'rate_limit_error'),
});

// Apply the Redis-backed limiter ONLY to the public, unauthenticated RUM
// beacon (POST /web-vitals) — its sole purpose. It must NOT sit in front of
// GET /prometheus: that route is bearer-token-gated and scraped over loopback,
// so a per-scrape Redis write buys nothing and couples the observability path
// to Redis health. A read-only replica made that write throw READONLY and
// 500'd the scrape. The limiter is wired per-route below.

// --- Validation Schemas ---

const webVitalsBodySchema = z
  .object({
    name: z.enum(['CLS', 'INP', 'LCP', 'TTFB', 'FCP']),
    rating: z.enum(['good', 'needs-improvement', 'poor']),
    value: z.number().finite().min(0).max(MAX_VALUE),
    id: z.string().min(1).max(MAX_ID_LEN),
    route: z.string().min(1).max(MAX_ROUTE_LEN),
  })
  .passthrough();
const webVitalsSchemas = { body: webVitalsBodySchema };

router.post(
  '/web-vitals',
  metricsLimiter,
  validate(webVitalsSchemas),
  async (req: ValidatedRequest<typeof webVitalsSchemas>, res) => {
  const { name, rating, value, id: metricId, route } = req.body;

  // Feed the same sample into Prometheus so RUM lands on the same dashboard
  // as server metrics. Done before the DB write so a misconfigured DB doesn't
  // also lose the metric.
  recordWebVital(name, value, rating, route);

  try {
    const db = await DatabaseService.getInstance();
    // Use server-side NOW() for captured_at — the client-supplied `ts` is
    // untrusted and unnecessary (clock skew would only confuse partition
    // routing and percentile windows).
    await db.run(
      `INSERT INTO web_vitals (name, value, rating, metric_id, route)
       VALUES ($1, $2, $3, $4, $5)`,
      name,
      value,
      rating,
      metricId,
      route,
    );
    res.status(204).end();
  } catch (err) {
    // Don't fail the page on RUM-ingestion errors — return 204 anyway after
    // logging so misconfigured DBs (e.g. table doesn't exist yet pre-
    // migration) don't show up as 500s in client error trackers.
    logger.warn('Failed to persist web-vitals sample', {
      operation: 'webVitalsInsert',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(204).end();
  }
});

// Prometheus scrape endpoint. Bearer-token auth via METRICS_BEARER_TOKEN
// env var; if the var is unset the endpoint returns 404 so external
// scanners don't even know it exists. Designed to be scraped from a
// Prometheus / Grafana Cloud agent on a private network or via the same
// nginx upstream — DO NOT expose publicly without the token set.
router.get('/prometheus', async (req: Request, res: Response) => {
  const expected = config.observability.metricsBearerToken;
  if (!expected) {
    res.status(404).end();
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${expected}`) {
    // 404 (not 401) so the endpoint is indistinguishable from "disabled"
    // to anyone without the token. Reduces signal for credential-stuffers.
    res.status(404).end();
    return;
  }
  res.set('Content-Type', promRegistry.contentType);
  res.end(await promRegistry.metrics());
});

export default router;
