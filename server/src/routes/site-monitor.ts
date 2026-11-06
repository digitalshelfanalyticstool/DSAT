/**
 * Site Monitor API Routes — endpoints for site change monitoring dashboard.
 *
 * All routes require admin authentication.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, sseAuthMiddleware, requireRole } from '../middleware/auth';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { DatabaseService } from '../services/database';
import { runMonitor, startMonitorRun, getMonitorSchedule, type MonitorScheduleConfig } from '../services/site-monitor-runner';
import { knownRetailers } from '../services/retailers';
import { getProgressBus, type MonitorProgressEvent } from '../services/progress-bus';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { initSSE, sendSSEEvent, startHeartbeat } from '../utils/sse';
import { paginationWithLimitSchema } from '../utils/schemas';

const logger = createLogger('site-monitor-routes');
const router = Router();

// Shared by the SSE stream route below (moved ahead of the blanket
// authMiddleware — see the route's own comment) and by runChangesSchemas
// further down.
const runIdParamSchema = z.object({
  runId: z.coerce.number().int().min(1),
});
const runIdSchemas = { params: runIdParamSchema };

/**
 * GET /api/site-monitor/runs/:runId/stream
 * SSE stream of live progress events for a monitor run.
 *
 * Registered BEFORE `router.use(authMiddleware)` below and gated with
 * sseAuthMiddleware + requireRole('admin') instead: a single-use SSE ticket
 * must authenticate exactly this route (and the other two stream routes),
 * never the general API — authMiddleware rejects sse_-prefixed tokens
 * outright. Because this route is terminal, a request that matches it never
 * reaches the router-wide authMiddleware registered afterward, so every
 * other route in this file is unaffected.
 */
router.get(
  '/runs/:runId/stream',
  sseAuthMiddleware,
  requireRole('admin'),
  validate(runIdSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof runIdSchemas>, res) => {
    const { runId } = req.params;
    const db = await DatabaseService.getInstance();

    const run = await db.get<{ id: number; status: string; error_message: string | null }>(
      'SELECT id, status, error_message FROM site_monitor_runs WHERE id = $1',
      runId,
    );

    if (!run) {
      res.status(404).json(errorResponse(`Monitor run ${runId} not found`, 'not_found'));
      return;
    }

    // Set SSE headers
    initSSE(res);
    res.flushHeaders();

    sendSSEEvent(res, 'connected', { run_id: runId, message: 'Connected to monitor updates' });

    // If run is already terminal, send status and close
    if (run.status === 'completed' || run.status === 'failed') {
      sendSSEEvent(res, run.status, {
        run_id: runId,
        status: run.status,
        error_message: run.error_message,
      });
      res.end();
      return;
    }

    // Subscribe to Redis Pub/Sub monitor progress channel
    let subscribed = true;

    const progressHandler = (event: MonitorProgressEvent): void => {
      try {
        sendSSEEvent(res, 'progress', event);

        if (event.type === 'run_complete' || event.type === 'run_error') {
          sendSSEEvent(res, event.type === 'run_complete' ? 'completed' : 'failed', event);
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
      }
    };

    const disposeProgress = await getProgressBus().subscribeMonitorProgress(runId, progressHandler);

    // Heartbeat to keep connection alive through proxies
    const heartbeatTimer = startHeartbeat(res);

    const cleanup = (): void => {
      if (!subscribed) return;
      subscribed = false;
      clearInterval(heartbeatTimer);
      disposeProgress().catch((err) => {
        logger.warn('Failed to unsubscribe from monitor progress channel', {
          operation: 'monitorStream',
          runId,
          error: (err as Error).message,
        });
      });
    };

    req.on('close', cleanup);
  }, { operation: 'monitorStream', message: 'Failed to establish stream' }),
);

// All other site-monitor routes require the general API auth (real
// access tokens only — never an sse_ ticket, which authMiddleware now
// rejects).
router.use(authMiddleware);
router.use(requireRole('admin'));

