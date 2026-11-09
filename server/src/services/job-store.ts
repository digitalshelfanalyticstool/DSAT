/**
 * JobStore — PostgreSQL-backed persistence layer for scraping job records.
 *
 * Replaces the file-based data/jobs.json storage with proper relational
 * storage that supports concurrent reads/writes from multiple worker processes.
 *
 * All queries use parameterized $1, $2 placeholders — no string interpolation.
 */

import { v4 as uuidv4 } from 'uuid';
import { DatabaseService, type TransactionClient } from './database';
import { createLogger } from '../utils/logger';
import { stripTotalCount } from './strip-total-count';

const logger = createLogger('job-store');

// --- ProgressUpdate type for type-safe partial progress updates ---

export interface ProgressUpdate {
  phase?: string;
  products_discovered?: number;
  products_processed?: number;
  variants_extracted?: number;
  phase_duration_ms?: number;
  phase_name?: string;
  phase_timings?: Record<string, number>;
}

// --- Data Types (backward-compatible with job-manager.ts Job interface) ---

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  job_id: string;
  user_id: string;
  site: string;
  brand: string;
  status: JobState;
  phase: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  products_discovered: number;
  products_processed: number;
  variants_extracted: number;
  failed_products: string[];
  file_path: string | null;
  error_message: string | null;
  failure_category: import('./failure-classifier').FailureCategory | null;
  restart_count: number;
  restart_parent_id: string | null;
  worker_id: string | null;
  phase_timings: Record<string, number> | null;
}

export type Job = JobRecord;

export interface JobFilters {
  site?: string;
  brand?: string;
  status?: JobState;
  user_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
  cursor?: string;
}

/**
 * Owner info joined onto a job record from the `users` table. Optional because
 * a job may reference a user that has been deleted (LEFT JOIN nulls).
 */
interface JobOwner {
  id: number;
  username: string;
  email: string;
}

/**
 * A JobRecord enriched with optional owner info from the users table.
 * Returned by `JobStore.list()` so callers don't need a second query.
 */
interface JobRecordWithOwner extends JobRecord {
  owner?: JobOwner;
}

export interface JobListResult {
  jobs: JobRecordWithOwner[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  next_cursor?: string;
}

export interface JobStats {
  jobsToday: number;
  activeJobs: number;
  recentCompletions: number;
}

// --- Row ↔ JobRecord mapping ---

interface JobRow {
  job_id: string;
  user_id: number;
  site: string;
  brand: string;
  status: string;
  phase: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  products_discovered: number;
  products_processed: number;
  variants_extracted: number;
  failed_products: string[] | string;
  file_path: string | null;
  error_message: string | null;
  failure_category: string | null;
  restart_count: number;
  restart_parent_id: string | null;
  worker_id: string | null;
  phase_timings: Record<string, number> | string | null;
}

/** Parse phase_timings from DB (may be JSON string, object, or null). */
function parsePhaseTimings(value: Record<string, number> | string | null): Record<string, number> | null {
  if (value == null) return null;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

/** Convert a nullable date field from a DB row to an ISO string or null. */
function toISOStringOrNull(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : null;
}

function rowToRecord(row: JobRow): JobRecord {
  return {
    job_id: row.job_id,
    user_id: String(row.user_id),
    site: row.site,
    brand: row.brand,
    status: row.status as JobState,
    phase: row.phase,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    started_at: toISOStringOrNull(row.started_at),
    completed_at: toISOStringOrNull(row.completed_at),
    products_discovered: row.products_discovered,
    products_processed: row.products_processed,
    variants_extracted: row.variants_extracted,
    failed_products: Array.isArray(row.failed_products) ? row.failed_products : JSON.parse(row.failed_products),
    file_path: row.file_path,
    error_message: row.error_message,
    failure_category: (row.failure_category as import('./failure-classifier').FailureCategory | null) ?? null,
    restart_count: row.restart_count,
    restart_parent_id: row.restart_parent_id,
    worker_id: row.worker_id,
    phase_timings: parsePhaseTimings(row.phase_timings),
  };
}

/** Serialize a field value for DB storage (handles user_id, JSON fields). */
function serializeFieldValue(key: string, value: unknown): unknown {
  if (key === 'user_id' && typeof value === 'string') {
    return Number.parseInt(value, 10);
  }
  if (key === 'failed_products' && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (key === 'phase_timings' && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

/** Fields a caller may write besides status. */
export type JobFieldUpdate = Partial<Omit<JobRecord, 'job_id' | 'created_at' | 'updated_at' | 'status'>>;

const UPDATABLE_COLUMNS = [
  'user_id', 'site', 'brand', 'status', 'phase', 'started_at', 'completed_at',
  'products_discovered', 'products_processed', 'variants_extracted', 'failed_products',
  'file_path', 'error_message', 'failure_category', 'restart_count', 'restart_parent_id',
  'worker_id', 'phase_timings',
] as const;

/** `UPDATE jobs SET … WHERE job_id = $n`, one value pushed per placeholder. */
function buildUpdate(updates: Record<string, unknown>, jobId: string): { sql: string; values: unknown[] } {
  const values: unknown[] = [new Date().toISOString()];
  const sets = ['updated_at = $1'];
  for (const column of UPDATABLE_COLUMNS) {
    if (!(column in updates)) continue;
    values.push(serializeFieldValue(column, updates[column]));
    sets.push(column + ' = $' + values.length);
  }
  values.push(jobId);
  return { sql: 'UPDATE jobs SET ' + sets.join(', ') + ' WHERE job_id = $' + values.length, values };
}

// --- JobStore class ---

/** Namespace for the two-key advisory lock taken per user in withUserLock. */
const USER_JOBS_LOCK_NS = 0x4a4f4253; // 'JOBS'

export class JobStore {
  private readonly db: DatabaseService | TransactionClient;

  constructor(db: DatabaseService | TransactionClient) {
    this.db = db;
  }

  /**
   * Run `fn` in a transaction holding a per-user advisory lock, with a store
   * bound to that transaction. Serializes a user's check-then-write sequences
   * (count active jobs, then insert) so a burst can't overshoot a limit.
   */
  async withUserLock<T>(userId: string, fn: (store: JobStore) => Promise<T>): Promise<T> {
    if (!('transaction' in this.db)) throw new Error('withUserLock cannot nest');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [USER_JOBS_LOCK_NS, Number.parseInt(userId, 10)]);
      return fn(new JobStore(tx));
    });
  }

  /** How many of a user's jobs are in one of `states`. */
  async countForUser(userId: string, states: readonly JobState[]): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM jobs WHERE user_id = $1 AND status = ANY($2::text[])',
      Number.parseInt(userId, 10),
      [...states],
    );
    return row?.n ?? 0;
  }

