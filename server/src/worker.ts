/**
 * Worker Entry Point — standalone process that consumes scraping jobs from BullMQ.
 *
 * Each worker process initializes its own PostgreSQL connection pool, Redis connections,
 * and BullMQ consumer. Multiple instances run in parallel via PM2 to achieve
 * 50 concurrent scraping jobs across 4 workers.
 *
 * Environment variables:
 *   WORKER_CONCURRENCY  — max concurrent jobs for this worker (default 13)
 *   DATABASE_POOL_SIZE  — PostgreSQL pool max connections (default in config.ts)
 *   REDIS_URL           — Redis connection string (default redis://localhost:6379)
 *
 * Lifecycle:
 *   1. Initialize PG pool, Redis, rate limiter, job store, queue service
 *   2. Clean up stale jobs from previous sessions
 *   3. Start BullMQ consumer with configured concurrency
 *   4. Start Redis heartbeat reporting
 *   5. On SIGTERM/SIGINT: stop accepting new jobs, wait for active jobs, shut down
 */

// Loads .env and initializes Sentry; must come before any module that loads http/express.
import './instrument';

import { hostname } from 'node:os';

import { DatabaseService } from './services/database';
import { recordScheduledRunResult } from './services/scheduler';
import { getJobStore } from './services/job-store';
import { startAttempt, completeJob, failJob, failStaleJobs } from './services/job-lifecycle';
import { QueueService } from './services/queue-service';
import { SCRAPE_QUEUE, EXCEL_QUEUE, PERSIST_QUEUE, WEBHOOK_QUEUE, type ScrapeJobPayload } from './services/queues';
import { getProgressBus } from './services/progress-bus';
import { getRedisClient, scanByPattern } from './services/redis-client';
import {
  WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_PATTERN, WORKER_HEARTBEAT_TTL_S,
  workerHeartbeatKey, workerIdFromHeartbeatKey, type WorkerHeartbeat,
} from './services/worker-heartbeat';
import { getRateLimiter } from './services/rate-limiter';
import { scrapeSite } from './services/scraper-orchestrator';
import { classifyFailure } from './services/failure-classifier';
import { cleanupOldCheckpoints, loadCheckpointForResume } from './services/checkpoint-manager';
import { handleExcelJob } from './services/excel-job-handler';
import { handlePersistJob } from './services/persist-job-handler';
import { handleWebhookJob } from './services/alerts/webhooks';
import { createLogger } from './utils/logger';
import { JobBandwidthStore } from './services/job-bandwidth-store';
import { BandwidthTracker, setBandwidthTracker, getBandwidthTracker } from './services/bandwidth-tracker';
import { sendJobCompleteEmail } from './services/job-complete-email';
import { config, validateConfigOrExit } from './config';
import { useProviderStore } from './services/scraping-provider-settings';

const logger = createLogger('worker');

// ── Configuration ───────────────────────────────────────────────────────────


// Worker identity: PM2 instance ID or hostname + pid.
const WORKER_ID = config.worker.pm2InstanceId
  ? `worker-${config.worker.pm2InstanceId}`
  : `worker-${hostname()}-${process.pid}`;

/** Max age (days) for checkpoint files — older ones are deleted on startup. */
const CHECKPOINT_MAX_AGE_DAYS = 7;

// ── Mutable state ───────────────────────────────────────────────────────────

let activeJobCount = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

/** Track job IDs currently being processed by this worker, for shutdown cleanup. */
const activeJobIds = new Set<string>();

// Service references (initialized in start())
let db: DatabaseService;
let queueService: QueueService;

/** Abort reasons: the run stops for one of these, not because scraping failed. */
class JobCancelledError extends Error {}
class JobTimeoutError extends Error {}