// --- Validation Schemas ---

const runsQuerySchema = paginationWithLimitSchema;

const changesQuerySchema = z.object({
  retailer: z.string().min(1).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
});

const runsSchemas = { query: runsQuerySchema };
const runChangesSchemas = { params: runIdParamSchema, query: changesQuerySchema };

// --- Routes ---

/**
 * GET /api/site-monitor/runs
 * Paginated list of monitor runs ordered by started_at DESC.
 */
router.get(
  '/runs',
  validate(runsSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof runsSchemas>, res) => {
    const { page, limit } = req.query;
    const offset = (page - 1) * limit;

    const db = await DatabaseService.getInstance();

    const countRow = await db.get<{ count: string }>(
      'SELECT COUNT(*) as count FROM site_monitor_runs',
    );
    const total = Number.parseInt(countRow?.count ?? '0', 10);

    const runs = await db.all<{
      id: number;
      status: string;
      retailers_checked: number;
      total_changes_detected: number;
      critical_changes: number;
      started_at: string;
      completed_at: string | null;
      error_message: string | null;
    }>(
      `SELECT id, status, retailers_checked, total_changes_detected, critical_changes,
              started_at, completed_at, error_message
       FROM site_monitor_runs
       ORDER BY started_at DESC
       LIMIT $1 OFFSET $2`,
      limit,
      offset,
    );

    res.json({ success: true, runs, pagination: { page, limit, total } });
  }, { operation: 'getMonitorRuns', message: 'Failed to fetch monitor runs' }),
);

/**
 * GET /api/site-monitor/runs/:runId/changes
 * Changes for a specific run, with optional retailer and severity filters.
 */
router.get(
  '/runs/:runId/changes',
  validate(runChangesSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof runChangesSchemas>, res) => {
    const { runId } = req.params;
    const { retailer, severity } = req.query;

    const db = await DatabaseService.getInstance();

    // Check run exists
    const run = await db.get<{ id: number }>(
      'SELECT id FROM site_monitor_runs WHERE id = $1',
      runId,
    );
    if (!run) {
      res.status(404).json(errorResponse(`Monitor run ${runId} not found`, 'not_found'));
      return;
    }

    // Build filtered query
    const conditions = ['run_id = $1'];
    const params: unknown[] = [runId];
    let paramIdx = 2;

    if (retailer) {
      conditions.push(`retailer = $${paramIdx}`);
      params.push(retailer);
      paramIdx++;
    }
    if (severity) {
      conditions.push(`severity = $${paramIdx}`);
      params.push(severity);
      paramIdx++;
    }

    const changes = await db.all<{
      id: number;
      retailer: string;
      product_id: number;
      url: string;
      change_type: string;
      selector_or_field: string;
      severity: string;
      description: string;
      before_value: string | null;
      after_value: string | null;
      detected_at: string;
    }>(
      `SELECT id, retailer, product_id, url, change_type, selector_or_field, severity,
              description, before_value, after_value, detected_at
       FROM site_monitor_changes
       WHERE ${conditions.join(' AND ')}
       ORDER BY detected_at DESC`,
      ...params,
    );

    res.json({ success: true, changes });
  }, { operation: 'getRunChanges', message: 'Failed to fetch run changes' }),
);

/**
 * GET /api/site-monitor/summary
 * Per-retailer summary: last check date, change count, highest severity.
 */
