/**
 * Job lifecycle — the only code that changes `jobs.status`.
 *
 *   queued ──▶ running ──▶ completed
 *     │           │──────▶ failed
 *     └───────────┴──────▶ cancelled / failed
 *   failed | cancelled ──(continue)──▶ queued
 *
 * Every change is a guarded UPDATE (`WHERE status IN (...)`), so a terminal
 * state can't be overwritten: a worker finishing after a cancel finds the row
 * no longer `running` and leaves it cancelled. Every BullMQ enqueue is one
 * attempt with its own BullMQ id (scrapeAttemptId), because BullMQ silently
 * drops an add whose id it still retains.
 */
import { getJobStore, type JobStore, type JobRecord, type JobState, type JobFieldUpdate } from './job-store';
import { getQueueService } from './queue-service';
import { getProgressBus } from './progress-bus';
import { getSites, getBrands } from './config-manager';
import { invalidateJobStatsCache } from './redis-cache';
import { scrapeAttemptId } from './queues';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import type { FailureCategory } from './failure-classifier';

const logger = createLogger('job-lifecycle');

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled'];
const ACTIVE_STATES: readonly JobState[] = ['queued', 'running'];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

/** A rule a caller broke (bad site/brand, wrong state). Routes answer with `statusCode`. */
export class JobLifecycleError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function changed(job: JobRecord | undefined): JobRecord | undefined {
  if (job) {
    void invalidateJobStatsCache(job.user_id).catch(() => {});
  }
  return job;
}

/** Resolve site and brand to their configured names, or throw why the pair can't run. */
async function resolveTarget(site: string, brand: string): Promise<{ site: string; brand: string }> {
  const siteConfig = (await getSites()).find((s) => s.name.toLowerCase() === site.toLowerCase() && s.enabled);
  if (!siteConfig) {
    throw new JobLifecycleError(`Site "${site}" is not configured or is disabled`);
  }
  const brandConfig = (await getBrands()).find((b) => b.name.toLowerCase() === brand.toLowerCase() && b.enabled);
  if (!brandConfig) {
    throw new JobLifecycleError(`Brand "${brand}" is not configured or is disabled`);
  }
  // Retailer-scoped brands only run where they have a discovery URL;
  // elsewhere discovery hits the junk fallback.
  if (brandConfig.allowed_retailers?.length && !brandConfig.allowed_retailers.includes(siteConfig.name.toLowerCase())) {
    throw new JobLifecycleError(`Brand "${brandConfig.name}" is not available for retailer "${siteConfig.name}"`);
  }
  return { site: siteConfig.name, brand: brandConfig.name };
}

/**
 * Run `write` (which makes one more of the user's jobs active) only while the
 * user is under config.jobs.maxActivePerUser, counting and writing under a
 * per-user lock so concurrent requests can't overshoot.
 */
async function underActiveLimit<T>(userId: string, write: (store: JobStore) => Promise<T>): Promise<T> {
  const limit = config.jobs.maxActivePerUser;
  return (await getJobStore()).withUserLock(userId, async (store) => {
    if (await store.countForUser(userId, ACTIVE_STATES) >= limit) {
      throw new JobLifecycleError(
        `You already have ${limit} queued or running jobs. Wait for one to finish or cancel one, then try again.`,
        429,
      );
    }
    return write(store);
  });
}

/** Check a site/brand pair without creating anything (schedule creation uses this). */
export async function validateJobTarget(site: string, brand: string): Promise<void> {
  await resolveTarget(site, brand);
}

async function enqueueAttempt(job: JobRecord, extra: { scheduleId?: number; resume?: boolean } = {}): Promise<void> {
  await getQueueService().enqueueScrapeJob(scrapeAttemptId(job.job_id, job.restart_count), {
    jobId: job.job_id,
    site: job.site,
    brand: job.brand,
    userId: job.user_id,
    ...extra,
  });
}

/**
 * Create a job and enqueue its first attempt. The one way a job comes into
 * being: POST /jobs, restart, the scheduler and admin backfill all call it, so
 * they all apply the same site/brand rules.
 */
