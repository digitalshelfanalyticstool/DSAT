/**
 * JobBandwidthStore — PostgreSQL-backed persistence layer for per-job bandwidth records.
 *
 * Stores bytes downloaded/uploaded and request counts per scraping job,
 * enabling per-retailer cost analytics and historical bandwidth queries.
 *
 * All queries use parameterized $1, $2 placeholders — no string interpolation.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';

const logger = createLogger('job-bandwidth-store');

// --- Data Types ---

export interface JobBandwidthRecord {
  id: number;
  jobId: string;
  site: string;
  bytesDownloaded: number;
  bytesUploaded: number;
  requestCount: number;
  createdAt: string;
}

export interface RetailerBandwidthAggregation {
  site: string;
  bytesDownloaded: number;
  bytesUploaded: number;
  requestCount: number;
  jobCount: number;
}

// --- Row mapping ---

interface JobBandwidthRow {
  id: number;
  job_id: string;
  site: string;
  bytes_downloaded: string | number;
  bytes_uploaded: string | number;
  request_count: number;
  created_at: Date | string;
}

function rowToRecord(row: JobBandwidthRow): JobBandwidthRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    site: row.site,
    bytesDownloaded: Number(row.bytes_downloaded),
    bytesUploaded: Number(row.bytes_uploaded),
    requestCount: row.request_count,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

// --- JobBandwidthStore class ---

export class JobBandwidthStore {
  private readonly db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Insert a new job bandwidth record.
   * Uses ON CONFLICT to upsert if a record for the job already exists.
   */
  async create(record: {
    jobId: string;
    site: string;
    bytesDownloaded: number;
    bytesUploaded: number;
    requestCount: number;
  }): Promise<JobBandwidthRecord> {
    const row = await this.db.get<JobBandwidthRow>(
      `INSERT INTO job_bandwidth (job_id, site, bytes_downloaded, bytes_uploaded, request_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO UPDATE SET
         bytes_downloaded = EXCLUDED.bytes_downloaded,
         bytes_uploaded = EXCLUDED.bytes_uploaded,
         request_count = EXCLUDED.request_count
       RETURNING *`,
      record.jobId,
      record.site,
      record.bytesDownloaded,
      record.bytesUploaded,
      record.requestCount,
    );

    if (!row) {
      throw new Error(`Failed to create job bandwidth record for job ${record.jobId}`);
    }

    logger.info('Job bandwidth record created', {
      operation: 'create',
      jobId: record.jobId,
      site: record.site,
      bytesDownloaded: record.bytesDownloaded,
      bytesUploaded: record.bytesUploaded,
      requestCount: record.requestCount,
    });

    return rowToRecord(row);
  }

  /**
   * Get bandwidth record for a specific job.
   */
  async getByJobId(jobId: string): Promise<JobBandwidthRecord | undefined> {
    const row = await this.db.get<JobBandwidthRow>(
      'SELECT * FROM job_bandwidth WHERE job_id = $1',
      jobId,
    );
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Get all bandwidth records for a retailer within a date range.
   */
  async getByRetailer(site: string, from: Date, to: Date): Promise<JobBandwidthRecord[]> {
    const rows = await this.db.all<JobBandwidthRow>(
      `SELECT * FROM job_bandwidth
       WHERE site = $1 AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at DESC`,
      site,
      from.toISOString(),
      to.toISOString(),
    );
    return rows.map(rowToRecord);
  }

  /**
   * Aggregate bandwidth by retailer for a date range.
   * Returns grouped sums of bytes and request counts, sorted by total bytes descending.
   * When excludeAdmin is true, jobs created by admin users are filtered out.
   */
  async aggregateByRetailer(from: Date, to: Date, excludeAdmin = false): Promise<RetailerBandwidthAggregation[]> {
    const adminJoin = excludeAdmin
      ? 'JOIN jobs j ON j.job_id = jb.job_id JOIN users u ON u.id = j.user_id'
      : '';
    const adminWhere = excludeAdmin ? "AND u.role <> 'admin'" : '';

    const rows = await this.db.all<{
      site: string;
      bytes_downloaded: string | number;
      bytes_uploaded: string | number;
      request_count: string | number;
      job_count: string | number;
    }>(
      `SELECT
         jb.site,
         COALESCE(SUM(jb.bytes_downloaded), 0) AS bytes_downloaded,
         COALESCE(SUM(jb.bytes_uploaded), 0) AS bytes_uploaded,
         COALESCE(SUM(jb.request_count), 0) AS request_count,
         COUNT(*) AS job_count
       FROM job_bandwidth jb
       ${adminJoin}
       WHERE jb.created_at >= $1 AND jb.created_at < ($2::date + INTERVAL '1 day') ${adminWhere}
       GROUP BY jb.site
       ORDER BY (SUM(jb.bytes_downloaded) + SUM(jb.bytes_uploaded)) DESC`,
      from.toISOString(),
      to.toISOString(),
    );

    return rows.map((row) => ({
      site: row.site,
      bytesDownloaded: Number(row.bytes_downloaded),
      bytesUploaded: Number(row.bytes_uploaded),
      requestCount: Number(row.request_count),
      jobCount: Number(row.job_count),
    }));
  }
}