  /**
   * Create a new job record in PostgreSQL.
   * Generates a UUID if job_id is not provided.
   */
  async create(input: {
    user_id: string;
    site: string;
    brand: string;
    job_id?: string;
    restart_count?: number;
    restart_parent_id?: string | null;
    schedule_id?: number;
  }): Promise<JobRecord> {
    const jobId = input.job_id ?? uuidv4();
    const now = new Date().toISOString();

    const row = await this.db.get<JobRow>(
      `INSERT INTO jobs (job_id, user_id, site, brand, status, restart_count, restart_parent_id, schedule_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      jobId,
      Number.parseInt(input.user_id, 10),
      input.site,
      input.brand,
      'queued',
      input.restart_count ?? 0,
      input.restart_parent_id ?? null,
      input.schedule_id ?? null,
      now,
      now,
    );

    if (!row) {
      throw new Error('Failed to create job record');
    }

    logger.info('Job record created', {
      operation: 'create',
      jobId,
      site: input.site,
      brand: input.brand,
    });

    return rowToRecord(row);
  }

  /**
   * Get a job by its UUID.
   */
  async getById(jobId: string): Promise<JobRecord | undefined> {
    const row = await this.db.get<JobRow>(
      'SELECT * FROM jobs WHERE job_id = $1',
      jobId,
    );
    if (!row) {
      logger.warn('Job not found in DB', { operation: 'getById', jobId });
    }
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Get multiple jobs by their UUIDs in a single query.
   * Returns a Map keyed by job_id for O(1) lookups.
   */
  async getByIds(jobIds: string[]): Promise<Map<string, JobRecord>> {
    const map = new Map<string, JobRecord>();
    if (jobIds.length === 0) return map;

    const rows = await this.db.all<JobRow>(
      'SELECT * FROM jobs WHERE job_id = ANY($1)',
      jobIds,
    );

    for (const row of rows) {
      map.set(row.job_id, rowToRecord(row));
    }
    return map;
  }

  /**
   * Update non-status fields on a job record (progress, results). Status is
   * written only by transition(), which job-lifecycle.ts owns.
   * Automatically sets updated_at to the current timestamp.
   */
  async update(jobId: string, updates: JobFieldUpdate): Promise<JobRecord> {
    if ('status' in updates) {
      throw new Error('JobStore.update cannot write status; use the job lifecycle');
    }
    const { sql, values } = buildUpdate(updates, jobId);
    const row = await this.db.get<JobRow>(sql + ' RETURNING *', ...values);
    if (!row) {
      throw new Error('Job "' + jobId + '" not found');
    }
    return rowToRecord(row);
  }

  /**
   * Guarded status change: sets `to` (plus `fields`) only while the row is in
   * one of `from`. Returns the updated record, or undefined when the row is in
   * another state (or missing) — the caller lost a race and must not act.
   */
  async transition(jobId: string, from: readonly JobState[], to: JobState, fields: JobFieldUpdate): Promise<JobRecord | undefined> {
    const { sql, values } = buildUpdate({ ...fields, status: to }, jobId);
    values.push([...from]);
    const row = await this.db.get<JobRow>(sql + ' AND status = ANY($' + values.length + '::text[]) RETURNING *', ...values);
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Delete a job record by ID.
   * Returns true if a row was deleted, false if not found.
   */
  async delete(jobId: string): Promise<boolean> {
    const result = await this.db.run(
      'DELETE FROM jobs WHERE job_id = $1',
      jobId,
    );
    return result.changes > 0;
  }

  /**
   * List jobs with filtering and pagination in reverse chronological order.
   *
   * This query LEFT JOINs the `users` table so callers get owner info without
   * an N+1 round-trip. Filter columns are qualified with `j.` because
   * `created_at`/`status`/etc. would otherwise be ambiguous against the join.
   */
  async list(filters: JobFilters = {}): Promise<JobListResult> {
      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (filters.site) {
        conditions.push('j.site = $' + paramIndex++);
        values.push(filters.site);
      }
      if (filters.brand) {
        conditions.push('j.brand = $' + paramIndex++);
        values.push(filters.brand);
      }
      if (filters.status) {
        conditions.push('j.status = $' + paramIndex++);
        values.push(filters.status);
      }
      if (filters.user_id) {
        conditions.push('j.user_id = $' + paramIndex++);
        values.push(Number.parseInt(filters.user_id, 10));
      }
      if (filters.date_from) {
        conditions.push('j.created_at >= $' + paramIndex++);
        values.push(filters.date_from);
      }
      if (filters.date_to) {
        conditions.push('j.created_at <= $' + paramIndex++);
        values.push(filters.date_to);
      }

      // Cursor-based pagination: use created_at from the last row of the previous page.
      // Falls back to OFFSET when cursor is not provided (backward compatible).
      const useCursor = !!filters.cursor;
      if (useCursor) {
        conditions.push('j.created_at < $' + paramIndex++);
        values.push(filters.cursor);
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const page = filters.page ?? 1;
      const pageSize = filters.page_size ?? 20;

      // Project all jobs columns plus owner columns from the LEFT JOIN.
      // Aliasing the user columns prevents `id` collision with future schema changes.
      const projection = 'j.*, u.id AS owner_id, u.username AS owner_username, u.email AS owner_email, COUNT(*) OVER() AS total_count';
      const fromJoin = 'FROM jobs j LEFT JOIN users u ON u.id = j.user_id';

      let sql: string;
      let queryValues: unknown[];
      if (useCursor) {
        sql = 'SELECT ' + projection + ' ' + fromJoin + ' ' + whereClause + ' ORDER BY j.created_at DESC LIMIT $' + paramIndex;
        queryValues = [...values, pageSize];
      } else {
        const offset = (page - 1) * pageSize;
        const limitParam = paramIndex++;
        const offsetParam = paramIndex;
        sql = 'SELECT ' + projection + ' ' + fromJoin + ' ' + whereClause + ' ORDER BY j.created_at DESC LIMIT $' + limitParam + ' OFFSET $' + offsetParam;
        queryValues = [...values, pageSize, offset];
      }

      type JoinedJobRow = JobRow & {
        total_count: string;
        owner_id: number | null;
        owner_username: string | null;
        owner_email: string | null;
      };

      const rows = await this.db.all<JoinedJobRow>(sql, ...queryValues);
      const total = rows.length > 0 ? Number.parseInt(rows[0].total_count, 10) : 0;
      const jobs: JobRecordWithOwner[] = rows.map((row) => {
        const { owner_id, owner_username, owner_email, ...rest } = row;
        const jobRow = stripTotalCount(rest);
        const record = rowToRecord(jobRow) as JobRecordWithOwner;
        // Only attach owner if the LEFT JOIN actually matched a user row.
        if (owner_id != null && owner_username != null && owner_email != null) {
          record.owner = {
            id: owner_id,
            username: owner_username,
            email: owner_email,
          };
        }
        return record;
      });

      // Provide next_cursor from the last row's created_at for cursor-based pagination
      const lastJob = jobs.at(-1);
      const next_cursor = jobs.length === pageSize && lastJob ? lastJob.created_at : undefined;

      return {
        jobs,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
        next_cursor,
      };
    }

  /**
   * Compute dashboard statistics. Returns global aggregates for all users —
   * stats are not per-user. Per-user filtering happens on `recentJobs` in
   * the /jobs/stats route, not here.
   */
  async getStats(): Promise<JobStats> {
    // Fan out the three count queries concurrently. They are
    // independent, so Promise.all lets the connection pool service them in
    // parallel instead of paying ~3x round-trip latency sequentially.
    const [todayRow, activeRow, recentRow] = await Promise.all([
      // Jobs created today
      this.db.get<{ count: string }>(
        `SELECT COUNT(*) as count FROM jobs WHERE created_at >= date_trunc('day', NOW())`,
      ),
      // Active jobs (running or queued)
      this.db.get<{ count: string }>(
        `SELECT COUNT(*) as count FROM jobs WHERE status IN ('running', 'queued')`,
      ),
      // Recent completions: count completed jobs among the 10 most recent
      this.db.get<{ count: string }>(
        `SELECT COUNT(*) as count FROM (
           SELECT status FROM jobs
           ORDER BY created_at DESC LIMIT 10
         ) sub WHERE sub.status = 'completed'`,
      ),
    ]);

    return {
      jobsToday: Number.parseInt(todayRow?.count ?? '0', 10),
      activeJobs: Number.parseInt(activeRow?.count ?? '0', 10),
      recentCompletions: Number.parseInt(recentRow?.count ?? '0', 10),
    };
  }

  /**
   * Fail jobs a previous crash left behind. Called on worker start.
   *
   * - running rows whose worker has no live heartbeat (`liveWorkerIds`);
   * - queued rows BullMQ no longer holds (`pendingJobIds`: jobs-table ids of
   *   waiting/delayed/active BullMQ jobs). Rows touched within QUEUED_GRACE
   *   are skipped: they may be between INSERT and enqueue.
   *
   * Either set may be undefined when the caller couldn't read it; that half is
   * then skipped rather than guessed at — a backlog legitimately waiting in
   * BullMQ, or a job another live worker runs, must never be failed.
   */
  async cleanupStale(liveWorkerIds: Set<string> | undefined, pendingJobIds: Set<string> | undefined): Promise<number> {
    const setFailed = `UPDATE jobs SET status = 'failed',
           error_message = 'Server restarted — job was interrupted',
           failure_category = 'other',
           completed_at = NOW(),
           updated_at = NOW()`;
    let changes = 0;

    if (liveWorkerIds) {
      // `NOT (worker_id = ANY($1))` rather than `NOT IN (...)`: NOT IN with a
      // NULL element is UNKNOWN for every row and would clean nothing.
      const live = [...liveWorkerIds].filter((id): id is string => id != null);
      changes += (await this.db.run(
        setFailed + `
         WHERE status = 'running' AND (worker_id IS NULL OR NOT (worker_id = ANY($1::text[])))`,
        live,
      )).changes;
    }

    if (pendingJobIds) {
      changes += (await this.db.run(
        setFailed + `
         WHERE status = 'queued'
           AND updated_at < NOW() - INTERVAL '2 minutes'
           AND NOT (job_id::text = ANY($1::text[]))`,
        [...pendingJobIds],
      )).changes;
    }

    if (changes > 0) {
      logger.info('Cleaned up stale jobs', { operation: 'cleanupStale', count: changes });
    }
    return changes;
  }
}

// --- Singleton accessor ---

let _singleton: JobStore | null = null;
let _singletonPromise: Promise<JobStore> | null = null;

/**
 * Returns a lazily-created singleton JobStore instance.
 * All callers in the same process share the same instance.
 * Concurrent calls during initialization are deduplicated via a shared promise.
 */
export async function getJobStore(): Promise<JobStore> {
  if (_singleton) return _singleton;
  _singletonPromise ??= DatabaseService.getInstance().then((db) => {
    _singleton = new JobStore(db);
    return _singleton;
  });
  return _singletonPromise;
}
