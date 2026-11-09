/**
 * Job Scheduler Service — manages recurring scheduled scraping jobs.
 *
 * Stores schedules in the scheduled_jobs table. A background check loop
 * runs every 60 seconds, comparing the current day/time against each enabled
 * schedule and firing jobs that are due (haven't run today at the scheduled time).
 *
 * Schedule format:
 *   - schedule_time: "HH:MM" in 24-hour format, in config.scheduling.timezone (default America/New_York)
 *   - schedule_days: JSON array of day numbers (0=Sunday … 6=Saturday)
 */

import { DatabaseService } from './database';
import { createJob } from './job-lifecycle';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { isOwnerOrAdmin } from './user-records';

const logger = createLogger('scheduler');

/** How often to check for due schedules (ms). */
export const SCHEDULE_CHECK_INTERVAL_MS = 60_000;

/** Business timezone — all schedule_time values are in Eastern Time. */
const BUSINESS_TZ = config.scheduling.timezone;

/** Get current day-of-week, hours, and minutes in Eastern Time. */
function getEasternNow(): { day: number; hh: string; mm: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const hh = parts.find(p => p.type === 'hour')!.value;
  const mm = parts.find(p => p.type === 'minute')!.value;
  // Get the actual day number in Eastern TZ
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: BUSINESS_TZ }));
  const day = eastern.getDay();
  return { day, hh, mm };
}

export interface ScheduledJob {
  id: number;
  user_id: number;
  site: string;
  brand: string;
  schedule_time: string;
  schedule_days: string;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  max_retries: number;
  retry_delay_minutes: number;
  current_retry_count: number;
  next_retry_at: number | null;
  last_failure_reason: string | null;
}

export interface CreateScheduleInput {
  userId: number;
  site: string;
  brand: string;
  scheduleTime: string;
  scheduleDays: number[];
  maxRetries?: number;
  retryDelayMinutes?: number;
}

export interface UpdateScheduleInput {
  scheduleTime?: string;
  scheduleDays?: number[];
  enabled?: boolean;
  maxRetries?: number;
  retryDelayMinutes?: number;
}

// ─── Validation ────────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VALID_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

function validateTime(time: string): void {
  if (!TIME_RE.test(time)) {
    throw new SchedulerError('schedule_time must be HH:MM (24-hour)', 400);
  }
}

function validateDays(days: number[]): void {
  if (!Array.isArray(days) || days.length === 0) {
    throw new SchedulerError('schedule_days must be a non-empty array of day numbers (0-6)', 400);
  }
  for (const d of days) {
    if (!VALID_DAYS.has(d)) {
      throw new SchedulerError(`Invalid day number: ${d}. Use 0 (Sun) through 6 (Sat)`, 400);
    }
  }
}

// ─── Error class ───────────────────────────────────────────────────────────────

