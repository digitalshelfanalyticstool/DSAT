/**
 * Admin Health Routes — real-time health dashboard, historical snapshots,
 * and operational actions (PM2 restart, queue pause, DB cleanup).
 *
 * All routes require authentication + admin role.
 *
 * Endpoints:
 *   - GET    /api/admin/health/stream      — SSE real-time health (5s push)
 *   - GET    /api/admin/health/history     — historical snapshots (24h/7d/30d)
 *   - POST   /api/admin/health/actions/:action — execute an admin action
 */

import { Router, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sseAuthMiddleware, requireRole } from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getHealthMonitor } from '../services/health-monitor';
import { DatabaseService } from '../services/database';
import { getQueueService } from '../services/queue-service';
import { SCRAPE_QUEUE } from '../services/queues';
import { cleanupExpiredTokens } from '../services/auth-token-cleanup';
import { listCatalogCaches, purgeCatalogCache } from '../services/product-catalog';
import { getSites, getBrands } from '../services/config-manager';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { initSSE, sendSSEEvent, startHeartbeat } from '../utils/sse';
import { getAuditContext } from './audit-context';

const logger = createLogger('admin-health');
const router = Router();
const execFileAsync = promisify(execFile);

// ─── Rate Limiting for Actions ──────────────────────────────────────────────

const actionCooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000; // 60 seconds

function checkCooldown(action: string): boolean {
  const last = actionCooldowns.get(action);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return false;
  }
  actionCooldowns.set(action, Date.now());
  return true;
}

// ─── SSE Health Stream ──────────────────────────────────────────────────────

const SSE_INTERVAL_MS = 5_000;

/**
 * GET /stream — Server-Sent Events for real-time health updates.
 * Pushes a full HealthReport every 5 seconds.
 *
 * Deliberately its own router (mounted separately in admin.ts, before that
 * router's blanket authMiddleware) and gated with sseAuthMiddleware instead
 * of the general authMiddleware every other admin-health route inherits. A
 * single-use SSE ticket must authenticate exactly the three stream routes,
 * never the general API — authMiddleware rejects sse_-prefixed tokens
 * outright, so this route can't reach a user through that path at all.
 * requireRole('admin') still applies, explicitly, since this route no
 * longer inherits it from the parent admin router either.
 */
export const adminHealthStreamRouter = Router();

adminHealthStreamRouter.get('/stream', sseAuthMiddleware, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  initSSE(res);
  res.flushHeaders();

  sendSSEEvent(res, 'connected', { message: 'Connected to health stream' });

  let active = true;
  const monitor = getHealthMonitor();

  // Push health report every 5 seconds
  const pushTimer = setInterval(async () => {
    if (!active) return;
    try {
      const report = await monitor.check();
      sendSSEEvent(res, 'health', report);
    } catch (err) {
      logger.warn('Failed to push health event', {
        operation: 'healthStream',
        error: (err as Error).message,
      });
    }
  }, SSE_INTERVAL_MS);

  // Send first report immediately
  monitor.check().then((report) => {
    if (active) sendSSEEvent(res, 'health', report);
  }).catch((err: unknown) => {
    logger.warn('Initial SSE health check failed', { error: err instanceof Error ? err.message : String(err) });
  });

  // Heartbeat to keep connection alive through proxies
  const heartbeatTimer = startHeartbeat(res);

  const cleanup = (): void => {
    if (!active) return;
    active = false;
    clearInterval(pushTimer);
    clearInterval(heartbeatTimer);
  };

  req.on('close', cleanup);
});

// ─── Polling Fallback ───────────────────────────────────────────────────────

/**
 * GET /stream/poll — single health check response (fallback when SSE fails).
 */
router.get('/stream/poll', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const monitor = getHealthMonitor();
  const report = await monitor.check();
  res.json(report);
}, { operation: 'healthPoll', message: 'Health check failed' }));

// ─── Historical Snapshots ───────────────────────────────────────────────────

/**
 * GET /history?range=24h|7d|30d — historical health snapshots.
 * Aggregated by time bucket depending on range.
 */
