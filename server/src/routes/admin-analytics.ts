/**
 * Admin Analytics Routes — system health, worker monitoring, and operational analytics.
 *
 * All routes are mounted under /api/admin/analytics/ via admin.ts,
 * which already applies authMiddleware + requireRole('admin').
 *
 * Endpoints:
 *   - GET /api/admin/analytics/system-health      — queue depth, worker count, 24h job stats
 *   - GET /api/admin/analytics/workers             — per-worker concurrency and heartbeat info
 *   - GET /api/admin/analytics/phase-timing        — avg/p50/p95 phase durations
 *   - GET /api/admin/analytics/data-completeness   — per-retailer field completeness %
 *   - GET /api/admin/analytics/stale-products      — products with 5+ consecutive failures
 *   - GET /api/admin/analytics/rate-limits         — per-retailer rate limit usage from Redis
 *   - GET /api/admin/analytics/cost-efficiency     — cost per job/variant by retailer
 *   - GET /api/admin/analytics/scrape-runs         — recent scrape runs with filters
 *   - GET /api/admin/analytics/compare             — compare two scrape runs
 *   - GET /api/admin/analytics/web-vitals          — p75 INP per route, last N days
 */

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { getRedisClient, readWorkerHeartbeats } from '../services/redis-client';
import { DatabaseService } from '../services/database';
import { config } from '../config';
import { getCachedOrFetch } from '../services/redis-cache';
import { knownRetailers } from '../services/retailers';
import { getSites } from '../services/config-manager';
import { getAdapter } from '../adapters';
import { getCostRate } from '../services/cost-calculator';
import { buildConfigFromEnv as buildRateLimitConfig } from '../services/rate-limiter';
import { scrapeSlotSettingsKey } from '../services/rate-limit-keys';
import { getQueueService } from '../services/queue-service';
import { SCRAPE_QUEUE } from '../services/queues';
import { diffRunPairs } from '../services/run-diff';

const router = Router();


// --- Validation Schemas ---
// `from`/`to` are required-and-truthy in the handlers and forwarded straight to
// SQL as date params; other query keys (site, exclude_admin, …) stay readable
// via `.passthrough()`, matching the handlers' lenient treatment of them.
const fromToQuerySchema = z
  .object({ from: z.string().min(1), to: z.string().min(1) })
  .passthrough();
const fromToSchemas = { query: fromToQuerySchema };

const compareQuerySchema = z
  .object({ run_a: z.string().min(1), run_b: z.string().min(1) })
  .passthrough();
const compareSchemas = { query: compareQuerySchema };

/**
 * @openapi
 * /admin/analytics/system-health:
 *   get:
 *     summary: Get system health — queue depth, worker count
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System health metrics
 */
router.get('/system-health', asyncHandler(async (_req, res) => {
  const redis = getRedisClient().getQueueConnection();

  const activeWorkers = (await readWorkerHeartbeats(redis)).length;

  // Get queue stats from BullMQ — use the shared singleton, no new connections
  const queue = getQueueService().queue(SCRAPE_QUEUE);
  const [waiting, active, completed, failed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
  ]);

  res.json({
    success: true,
    health: {
      active_workers: activeWorkers,
      queue_waiting: waiting,
      queue_active: active,
      queue_completed_total: completed,
      queue_failed_total: failed,
    },
  });
}, { operation: 'getSystemHealth', message: 'Failed to get system health' }));

/**
 * @openapi
 * /admin/analytics/workers:
 *   get:
 *     summary: Get per-worker concurrency and heartbeat info
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Worker status list
 */
