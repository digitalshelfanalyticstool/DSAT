/**
 * Job API Routes — REST endpoints for job creation, listing, status, streaming, and cancellation.
 *
 * All routes require authentication via Bearer token.
 * Regular users can only access their own jobs; admins can access all jobs.
 *
 * Uses JobStore (PostgreSQL) for persistence and QueueService (BullMQ/Redis)
 * for job queuing and SSE progress relay.
 */

import { Router } from 'express';
import { z } from 'zod';
import { JobStore, getJobStore, type JobRecord, type JobState } from '../services/job-store';
import { getProgressBus, type ProgressEvent } from '../services/progress-bus';
import { createJob, cancelJob, continueJob, isTerminal, validateJobTarget } from '../services/job-lifecycle';
import { DatabaseService } from '../services/database';
import { authMiddleware, sseAuthMiddleware } from '../middleware/auth';
import { isOwnerOrAdmin } from '../services/user-records';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { sseLimiter } from '../middleware/sse-limiter';
import { AuditService } from '../services/audit-service';
import {
  hasCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  CheckpointSchemaMismatchError,
} from '../services/checkpoint-manager';
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
} from '../services/scheduler';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler, httpError } from '../utils/async-handler';
import { getCachedOrFetch } from '../services/redis-cache';
import { initSSE, sendSSEEvent, startHeartbeat } from '../utils/sse';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('job-routes');
const router = Router();

// --- Error handling ---
//
// Handlers below `throw` and let `asyncHandler` forward to the app-wide
// `errorHandler` (utils/async-handler.ts), which logs the real error
// server-side and emits the canonical envelope: 4xx keep their message, 5xx
// respond `Internal server error` so internal strings can't leak.

// --- Validation Schemas ---

// `site`/`brand` are required-and-truthy in the handler and then `.toLowerCase()`'d
// (so must be strings); the configured/enabled checks stay in the handler. Body
// stays passthrough since the handler ignores any other keys.
const createJobSchema = z
  .object({ site: z.string().min(1), brand: z.string().min(1) })
  .passthrough();
const createJobSchemas = { body: createJobSchema };

// --- Helpers ---

/** Extract route param as string (Express types it as string | string[]) */
function paramId(req: AuthenticatedRequest): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Get a job by ID with ownership verification.
 * Throws 403 if a regular user tries to access another user's job.
 *
 * Both throws carry the status (and, for 403, the established `forbidden`
 * envelope tag rather than the status default `authorization_error`) so the
 * shared error middleware reproduces the previous responses byte-for-byte.
 */
async function getJobWithOwnership(
  jobStore: JobStore,
  jobId: string,
  userId: string,
  userRole: string,
): Promise<JobRecord> {
  const job = await jobStore.getById(jobId);
  if (!job) {
    throw httpError(new Error(`Job "${jobId}" not found`), 404);
  }
  if (!isOwnerOrAdmin(job.user_id, userId, userRole)) {
    throw httpError(new Error('Forbidden: you do not own this job'), 403, 'forbidden');
  }
  return job;
}

/**
 * Enriches a job with owner info from the users table.
 */
async function enrichJobWithOwner(job: JobRecord): Promise<JobRecord & { owner?: { id: number; username: string; email: string } }> {
  try {
    const db = await DatabaseService.getInstance();
    const user = await db.get<{ id: number; username: string; email: string }>(
      'SELECT id, username, email FROM users WHERE id = $1',
      Number.parseInt(job.user_id, 10),
    );
    return { ...job, owner: user ?? undefined };
  } catch {
    return job;
  }
}

// `JobStore.list()` joins `users` and returns the owner inline. The single-job
// helper `enrichJobWithOwner` above backs the `/:id` route, which uses
// `JobStore.getById()`.

// ─── SSE Stream (Redis Pub/Sub relay) ──────────────────────────────────────────
//
// Registered BEFORE `router.use(authMiddleware)` below and gated with
// sseAuthMiddleware instead: a single-use SSE ticket must authenticate
// exactly this route (and the other two stream routes), never the general
// API — authMiddleware now rejects sse_-prefixed tokens outright. Because
// this route is terminal (it always ends the response and never calls
// next()), a request that matches it never reaches the router-wide
// authMiddleware registered afterward, so every other route in this file is
// unaffected.