export async function createJob(input: {
  site: string;
  brand: string;
  userId: string;
  scheduleId?: number;
  /** The failed/cancelled job this one restarts from scratch. */
  restartOf?: JobRecord;
  /** Skip the per-user active-job limit (scheduler and admin backfill only). */
  bypassActiveLimit?: boolean;
}): Promise<JobRecord> {
  const target = await resolveTarget(input.site, input.brand);
  const insert = (store: JobStore) => store.create({
    user_id: input.userId,
    site: target.site,
    brand: target.brand,
    schedule_id: input.scheduleId,
    restart_count: input.restartOf ? input.restartOf.restart_count + 1 : 0,
    restart_parent_id: input.restartOf?.job_id ?? null,
  });
  const job = input.bypassActiveLimit
    ? await insert(await getJobStore())
    : await underActiveLimit(input.userId, insert);
  try {
    await enqueueAttempt(job, { scheduleId: input.scheduleId });
  } catch (err) {
    // Without a BullMQ job nothing will ever run this row.
    await failJob(job.job_id, `Could not enqueue job: ${(err as Error).message}`, 'other').catch(() => {});
    throw err;
  }
  changed(job);
  return job;
}

/**
 * Re-queue a failed or cancelled job to resume from its checkpoint, as a new
 * attempt. The worker reads the checkpoint itself (it shares the data dir).
 */
export async function continueJob(job: JobRecord): Promise<JobRecord> {
  const queued = changed(await underActiveLimit(job.user_id, (store) => store.transition(job.job_id, ['failed', 'cancelled'], 'queued', {
    error_message: null,
    failure_category: null,
    completed_at: null,
    restart_count: job.restart_count + 1,
  })));
  if (!queued) {
    throw new JobLifecycleError(`Job ${job.job_id} changed state; reload and try again`, 409);
  }
  await enqueueAttempt(queued, { resume: true });
  return queued;
}

/**
 * Cancel a queued or running job: record it, drop the waiting BullMQ job, and
 * tell the worker running it (if any) to stop.
 */
export async function cancelJob(job: JobRecord): Promise<JobRecord> {
  const jobStore = await getJobStore();
  const cancelled = changed(await jobStore.transition(job.job_id, ACTIVE_STATES, 'cancelled', {
    completed_at: new Date().toISOString(),
  }));
  if (!cancelled) {
    const current = (await jobStore.getById(job.job_id))?.status ?? job.status;
    throw new JobLifecycleError(`Cannot cancel job in "${current}" state`);
  }
  const queueService = getQueueService();
  const bus = getProgressBus();
  const steps = await Promise.allSettled([
    queueService.removeScrapeJob(scrapeAttemptId(job.job_id, job.restart_count)),
    bus.publishCancel(job.job_id),
    bus.publishProgress(job.job_id, { jobId: job.job_id, status: 'cancelled' }),
  ]);
  for (const step of steps) {
    if (step.status === 'rejected') {
      logger.warn('Cancel side effect failed', { operation: 'cancelJob', jobId: job.job_id, error: String(step.reason) });
    }
  }
  return cancelled;
}

// ── Worker side ───────────────────────────────────────────────────────────

/** Claim a queued job for this worker. Undefined: the job isn't queued (cancelled, or already taken). */
export async function startAttempt(jobId: string, workerId: string): Promise<JobRecord | undefined> {
  return changed(await (await getJobStore()).transition(jobId, ['queued'], 'running', {
    worker_id: workerId,
    started_at: new Date().toISOString(),
  }));
}

/** Record a successful run. Undefined: the job stopped being `running` (cancelled meanwhile). */
export async function completeJob(jobId: string, results: JobFieldUpdate): Promise<JobRecord | undefined> {
  return changed(await (await getJobStore()).transition(jobId, ['running'], 'completed', {
    ...results,
    error_message: '',
    completed_at: new Date().toISOString(),
  }));
}

/** Record a failure. Undefined: the job was already terminal (e.g. cancelled), which stands. */
export async function failJob(jobId: string, message: string, category: FailureCategory): Promise<JobRecord | undefined> {
  return changed(await (await getJobStore()).transition(jobId, ACTIVE_STATES, 'failed', {
    error_message: message,
    failure_category: category,
    completed_at: new Date().toISOString(),
  }));
}

/** Fail rows a crash left behind; see JobStore.cleanupStale for which. */
export async function failStaleJobs(liveWorkerIds: Set<string> | undefined, pendingJobIds: Set<string> | undefined): Promise<number> {
  return (await getJobStore()).cleanupStale(liveWorkerIds, pendingJobIds);
}