router.get('/workers', asyncHandler(async (_req, res) => {
  const redis = getRedisClient().getQueueConnection();

  const workers = (await readWorkerHeartbeats(redis)).map((hb) => ({
    id: hb.workerId,
    concurrency_max: hb.concurrency || config.worker.concurrency,
    concurrency_active: hb.activeJobs,
    last_heartbeat: hb.lastSeen || null,
    pid: hb.pid || null,
  }));

  workers.sort((a, b) => (b.last_heartbeat || '').localeCompare(a.last_heartbeat || ''));
  res.json({ success: true, workers });
}, { operation: 'getWorkers', message: 'Failed to get workers' }));

/**
 * @openapi
 * /admin/analytics/phase-timing:
 *   get:
 *     summary: Get avg/p50/p95 phase durations for completed jobs
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Phase timing statistics
 */
router.get('/phase-timing', validate(fromToSchemas), asyncHandler(async (req: ValidatedRequest<typeof fromToSchemas>, res) => {
  const { from, to } = req.query;

  const excludeAdmin = req.query.exclude_admin === 'true';

  const phases = await getCachedOrFetch(
    `cache:analytics:phase-timing:${from}:${to}:ea=${excludeAdmin}`,
    900, // 15 minutes
    async () => {
      const db = await DatabaseService.getInstance();
      const adminJoin = excludeAdmin ? "JOIN users u ON u.id = j.user_id" : "";
      const adminWhere = excludeAdmin ? "AND u.role <> 'admin'" : "";
      const rows = await db.all<{ phase: string; avg_ms: string; p50_ms: string; p95_ms: string; job_count: string }>(
        `WITH phase_data AS (
          SELECT key AS phase, (value::text)::numeric AS duration_ms
          FROM jobs j ${adminJoin}, jsonb_each(j.phase_timings)
          WHERE j.phase_timings IS NOT NULL
            AND j.created_at >= $1 AND j.created_at < ($2::date + INTERVAL '1 day')
            AND j.status = 'completed'
            ${adminWhere}
        )
        SELECT phase,
          ROUND(AVG(duration_ms)) AS avg_ms,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)) AS p50_ms,
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)) AS p95_ms,
          COUNT(*)::text AS job_count
        FROM phase_data
        GROUP BY phase
        ORDER BY avg_ms DESC`,
        from, to,
      );
      return rows.map(r => ({
        phase: r.phase,
        avg_ms: Number(r.avg_ms),
        p50_ms: Number(r.p50_ms),
        p95_ms: Number(r.p95_ms),
        job_count: Number(r.job_count),
      }));
    },
  );

  res.json({ success: true, phases });
}, { operation: 'getPhaseTiming', message: 'Failed to get phase timing' }));

/**
 * @openapi
 * /admin/analytics/data-completeness:
 *   get:
 *     summary: Get per-retailer field completeness percentages
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Per-retailer completeness percentages
 */
router.get('/data-completeness', validate(fromToSchemas), asyncHandler(async (req: ValidatedRequest<typeof fromToSchemas>, res) => {
  const { from, to } = req.query;

  const excludeAdmin = req.query.exclude_admin === 'true';

  const retailers = await getCachedOrFetch(
    `cache:analytics:data-completeness:${from}:${to}:ea=${excludeAdmin}`,
    900, // 15 minutes
    async () => {
      const db = await DatabaseService.getInstance();
      const adminJoin = excludeAdmin
        ? `JOIN scrape_runs sr ON sr.id = ps.scrape_run_id
           JOIN jobs j ON j.job_id = sr.job_id
           JOIN users u ON u.id = j.user_id`
        : "";
      const adminWhere = excludeAdmin ? "AND u.role <> 'admin'" : "";
      const rows = await db.all<{
        site: string; total_variants: string;
        upc_pct: string; selling_price_pct: string; list_price_pct: string;
        inventory_pct: string; item_number_pct: string;
      }>(
        `SELECT p.retailer AS site,
          COUNT(*)::text AS total_variants,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ps.upc IS NOT NULL AND ps.upc != '') / NULLIF(COUNT(*), 0))::text AS upc_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ps.selling_price IS NOT NULL) / NULLIF(COUNT(*), 0))::text AS selling_price_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ps.list_price IS NOT NULL) / NULLIF(COUNT(*), 0))::text AS list_price_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ps.inventory IS NOT NULL) / NULLIF(COUNT(*), 0))::text AS inventory_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE ps.item_number IS NOT NULL AND ps.item_number != '') / NULLIF(COUNT(*), 0))::text AS item_number_pct
        FROM product_snapshots ps
        JOIN products p ON p.id = ps.product_id
        ${adminJoin}
        WHERE ps.scraped_at >= $1 AND ps.scraped_at < ($2::date + INTERVAL '1 day')
          ${adminWhere}
        GROUP BY p.retailer
        ORDER BY total_variants DESC`,
        from, to,
      );
      return rows.map(r => ({
        site: r.site,
        total_variants: Number(r.total_variants),
        upc_pct: Number(r.upc_pct) || 0,
        selling_price_pct: Number(r.selling_price_pct) || 0,
        list_price_pct: Number(r.list_price_pct) || 0,
        inventory_pct: Number(r.inventory_pct) || 0,
        item_number_pct: Number(r.item_number_pct) || 0,
      }));
    },
  );

  res.json({ success: true, retailers });
}, { operation: 'getDataCompleteness', message: 'Failed to get data completeness' }));

