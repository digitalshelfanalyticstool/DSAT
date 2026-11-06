/**
 * Download Service — serves generated Excel files with authentication and authorization checks.
 *
 * Provides file download, file metadata retrieval, and old file cleanup.
 * Files are stored under storage/excel/ organized by date.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getJobStore, type JobRecord } from './job-store';
import { buildOutputPath } from './excel-generator';
import { exportScrapeRun } from './excel-job-handler';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { isOwnerOrAdmin } from './user-records';

const logger = createLogger('download-service');

/**
 * Typed error class for download-related failures.
 * Carries an HTTP status code for route-level error handling.
 */
export class DownloadError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'DownloadError';
    this.statusCode = statusCode;
  }
}

/**
 * Validate that a file path resolves to a location within the allowed base directory.
 *
 * Resolves both the file and base to their real (symlink-resolved) absolute paths,
 * then verifies the file is contained within the base. Blocks path traversal via
 * `../`, symlinks, or any other technique that escapes the allowed directory.
 *
 * @param filePath  — the path to validate (may be relative or absolute)
 * @param allowedBase — the directory the file must reside within
 * @returns the resolved real absolute path of the file
 * @throws DownloadError 404 if the file does not exist
 * @throws DownloadError 403 if the resolved path escapes the allowed base
 */
export function validateFilePath(filePath: string, allowedBase: string): string {
  const resolvedBase = path.resolve(allowedBase);
  const resolvedFile = path.resolve(filePath);

  let realFile: string;
  try {
    realFile = fs.realpathSync(resolvedFile);
  } catch {
    throw new DownloadError('File not found', 404);
  }

  let realBase: string;
  try {
    realBase = fs.realpathSync(resolvedBase);
  } catch {
    throw new DownloadError('File not found', 404);
  }

  if (!realFile.startsWith(realBase + path.sep) && realFile !== realBase) {
    logger.warn('Path traversal attempt blocked', {
      operation: 'validateFilePath',
      requestedPath: filePath,
      resolvedPath: realFile,
      allowedBase: realBase,
    });
    throw new DownloadError('Access denied', 403);
  }

  return realFile;
}

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// --- Interfaces ---

export interface DownloadFileResult {
  filePath: string;
  filename: string;
  contentType: string;
}

export interface FileInfo {
  filename: string;
  size: number;
  createdAt: string;
  contentType: string;
}

// --- Helpers ---

/**
 * Build the download filename from job metadata.
 * Format: {job_id}_{site}_{brand}_{timestamp}.xlsx
 */
function buildFilename(jobId: string, site: string, brand: string, completedAt: string): string {
  const ts = completedAt.replaceAll(/[-:T]/g, '').replaceAll(/\.\d+Z$/g, '');
  return `${jobId}_${site}_${brand}_${ts}.xlsx`;
}

function getStorageBase(): string {
  return path.resolve(config.scraping.storageDir);
}

// --- Public API ---

/**
 * Verify authorization and return file info for streaming.
 *
 * Checks:
 * 1. Job exists (404 if not)
 * 2. User owns the job or is admin (403 if not)
 * 3. Job has a file_path and the file exists on disk (404 if not)
 *
 * Returns the absolute file path, suggested download filename, and content type.
 */
export async function downloadFile(
  jobId: string,
  userId: string,
  userRole: string,
): Promise<DownloadFileResult> {
  const job = await getJobOrThrow404(jobId);

  // Authorization: user must own the job or be admin
  if (!isOwnerOrAdmin(job.user_id, userId, userRole)) {
    logger.warn('Unauthorized download attempt', {
      operation: 'downloadFile',
      jobId,
      userId,
      jobOwner: job.user_id,
    });
    throw new DownloadError('You do not have permission to download this file', 403);
  }

  // File must exist
  if (!job.file_path) {
    const err = new DownloadError('No file available for this job', 404);
    throw err;
  }

  // Path traversal prevention: validate the file is within storage/excel/
  const storageBase = getStorageBase();
  const validatedPath = validateFilePath(job.file_path, storageBase);

  try {
    await fs.promises.access(validatedPath, fs.constants.R_OK);
  } catch {
    logger.warn('File not found on disk', {
      operation: 'downloadFile',
      jobId,
      filePath: validatedPath,
    });
    throw new DownloadError('File not found', 404);
  }

  const filename = buildFilename(
    job.job_id,
    job.site,
    job.brand,
    job.completed_at || job.updated_at,
  );

  logger.info('File download authorized', {
    operation: 'downloadFile',
    jobId,
    userId,
    filename,
  });

  return {
    filePath: validatedPath,
    filename,
    contentType: XLSX_CONTENT_TYPE,
  };
}

