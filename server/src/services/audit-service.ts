/**
 * Audit Service — logs administrative actions for security and compliance tracking.
 *
 * Records actions like user creation, updates, deletions, reactivations,
 * job deletions, logins, and failed logins. Provides paginated, filterable
 * log retrieval for admin review.
 *
 * All audit records are stored in the audit_logs table with indexes on
 * user_id, action, resource_type, and created_at for query performance.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';

const logger = createLogger('audit-service');

// --- Types ---

export interface CreateAuditLogInput {
  userId: number | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Who made the request an audit row records. */
export interface AuditRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** What services that audit need from AuditService. */
export type AuditLogger = Pick<AuditService, 'log'>;

export interface AuditLogRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface AuditLogResponse {
  id: number;
  user: { id: number; username: string } | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface AuditLogFilters {
  userId?: number;
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface AuditLogListResult {
  logs: AuditLogResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// --- Constants & Helpers ---

/**
 * Cap user-controlled string fields written into
 * `audit_logs` at 255 characters per identifier-like field. The schema uses
 * unbounded TEXT columns for historical reasons — there is no DB-level
 * bound, so a malicious or buggy upstream could otherwise insert
 * arbitrarily large rows. 255 is generous for any legitimate
 * username/identifier and keeps logs cheap to scan.
 *
 * Apply this cap to scalar identifier values BEFORE serializing them into
 * the `details` JSON. Do not call `truncateForAudit` on the JSON envelope
 * itself — slicing a JSON string mid-character breaks downstream consumers.
 *
 * For the `details` JSON envelope as a whole, a generous bound is enforced
 * separately (`AUDIT_DETAILS_MAX_LENGTH`).
 */
export const AUDIT_FIELD_MAX_LENGTH = 255;

/**
 * Cap on the entire serialized `details` JSON column. Generous (4 KiB) so
 * legitimate structured payloads fit, but bounded against pathological
 * input.
 */
export const AUDIT_DETAILS_MAX_LENGTH = 4096;

/**
 * Cap on the `user_agent` column.
 */
export const AUDIT_USER_AGENT_MAX_LENGTH = 512;

/**
 * Truncate an identifier-like field to AUDIT_FIELD_MAX_LENGTH (255 chars).
 * Pass-through for `null`/`undefined`. Use BEFORE serializing into JSON,
 * not on the JSON envelope itself.
 */
export function truncateForAudit(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length > AUDIT_FIELD_MAX_LENGTH
    ? value.slice(0, AUDIT_FIELD_MAX_LENGTH)
    : value;
}

/**
 * Truncate a free-form string column to a given max length, preserving
 * null/undefined as null.
 */
function truncateForColumn(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// --- Service ---

export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Insert an audit log record into the audit_logs table.
   * Failures are caught and logged rather than thrown, so audit logging
   * never breaks the primary operation.
   *
   * `details` is bounded to AUDIT_DETAILS_MAX_LENGTH (4 KiB) and
   * `user_agent` to AUDIT_USER_AGENT_MAX_LENGTH (512). Identifier-like
   * fields *inside* `details` (e.g. usernames) should be capped to
   * AUDIT_FIELD_MAX_LENGTH (255) by the caller via `truncateForAudit`
   * BEFORE being JSON.stringify'd — otherwise slicing JSON mid-character
   * would corrupt it.
   *
   * @param input - Audit log data (userId, action, resourceType, etc.)
   */
  public async log(input: CreateAuditLogInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.db.run(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        input.userId,
        input.action,
        input.resourceType,
        truncateForAudit(input.resourceId),
        truncateForColumn(input.details, AUDIT_DETAILS_MAX_LENGTH),
        input.ipAddress ?? null,
        truncateForColumn(input.userAgent, AUDIT_USER_AGENT_MAX_LENGTH),
        now,
      );
    } catch (err) {
      logger.error('Failed to write audit log', {
        operation: 'log',
        action: input.action,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Retrieve paginated, filterable audit logs with joined user information.
   * Default: 50 per page, max 200. Results are ordered by created_at descending.
   * Supports filtering by userId, action, resourceType, and date range.
   * @param filters - Optional filters and pagination (page, limit, userId, action, resourceType, startDate, endDate)
   * @returns Paginated result with logs array, total count, and page metadata
   */
  public async listLogs(filters: AuditLogFilters = {}): Promise<AuditLogListResult> {
      const page = Math.max(1, filters.page ?? 1);
      const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
      const offset = (page - 1) * limit;

      const whereClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters.userId !== undefined) {
        whereClauses.push('a.user_id = $' + paramIndex++);
        params.push(filters.userId);
      }
      if (filters.action) {
        whereClauses.push('a.action = $' + paramIndex++);
        params.push(filters.action);
      }
      if (filters.resourceType) {
        whereClauses.push('a.resource_type = $' + paramIndex++);
        params.push(filters.resourceType);
      }
      if (filters.startDate) {
        const startTs = Math.floor(new Date(filters.startDate).getTime() / 1000);
        whereClauses.push('a.created_at >= $' + paramIndex++);
        params.push(startTs);
      }
      if (filters.endDate) {
        const endTs = Math.floor(new Date(filters.endDate).getTime() / 1000);
        whereClauses.push('a.created_at <= $' + paramIndex++);
        params.push(endTs);
      }

      const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

      // Fetch page with user join. COUNT(*) OVER() returns the total matching
      // rows (pre-LIMIT) on every row, so a page load is one round-trip, not a
      // separate COUNT query plus the page.
      // Cast to int so the value is a JS number, not a bigint string.
      const limitParam = '$' + paramIndex++;
      const offsetParam = '$' + paramIndex++;
      const rows = await this.db.all<AuditLogRow & { username: string | null; resource_username: string | null; total_count: number }>(
        'SELECT a.*, u.username, ru.username AS resource_username, COUNT(*) OVER()::int AS total_count' +
         ' FROM audit_logs a' +
         ' LEFT JOIN users u ON a.user_id = u.id' +
         ' LEFT JOIN users ru ON a.resource_type = \'user\' AND ru.id = CASE WHEN a.resource_id ~ \'^[0-9]+$\' THEN CAST(a.resource_id AS INTEGER) END' +
         ' ' + whereStr +
         ' ORDER BY a.created_at DESC' +
         ' LIMIT ' + limitParam + ' OFFSET ' + offsetParam,
        ...params, limit, offset,
      );

      // No rows → no window value to read → 0 matches.
      const total = rows[0]?.total_count ?? 0;

      const logs: AuditLogResponse[] = rows.map((row) => ({
        id: row.id,
        user: row.user_id != null && row.username != null
          ? { id: row.user_id, username: row.username }
          : null,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        resource_name: row.resource_username ?? null,
        details: row.details,
        ip_address: row.ip_address,
        created_at: new Date(row.created_at * 1000).toISOString(),
      }));

      return {
        logs,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

  // --- Convenience Methods ---

  /**
   * Log a job deletion event (action: delete_job).
   * @param userId - ID of the user who deleted the job
   * @param jobId - ID of the deleted job
   * @param ipAddress - Client IP address (optional)
   * @param userAgent - Client user agent string (optional)
   */
  public async logJobDeletion(userId: number, jobId: string, ipAddress?: string, userAgent?: string): Promise<void> {
    await this.log({
      userId,
      action: 'delete_job',
      resourceType: 'job',
      resourceId: jobId,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Log a successful login event (action: login).
   * @param userId - ID of the user who logged in
   * @param ipAddress - Client IP address
   * @param userAgent - Client user agent string
   */
  public async logLogin(userId: number, ipAddress: string, userAgent: string): Promise<void> {
    await this.log({
      userId,
      action: 'login',
      resourceType: 'session',
      ipAddress,
      userAgent,
    });
  }

  /**
   * Stream audit logs in batches using keyset pagination.
   * Yields one AuditLogResponse at a time, fetching 1,000 rows per DB query.
   * Total output capped at 50,000 rows.
   */
  public async *exportLogsBatched(
    filters: Omit<AuditLogFilters, 'page' | 'limit'> = {},
  ): AsyncGenerator<AuditLogResponse> {
    const batchSize = 1000;
    const maxRows = 50000;
    let cursor: number | undefined;
    let totalYielded = 0;

    while (totalYielded < maxRows) {
      const batch = await this.fetchExportBatch(filters, batchSize, cursor);
      if (batch.length === 0) break;

      for (const row of batch) {
        yield this.formatAuditRow(row);
        totalYielded++;
        if (totalYielded >= maxRows) break;
      }

      cursor = batch.at(-1)!.id;
      if (batch.length < batchSize) break;
    }
  }

  private async fetchExportBatch(
    filters: Omit<AuditLogFilters, 'page' | 'limit'>,
    batchSize: number,
    cursor?: number,
  ): Promise<Array<AuditLogRow & { username: string | null; resource_username: string | null }>> {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.userId !== undefined) {
      whereClauses.push('a.user_id = $' + paramIndex++);
      params.push(filters.userId);
    }
    if (filters.action) {
      whereClauses.push('a.action = $' + paramIndex++);
      params.push(filters.action);
    }
    if (filters.resourceType) {
      whereClauses.push('a.resource_type = $' + paramIndex++);
      params.push(filters.resourceType);
    }
    if (filters.startDate) {
      const startTs = Math.floor(new Date(filters.startDate).getTime() / 1000);
      whereClauses.push('a.created_at >= $' + paramIndex++);
      params.push(startTs);
    }
    if (filters.endDate) {
      const endTs = Math.floor(new Date(filters.endDate).getTime() / 1000);
      whereClauses.push('a.created_at <= $' + paramIndex++);
      params.push(endTs);
    }
    if (cursor !== undefined) {
      whereClauses.push('a.id < $' + paramIndex++);
      params.push(cursor);
    }

    const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const limitParam = '$' + paramIndex++;

    return this.db.all<AuditLogRow & { username: string | null; resource_username: string | null }>(
      'SELECT a.*, u.username, ru.username AS resource_username' +
       ' FROM audit_logs a' +
       ' LEFT JOIN users u ON a.user_id = u.id' +
       ' LEFT JOIN users ru ON a.resource_type = \'user\' AND ru.id = CASE WHEN a.resource_id ~ \'^[0-9]+$\' THEN CAST(a.resource_id AS INTEGER) END' +
       ' ' + whereStr +
       ' ORDER BY a.id DESC' +
       ' LIMIT ' + limitParam,
      ...params, batchSize,
    );
  }

  private formatAuditRow(row: AuditLogRow & { username: string | null; resource_username: string | null }): AuditLogResponse {
    return {
      id: row.id,
      user: row.user_id != null && row.username != null
        ? { id: row.user_id, username: row.username }
        : null,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      resource_name: row.resource_username ?? null,
      details: row.details,
      ip_address: row.ip_address,
      created_at: new Date(row.created_at * 1000).toISOString(),
    };
  }

  /**
   * Log a failed login attempt (action: failed_login).
   * user_id is set to null since the user may not exist; the attempted username
   * is stored (truncated, see truncateForAudit) in the details field for investigation.
   * @param username - The username that was attempted
   * @param ipAddress - Client IP address
   * @param extra - Fixed-vocabulary context, e.g. `{ method: 'sso', reason: 'not_allowed' }`
   */
  public async logFailedLogin(username: string, ipAddress: string, extra?: Record<string, string>): Promise<void> {
    // Cap the attempted username at 255 chars before
    // it crosses into the JSON payload — the `details` column is unbounded
    // TEXT and we don't want a malicious caller to balloon row sizes.
    const safeUsername = (username ?? '').slice(0, AUDIT_FIELD_MAX_LENGTH);
    await this.log({
      userId: null,
      action: 'failed_login',
      resourceType: 'session',
      details: JSON.stringify({ username: safeUsername, ...extra }),
      ipAddress,
    });
  }
}