/**
 * @openapi
 * /admin/analytics/stale-products:
 *   get:
 *     summary: Products that failed to scrape in N+ jobs within the window (threshold configurable, default 5)
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: site
 *         schema: { type: string }
 *         description: Filter by retailer
 *     responses:
 *       200:
 *         description: List of stale products (max 50)
 */
router.get('/stale-products', validate(fromToSchemas), asyncHandler(async (req: ValidatedRequest<typeof fromToSchemas>, res) => {
  const { from, to } = req.query;
  const site = typeof req.query.site === 'string' ? req.query.site : undefined;

  const excludeAdmin = req.query.exclude_admin === 'true';

  const db = await DatabaseService.getInstance();

  // Per-product scrape failures are recorded in jobs.failed_products (a JSONB
  // array of retailer style ids that still had no variants after retry+cache-fill
  // for that job) — NOT in scrape_runs, which only ever stores successful runs.
  // Unnest failed_products across jobs in the window and count, per product, how
  // many of those jobs failed it (cumulative-in-window).
  const jobConditions = [
    'j.completed_at >= $1',
    "j.completed_at < ($2::date + INTERVAL '1 day')",
  ];
  const params: unknown[] = [from, to];
  let idx = 2;

  if (site) {
    idx++;
    jobConditions.push(`j.site = $${idx}`);
    params.push(site);
  }
  if (excludeAdmin) {
    jobConditions.push("u.role <> 'admin'");
  }
  idx++;
  const thresholdParam = idx;
  params.push(config.scraping.staleProductFailureThreshold);

  const adminJoin = excludeAdmin ? 'JOIN users u ON u.id = j.user_id' : '';

  // Every failing product id is reported, including ones with no products row
  // (a product that has only ever failed is never persisted).
  const failures = await db.all<{ site: string; pid: string; failure_count: string; last_seen_at: string }>(
    `SELECT j.site, fp.pid, COUNT(*)::text AS failure_count, MAX(j.completed_at)::text AS last_seen_at
     FROM jobs j
     ${adminJoin}
     CROSS JOIN LATERAL jsonb_array_elements_text(j.failed_products) AS fp(pid)
     WHERE ${jobConditions.join(' AND ')}
     GROUP BY j.site, fp.pid
     HAVING COUNT(*) >= $${thresholdParam}
     ORDER BY COUNT(*) DESC
     LIMIT 50`,
    ...params,
  );

  // failed_products holds the adapter's product id for a URL, which is not
  // always the style_id, so title/url come from the products row whose URL maps
  // to that id. The id is always a substring of its URL, which narrows the scan.
  const candidates = failures.length === 0 ? [] : await db.all<{ retailer: string; url: string; title: string | null }>(
    `SELECT p.retailer, p.url, p.title
     FROM unnest($1::text[], $2::text[]) AS f(site, pid)
     JOIN products p ON p.retailer = f.site AND strpos(p.url, f.pid) > 0`,
    failures.map(f => f.site), failures.map(f => f.pid),
  );
  const adapterBySite = new Map((await getSites()).map(s => [s.name, s.adapter]));
  const productIdOf = (site: string, url: string): string | null => {
    try {
      return getAdapter(adapterBySite.get(site)).productId(url);
    } catch {
      return null;
    }
  };
  const rows = failures.map(f => {
    const product = candidates.find(c => c.retailer === f.site && productIdOf(f.site, c.url) === f.pid);
    return {
      style_id: f.pid,
      title: product?.title ?? null,
      url: product?.url ?? null,
      retailer: f.site,
      failure_count: f.failure_count,
      last_seen_at: f.last_seen_at,
    };
  });

  res.json({
    success: true,
    products: rows.map(r => ({
      style_id: r.style_id,
      title: r.title,
      url: r.url,
      retailer: r.retailer,
      // Kept as `consecutive_failures` for client compatibility; semantics are
      // now cumulative failures within the reporting window.
      consecutive_failures: Number(r.failure_count),
      last_seen_at: r.last_seen_at,
    })),
    total: rows.length,
  });
}, { operation: 'getStaleProducts', message: 'Failed to get stale products' }));

