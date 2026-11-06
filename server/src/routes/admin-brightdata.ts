/**
 * Admin Bright Data Routes — usage monitoring and retailer cost analytics.
 *
 * Mounted at /api/admin/brightdata by the parent admin router.
 *
 * Bright Data Usage:
 *   - GET  /usage                  — account status + zone bandwidth stats
 *
 * Retailer Cost Analytics:
 *   - GET  /retailer-costs         — aggregated costs by retailer
 *   - GET  /retailer-costs/export  — CSV export of retailer costs
 *   - GET  /cost-rate              — current cost rate ($/GB)
 *   - PUT  /cost-rate              — update cost rate
 *   - GET  /job-costs/:jobId       — bandwidth + cost for a single job
 */

import { Router } from 'express';
import { z } from 'zod';
import { getUsageSummary, clearUsageCache } from '../services/brightdata-usage';
import { CostCalculator, type TimePeriod } from '../services/cost-calculator';
import { JobBandwidthStore } from '../services/job-bandwidth-store';
import { DatabaseService } from '../services/database';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { getActiveProvider } from '../services/scraping-provider-settings';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('admin-brightdata-routes');
const router = Router();

// --- Validation Schemas ---

const costRateBodySchema = z
  .object({ cost_per_gb: z.number().min(0) })
  .passthrough();
const costRateSchemas = { body: costRateBodySchema };

const jobCostsBatchBodySchema = z
  .object({ ids: z.array(z.unknown()).min(1).max(100) })
  .passthrough();
const jobCostsBatchSchemas = { body: jobCostsBatchBodySchema };

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_PERIODS = ['today', 'yesterday', '7d', '30d', 'month', 'last_month'] as const;

/** Helper: get CostCalculator instance. */
async function getCostCalculator() {
  const db = await DatabaseService.getInstance();
  const bandwidthStore = new JobBandwidthStore(db);
  return new CostCalculator(db, bandwidthStore);
}

/** Helper: parse and validate period/date params from query string. */
function parsePeriodParams(query: Record<string, unknown>): { period: TimePeriod } | { from: string; to: string } | null {
  const { period, from, to } = query;

  if (period && VALID_PERIODS.includes(period as TimePeriod)) {
    return { period: period as TimePeriod };
  }

  if (from && to && typeof from === 'string' && typeof to === 'string') {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime())) {
      return { from, to };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bright Data Usage
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/brightdata/usage
 * Fetch account status and bandwidth stats for all configured Bright Data zones.
 * Query params: refresh=true to bypass cache.
 */
router.get('/usage', asyncHandler(async (req: AuthenticatedRequest, res) => {
  // The active provider, not raw env: keys saved in the Config panel live in the DB.
  const provider = await getActiveProvider();
  const bd = provider.kind === 'brightdata' ? provider : undefined;
  const apiKey = bd?.apiKey;
  if (!apiKey) {
    res.status(503).json(
      errorResponse('BRIGHTDATA_API_KEY is not configured', 'configuration_error'),
    );
    return;
  }

  const zones = new Set<string>();
  const unlockerZone = bd?.zone;
  if (unlockerZone) zones.add(unlockerZone);

  if (zones.size === 0) {
    res.status(503).json(
      errorResponse('No Bright Data zones configured (BRIGHTDATA_ZONE)', 'configuration_error'),
    );
    return;
  }

  if (req.query.refresh === 'true') {
    clearUsageCache();
  }

  const summary = await getUsageSummary(apiKey, Array.from(zones));

  logger.info('Bright Data usage fetched', {
    operation: 'getBrightDataUsage',
    adminId: req.user!.id,
    zoneCount: summary.zones.length,
  });

  res.json({ success: true, ...summary });
  // The upstream error text stays out of the response body: it carries the same
  // disclosure risk as any other raw message. It is in the server log, keyed by requestId.
}, { operation: 'getBrightDataUsage', statusCode: 502, message: 'Failed to fetch Bright Data usage', errorType: 'upstream_error' }));

// ═══════════════════════════════════════════════════════════════════════════════
// Retailer Cost Analytics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/brightdata/retailer-costs
 * Aggregated bandwidth and cost data by retailer for a time period.
 * Query params: period (today|yesterday|7d|30d|month|last_month) OR from/to ISO dates.
 */
router.get('/retailer-costs', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const params = parsePeriodParams(req.query);
  if (!params) {
    res.status(400).json(
      errorResponse(
        'Invalid or missing period parameter. Use one of: today, yesterday, 7d, 30d, month, last_month, or provide from/to ISO date strings.',
        'validation_error',
      ),
    );
    return;
  }

  const excludeAdmin = req.query.exclude_admin === 'true';
  const calculator = await getCostCalculator();
  const aggregation = await calculator.getRetailerCosts(
    'period' in params ? params.period : { from: params.from, to: params.to },
    excludeAdmin,
  );

  res.json({ success: true, data: aggregation });
}, { operation: 'getRetailerCosts' }));