router.get(
  '/:id/stream',
  sseAuthMiddleware,
  sseLimiter({ maxConnectionsPerUser: 5 }),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const jobStore = await getJobStore();
    const job = await getJobWithOwnership(
      jobStore,
      paramId(req),
      String(req.user!.id),
      req.user!.role,
    );

    const jobId = job.job_id;

    // Set SSE headers
    initSSE(res);
    res.flushHeaders();

    // If job is already in a terminal state, send it immediately and close
    if (isTerminal(job.status)) {
      sendSSEEvent(res, 'connected', { job_id: jobId, message: 'Connected to job updates' });
      sendSSEEvent(res, 'progress', {
        job_id: jobId,
        status: job.status,
        phase: job.phase,
        products_discovered: job.products_discovered,
        products_processed: job.products_processed,
        variants_extracted: job.variants_extracted,
        file_path: job.file_path,
        error_message: job.error_message,
      });
      sendSSEEvent(res, job.status, {
        job_id: jobId,
        status: job.status,
        file_path: job.file_path,
        products_discovered: job.products_discovered,
        products_processed: job.products_processed,
        variants_extracted: job.variants_extracted,
        error_message: job.error_message,
      });
      res.end();
      return;
    }

    // Subscribe to Redis Pub/Sub FIRST, then re-fetch current state.
    // This eliminates the race where events published between the initial
    // fetch and subscribe are lost (e.g. a missed queued→running).
    let subscribed = true;

    const progressHandler = (progress: ProgressEvent): void => {
      try {
        sendSSEEvent(res, 'progress', progress);

        // Terminal events — close the stream
        if (isTerminal(progress.status)) {
          sendSSEEvent(res, progress.status, progress);
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
      }
    };

    const disposeProgress = await getProgressBus().subscribeProgress(jobId, progressHandler);

    // Re-fetch job state AFTER subscribing so we capture any transitions
    // that occurred between the ownership check above and the subscription.
    const freshJob = await jobStore.getById(jobId);
    const currentJob = freshJob || job;

    // Declare cleanup and heartbeat with hoistable `let` so cleanup can be
    // called before the heartbeat timer is started (terminal-state early exit).
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const cleanup = (): void => {
      if (!subscribed) return;
      subscribed = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Dispose only THIS viewer's subscription — a co-viewer of the same job
      // keeps streaming, and the Redis channel stays open until the last leaves.
      disposeProgress().catch((err) => {
        logger.warn('Failed to unsubscribe from progress channel', {
          operation: 'stream',
          jobId,
          error: (err as Error).message,
        });
      });
    };

    sendSSEEvent(res, 'connected', { job_id: jobId, message: 'Connected to job updates' });
    sendSSEEvent(res, 'progress', {
      job_id: jobId,
      status: currentJob.status,
      phase: currentJob.phase,
      products_discovered: currentJob.products_discovered,
      products_processed: currentJob.products_processed,
      variants_extracted: currentJob.variants_extracted,
      file_path: currentJob.file_path,
      error_message: currentJob.error_message,
    });

    // If the job reached a terminal state between the first check and now,
    // send the terminal event and close.
    if (isTerminal(currentJob.status)) {
      sendSSEEvent(res, currentJob.status, {
        job_id: jobId,
        status: currentJob.status,
        file_path: currentJob.file_path,
        products_discovered: currentJob.products_discovered,
        products_processed: currentJob.products_processed,
        variants_extracted: currentJob.variants_extracted,
        error_message: currentJob.error_message,
      });
      cleanup();
      res.end();
      return;
    }

    // Heartbeat to keep connection alive through proxies
    heartbeatTimer = startHeartbeat(res);

    // Clean up on client disconnect
    req.on('close', cleanup);
  }),
);

// All other job routes require the general API auth (real access tokens
// only — never an sse_ ticket, which authMiddleware now rejects).
router.use(authMiddleware);

// ─── Scheduled Jobs (must be before /:id routes) ───────────────────────────────

router.get('/schedules/list', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  const schedules = await listSchedules(db, req.user!.id, req.user!.role);
  res.json({ success: true, schedules });
}));

// `SchedulerError` already carries the status it maps to, so the three schedule
// mutation routes just let it propagate. Their previous hand-rolled catches
// tagged every non-400 as `server_error`, which mislabelled scheduler 403/404s;
// the shared handler now derives the canonical type from the status.
router.post('/schedules', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { site, brand, schedule_time, schedule_days, max_retries, retry_delay_minutes } = req.body;

  if (!site || !brand || !schedule_time || !schedule_days) {
    res.status(400).json(
      errorResponse('site, brand, schedule_time, and schedule_days are required', 'validation_error'),
    );
    return;
  }

  // The same rules a run is created under, so a schedule can't be saved for a
  // pair that would fail every time it fires.
  await validateJobTarget(String(site), String(brand));

  const db = await DatabaseService.getInstance();
  const schedule = await createSchedule(db, {
    userId: req.user!.id,
    site,
    brand,
    scheduleTime: schedule_time,
    scheduleDays: schedule_days,
    maxRetries: max_retries,
    retryDelayMinutes: retry_delay_minutes,
  });

  logger.info('Schedule created via API', {
    operation: 'createSchedule',
    scheduleId: schedule.id,
    userId: req.user!.id,
  });

  res.status(201).json({ success: true, schedule });
}));