router.get('/summary', asyncHandler(async (req, res) => {
  const db = await DatabaseService.getInstance();
  const retailers = await knownRetailers();

  // Get the most recent completed run
  const lastRun = await db.get<{ id: number; started_at: string }>(
    `SELECT id, started_at FROM site_monitor_runs
     WHERE status = 'completed'
     ORDER BY started_at DESC LIMIT 1`,
  );

  const summaries = [];

  if (lastRun) {
    // Get all stats for all retailers in a single grouped query
    const statsRows = await db.all<{ retailer: string; change_count: string; highest_severity: string | null }>(
      `SELECT retailer,
              COUNT(*) as change_count,
              CASE
                WHEN COUNT(*) FILTER (WHERE severity = 'critical') > 0 THEN 'critical'
                WHEN COUNT(*) FILTER (WHERE severity = 'warning') > 0 THEN 'warning'
                WHEN COUNT(*) FILTER (WHERE severity = 'info') > 0 THEN 'info'
                ELSE NULL
              END as highest_severity
       FROM site_monitor_changes
       WHERE run_id = $1 AND retailer = ANY($2)
       GROUP BY retailer`,
      lastRun.id,
      retailers,
    );

    // Build a map of stats by retailer for easy lookup
    const statsByRetailer = new Map(
      statsRows.map((row) => [
        row.retailer,
        { change_count: row.change_count, highest_severity: row.highest_severity },
      ]),
    );

    // Build response with all retailers, filling in zeros/nulls for missing data
    for (const retailer of retailers) {
      const stats = statsByRetailer.get(retailer);
      summaries.push({
        retailer,
        last_check_date: lastRun.started_at,
        change_count: stats ? Number.parseInt(stats.change_count, 10) : 0,
        highest_severity: stats?.highest_severity ?? null,
      });
    }
  } else {
    // If no completed run exists, return zeros for all retailers
    for (const retailer of retailers) {
      summaries.push({
        retailer,
        last_check_date: null,
        change_count: 0,
        highest_severity: null,
      });
    }
  }

  res.json({ success: true, retailers: summaries });
}, { operation: 'getSiteMonitorSummary', message: 'Failed to fetch summary' }));

// --- Monitor schedule ---

const scheduleBodySchema = z.object({
  enabled: z.boolean(),
  schedule_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  schedule_days: z.array(z.number().int().min(0).max(6)).min(0).max(7),
});
const scheduleSchemas = { body: scheduleBodySchema };

/**
 * GET /api/site-monitor/schedule
 * Returns the current monitor schedule config (or defaults).
 */
router.get('/schedule', asyncHandler(async (_req, res) => {
  const config = await getMonitorSchedule();
  res.json({ success: true, schedule: config });
}, { operation: 'getMonitorSchedule', message: 'Failed to fetch monitor schedule' }));

/**
 * PUT /api/site-monitor/schedule
 * Update the monitor schedule config.
 */
router.put(
  '/schedule',
  validate(scheduleSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof scheduleSchemas>, res) => {
    const { enabled, schedule_time, schedule_days } = req.body;

    // Validate HH:MM values
    const [hh, mm] = schedule_time.split(':').map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      res.status(400).json(errorResponse('Invalid time: hours must be 0-23, minutes 0-59', 'validation_error'));
      return;
    }

    const config: MonitorScheduleConfig = { enabled, schedule_time, schedule_days };
    const db = await DatabaseService.getInstance();
    const now = Math.floor(Date.now() / 1000);

    await db.run(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      'site_monitor_schedule',
      JSON.stringify(config),
      now,
    );

    res.json({ success: true, schedule: config });
  }, { operation: 'updateMonitorSchedule', message: 'Failed to update monitor schedule' }),
);

/**
 * POST /api/site-monitor/trigger
 * Trigger an on-demand monitor run. Returns 409 if one is already running.
 */
router.post('/trigger', asyncHandler(async (req, res) => {
  const runId = await startMonitorRun();
  if (runId === null) {
    res.status(409).json(errorResponse(
      'A monitor run is already in progress',
      'conflict',
    ));
    return;
  }

  // Execute the monitor asynchronously — don't block the response
  runMonitor(runId).catch((err) => {
    logger.error('Triggered monitor run failed', {
      operation: 'triggerMonitorRun',
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  res.json({
    success: true,
    run_id: runId,
    status: 'running',
  });
}, { operation: 'triggerMonitorRun', message: 'Failed to trigger monitor run' }));

export default router;