router.get('/history', asyncHandler(async (req: AuthenticatedRequest, res) => {
  // Normalize to the supported set explicitly so an unknown/typo'd range
  // (e.g. "7D") deterministically maps to the 24h default instead of silently
  // falling through the switch with no signal.
  const VALID_RANGES = ['24h', '7d', '30d'] as const;
  const rawRange = (req.query.range as string) || '24h';
  const range = (VALID_RANGES as readonly string[]).includes(rawRange) ? rawRange : '24h';
  const db = await DatabaseService.getInstance();

  let query: string;
  switch (range) {
    case '7d':
      // Average per hour
      query = `
        SELECT
          date_trunc('hour', created_at) AS bucket,
          mode() WITHIN GROUP (ORDER BY status) AS status,
          ROUND(AVG(uptime))::INTEGER AS uptime,
          BOOL_AND(pg_ok) AS pg_ok,
          ROUND(AVG(pg_pool_size))::INTEGER AS pg_pool_size,
          ROUND(AVG(pg_active_connections))::INTEGER AS pg_active_connections,
          BOOL_AND(redis_ok) AS redis_ok,
          ROUND(AVG(redis_memory_mb)::NUMERIC, 2)::REAL AS redis_memory_mb,
          ROUND(AVG(redis_clients))::INTEGER AS redis_clients,
          -- 6-hour bucketing:
          --   1) date_trunc('day', created_at) gives midnight of the day
          --   2) EXTRACT(HOUR FROM created_at) / 6 yields 0–3 for hours 0–23
          --   3) FLOOR(...) * INTERVAL '6 hours' gives 0, 6, 12, or 18 hours
          --   4) Adding that interval to the truncated day gives the bucket start time
          ROUND(AVG(queue_waiting))::INTEGER AS queue_waiting,
          ROUND(AVG(queue_active))::INTEGER AS queue_active,
          ROUND(AVG(queue_stalled))::INTEGER AS queue_stalled,
          ROUND(AVG(workers_active))::INTEGER AS workers_active,
          ROUND(AVG(workers_expected))::INTEGER AS workers_expected
        FROM health_snapshots
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY bucket
        ORDER BY bucket ASC
      `;
      break;

    case '30d':
      // Average per 6-hour bucket
      query = `
        SELECT
          date_trunc('day', created_at) + INTERVAL '6 hours' * FLOOR(EXTRACT(HOUR FROM created_at) / 6) AS bucket,
          mode() WITHIN GROUP (ORDER BY status) AS status,
          ROUND(AVG(uptime))::INTEGER AS uptime,
          BOOL_AND(pg_ok) AS pg_ok,
          ROUND(AVG(pg_pool_size))::INTEGER AS pg_pool_size,
          ROUND(AVG(pg_active_connections))::INTEGER AS pg_active_connections,
          BOOL_AND(redis_ok) AS redis_ok,
          ROUND(AVG(redis_memory_mb)::NUMERIC, 2)::REAL AS redis_memory_mb,
          ROUND(AVG(redis_clients))::INTEGER AS redis_clients,
          ROUND(AVG(queue_waiting))::INTEGER AS queue_waiting,
          ROUND(AVG(queue_active))::INTEGER AS queue_active,
          ROUND(AVG(queue_stalled))::INTEGER AS queue_stalled,
          ROUND(AVG(workers_active))::INTEGER AS workers_active,
          ROUND(AVG(workers_expected))::INTEGER AS workers_expected
        FROM health_snapshots
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY bucket
        ORDER BY bucket ASC
      `;
      break;

    default:
      // 24h: raw snapshots
      query = `
        SELECT
          created_at AS bucket,
          status, uptime,
          pg_ok, pg_pool_size, pg_active_connections,
          redis_ok, redis_memory_mb, redis_clients,
          queue_waiting, queue_active, queue_stalled,
          workers_active, workers_expected
        FROM health_snapshots
        WHERE created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at ASC
      `;
      break;
  }

  const rows = await db.all(query);
  res.json({ success: true, range, snapshots: rows });
}, { operation: 'healthHistory', message: 'Failed to fetch health history' }));

// ─── Catalog Cache Inventory ──────────────────────────────────────────────────

/**
 * GET /cache — list on-disk discovery/variant caches with a poisoned-run flag,
 * so an admin can spot and purge a catalog that replayed a bad discovery.
 */
router.get('/cache', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const caches = await listCatalogCaches();
  res.json({ success: true, caches });
}, { operation: 'listCatalogCaches', message: 'Failed to list catalog caches' }));

// ─── Admin Actions ──────────────────────────────────────────────────────────

/** Allowed PM2 process names to prevent arbitrary command execution. */
const ALLOWED_PM2_PROCESSES = new Set([
  'scraper-api',
  'scraper-worker-1',
  'scraper-worker-2',
  'scraper-worker-3',
  'scraper-worker-4',
]);

async function logAction(req: AuthenticatedRequest, action: string, details: string): Promise<void> {
  const { audit, ctx } = await getAuditContext(req);
  await audit.log({
    userId: req.user!.id,
    action: 'system_action',
    resourceType: 'system',
    resourceId: action,
    details,
    ...ctx,
  });
}

/**
 * purge-cache action: validate site+brand against config, then move the catalog
 * + variant caches aside so the next run re-discovers. Extracted from the action
 * switch to keep that handler's complexity in check.
 */
async function handlePurgeCache(req: AuthenticatedRequest, res: Response, action: string): Promise<void> {
  const site = String(req.body?.site ?? '').toLowerCase().trim();
  const brand = String(req.body?.brand ?? '').toLowerCase().trim();
  if (!site || !brand) {
    res.status(400).json(errorResponse('site and brand are required', 'validation_error'));
    return;
  }
  const [sites, brands] = await Promise.all([getSites(), getBrands()]);
  const siteOk = sites.some((s) => s.name.toLowerCase() === site);
  const brandOk = brands.some((b) => b.name.toLowerCase() === brand);
  if (!siteOk || !brandOk) {
    res.status(400).json(errorResponse('Unknown site or brand', 'validation_error'));
    return;
  }
  const moved = await purgeCatalogCache(site, brand);
  await logAction(req, action, `Purged ${site}/${brand} cache (${moved.length} file(s))`);
  res.json({
    success: true,
    message: moved.length > 0
      ? `Purged ${site}/${brand} — ${moved.length} cache file(s) moved aside. Next run re-discovers.`
      : `No active cache for ${site}/${brand}.`,
  });
}