/**
 * @openapi
 * /admin/analytics/rate-limits:
 *   get:
 *     summary: Get per-retailer scrape slots in use (all workers) vs the configured maximum
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Rate limit usage per retailer
 */
router.get('/rate-limits', asyncHandler(async (_req, res) => {
  const redis = getRedisClient().getQueueConnection();
  const limits = buildRateLimitConfig();
  const result = [];

  for (const site of await knownRetailers()) {
    const inUse = Number(await redis.hget(scrapeSlotSettingsKey(site), 'running')) || 0;
    const max = limits.maxConcurrent[site] ?? limits.defaultMaxConcurrent;
    result.push({ site, in_use: inUse, max_concurrent: max, pct_used: Math.round((inUse / max) * 100) });
  }

  res.json({ success: true, retailers: result });
}, { operation: 'getRateLimits', message: 'Failed to get rate limits' }));

/**
 * @openapi
 * /admin/analytics/cost-efficiency:
 *   get:
 *     summary: Get cost per job/variant by retailer and daily trend
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Cost efficiency by retailer and trend
 */
router.get('/cost-efficiency', validate(fromToSchemas), asyncHandler(async (req: ValidatedRequest<typeof fromToSchemas>, res) => {
  const { from, to } = req.query;

  const excludeAdmin = req.query.exclude_admin === 'true';
  const BYTES_PER_GB = 1_073_741_824;
  const costRate = await getCostRate(await DatabaseService.getInstance());

  const adminJoin = excludeAdmin ? 'JOIN users u ON u.id = j.user_id' : '';
  const adminWhere = excludeAdmin ? "AND u.role <> 'admin'" : '';

  const cached = await getCachedOrFetch(
    `cache:analytics:cost-efficiency:${from}:${to}:ea=${excludeAdmin}`,
    900, // 15 minutes
    async () => {
      const db = await DatabaseService.getInstance();
      const [byRetailer, trend] = await Promise.all([
        db.all<{
          site: string; total_bytes: string; total_jobs: string; total_variants: string;
        }>(
          `SELECT jb.site,
            SUM(jb.bytes_downloaded + jb.bytes_uploaded)::text AS total_bytes,
            COUNT(DISTINCT jb.job_id)::text AS total_jobs,
            COALESCE(SUM(j.variants_extracted), 0)::text AS total_variants
          FROM job_bandwidth jb
          JOIN jobs j ON j.job_id = jb.job_id
          ${adminJoin}
          WHERE jb.created_at >= $1 AND jb.created_at < ($2::date + INTERVAL '1 day') ${adminWhere}
          GROUP BY jb.site
          ORDER BY total_bytes DESC`,
          from, to,
        ),
        db.all<{ date: string; total_bytes: string; job_count: string }>(
          `SELECT DATE(jb.created_at) AS date,
            SUM(jb.bytes_downloaded + jb.bytes_uploaded)::text AS total_bytes,
            COUNT(DISTINCT jb.job_id)::text AS job_count
          FROM job_bandwidth jb
          JOIN jobs j ON j.job_id = jb.job_id
          ${adminJoin}
          WHERE jb.created_at >= $1 AND jb.created_at < ($2::date + INTERVAL '1 day') ${adminWhere}
          GROUP BY DATE(jb.created_at)
          ORDER BY date`,
          from, to,
        ),
      ]);
      return { byRetailer, trend };
    },
  );

  const byRetailer = cached.byRetailer.map(r => {
    const totalBytes = Number(r.total_bytes);
    const totalJobs = Number(r.total_jobs) || 1;
    const totalVariants = Number(r.total_variants) || 1;
    const totalCost = (totalBytes / BYTES_PER_GB) * costRate;
    return {
      site: r.site,
      avg_cost_per_job: Math.round((totalCost / totalJobs) * 100) / 100,
      avg_cost_per_variant: Math.round((totalCost / totalVariants) * 10000) / 10000,
      total_jobs: totalJobs,
    };
  });

  // Zero-fill configured sites so the panel always shows each one.
  // SQL ordered by total_bytes DESC; zero entries naturally land last.
  const seen = new Set(byRetailer.map((r) => r.site));
  for (const site of await knownRetailers()) {
    if (!seen.has(site)) {
      byRetailer.push({
        site,
        avg_cost_per_job: 0,
        avg_cost_per_variant: 0,
        total_jobs: 0,
      });
    }
  }

  res.json({
    success: true,
    by_retailer: byRetailer,
    trend: cached.trend.map(r => {
      const bytes = Number(r.total_bytes);
      const jobs = Number(r.job_count) || 1;
      const cost = (bytes / BYTES_PER_GB) * costRate;
      return {
        date: r.date,
        avg_cost_per_job: Math.round((cost / jobs) * 100) / 100,
      };
    }),
  });
}, { operation: 'getCostEfficiency', message: 'Failed to get cost efficiency' }));