/**
 * GET /api/admin/brightdata/retailer-costs/export
 * CSV export of retailer cost data for a time period.
 * Query params: exclude_admin=true to filter out admin user jobs.
 */
router.get('/retailer-costs/export', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const params = parsePeriodParams(req.query);
  if (!params) {
    res.status(400).json(
      errorResponse(
        'Invalid or missing period parameter. Use one of: today, yesterday, 7d, 30d, month, last_month, or provide from/to ISO date strings.',
        'validation_error',
      ),
    );
    return;
  }

  const excludeAdmin = req.query.exclude_admin === 'true';
  const calculator = await getCostCalculator();
  const aggregation = await calculator.getRetailerCosts(
    'period' in params ? params.period : { from: params.from, to: params.to },
    excludeAdmin,
  );

  const csv = calculator.generateCsv(aggregation);
  const fromDate = aggregation.period.from.slice(0, 10);
  const toDate = aggregation.period.to.slice(0, 10);
  const filename = `retailer-costs-${fromDate}-to-${toDate}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}, { operation: 'exportRetailerCostsCsv' }));

/**
 * GET /api/admin/brightdata/cost-rate
 * Return the current Bright Data cost rate ($/GB).
 */
router.get('/cost-rate', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const calculator = await getCostCalculator();
  const costPerGb = await calculator.getCostRate();
  res.json({ success: true, cost_per_gb: costPerGb });
}, { operation: 'getCostRate' }));

/**
 * PUT /api/admin/brightdata/cost-rate
 * Update the Bright Data cost rate ($/GB).
 * Body: { "cost_per_gb": number }
 */
router.put(
  '/cost-rate',
  validate(costRateSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof costRateSchemas, AuthenticatedRequest>, res) => {
    const { cost_per_gb } = req.body;

    const calculator = await getCostCalculator();
    await calculator.setCostRate(cost_per_gb, req.user!.id);
    res.json({ success: true, cost_per_gb });
  }, { operation: 'setCostRate' }),
);

/**
 * GET /api/admin/brightdata/job-costs/:jobId
 * Return bandwidth record and estimated cost for a single job.
 */
router.get('/job-costs/:jobId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = String(req.params.jobId);
  const calculator = await getCostCalculator();
  const result = await calculator.getJobCost(jobId);

  if (!result) {
    res.status(404).json(
      errorResponse(`No bandwidth record found for job ${jobId}`, 'not_found'),
    );
    return;
  }

  res.json({ success: true, ...result });
}, { operation: 'getJobCost' }));

/**
 * POST /api/admin/brightdata/job-costs/batch
 * Batch bandwidth + cost lookup. Body: { ids: string[] }.
 * Returns a map keyed by jobId; missing jobs are simply absent from the map.
 */
router.post(
  '/job-costs/batch',
  validate(jobCostsBatchSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof jobCostsBatchSchemas, AuthenticatedRequest>, res) => {
    const { ids } = req.body;
    const calculator = await getCostCalculator();
    const results = await Promise.all(
      ids.map(async (id: unknown) => {
        const jobId = String(id);
        const result = await calculator.getJobCost(jobId).catch(() => null);
        return [jobId, result] as const;
      }),
    );
    const map: Record<string, { bandwidth: unknown; estimatedCost: number }> = {};
    for (const [id, result] of results) {
      if (result) map[id] = result;
    }
    res.json({ success: true, results: map });
  }, { operation: 'getJobCostsBatch' }),
);

export default router;