/**
 * purge-all-caches action: move every on-disk catalog + variant cache aside.
 * Bulk counterpart to purge-cache — used when several caches look stale/poisoned
 * at once instead of purging one site/brand at a time.
 */
async function handlePurgeAllCaches(req: AuthenticatedRequest, res: Response, action: string): Promise<void> {
  const caches = await listCatalogCaches();
  let totalFiles = 0;
  for (const c of caches) {
    const moved = await purgeCatalogCache(c.site, c.brand);
    totalFiles += moved.length;
  }
  await logAction(req, action, `Purged all catalog caches (${caches.length} site/brand pair(s), ${totalFiles} file(s))`);
  res.json({
    success: true,
    message: caches.length > 0
      ? `Purged ${caches.length} cache(s) — ${totalFiles} file(s) moved aside. Next runs re-discover.`
      : 'No active caches to purge.',
  });
}

/**
 * POST /actions/:action — execute an admin action.
 */
router.post('/actions/:action', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const action = req.params.action as string;

  // purge-cache is keyed per site+brand so an admin can clear several poisoned
  // entries in succession without tripping the shared 60s action cooldown.
  const cooldownKey = action === 'purge-cache'
    ? `purge-cache:${String(req.body?.site ?? '')}:${String(req.body?.brand ?? '')}`
    : action;

  if (!checkCooldown(cooldownKey)) {
    res.status(429).json(errorResponse('Action on cooldown. Please wait 60 seconds.', 'rate_limited'));
    return;
  }

  // A thrown action failure propagates to the central error handler, which logs
  // the real error server-side and returns a generic 500 (no err.message leak).
  switch (action) {
      case 'restart-api': {
        await execFileAsync('pm2', ['restart', 'scraper-api']);
        await logAction(req, action, 'Restarted scraper-api process');
        res.json({ success: true, message: 'API process restarted' });
        break;
      }

      case 'restart-worker': {
        const name = req.body?.name;
        if (!name || !ALLOWED_PM2_PROCESSES.has(name)) {
          res.status(400).json(errorResponse(
            `Invalid process name. Allowed: ${[...ALLOWED_PM2_PROCESSES].join(', ')}`,
            'validation_error',
          ));
          return;
        }
        // After ALLOWED_PM2_PROCESSES.has(name) check above, name is provably
        // one of the literal strings in that Set, but req.body.name typed as any.
        const safeName = String(name);
        await execFileAsync('pm2', ['restart', safeName]);
        await logAction(req, action, `Restarted ${safeName} process`);
        res.json({ success: true, message: `${safeName} restarted` });
        break;
      }

      case 'pause-queue': {
        const queue = getQueueService().queue(SCRAPE_QUEUE);
        await queue.pause();
        await logAction(req, action, `Paused ${SCRAPE_QUEUE} queue`);
        res.json({ success: true, message: 'Queue paused' });
        break;
      }

      case 'resume-queue': {
        const queue = getQueueService().queue(SCRAPE_QUEUE);
        await queue.resume();
        await logAction(req, action, `Resumed ${SCRAPE_QUEUE} queue`);
        res.json({ success: true, message: 'Queue resumed' });
        break;
      }

      case 'cleanup-tokens': {
        const db = await DatabaseService.getInstance();
        const deleted = await cleanupExpiredTokens(db);
        await logAction(req, action, `Cleaned up ${deleted} expired tokens`);
        res.json({ success: true, message: `${deleted} expired tokens cleaned up` });
        break;
      }

      case 'clear-rate-limits': {
        const db = await DatabaseService.getInstance();
        const result = await db.run('DELETE FROM rate_limit_attempts');
        const count = result.changes;
        await logAction(req, action, `Cleared ${count} rate limit entries`);
        res.json({ success: true, message: `${count} rate limit entries cleared` });
        break;
      }

      case 'flush-dlq': {
        const queueService = getQueueService();
        const { jobs } = await queueService.getFailedJobs(0, 999);
        let retried = 0;
        for (const job of jobs) {
          try {
            await queueService.retryFailedJob(job.id);
            retried++;
          } catch {
            // Skip jobs that can't be retried
          }
        }
        await logAction(req, action, `Retried ${retried}/${jobs.length} failed jobs`);
        res.json({ success: true, message: `${retried} failed jobs retried` });
        break;
      }

      case 'purge-cache':
        await handlePurgeCache(req, res, action);
        break;

      case 'purge-all-caches':
        await handlePurgeAllCaches(req, res, action);
        break;

      default:
        res.status(400).json(errorResponse(`Unknown action: ${action}`, 'validation_error'));
    }
}));

export default router;