/**
 * @openapi
 * /admin/analytics/scrape-runs:
 *   get:
 *     summary: Get recent scrape runs with optional filters
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: site
 *         schema: { type: string }
 *       - in: query
 *         name: brand
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Recent scrape runs (max 50)
 */
router.get('/scrape-runs', asyncHandler(async (req: Request, res) => {
  const { site, brand } = req.query as Record<string, string>;
  const db = await DatabaseService.getInstance();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 0;

  if (site) { idx++; conditions.push(`sr.site = $${idx}`); params.push(site); }
  if (brand) { idx++; conditions.push(`sr.brand = $${idx}`); params.push(brand); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await db.all<{ id: string; site: string; brand: string; variant_count: string; products_upserted: string; scraped_at: string }>(
    `SELECT id::text, site, brand, variant_count::text, products_upserted::text, scraped_at::text
     FROM scrape_runs ${where}
     ORDER BY scraped_at DESC LIMIT 50`,
    ...params,
  );

  res.json({ success: true, runs: rows });
}, { operation: 'getScrapeRuns', message: 'Failed to get scrape runs' }));

/**
 * @openapi
 * /admin/analytics/compare:
 *   get:
 *     summary: Compare two scrape runs — price, inventory, product changes
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: run_a
 *         required: true
 *         schema: { type: integer }
 *         description: First scrape run ID
 *       - in: query
 *         name: run_b
 *         required: true
 *         schema: { type: integer }
 *         description: Second scrape run ID
 *     responses:
 *       200:
 *         description: Comparison results
 *       404:
 *         description: One or both scrape runs not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/compare', validate(compareSchemas), asyncHandler(async (req: ValidatedRequest<typeof compareSchemas>, res) => {
  const { run_a, run_b } = req.query;

  const db = await DatabaseService.getInstance();

  const [runA, runB] = await Promise.all([
    db.get<{ id: string; site: string; brand: string; variant_count: number; products_upserted: number; scraped_at: string }>(
      'SELECT id, site, brand, variant_count, products_upserted, scraped_at FROM scrape_runs WHERE id = $1', run_a),
    db.get<{ id: string; site: string; brand: string; variant_count: number; products_upserted: number; scraped_at: string }>(
      'SELECT id, site, brand, variant_count, products_upserted, scraped_at FROM scrape_runs WHERE id = $1', run_b),
  ]);

  if (!runA || !runB) {
    res.status(404).json(errorResponse('One or both scrape runs not found', 'not_found'));
    return;
  }

  const [diff] = await diffRunPairs(db, [{
    a: { id: Number(runA.id), scraped_at: runA.scraped_at },
    b: { id: Number(runB.id), scraped_at: runB.scraped_at },
  }]);

  res.json({
    success: true,
    run_a: { id: runA.id, date: runA.scraped_at, product_count: runA.products_upserted, variant_count: runA.variant_count },
    run_b: { id: runB.id, date: runB.scraped_at, product_count: runB.products_upserted, variant_count: runB.variant_count },
    ...diff,
  });
}, { operation: 'compareRuns', message: 'Failed to compare runs' }));

/**
 * @openapi
 * /admin/analytics/web-vitals:
 *   get:
 *     summary: p75 of each Core Web Vital per route over the last N days
 *     tags: [Admin Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, minimum: 1, maximum: 90 }
 *         description: Look-back window in days (default 7, capped at 90)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: Maximum routes per metric name (default 20, sorted by p75 desc)
 *     responses:
 *       200:
 *         description: Array of { route, name, p75 } objects
 */
router.get('/web-vitals', asyncHandler(async (req: Request, res) => {
  const daysParam = Number.parseInt(String(req.query.days ?? '7'), 10);
  const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 90) : 7;
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;

  const data = await getCachedOrFetch(
    `cache:analytics:web-vitals:${days}:${limit}`,
    300, // 5 minutes — RUM data lags real time slightly anyway
    async () => {
      const db = await DatabaseService.getInstance();
      // PERCENTILE_CONT for p75. We rank routes per metric name so the
      // admin UI can show e.g. "top 20 worst INP routes" without one
      // chatty page hogging the entire result.
      const rows = await db.all<{ route: string; name: string; p75: string; sample_count: string }>(
        `WITH ranked AS (
          SELECT
            route,
            name,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value) AS p75,
            COUNT(*) AS sample_count,
            ROW_NUMBER() OVER (PARTITION BY name ORDER BY PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value) DESC) AS rn
          FROM web_vitals
          WHERE captured_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY route, name
        )
        SELECT route, name, ROUND(p75::numeric, 2)::text AS p75, sample_count::text AS sample_count
        FROM ranked
        WHERE rn <= $2
        ORDER BY name ASC, p75 DESC`,
        days,
        limit,
      );
      return rows.map(r => ({
        route: r.route,
        name: r.name,
        p75: Number(r.p75),
        sample_count: Number(r.sample_count),
      }));
    },
  );

  res.json({ success: true, data, days, limit });
}, { operation: 'getWebVitalsAnalytics', message: 'Failed to get web-vitals analytics' }));