/**
 * Return file metadata for a job's output file.
 *
 * Checks (mirrors downloadFile):
 * 1. Job exists (404 if not)
 * 2. User owns the job or is admin (403 if not)
 * 3. Job has a file_path and the file exists on disk (404 if not)
 *
 * The ownership check is what stops any authenticated user from enumerating
 * other users' job filenames + sizes via GET /api/jobs/:id/file-info (IDOR).
 */
export async function getFileInfo(
  jobId: string,
  userId: string,
  userRole: string,
): Promise<FileInfo> {
  const job = await getJobOrThrow404(jobId);

  // Authorization: user must own the job or be admin
  if (!isOwnerOrAdmin(job.user_id, userId, userRole)) {
    logger.warn('Unauthorized file-info attempt', {
      operation: 'getFileInfo',
      jobId,
      userId,
      jobOwner: job.user_id,
    });
    throw new DownloadError('You do not have permission to view this file', 403);
  }

  if (!job.file_path) {
    throw new DownloadError('No file available for this job', 404);
  }

  // Path traversal prevention: validate the file is within storage/excel/
  const storageBase = getStorageBase();
  const validatedPath = validateFilePath(job.file_path, storageBase);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(validatedPath);
  } catch {
    throw new DownloadError('File not found', 404);
  }

  const filename = buildFilename(
    job.job_id,
    job.site,
    job.brand,
    job.completed_at || job.updated_at,
  );

  return {
    filename,
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    contentType: XLSX_CONTENT_TYPE,
  };
}

/**
 * Delete a single Excel file by job id (admin-initiated, surgical).
 *
 * Verifies the job exists, validates the path is within the storage base
 * (path-traversal guard), unlinks the file, and clears `jobs.file_path` so
 * subsequent download attempts return 404 cleanly instead of re-Exporting
 * a file the admin just chose to remove.
 *
 * Idempotent on the file: returns `{deleted: false}` if file_path is already
 * null OR the file is missing on disk — caller should still null the DB
 * column in either case.
 *
 * @throws DownloadError(404) if the job does not exist
 * @throws DownloadError(403) if the resolved path escapes the storage base
 */
export async function deleteExcelFile(jobId: string): Promise<{ deleted: boolean; bytes: number; filePath: string | null }> {
  const job = await getJobOrThrow404(jobId);

  if (!job.file_path) {
    return { deleted: false, bytes: 0, filePath: null };
  }

  const storageBase = getStorageBase();
  let validatedPath: string;
  try {
    validatedPath = validateFilePath(job.file_path, storageBase);
  } catch (err) {
    // File already missing (cleanupOldFiles or manual rm) — still null the DB column
    if (err instanceof DownloadError && err.statusCode === 404) {
      await clearJobFilePath(jobId);
      return { deleted: false, bytes: 0, filePath: job.file_path };
    }
    throw err;
  }

  let bytes = 0;
  try {
    const stat = await fs.promises.stat(validatedPath);
    bytes = stat.size;
  } catch {
    // racing with another cleanup — proceed to unlink anyway
  }

  await fs.promises.unlink(validatedPath);
  await clearJobFilePath(jobId);

  logger.info('Admin deleted excel report', {
    operation: 'deleteExcelFile',
    jobId,
    filePath: validatedPath,
    bytes,
  });

  return { deleted: true, bytes, filePath: validatedPath };
}

async function clearJobFilePath(jobId: string): Promise<void> {
  const { DatabaseService } = await import('./database');
  const db = await DatabaseService.getInstance();
  await db.run('UPDATE jobs SET file_path = NULL, updated_at = NOW() WHERE job_id = $1', jobId);
}

/**
 * Remove Excel files older than the retention period.
 * Walks the storage/excel/ directory tree and deletes old .xlsx files.
 * Returns the count of deleted files.
 */
