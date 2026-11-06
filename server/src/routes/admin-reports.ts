/**
 * Admin Reports Routes — list + delete generated Excel reports.
 *
 * Mounted at /api/admin/reports by the admin hub router. Auth + admin-role
 * middleware applied by the parent (see routes/admin.ts).
 *
 * Endpoints:
 *   - GET    /api/admin/reports/excels           — paginated list of jobs with file_path, plus retention_days
 *   - DELETE /api/admin/reports/excels/:jobId    — delete a single excel from disk + clear file_path
 */

import fs from 'node:fs';
import { Router } from 'express';
import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import { deleteExcelFile } from '../services/download-service';
import { asyncHandler } from '../utils/async-handler';
import { config } from '../config';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

interface ExcelReportRow {
  job_id: string;
  site: string;
  brand: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  file_path: string;
  file_size_bytes: number;  // on-disk size; only files present on disk are listed
}

/**
 * GET /api/admin/reports/excels
 * Lists jobs whose Excel file is still present on disk, paginated by
 * completed_at DESC.
 *
 * Query params: page (default 1), limit (default 50, max 200).
 * On-disk presence isn't tracked in the DB, so every job with a file_path is
 * stat()'d and only files that exist are returned; tombstones (file_path set
 * but the file removed by the retention sweep) are excluded from the listing.
 */
router.get('/excels', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
  const offset = (page - 1) * limit;

  const db = await DatabaseService.getInstance();

  interface JobFileRow {
    job_id: string;
    site: string;
    brand: string;
    status: string;
    created_at: Date | string;
    completed_at: Date | string | null;
    file_path: string;
  }

  // Presence on disk isn't tracked in the DB — the retention sweep deletes
  // report files without nulling jobs.file_path, leaving "tombstone" pointers.
  // We stat() every candidate and list ONLY files that still exist; missing
  // files are excluded entirely. Volume is bounded by the report retention
  // window, so scanning + statting the full candidate set is cheap here.
  // Bound the candidate set to the report retention window. Files older than
  // that have already been swept off disk (their stat() below would fail and
  // exclude them anyway), so this only avoids loading + statting dead
  // tombstone rows — result-preserving, not a behavior change.
  const rows = await db.all<JobFileRow>(
    `SELECT job_id, site, brand, status, created_at, completed_at, file_path
     FROM jobs
     WHERE file_path IS NOT NULL
       AND COALESCE(completed_at, created_at) >= NOW() - INTERVAL '1 day' * $1
     ORDER BY COALESCE(completed_at, created_at) DESC`,
    config.scraping.reportRetentionDays,
  );

  const statted = await Promise.all(
    rows.map(async (r) => {
      try {
        const stat = await fs.promises.stat(r.file_path);
        return { row: r, bytes: stat.size };
      } catch {
        return null; // file gone — exclude the tombstone from the listing
      }
    }),
  );
  // filter() preserves the completed_at DESC ordering from the query.
  const present = statted.filter(
    (x): x is { row: JobFileRow; bytes: number } => x !== null,
  );
  const total = present.length;

  const reports: ExcelReportRow[] = present
    .slice(offset, offset + limit)
    .map(({ row: r, bytes }) => ({
      job_id: r.job_id,
      site: r.site,
      brand: r.brand,
      status: r.status,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      completed_at: r.completed_at instanceof Date ? r.completed_at.toISOString() : (r.completed_at ?? null),
      file_path: r.file_path,
      file_size_bytes: bytes,
    }));

  res.json({
    success: true,
    reports,
    pagination: { page, limit, total },
    // REPORT_RETENTION_DAYS: the client shows it rather than assuming a default.
    retention_days: config.scraping.reportRetentionDays,
  });
}, { operation: 'listExcelReports', message: 'Failed to list excel reports' }));

/**
 * DELETE /api/admin/reports/excels/:jobId
 * Deletes the excel file from disk + nulls jobs.file_path. Idempotent: if
 * the file is already missing, still clears the DB pointer.
 */
router.delete('/excels/:jobId', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = String(req.params.jobId);
  const result = await deleteExcelFile(jobId);

  const db = await DatabaseService.getInstance();
  const audit = new AuditService(db);
  await audit.log({
    userId: req.user!.id,
    action: 'delete_excel_report',
    resourceType: 'excel_report',
    resourceId: jobId,
    ipAddress: req.ip ?? undefined,
    userAgent: req.get('user-agent'),
    details: JSON.stringify({
      deleted: result.deleted,
      bytes: result.bytes,
      file_path: result.filePath,
    }),
  });

  res.json({
    success: true,
    message: result.deleted
      ? `Excel report for job "${jobId}" deleted (${result.bytes} bytes freed)`
      : `Excel report for job "${jobId}" already missing; DB pointer cleared`,
    deleted: result.deleted,
    bytes_freed: result.bytes,
  });
}, { operation: 'deleteExcelReport', message: 'Failed to delete excel report' }));

export default router;
