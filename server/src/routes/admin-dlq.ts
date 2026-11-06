/**
 * Dead Letter Queue (DLQ) Routes — admin UI for inspecting, retrying,
 * and discarding permanently failed scrape jobs.
 *
 * All routes require authentication + admin role (applied by parent router).
 *
 *   GET    /api/admin/dlq              — list failed jobs (paginated)
 *   POST   /api/admin/dlq/:jobId/retry — retry a single failed job
 *   DELETE /api/admin/dlq/:jobId       — discard a single failed job
 *   POST   /api/admin/dlq/retry-all    — retry all failed jobs
 *   POST   /api/admin/dlq/discard-all  — discard all failed jobs
 */

import { Router } from 'express';
import { getQueueService } from '../services/queue-service';
import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

/**
 * GET /api/admin/dlq
 * List failed jobs with pagination.
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.page_size || '20'), 10) || 20));
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  const qs = getQueueService();
  const result = await qs.getFailedJobs(start, end);

  res.json({
    success: true,
    jobs: result.jobs,
    total: result.total,
    page,
    page_size: pageSize,
  });
}));

/**
 * POST /api/admin/dlq/retry-all
 * Retry all failed jobs. Returns count of retried/failed.
 */
router.post('/retry-all', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const qs = getQueueService();
  const { jobs } = await qs.getFailedJobs(0, 999);

  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await qs.retryFailedJob(job.id);
      retried++;
    } catch {
      failed++;
    }
  }

  const db = await DatabaseService.getInstance();
  const audit = new AuditService(db);
  await audit.log({
    userId: req.user!.id,
    action: 'retry_all_failed_jobs',
    resourceType: 'job',
    details: JSON.stringify({ retried, failed }),
    ipAddress: req.ip ?? undefined,
    userAgent: req.get('user-agent'),
  });

  res.json({ success: true, retried, failed });
}));

/**
 * POST /api/admin/dlq/discard-all
 * Discard all failed jobs. Returns count of discarded/failed.
 */
router.post('/discard-all', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const qs = getQueueService();
  const { jobs } = await qs.getFailedJobs(0, 999);

  let discarded = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await qs.removeFailedJob(job.id);
      discarded++;
    } catch {
      failed++;
    }
  }

  const db = await DatabaseService.getInstance();
  const audit = new AuditService(db);
  await audit.log({
    userId: req.user!.id,
    action: 'discard_all_failed_jobs',
    resourceType: 'job',
    details: JSON.stringify({ discarded, failed }),
    ipAddress: req.ip ?? undefined,
    userAgent: req.get('user-agent'),
  });

  res.json({ success: true, discarded, failed });
}));

/**
 * POST /api/admin/dlq/:jobId/retry
 * Retry a single failed job.
 */
router.post('/:jobId/retry', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = String(req.params.jobId);
  const qs = getQueueService();
  try {
    await qs.retryFailedJob(jobId);
  } catch (err) {
    // A "not found" failure is a client-visible 404 with its exact message;
    // anything else propagates to the central handler as a generic 500.
    if ((err as Error).message.includes('not found')) {
      res.status(404).json(errorResponse((err as Error).message, 'not_found'));
      return;
    }
    throw err;
  }

  const db = await DatabaseService.getInstance();
  const audit = new AuditService(db);
  await audit.log({
    userId: req.user!.id,
    action: 'retry_failed_job',
    resourceType: 'job',
    resourceId: jobId,
    ipAddress: req.ip ?? undefined,
    userAgent: req.get('user-agent'),
  });

  res.json({ success: true, message: `Job "${jobId}" retried` });
}));

/**
 * DELETE /api/admin/dlq/:jobId
 * Discard a single failed job.
 */
router.delete('/:jobId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = String(req.params.jobId);
  const qs = getQueueService();
  try {
    await qs.removeFailedJob(jobId);
  } catch (err) {
    // "not found" → client-visible 404 with exact message; else → generic 500.
    if ((err as Error).message.includes('not found')) {
      res.status(404).json(errorResponse((err as Error).message, 'not_found'));
      return;
    }
    throw err;
  }

  const db = await DatabaseService.getInstance();
  const audit = new AuditService(db);
  await audit.log({
    userId: req.user!.id,
    action: 'discard_failed_job',
    resourceType: 'job',
    resourceId: jobId,
    ipAddress: req.ip ?? undefined,
    userAgent: req.get('user-agent'),
  });

  res.json({ success: true, message: `Job "${jobId}" discarded` });
}));

export default router;