const scheduleIdSchemas = { params: z.object({ scheduleId: z.coerce.number().int().positive() }) };

router.patch('/schedules/:scheduleId', validate(scheduleIdSchemas), asyncHandler(async (req: ValidatedRequest<typeof scheduleIdSchemas, AuthenticatedRequest>, res) => {
  const scheduleId = req.params.scheduleId;

  const { schedule_time, schedule_days, enabled, max_retries, retry_delay_minutes } = req.body;
  const db = await DatabaseService.getInstance();
  const schedule = await updateSchedule(db, scheduleId, req.user!.id, req.user!.role, {
    scheduleTime: schedule_time,
    scheduleDays: schedule_days,
    enabled,
    maxRetries: max_retries,
    retryDelayMinutes: retry_delay_minutes,
  });

  res.json({ success: true, schedule });
}));

router.delete('/schedules/:scheduleId', validate(scheduleIdSchemas), asyncHandler(async (req: ValidatedRequest<typeof scheduleIdSchemas, AuthenticatedRequest>, res) => {
  const scheduleId = req.params.scheduleId;

  const db = await DatabaseService.getInstance();
  await deleteSchedule(db, scheduleId, req.user!.id, req.user!.role);

  res.json({ success: true, message: 'Schedule deleted' });
}));

// ─── Dashboard Stats ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /jobs/stats:
 *   get:
 *     summary: Get job statistics for the dashboard
 *     tags: [Jobs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job statistics
 */
router.get('/stats', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const userId = String(req.user!.id);
  const userRole = req.user!.role;
  const cacheKey = `cache:job-stats:${userRole}:${userId}`;

  const result = await getCachedOrFetch(cacheKey, 30, async () => {
    const jobStore = await getJobStore();
    const [stats, recentResult] = await Promise.all([
      jobStore.getStats(),
      jobStore.list({
        page: 1,
        page_size: 10,
        ...(userRole === 'admin' ? {} : { user_id: userId }),
      }),
    ]);
    // jobStore.list() already returns jobs with owner info inline.
    return { stats, recentJobs: recentResult.jobs };
  });

  res.json({ success: true, ...result });
}));

// ─── Create Job ────────────────────────────────────────────────────────────────

router.post(
  '/',
  validate(createJobSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof createJobSchemas, AuthenticatedRequest>, res) => {
    const { site, brand } = req.body;

    // A rule violation (unconfigured site, brand not enabled for the
    // retailer) is a JobLifecycleError carrying its 400, or 429 at the
    // per-user active-job limit; anything else is a 500.
    const job = await createJob({ site, brand, userId: String(req.user!.id) });

    logger.info('Job created via API', {
      operation: 'createJob',
      jobId: job.job_id,
      userId: req.user!.id,
    });

    res.status(201).json({ success: true, job });
  }),
);

// ─── List Jobs ─────────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { site, brand, status, date_from, date_to, page, page_size, cursor } = req.query;

  const pageNum = page ? Number.parseInt(page as string, 10) : undefined;
  const pageSizeNum = page_size
    ? Math.min(Number.parseInt(page_size as string, 10), 100)
    : undefined;

  const jobStore = await getJobStore();
  const result = await jobStore.list({
    site: site as string | undefined,
    brand: brand as string | undefined,
    status: status as JobState | undefined,
    date_from: date_from as string | undefined,
    date_to: date_to as string | undefined,
    page: pageNum,
    page_size: pageSizeNum,
    cursor: cursor as string | undefined,
    // Ownership filtering: regular users see only their own jobs
    ...(req.user!.role === 'admin' ? {} : { user_id: String(req.user!.id) }),
  });

  res.json({
    success: true,
    ...result,
  });
}));

// ─── Get Job Details ───────────────────────────────────────────────────────────

router.get('/:id', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const jobId = paramId(req);
  const job = await jobStore.getById(jobId);

  if (!job) {
    logger.warn('Job not found in PostgreSQL', {
      operation: 'getJob',
      jobId,
      userId: req.user!.id,
      userRole: req.user!.role,
    });
    res.status(404).json(errorResponse(`Job "${jobId}" not found`, 'not_found'));
    return;
  }

  if (!isOwnerOrAdmin(job.user_id, req.user!.id, req.user!.role)) {
    res.status(403).json(errorResponse('Forbidden: you do not own this job', 'forbidden'));
    return;
  }

  const responseJob = await enrichJobWithOwner(job);
  res.json({ success: true, job: responseJob });
}));

// ─── Get Job Status ────────────────────────────────────────────────────────────

router.get('/:id/status', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const job = await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  res.json({
    success: true,
    status: {
      job_id: job.job_id,
      status: job.status,
      phase: job.phase,
      products_discovered: job.products_discovered,
      products_processed: job.products_processed,
      variants_extracted: job.variants_extracted,
      error_message: job.error_message || undefined,
    },
  });
}));