export async function cleanupOldFiles(retentionDays: number = 30): Promise<number> {
  const storageBase = getStorageBase();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    await fs.promises.access(storageBase);
  } catch {
    // Storage directory doesn't exist yet — nothing to clean
    return 0;
  }

  deleted = await walkAndDelete(storageBase, cutoff);

  logger.info('Old file cleanup completed', {
    operation: 'cleanupOldFiles',
    retentionDays,
    deletedCount: deleted,
  });

  return deleted;
}

/**
 * Re-export an Excel file for a completed job by regenerating it from
 * the variant data stored in the database (product_snapshots).
 *
 * Used when the original file has been cleaned up by the weekly retention job.
 * Updates the job's file_path in the database so subsequent downloads work.
 */
export async function reExportFile(
  jobId: string,
  userId: string,
  userRole: string,
): Promise<DownloadFileResult> {
  const job = await getJobOrThrow404(jobId);

  if (!isOwnerOrAdmin(job.user_id, userId, userRole)) {
    throw new DownloadError('You do not have permission to re-export this file', 403);
  }

  if (job.status !== 'completed') {
    throw new DownloadError('Only completed jobs can be re-exported', 400);
  }

  const scrapeRunId = await latestScrapeRunId(jobId);
  if (scrapeRunId === null) {
    throw new DownloadError('No variant data found in database for this job. The data may not have been persisted.', 404);
  }

  const outputPath = buildOutputPath(getStorageBase(), jobId, job.site, job.brand);
  const { filePath, variantCount } = await exportScrapeRun(scrapeRunId, outputPath, job.site, job.brand);

  // Update job record with new file path
  const jobStore = await getJobStore();
  await jobStore.update(jobId, { file_path: filePath });

  const filename = buildFilename(
    job.job_id,
    job.site,
    job.brand,
    job.completed_at || job.updated_at,
  );

  logger.info('File re-exported from database', {
    operation: 'reExportFile',
    jobId,
    userId,
    scrapeRunId,
    variantCount,
    filePath,
  });

  return {
    filePath,
    filename,
    contentType: XLSX_CONTENT_TYPE,
  };
}

/**
 * Check whether variant data exists in the database for a job.
 * Used to determine if a re-export is possible when the file is missing.
 */
export async function canReExport(jobId: string): Promise<boolean> {
  try {
    return (await latestScrapeRunId(jobId)) !== null;
  } catch {
    return false;
  }
}

// --- Internal helpers ---

/** The job's most recent scrape run that persisted variants, or null. */
async function latestScrapeRunId(jobId: string): Promise<number | null> {
  const { DatabaseService } = await import('./database');
  const db = await DatabaseService.getInstance();
  const row = await db.get<{ id: number }>(
    'SELECT id FROM scrape_runs WHERE job_id = $1 AND variant_count > 0 ORDER BY id DESC LIMIT 1',
    jobId,
  );
  return row ? Number(row.id) : null;
}

async function getJobOrThrow404(jobId: string): Promise<JobRecord> {
  const jobStore = await getJobStore();
  const job = await jobStore.getById(jobId);
  if (!job) {
    throw new DownloadError(`Job "${jobId}" not found`, 404);
  }
  return job;
}

/** Remove `dir` if it has become empty. Errors are swallowed — best-effort. */
async function tryRemoveIfEmpty(dir: string): Promise<void> {
  try {
    const remaining = await fs.promises.readdir(dir);
    if (remaining.length === 0) {
      await fs.promises.rmdir(dir);
    }
  } catch {
    // ignore
  }
}

/**
 * Unlink an .xlsx file whose mtime is older than `cutoff`. Returns 1 when a
 * file was deleted, 0 otherwise. Errors are swallowed — best-effort.
 */
async function tryDeleteStaleXlsx(fullPath: string, cutoff: number): Promise<number> {
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.mtimeMs < cutoff) {
      await fs.promises.unlink(fullPath);
      logger.debug('Deleted old file', { operation: 'cleanupOldFiles', file: fullPath });
      return 1;
    }
  } catch {
    // ignore individual file errors
  }
  return 0;
}

async function walkAndDelete(dir: string, cutoff: number): Promise<number> {
  let entries: fs.Dirent[];

  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      deleted += await walkAndDelete(fullPath, cutoff);
      await tryRemoveIfEmpty(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.xlsx')) {
      deleted += await tryDeleteStaleXlsx(fullPath, cutoff);
    }
  }

  return deleted;
}