/** A promise that rejects with the signal's reason once it aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  p.catch(() => {}); // only ever observed through Promise.race
  return p;
}

/** Tell a scheduled job's schedule how its run ended (drives schedule retries). */
async function reportToSchedule(payload: ScrapeJobPayload, errorMessage: string | null): Promise<void> {
  if (!payload.scheduleId) return;
  await recordScheduledRunResult(db, payload.scheduleId, errorMessage).catch((err: unknown) => {
    logger.warn('Failed to record scheduled run result', {
      operation: 'handleJob', jobId: payload.jobId, scheduleId: payload.scheduleId, error: (err as Error).message,
    });
  });
}


// ── Job Handler ─────────────────────────────────────────────────────────────

/**
 * Process one attempt of a scraping job dequeued from BullMQ.
 *
 * 1. Listen for a cancel signal, then claim the row (queued → running). A row
 *    that isn't queued (cancelled before pickup, or a BullMQ re-delivery) is skipped.
 * 2. Acquire the per-retailer rate limit token and run scrapeSite with an
 *    AbortSignal that cancel and the job timeout both fire.
 * 3. Record the outcome through the lifecycle (guarded, so a cancel stands)
 *    and publish it for SSE.
 *
 * Never rethrows: the outcome is recorded here, and the scrape queue runs each
 * attempt once (attempts: 1).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- the worker's one job-lifecycle chokepoint: each failure mode (claim, scrape, abort, record, publish) is handled where it is visible next to the others. NOSONAR(typescript:S3776).
async function handleJob(payload: ScrapeJobPayload): Promise<void> {
  const { jobId, site, brand } = payload;
  const rateLimiter = getRateLimiter();
  const bus = getProgressBus();
  const timeoutMs = config.jobs.jobTimeoutMs;
  const controller = new AbortController();
  let tokenId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let disposeCancel: (() => Promise<void>) | undefined;

  activeJobCount++;
  activeJobIds.add(jobId);
  logger.info('Job dequeued', { operation: 'handleJob', jobId, site, brand, workerId: WORKER_ID, activeJobs: activeJobCount });

  try {
    // Subscribe before claiming: a cancel landing before the claim makes the
    // claim fail; one landing after reaches this subscription.
    disposeCancel = await bus.subscribeCancel(jobId, () => controller.abort(new JobCancelledError('Job cancelled')));

    if (!(await startAttempt(jobId, WORKER_ID))) {
      logger.info('Job is not queued any more; skipping', { operation: 'handleJob', jobId });
      return;
    }
    await bus.publishProgress(jobId, { jobId, status: 'running', phase: 'discovery' });

    tokenId = await rateLimiter.acquire(site);
    logger.info('Rate limit token acquired', { operation: 'handleJob', jobId, site, tokenId });

    timer = setTimeout(
      () => controller.abort(new JobTimeoutError(`Job timed out after ${timeoutMs / 60000} minutes`)),
      timeoutMs,
    );
    const aborted = whenAborted(controller.signal);

    // Release the rate-limit token as soon as Bright-Data-billing phases
    // (1–4) finish. Persist (4.5) and Excel (5) run via separate queues at
    // low concurrency; pinning the slot through their queue waits dropped
    // effective retailer concurrency by ~33–40% during bursts.
    // Clears tokenId before awaiting, so a second call and the finally below are no-ops.
    const releaseRateLimitTokenEarly = async (): Promise<void> => {
      const held = tokenId;
      if (!held) return;
      tokenId = undefined;
      await rateLimiter.release(site, held).catch((err: unknown) => {
        logger.warn('Failed to release rate limit token early', { operation: 'handleJob', jobId, site, error: (err as Error).message });
      });
    };

    const checkpoint = payload.resume ? await loadCheckpointForResume(jobId) : undefined;
    const result = await Promise.race([
      scrapeSite(jobId, site, brand, {
        checkpoint,
        queueService,
        onBrightDataPhasesComplete: releaseRateLimitTokenEarly,
        signal: controller.signal,
      }),
      aborted,
    ]);

    // ── Phase 5 (off the hot path): dispatch Excel via excel-jobs queue ──
    // When Phase 4.5 (DB persist) succeeded, scrapeSite returns a deterministic
    // file_path without generating the file; generation runs on the excel queue.
    // When scrape_run_id is null, scrapeSite already generated inline as fallback.
    if (result.scrape_run_id !== null) {
      await bus.publishProgress(jobId, { jobId, status: 'running', phase: 'excel' });
      const excelResult = await Promise.race([
        queueService.runExcelJob({ jobId, siteName: site, brand, scrapeRunId: result.scrape_run_id, outputPath: result.file_path }),
        aborted,
      ]);
      result.file_path = excelResult.filePath;
      result.phase_timings.excel = excelResult.durationMs;
    }

    const completed = await completeJob(jobId, {
      file_path: result.file_path,
      products_discovered: result.products_discovered,
      products_processed: result.products_processed,
      variants_extracted: result.variants_extracted,
      failed_products: result.failed_products,
      phase_timings: result.phase_timings,
    });
    if (!completed) {
      logger.info('Job finished after it was cancelled; result discarded', { operation: 'handleJob', jobId });
      return;
    }

    await bus.publishProgress(jobId, {
      jobId,
      status: 'completed',
      file_path: result.file_path,
      products_discovered: result.products_discovered,
      products_processed: result.products_processed,
      variants_extracted: result.variants_extracted,
    });

    // Fire-and-forget job-complete email. EmailService never throws and writes
    // an email_log row for every outcome; the worker doesn't await so a slow
    // mail provider can't add latency to job completion or pin worker concurrency.
    void sendJobCompleteEmail({ jobId, site, brand, rowCount: result.variants_extracted }).catch((err) => {
      logger.warn('Job-complete email failed (non-blocking)', { operation: 'handleJob', jobId, error: (err as Error).message });
    });

    await reportToSchedule(payload, null);

    logger.info('Job completed', {
      operation: 'handleJob', jobId, site, brand,
      products_discovered: result.products_discovered,
      products_processed: result.products_processed,
      variants_extracted: result.variants_extracted,
    });
  } catch (err) {
    if (err instanceof JobCancelledError) {
      // The API already wrote `cancelled` and published it; nothing to record.
      logger.info('Job stopped after cancel', { operation: 'handleJob', jobId });
      return;
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Job failed', { operation: 'handleJob', jobId, site, brand, error: errorMessage });

    let stillActive = true;
    try {
      stillActive = (await failJob(jobId, errorMessage, classifyFailure(err))) !== undefined;
    } catch (updateErr) {
      // Publish anyway: a client watching SSE must not wait forever on a dead job.
      logger.error('Failed to update job status after error', { operation: 'handleJob', jobId, error: (updateErr as Error).message });
    }
    if (!stillActive) return; // cancelled meanwhile: that outcome stands

    try {
      await bus.publishProgress(jobId, { jobId, status: 'failed', error_message: errorMessage });
    } catch (pubErr) {
      logger.error('Failed to publish failure progress', { operation: 'handleJob', jobId, error: (pubErr as Error).message });
    }

    await reportToSchedule(payload, errorMessage);
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new JobCancelledError('Job attempt ended'));
    await disposeCancel?.().catch(() => {});

    if (tokenId) {
      try {
        await rateLimiter.release(site, tokenId);
      } catch (releaseErr) {
        logger.warn('Failed to release rate limit token', {
          operation: 'handleJob', jobId, site, tokenId, error: (releaseErr as Error).message,
        });
      }
    }

    activeJobCount--;
    activeJobIds.delete(jobId);
    logger.debug('Job slot freed', { operation: 'handleJob', jobId, activeJobs: activeJobCount });
  }
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

/**
 * Start periodic Redis heartbeat updates.
 * Writes a WorkerHeartbeat under workerHeartbeatKey() with a TTL.
 * If the worker dies without graceful shutdown, the key auto-expires.
 */
