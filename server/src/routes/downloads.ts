/**
 * Download API Routes — REST endpoints for downloading Excel files and retrieving file metadata.
 *
 * All routes require authentication via Bearer token.
 */

import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import { downloadFile, getFileInfo, reExportFile, canReExport, DownloadError } from '../services/download-service';
import { authMiddleware } from '../middleware/auth';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { config } from '../config';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('download-routes');
const router = Router();

/**
 * Auth middleware wrapper for browser-facing download routes.
 * On 401 (expired/invalid token), redirects to the login page instead of
 * returning JSON — because downloads open in a new tab via window.open()
 * where the client-side 401 handler can't intercept.
 */
function browserAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Intercept res.status(401).json() calls from authMiddleware
  const originalJson = res.json.bind(res);
  const originalStatus = res.status.bind(res);
  let interceptedStatus = 0;

  res.status = function (code: number) {
    interceptedStatus = code;
    return originalStatus(code);
  } as typeof res.status;

  res.json = function (body: unknown) {
    if (interceptedStatus === 401) {
      // Determine the frontend origin for the redirect
      // Validate redirect origin against allowed CORS origins to prevent open redirect
      const allowedOrigins = (config.server.corsOrigins || 'http://localhost:3000')
        .split(',')
        .map(o => o.trim());
      const headerOrigin = req.headers.origin;
      const refererOrigin = req.headers.referer?.replace(/\/[^/]*$/, '');

      let origin = allowedOrigins[0];
      if (headerOrigin && allowedOrigins.includes(headerOrigin)) {
        origin = headerOrigin;
      } else if (refererOrigin && allowedOrigins.includes(refererOrigin)) {
        origin = refererOrigin;
      }

      logger.info('Redirecting expired session to login', {
        operation: 'browserAuthMiddleware',
        path: req.originalUrl,
      });

      // Reset status and redirect to login
      res.status(302);
      res.setHeader('Location', `${origin}/login?session_expired=true`);
      res.end();
      return res;
    }
    return originalJson(body);
  } as typeof res.json;

  authMiddleware(req, res, next);
}

// Download routes use browser-aware auth that redirects on 401
router.use(browserAuthMiddleware);

// ─── Download File ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/jobs/{id}/download:
 *   get:
 *     summary: Download the Excel file for a completed job
 *     tags: [Downloads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Job ID
 *     responses:
 *       200:
 *         description: Excel file download
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 */
/**
 * @swagger
 * /api/jobs/{id}/download:
 *   get:
 *     responses:
 *       403:
 *         description: User does not have permission to download this file
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Job or file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id/download', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = req.params.id as string;

  try {
    const result = await downloadFile(jobId, String(req.user!.id), req.user!.role);

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);

    const stream = await import('node:fs').then((fs) => fs.createReadStream(result.filePath));
    stream.pipe(res);

    stream.on('error', (err) => {
      logger.error('File stream error', { operation: 'download', jobId, error: err.message });
      if (!res.headersSent) {
        res.status(500).json(errorResponse('Failed to stream file', 'server_error'));
      }
    });
  } catch (err) {
    const statusCode = err instanceof DownloadError ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err);

    // The only branch this catch still owns: a cleaned-up file that can be
    // regenerated answers 410 with a re-export URL, which is not an error
    // envelope at all. Everything else goes to the shared handler.
    if (statusCode === 404 && message === 'File not found' && await canReExport(jobId)) {
      res.status(410).json({
        success: false,
        error_type: 'file_expired',
        message: 'This file has been cleaned up to save disk space. You can regenerate it from the stored data.',
        re_export_url: `/api/jobs/${jobId}/re-export`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    throw err;
  }
}, { operation: 'download' }));

// ─── File Info ─────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/jobs/{id}/file-info:
 *   get:
 *     summary: Get file metadata for a completed job
 *     tags: [Downloads]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Job ID
 *     responses:
 *       200:
 *         description: File metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 file:
 *                   type: object
 *                   properties:
 *                     filename:
 *                       type: string
 *                       example: "abc123_example-shop_Example-Brand_20240115143022.xlsx"
 *                     size:
 *                       type: integer
 *                       description: File size in bytes
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     contentType:
 *                       type: string
 *                       example: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
 *       404:
 *         description: Job or file not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id/file-info', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = req.params.id as string;
  const info = await getFileInfo(jobId, String(req.user!.id), req.user!.role);
  res.json({ success: true, file: info });
}, { operation: 'fileInfo' }));

// ─── Re-export File ──────────────────────────────────────────────────────────

/**
 * POST /api/jobs/:id/re-export
 * Regenerate the Excel file for a completed job from database variant data.
 * Used when the original file has been cleaned up by the weekly retention job.
 */
router.post('/:id/re-export', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const jobId = req.params.id as string;

  const { filename, contentType } = await reExportFile(
    jobId,
    String(req.user!.id),
    req.user!.role,
  );

  logger.info('File re-exported successfully', {
    operation: 're-export',
    jobId,
    userId: req.user!.id,
    filename,
  });

  res.json({
    success: true,
    message: 'File regenerated successfully',
    file: {
      filename,
      contentType,
      download_url: `/api/jobs/${jobId}/download`,
    },
  });
}, { operation: 're-export' }));

export default router;