// ─── Cancel Job ────────────────────────────────────────────────────────────────

router.delete('/:id', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const job = await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  // Guarded: a job that finished meanwhile is a 400, not overwritten.
  const updated = await cancelJob(job);

  logger.info('Job cancelled via API', {
    operation: 'cancelJob',
    jobId: paramId(req),
    userId: req.user!.id,
  });

  res.json({ success: true, job: updated });
}));

// ─── Delete Job (permanent) ────────────────────────────────────────────────────

router.delete('/:id/purge', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const job = await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  if (job.status === 'running') {
    res.status(400).json(errorResponse('Cannot delete a running job', 'validation_error'));
    return;
  }

  const deleted = await jobStore.delete(job.job_id);
  if (!deleted) {
    res.status(404).json(errorResponse(`Job "${paramId(req)}" not found`, 'not_found'));
    return;
  }

  // Clean up checkpoint file
  await deleteCheckpoint(job.job_id);

  // Audit log when admin deletes a job
  if (req.user!.role === 'admin') {
    try {
      const db = await DatabaseService.getInstance();
      const audit = new AuditService(db);
      await audit.logJobDeletion(
        req.user!.id,
        paramId(req),
        req.ip ?? undefined,
        req.get('user-agent'),
      );
    } catch (auditErr) {
      logger.warn('Failed to write audit log for job deletion', {
        operation: 'deleteJob',
        jobId: paramId(req),
        error: (auditErr as Error).message,
      });
    }
  }

  logger.info('Job deleted via API', {
    operation: 'deleteJob',
    jobId: paramId(req),
    userId: req.user!.id,
  });

  res.json({ success: true, message: 'Job deleted' });
}));

// ─── Restart Job ───────────────────────────────────────────────────────────────

router.post('/:id/restart', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const original = await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  if (original.status !== 'failed' && original.status !== 'cancelled') {
    res.status(400).json(errorResponse(`Cannot restart job with status "${original.status}"`, 'validation_error'));
    return;
  }

  const newJob = await createJob({
    site: original.site,
    brand: original.brand,
    userId: original.user_id,
    restartOf: original,
  });

  // Delete the original job's checkpoint — fresh start
  await deleteCheckpoint(original.job_id);

  logger.info('Job restarted via API', {
    operation: 'restartJob',
    originalJobId: paramId(req),
    newJobId: newJob.job_id,
    userId: req.user!.id,
  });

  res.status(201).json({
    success: true,
    job_id: newJob.job_id,
    original_job_id: paramId(req),
    status: newJob.status,
    restart_count: newJob.restart_count,
  });
}));

// ─── Continue Job ──────────────────────────────────────────────────────────────

router.post('/:id/continue', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  const job = await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  if (job.status !== 'failed' && job.status !== 'cancelled') {
    res.status(400).json(errorResponse(`Cannot continue job with status "${job.status}"`, 'validation_error'));
    return;
  }

  const checkpointExists = await hasCheckpoint(job.job_id);
  if (!checkpointExists) {
    res.status(400).json(errorResponse(`No checkpoint found for job ${job.job_id} — use restart instead`, 'validation_error'));
    return;
  }

  // `loadCheckpoint` is the only call here with non-500 failure modes, so the
  // status mapping is attached to it rather than to a catch around the whole
  // handler, rather than sniffing every error's message for "not found", which
  // would mislabel an unrelated failure that happened to say so.
  const checkpoint = await loadCheckpoint(job.job_id).catch((err: unknown) => {
    if (err instanceof CheckpointSchemaMismatchError) {
      logger.warn('Refusing to continue job from stale-schema checkpoint', {
        operation: 'continueJob', jobId: paramId(req), error: err.message,
      });
      throw httpError(err, 409, 'validation_error');
    }
    throw (err as Error).message.includes('not found') ? httpError(err, 404) : err;
  });

  // Same job row, new attempt (and new BullMQ id) resuming from the checkpoint.
  const updated = await continueJob(job);

  logger.info('Job continued via API', {
    operation: 'continueJob',
    jobId: paramId(req),
    userId: req.user!.id,
  });

  res.status(200).json({
    success: true,
    job_id: updated.job_id,
    status: updated.status,
    restart_count: updated.restart_count,
    checkpoint_phase: checkpoint.phase ?? null,
  });
}));

// ─── Check Checkpoint Availability ─────────────────────────────────────────────

router.get('/:id/checkpoint', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobStore = await getJobStore();
  await getJobWithOwnership(
    jobStore,
    paramId(req),
    String(req.user!.id),
    req.user!.role,
  );

  const exists = await hasCheckpoint(paramId(req));
  res.json({ success: true, has_checkpoint: exists });
}));

export default router;