function startHeartbeat(): void {
  const redisClient = getRedisClient();
  const publisher = redisClient.getPublisherConnection();
  const key = workerHeartbeatKey(WORKER_ID);

  const updateHeartbeat = async (): Promise<void> => {
    try {
      const heartbeat: WorkerHeartbeat = {
        lastSeen: new Date().toISOString(),
        activeJobs: activeJobCount,
        pid: process.pid,
        concurrency: config.worker.concurrency,
        workerId: WORKER_ID,
      };
      await publisher.set(key, JSON.stringify(heartbeat), 'EX', WORKER_HEARTBEAT_TTL_S);
    } catch (err) {
      logger.warn('Failed to update heartbeat', {
        operation: 'heartbeat',
        workerId: WORKER_ID,
        error: (err as Error).message,
      });
    }
  };

  // Immediate first heartbeat
  updateHeartbeat();

  heartbeatTimer = setInterval(updateHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS);

  logger.info('Heartbeat started', {
    operation: 'startHeartbeat',
    workerId: WORKER_ID,
    intervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
    ttlS: WORKER_HEARTBEAT_TTL_S,
  });
}

/**
 * Stop the heartbeat timer and remove the key from Redis.
 */
async function stopHeartbeat(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  try {
    const redisClient = getRedisClient();
    const publisher = redisClient.getPublisherConnection();
    await publisher.del(workerHeartbeatKey(WORKER_ID));
  } catch {
    // Best-effort cleanup — key will expire via TTL anyway
  }

  logger.info('Heartbeat stopped', {
    operation: 'stopHeartbeat',
    workerId: WORKER_ID,
  });
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────

/**
 * Handle SIGTERM/SIGINT: stop accepting new jobs, wait for active jobs
 * to finish within the timeout, then shut down all connections and exit.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn('Shutdown already in progress, ignoring duplicate signal', {
      operation: 'shutdown',
      signal,
    });
    return;
  }

  shuttingDown = true;

  logger.info('Graceful shutdown initiated', {
    operation: 'shutdown',
    signal,
    workerId: WORKER_ID,
    activeJobs: activeJobCount,
  });

  try {
    // 1. Stop accepting new jobs from BullMQ
    await queueService.stopWorker(SCRAPE_QUEUE, config.worker.shutdownTimeoutMs);

    logger.info('BullMQ worker stopped', {
      operation: 'shutdown',
      activeJobs: activeJobCount,
    });

    // 1b. Mark any jobs still owned by this worker as failed in PostgreSQL.
    // These are jobs that didn't finish within the shutdown timeout.
    if (activeJobIds.size > 0) {
      const orphanedIds = Array.from(activeJobIds);
      logger.warn('Marking orphaned jobs as failed', {
        operation: 'shutdown',
        orphanedJobIds: orphanedIds,
      });
      for (const jobId of orphanedIds) {
        // Clear bandwidth context without persisting for cancelled/orphaned jobs
        try {
          const tracker = getBandwidthTracker();
          if (tracker) {
            tracker.clearJob(jobId);
          }
        } catch {
          // Best-effort cleanup
        }
        try {
          await failJob(jobId, `Worker ${WORKER_ID} shut down before job completed (signal: ${signal})`, 'other');
        } catch (updateErr) {
          logger.error('Failed to mark orphaned job as failed', {
            operation: 'shutdown',
            jobId,
            error: (updateErr as Error).message,
          });
        }
      }
      activeJobIds.clear();
    }

    // 2. Stop heartbeat
    await stopHeartbeat();

    // 3. Disconnect rate limiter (releases all Bottleneck instances)
    await getRateLimiter().disconnect();

    // 4. Shut down queue service (closes Redis connections for queue)
    await queueService.shutdown();

    // 5. Shut down Redis client manager
    const redisClient = getRedisClient();
    await redisClient.shutdown();

    // 6. Close PostgreSQL pool
    await db.close();

    logger.info('Graceful shutdown complete', {
      operation: 'shutdown',
      workerId: WORKER_ID,
    });
  } catch (err) {
    logger.error('Error during shutdown', {
      operation: 'shutdown',
      error: (err as Error).message,
    });
  } finally {
    process.exit(0);
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/** Workers with a live heartbeat, this one included; undefined if Redis can't be read. */
async function readLiveWorkerIds(): Promise<Set<string> | undefined> {
  try {
    const keys = await scanByPattern(getRedisClient().getPublisherConnection(), WORKER_HEARTBEAT_PATTERN);
    const live = new Set(keys.map(workerIdFromHeartbeatKey).filter(Boolean));
    live.add(WORKER_ID);
    return live;
  } catch (err) {
    logger.warn('Failed to fetch live worker heartbeats for stale cleanup', { operation: 'start', error: (err as Error).message });
    return undefined;
  }
}

export async function start(): Promise<void> {
  logger.info('Worker starting', { operation: 'start', workerId: WORKER_ID, concurrency: config.worker.concurrency });

  // 1. Initialize PostgreSQL connection pool
  db = await DatabaseService.getInstance();
  await db.initializeSchema();
  useProviderStore(db);

  // 2b. Initialize bandwidth tracker (singleton)
  const bandwidthStore = new JobBandwidthStore(db);
  const bandwidthTracker = new BandwidthTracker(bandwidthStore);
  setBandwidthTracker(bandwidthTracker);

  queueService = new QueueService();

  // 3. Fail jobs a crash left behind — only those provably orphaned: running
  // rows whose worker has no heartbeat, queued rows BullMQ no longer holds.
  // If either input can't be read, that half is skipped (see cleanupStale).
  const liveWorkerIds = await readLiveWorkerIds();
  const pendingJobIds = await queueService.pendingScrapeJobIds().catch((err: unknown) => {
    logger.warn('Failed to read pending BullMQ jobs for stale cleanup', { operation: 'start', error: (err as Error).message });
    return undefined;
  });
  const staleCount = await failStaleJobs(liveWorkerIds, pendingJobIds);
  if (staleCount > 0) {
    logger.info('Cleaned up stale jobs', { operation: 'start', staleJobsRecovered: staleCount });
  }

  // 3a. Release BullMQ jobs stuck "active" under a dead worker's lock
  // (e.g. force-killed during PM2 reload).
  if (liveWorkerIds) {
    const staleBullMQCount = await queueService.cleanupStaleBullMQJobs(liveWorkerIds, await getJobStore());
    if (staleBullMQCount > 0) {
      logger.info('Cleaned up stale BullMQ jobs', { operation: 'start', staleBullMQJobsCleaned: staleBullMQCount });
    }
  }

  // 3b. Clean up old checkpoint files (older than 7 days)
  try {
    const deletedCheckpoints = await cleanupOldCheckpoints(CHECKPOINT_MAX_AGE_DAYS);
    if (deletedCheckpoints > 0) {
      logger.info('Cleaned up old checkpoint files', {
        operation: 'start',
        deletedCheckpoints,
        maxAgeDays: CHECKPOINT_MAX_AGE_DAYS,
      });
    }
  } catch (err) {
    logger.warn('Failed to clean up old checkpoints', {
      operation: 'start',
      error: (err as Error).message,
    });
  }

  // 5. Start BullMQ consumers — main scrape queue + excel-jobs queue + persist-jobs queue
  queueService.startWorker(SCRAPE_QUEUE, config.worker.concurrency, handleJob);
  queueService.startWorker(EXCEL_QUEUE, config.worker.excelConcurrency, handleExcelJob);
  queueService.startWorker(PERSIST_QUEUE, config.worker.persistConcurrency, handlePersistJob);
  queueService.startWorker(WEBHOOK_QUEUE, config.jobs.webhookConcurrency, handleWebhookJob);

  // 6. Start heartbeat
  startHeartbeat();

  // 7. Register shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Worker ready', {
    operation: 'start',
    workerId: WORKER_ID,
    concurrency: config.worker.concurrency,
    excelConcurrency: config.worker.excelConcurrency,
    persistConcurrency: config.worker.persistConcurrency,
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

// Only auto-start when worker.ts is the direct entry point (not imported by index.ts)
// index.ts validates before delegating here in PROCESS_ROLE=worker mode.
if (require.main === module) {
  validateConfigOrExit('worker');
  start().catch((err) => {
    logger.error('Worker failed to start', {
      operation: 'start',
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}