/**
 * GET /api/admin/analytics/failures?days=N
 *
 * Returns a per-(site, failure_category) count of failed jobs within the
 * last N days (default 7, max 90). Used by the admin dashboard to surface
 * which retailers are failing and what kinds of failures dominate.
 */
router.get('/failures', asyncHandler(async (req, res) => {
  const rawDays = Number.parseInt(String(req.query.days ?? '7'), 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const db = await DatabaseService.getInstance();
  const rows = await db.all<{ site: string; failure_category: string; count: string }>(
    `SELECT site, failure_category, COUNT(*) AS count
       FROM jobs
      WHERE status = 'failed'
        AND failure_category IS NOT NULL
        AND completed_at >= $1
      GROUP BY site, failure_category
      ORDER BY count DESC`,
    cutoffIso,
  );

  const breakdown = rows.map((r) => ({
    site: r.site,
    failure_category: r.failure_category,
    count: Number.parseInt(r.count, 10),
  }));

  res.json({ success: true, days, breakdown });
  // These two handlers answered failures with `{ success: false, error }` --
  // no error_type, no timestamp, and a field the client never reads (it reads
  // `message`, so this surfaced as "An error occurred"). They now use the
  // standard envelope like every other route.
}, { operation: 'getFailureBreakdown', message: 'Failed to get failure breakdown' }));

/**
 * GET /api/admin/analytics/cache-hit-rate
 *
 * Aggregates cache hit/miss counters recorded into scrape_runs (migration 39).
 * Slices by site so operators can see per-retailer cache effectiveness over
 * a rolling window. Used to tune DISCOVERY_CACHE_TTL_HOURS and
 * VARIANT_CACHE_TTL_HOURS instead of guessing.
 */
router.get('/cache-hit-rate', asyncHandler(async (req: Request, res) => {
  const rawDays = Number.parseInt(String(req.query.days ?? '7'), 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const db = await DatabaseService.getInstance();
  const rows = await db.all<{
    site: string;
    total_runs: string;
    discovery_hits: string;
    variant_hits: string;
    variant_misses: string;
    fill_hits: string;
    fill_misses: string;
  }>(
    `SELECT site,
            COUNT(*) AS total_runs,
            COUNT(*) FILTER (WHERE discovery_cache_hit) AS discovery_hits,
            COALESCE(SUM(variant_cache_hits), 0) AS variant_hits,
            COALESCE(SUM(variant_cache_misses), 0) AS variant_misses,
            COALESCE(SUM(cache_fill_hits), 0) AS fill_hits,
            COALESCE(SUM(cache_fill_misses), 0) AS fill_misses
       FROM scrape_runs
      WHERE scraped_at >= $1
      GROUP BY site
      ORDER BY site`,
    cutoffIso,
  );

  const ratio = (hits: number, misses: number): number => {
    const total = hits + misses;
    return total === 0 ? 0 : Number((hits / total).toFixed(4));
  };

  const perSite = rows.map((r) => {
    const totalRuns = Number(r.total_runs);
    const discoveryHits = Number(r.discovery_hits);
    const variantHits = Number(r.variant_hits);
    const variantMisses = Number(r.variant_misses);
    const fillHits = Number(r.fill_hits);
    const fillMisses = Number(r.fill_misses);
    return {
      site: r.site,
      total_runs: totalRuns,
      discovery_hit_rate: totalRuns === 0 ? 0 : Number((discoveryHits / totalRuns).toFixed(4)),
      discovery_hits: discoveryHits,
      variant_cache_hits: variantHits,
      variant_cache_misses: variantMisses,
      variant_hit_rate: ratio(variantHits, variantMisses),
      cache_fill_hits: fillHits,
      cache_fill_misses: fillMisses,
      cache_fill_rate: ratio(fillHits, fillMisses),
    };
  });

  res.json({ success: true, days, per_site: perSite });
}, { operation: 'getCacheHitRate', message: 'Failed to get cache hit rate' }));

export { router as adminAnalyticsRouter };
