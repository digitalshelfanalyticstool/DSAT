/**
 * Admin Audit Log Routes
 *
 * All routes require authentication + admin role (enforced by parent router).
 *
 * Routes (mounted at /audit-logs by admin.ts):
 *   - GET /          — list audit logs (paginated, filterable)
 *   - GET /export    — export audit logs as CSV or JSON (streamed)
 */

import { Router } from 'express';
import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { csvRow } from '../utils/csv';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

interface AuditExportFilters {
  userId?: number;
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
}

function parseAuditExportFilters(query: Record<string, unknown>): AuditExportFilters {
  const filters: AuditExportFilters = {};

  if (query.user_id) {
    const parsed = Number.parseInt(query.user_id as string, 10);
    if (!Number.isNaN(parsed)) filters.userId = parsed;
  }
  if (typeof query.action === 'string') filters.action = query.action;
  if (typeof query.resource_type === 'string') filters.resourceType = query.resource_type;
  if (typeof query.start_date === 'string') filters.startDate = query.start_date;
  if (typeof query.end_date === 'string') filters.endDate = query.end_date;

  return filters;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Audit Log Routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /admin/audit-logs:
 *   get:
 *     summary: List audit logs with pagination and filtering
 *     tags: [Admin - Audit]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_id
 *         schema: { type: integer }
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *       - in: query
 *         name: resource_type
 *         schema: { type: string }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated audit logs
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { user_id, action, resource_type, start_date, end_date, page, limit } = req.query;

    const filters: {
      userId?: number;
      action?: string;
      resourceType?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
    } = {};

    if (user_id) {
      const parsed = Number.parseInt(user_id as string, 10);
      if (!Number.isNaN(parsed)) filters.userId = parsed;
    }
    if (action) filters.action = String(action);
    if (resource_type) filters.resourceType = String(resource_type);
    if (start_date) filters.startDate = String(start_date);
    if (end_date) filters.endDate = String(end_date);
    if (page) {
      const parsed = Number.parseInt(page as string, 10);
      if (!Number.isNaN(parsed)) filters.page = parsed;
    }
    if (limit) {
      const parsed = Number.parseInt(limit as string, 10);
      if (!Number.isNaN(parsed)) filters.limit = parsed;
    }

    const db = await DatabaseService.getInstance();
    const audit = new AuditService(db);
    const result = await audit.listLogs(filters);

    res.json({ success: true, ...result });
  }, { operation: 'adminListAuditLogs' }),
);

/**
 * @openapi
 * /admin/audit-logs/export:
 *   get:
 *     summary: Export audit logs as CSV or JSON
 *     tags: [Admin - Audit]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [csv, json], default: csv }
 *       - in: query
 *         name: user_id
 *         schema: { type: integer }
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *       - in: query
 *         name: resource_type
 *         schema: { type: string }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: File download (CSV or JSON)
 */
router.get('/export', asyncHandler(async (req: AuthenticatedRequest, res) => {
    const exportFormat = String(req.query.format || 'csv').toLowerCase();

    if (exportFormat !== 'csv' && exportFormat !== 'json') {
      res.status(400).json(errorResponse('format must be "csv" or "json"', 'validation_error'));
      return;
    }

    const filters = parseAuditExportFilters(req.query);
    const db = await DatabaseService.getInstance();
    const audit = new AuditService(db);
    const dateStr = new Date().toISOString().slice(0, 10);

    if (exportFormat === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${dateStr}.json"`);

      res.write('[');
      let first = true;
      for await (const log of audit.exportLogsBatched(filters)) {
        if (!first) res.write(',');
        res.write(JSON.stringify(log));
        first = false;
      }
      res.write(']');
      res.end();
      return;
    }

    // CSV format — streamed in batches
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${dateStr}.csv"`);

    res.write('ID,User ID,Username,Action,Resource Type,Resource ID,Resource Name,Details,IP Address,Created At\n');

    for await (const log of audit.exportLogsBatched(filters)) {
      res.write(csvRow([
        log.id, log.user?.id, log.user?.username, log.action, log.resource_type,
        log.resource_id, log.resource_name, log.details, log.ip_address, log.created_at,
      ]) + '\n');
    }

    res.end();
  }, { operation: 'auditLogExport' }),
);

export default router;