export class SchedulerError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'SchedulerError';
  }
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export async function createSchedule(db: DatabaseService, input: CreateScheduleInput): Promise<ScheduledJob> {
  validateTime(input.scheduleTime);
  validateDays(input.scheduleDays);

  const maxRetries = input.maxRetries ?? 0;
  const retryDelay = input.retryDelayMinutes ?? 15;
  if (maxRetries < 0 || maxRetries > 5) {
    throw new SchedulerError('max_retries must be between 0 and 5', 400);
  }
  if (retryDelay < 5 || retryDelay > 60) {
    throw new SchedulerError('retry_delay_minutes must be between 5 and 60', 400);
  }

  const now = Date.now();
  const result = await db.run(
    `INSERT INTO scheduled_jobs (user_id, site, brand, schedule_time, schedule_days, enabled, max_retries, retry_delay_minutes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)`,
    input.userId,
    input.site,
    input.brand,
    input.scheduleTime,
    JSON.stringify(input.scheduleDays),
    maxRetries,
    retryDelay,
    now,
    now,
  );

  logger.info('Schedule created', {
    operation: 'createSchedule',
    scheduleId: result.lastInsertRowid,
    userId: input.userId,
    site: input.site,
    brand: input.brand,
  });

  return (await db.get<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE id = $1', result.lastInsertRowid))!;
}

export async function updateSchedule(
  db: DatabaseService,
  scheduleId: number,
  userId: number,
  userRole: string,
  updates: UpdateScheduleInput,
): Promise<ScheduledJob> {
  const existing = await db.get<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE id = $1', scheduleId);
  if (!existing) {
    throw new SchedulerError('Schedule not found', 404);
  }
  if (!isOwnerOrAdmin(existing.user_id, userId, userRole)) {
    throw new SchedulerError('Forbidden', 403);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (updates.scheduleTime !== undefined) {
    validateTime(updates.scheduleTime);
    sets.push(`schedule_time = $${paramIndex++}`);
    params.push(updates.scheduleTime);
  }
  if (updates.scheduleDays !== undefined) {
    validateDays(updates.scheduleDays);
    sets.push(`schedule_days = $${paramIndex++}`);
    params.push(JSON.stringify(updates.scheduleDays));
  }
  if (updates.enabled !== undefined) {
    sets.push(`enabled = $${paramIndex++}`);
    params.push(updates.enabled ? 1 : 0);
  }
  if (updates.maxRetries !== undefined) {
    if (updates.maxRetries < 0 || updates.maxRetries > 5) {
      throw new SchedulerError('max_retries must be between 0 and 5', 400);
    }
    sets.push(`max_retries = $${paramIndex++}`);
    params.push(updates.maxRetries);
  }
  if (updates.retryDelayMinutes !== undefined) {
    if (updates.retryDelayMinutes < 5 || updates.retryDelayMinutes > 60) {
      throw new SchedulerError('retry_delay_minutes must be between 5 and 60', 400);
    }
    sets.push(`retry_delay_minutes = $${paramIndex++}`);
    params.push(updates.retryDelayMinutes);
  }

  if (sets.length === 0) {
    throw new SchedulerError('No fields to update', 400);
  }

  // One params.push() per placeholder so $N ↔ params[N-1] stays mechanically
  // auditable (a two-value push with a single index bump is a known footgun).
  sets.push(`updated_at = $${paramIndex++}`);
  params.push(Date.now());
  const idParamIndex = paramIndex++;
  params.push(scheduleId);

  await db.run(`UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = $${idParamIndex}`, ...params);

  return (await db.get<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE id = $1', scheduleId))!;
}

export async function deleteSchedule(
  db: DatabaseService,
  scheduleId: number,
  userId: number,
  userRole: string,
): Promise<void> {
  const existing = await db.get<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE id = $1', scheduleId);
  if (!existing) {
    throw new SchedulerError('Schedule not found', 404);
  }
  if (!isOwnerOrAdmin(existing.user_id, userId, userRole)) {
    throw new SchedulerError('Forbidden', 403);
  }

  await db.run('DELETE FROM scheduled_jobs WHERE id = $1', scheduleId);

  logger.info('Schedule deleted', { operation: 'deleteSchedule', scheduleId, userId });
}

export async function listSchedules(
  db: DatabaseService,
  userId: number,
  userRole: string,
): Promise<ScheduledJob[]> {
  if (userRole === 'admin') {
    return await db.all<ScheduledJob>('SELECT * FROM scheduled_jobs ORDER BY created_at DESC');
  }
  return await db.all<ScheduledJob>(
    'SELECT * FROM scheduled_jobs WHERE user_id = $1 ORDER BY created_at DESC',
    userId,
  );
}

// ─── Due-schedule check (run every SCHEDULE_CHECK_INTERVAL_MS by background-tasks.ts) ───

/**
 * Returns true when a regular (non-retry) firing should be skipped for this
 * tick — schedule day not matched, already ran in this minute window, or a
 * retry is already pending.
 */
function shouldSkipRegularFire(schedule: ScheduledJob, now: Date, currentDay: number): boolean {
  const days: number[] = JSON.parse(schedule.schedule_days);
  if (!days.includes(currentDay)) return true;

  if (schedule.last_run_at) {
    const lastRun = new Date(schedule.last_run_at);
    const diffMs = now.getTime() - lastRun.getTime();
    if (diffMs < SCHEDULE_CHECK_INTERVAL_MS) return true;
  }

  // Skip regular firing if a retry is pending
  if (schedule.next_retry_at && schedule.current_retry_count > 0) return true;

  return false;
}

/**
 * Create a job from a schedule, enqueue it into BullMQ, run the post-fire DB
 * update, and log success — wrapped in a single try/catch that logs failure
 * using the caller's operation tag. Preserves the per-variant log string and
 * payload exactly.
 */
async function fireScheduledJobOnce(
  schedule: ScheduledJob,
  variant: {
    operation: 'fireScheduledJob' | 'fireScheduledRetry';
    successMessage: string;
    failureMessage: string;
    runPostFireUpdate: (db: DatabaseService) => Promise<void>;
    buildSuccessMeta: (jobId: string) => Record<string, unknown>;
  },
): Promise<void> {
  try {
    const db = await DatabaseService.getInstance();
    const job = await createJob({
      site: schedule.site,
      brand: schedule.brand,
      userId: String(schedule.user_id),
      scheduleId: schedule.id,
    });

    await variant.runPostFireUpdate(db);

    logger.info(variant.successMessage, {
      operation: variant.operation,
      scheduleId: schedule.id,
      ...variant.buildSuccessMeta(job.job_id),
    });
  } catch (err) {
    logger.error(variant.failureMessage, {
      operation: variant.operation,
      scheduleId: schedule.id,
      error: (err as Error).message,
    });
  }
}

/**
 * Check all enabled schedules and fire any that are due right now.
 * A schedule is "due" if:
 *   1. Today's day-of-week is in schedule_days
 *   2. Current time matches schedule_time (same HH:MM)
 *   3. It hasn't already run in this minute window
 */
export async function checkAndFireDueSchedules(): Promise<void> {
  const db = await DatabaseService.getInstance();
  const now = new Date();
  const eastern = getEasternNow();
  const currentDay = eastern.day;
  const currentTime = `${eastern.hh}:${eastern.mm}`;

  const schedules = await db.all<ScheduledJob>(
    `SELECT s.* FROM scheduled_jobs s JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND s.schedule_time = $1`,
    currentTime,
  );

  for (const schedule of schedules) {
    if (shouldSkipRegularFire(schedule, now, currentDay)) continue;

    await fireScheduledJobOnce(schedule, {
      operation: 'fireScheduledJob',
      successMessage: 'Scheduled job fired',
      failureMessage: 'Failed to fire scheduled job',
      runPostFireUpdate: async (innerDb) => {
        await innerDb.run(
          'UPDATE scheduled_jobs SET last_run_at = $1, updated_at = $2 WHERE id = $3',
          now.getTime(),
          now.getTime(),
          schedule.id,
        );
      },
      buildSuccessMeta: (jobId) => ({
        jobId,
        site: schedule.site,
        brand: schedule.brand,
      }),
    });
  }

  // --- Retry check: fire pending retries for failed scheduled jobs ---
  const nowMs = now.getTime();
  const retrySchedules = await db.all<ScheduledJob>(
    `SELECT s.* FROM scheduled_jobs s JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.is_active = 1
       AND s.next_retry_at IS NOT NULL
       AND s.next_retry_at <= $1
       AND s.current_retry_count < s.max_retries`,
    nowMs,
  );

  for (const schedule of retrySchedules) {
    await fireScheduledJobOnce(schedule, {
      operation: 'fireScheduledRetry',
      successMessage: 'Scheduled job retry fired',
      failureMessage: 'Failed to fire scheduled retry',
      // Clear next_retry_at so we don't fire again until worker reports back
      runPostFireUpdate: async (innerDb) => {
        await innerDb.run(
          'UPDATE scheduled_jobs SET next_retry_at = NULL, updated_at = $1 WHERE id = $2',
          now.getTime(),
          schedule.id,
        );
      },
      buildSuccessMeta: (jobId) => ({
        jobId,
        retryCount: schedule.current_retry_count,
      }),
    });
  }
}

/**
 * Record how a scheduled run ended. Success clears the retry state; a failure
 * schedules the next retry after `retry_delay_minutes` until `max_retries`
 * attempts have failed, then stops and keeps the last failure reason.
 */
export async function recordScheduledRunResult(
  db: Pick<DatabaseService, 'get' | 'run'>,
  scheduleId: number,
  errorMessage: string | null,
): Promise<void> {
  const now = Date.now();
  if (errorMessage === null) {
    await db.run(
      'UPDATE scheduled_jobs SET current_retry_count = 0, next_retry_at = NULL, last_failure_reason = NULL, updated_at = $1 WHERE id = $2',
      now, scheduleId,
    );
    return;
  }

  const schedule = await db.get<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE id = $1', scheduleId);
  if (!schedule?.max_retries) return;

  const nextCount = schedule.current_retry_count + 1;
  const nextRetryAt = nextCount < schedule.max_retries ? now + schedule.retry_delay_minutes * 60_000 : null;
  await db.run(
    'UPDATE scheduled_jobs SET current_retry_count = $1, next_retry_at = $2, last_failure_reason = $3, updated_at = $4 WHERE id = $5',
    nextCount, nextRetryAt, errorMessage, now, scheduleId,
  );
  if (nextRetryAt === null) {
    logger.warn('Max retries reached for schedule', { operation: 'recordScheduledRunResult', scheduleId, maxRetries: schedule.max_retries });
  } else {
    logger.info('Scheduled retry queued', {
      operation: 'recordScheduledRunResult', scheduleId, retryCount: nextCount, nextRetryAt: new Date(nextRetryAt).toISOString(),
    });
  }
}

