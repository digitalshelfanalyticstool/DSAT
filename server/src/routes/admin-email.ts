/**
 * Admin Email Routes — email settings, templates, and test sends.
 *
 * Mounted at /api/admin/email by the parent admin router.
 * All routes inherit authMiddleware + requireRole('admin').
 *
 * Endpoints:
 *   - GET  /settings                — get current email settings
 *   - PUT  /settings                — update email settings
 *   - POST /test                    — send a test email (rate-limited 5/min/user)
 *   - GET  /templates               — list all email templates
 *   - GET  /templates/:slug         — get a single template
 *   - PUT  /templates/:slug         — update a template
 *   - GET  /log                     — list email send log
 */

import { Router } from 'express';
import { z } from 'zod';
import { getEmailService } from '../services/email/email-service';
import { DatabaseService } from '../services/database';
import { getAuditContext } from './audit-context';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { validate, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('admin-email-routes');
const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Schemas
// ═══════════════════════════════════════════════════════════════════════════════

const settingsBodySchema = z
  .object({
    provider: z.enum(['disabled', 'smtp']),
    from_address: z.string().email().optional().nullable(),
    from_name: z.string().optional().nullable(),
    is_enabled: z.boolean().optional(),
    smtp_credentials: z
      .object({
        host: z.string(),
        port: z.number().int().positive(),
        secure: z.boolean(),
        user: z.string().optional(),
        password: z.string().optional(),
        requireTls: z.boolean().optional(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();
const settingsSchemas = { body: settingsBodySchema };

const testSendSchema = z.object({ to: z.string().email() });
const testSendSchemas = { body: testSendSchema };

const templateUpdateSchema = z
  .object({
    subject: z.string().min(1),
    body_html: z.string().min(1),
    body_text: z.string().min(1),
    variables: z.array(z.string()),
  })
  .passthrough();
const templateUpdateSchemas = { body: templateUpdateSchema };

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Rate limiter: Map<userId, Array<timestamp>>. Max 5 successful test sends per minute. */
const rateLimitMap = new Map<number, number[]>();

/** Check if user has exceeded rate limit (5/min). If OK, add timestamp and return true. */
function checkAndUpdateRateLimit(userId: number, allowAdd: boolean): boolean {
  const now = Date.now();
  const windowStart = now - 60_000; // 60 seconds ago

  let timestamps = rateLimitMap.get(userId) ?? [];
  // Prune old timestamps outside the window
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length >= 5) {
    // Rate limit exceeded
    rateLimitMap.set(userId, timestamps);
    return false;
  }

  // Add new timestamp only if request succeeded (allowAdd = true)
  if (allowAdd) {
    timestamps.push(now);
  }
  rateLimitMap.set(userId, timestamps);
  return true;
}
// ═══════════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/email/settings
 * Fetch current email settings without encrypted credentials.
 */
router.get('/settings', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const emailService = await getEmailService();
  const settings = await emailService.getSettingsForDisplay();

  // Verify no encrypted_credentials in response
  const settingsObj = structuredClone(settings);
  if ('encrypted_credentials' in settingsObj) {
    logger.warn('getSettingsForDisplay leaked encrypted_credentials', {
      operation: 'getSettings',
    });
  }

  res.json({ success: true, settings });
}, { operation: 'getSettings' }));

/**
 * PUT /api/admin/email/settings
 * Update email settings and audit-log the change.
 * Body: { provider, from_address?, from_name?, smtp_credentials?, is_enabled? }
 */
router.put(
  '/settings',
  validate(settingsSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof settingsSchemas, AuthenticatedRequest>, res) => {
    const emailService = await getEmailService();
    const { audit, ctx } = await getAuditContext(req);
    const adminId = req.user!.id;

    // Update settings
    await emailService.updateSettings({
      provider: req.body.provider,
      from_address: req.body.from_address ?? null,
      from_name: req.body.from_name ?? null,
      smtp_credentials: req.body.smtp_credentials ?? null,
      is_enabled: req.body.is_enabled ?? undefined,
      updated_by: adminId,
    });

    // Audit log — record provider and enabled state, but NOT the credentials
    await audit.log({
      userId: adminId,
      action: 'update_email_settings',
      resourceType: 'email_settings',
      resourceId: '1',
      details: JSON.stringify({
        provider: req.body.provider,
        is_enabled: req.body.is_enabled,
      }),
      ...ctx,
    });

    logger.info('Email settings updated', {
      operation: 'updateSettings',
      adminId,
      provider: req.body.provider,
    });

    // Return fresh settings
    const settings = await emailService.getSettingsForDisplay();
    res.json({ success: true, settings });
  }, { operation: 'updateSettings' }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Test Send
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/email/test
 * Send a test email to the specified address.
 * Rate-limited to 5 successful sends per minute per user.
 * Body: { to: string (valid email) }
 */
router.post(
  '/test',
  validate(testSendSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof testSendSchemas, AuthenticatedRequest>, res) => {
    const emailService = await getEmailService();
    const { audit, ctx } = await getAuditContext(req);
    const adminId = req.user!.id;
    const to = req.body.to;

    // Send test email first to see if it succeeds
    const result = await emailService.testSend(to);

    // Check rate limit and update only on success
    const successfullySent = result.status === 'sent';
    if (!checkAndUpdateRateLimit(adminId, successfullySent)) {
      res.status(429).json(
        errorResponse('Rate limit: max 5 test sends per minute', 'rate_limit'),
      );
      return;
    }

    // Audit log the test send
    await audit.log({
      userId: adminId,
      action: 'test_send_email',
      resourceType: 'test_send',
      resourceId: to,
      details: JSON.stringify({ status: result.status }),
      ...ctx,
    });

    logger.info('Test email sent', {
      operation: 'testSend',
      adminId,
      to,
      status: result.status,
    });

    res.json({ success: true, result });
  }, { operation: 'testSend' }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/email/templates
 * List all email templates.
 */
router.get('/templates', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  const templates = await db.all<{
    slug: string;
    subject: string;
    body_html: string;
    body_text: string;
    variables: string[];
    updated_at: Date;
    updated_by: number | null;
  }>(
    `SELECT slug, subject, body_html, body_text, variables, updated_at, updated_by
       FROM email_templates
       ORDER BY slug`,
  );

  const result = templates.map((t) => ({
    ...t,
    updated_at: t.updated_at instanceof Date ? t.updated_at.toISOString() : String(t.updated_at),
  }));

  res.json({ success: true, templates: result });
}, { operation: 'listTemplates' }));

/**
 * GET /api/admin/email/templates/:slug
 * Get a single email template by slug.
 */
router.get('/templates/:slug', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  const slug = String(req.params.slug);

  const template = await db.get<{
    slug: string;
    subject: string;
    body_html: string;
    body_text: string;
    variables: string[];
    updated_at: Date;
    updated_by: number | null;
  }>(
    `SELECT slug, subject, body_html, body_text, variables, updated_at, updated_by
       FROM email_templates
       WHERE slug = $1`,
    slug,
  );

  if (!template) {
    res.status(404).json(errorResponse('Template not found', 'not_found'));
    return;
  }

  const result = {
    ...template,
    updated_at: template.updated_at instanceof Date ? template.updated_at.toISOString() : String(template.updated_at),
  };

  res.json({ success: true, template: result });
}, { operation: 'getTemplate' }));

/**
 * PUT /api/admin/email/templates/:slug
 * Update an email template.
 * Body: { subject, body_html, body_text, variables }
 */
router.put(
  '/templates/:slug',
  validate(templateUpdateSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof templateUpdateSchemas, AuthenticatedRequest>, res) => {
    const db = await DatabaseService.getInstance();
    const { audit, ctx } = await getAuditContext(req);
    const adminId = req.user!.id;
    const slug = String(req.params.slug);
    const { subject, body_html, body_text, variables } = req.body;

    // Update template
    await db.run(
      `UPDATE email_templates
         SET subject = $1, body_html = $2, body_text = $3, variables = $4,
             updated_by = $5, updated_at = NOW()
       WHERE slug = $6`,
      subject,
      body_html,
      body_text,
      JSON.stringify(variables),
      adminId,
      slug,
    );

    // Audit log
    await audit.log({
      userId: adminId,
      action: 'update_email_template',
      resourceType: 'email_template',
      resourceId: slug,
      details: JSON.stringify({
        subject,
        num_variables: variables.length,
      }),
      ...ctx,
    });

    logger.info('Email template updated', {
      operation: 'updateTemplate',
      adminId,
      slug,
    });

    // Return updated template
    const template = await db.get<{
      slug: string;
      subject: string;
      body_html: string;
      body_text: string;
      variables: string[];
      updated_at: Date;
      updated_by: number | null;
    }>(
      `SELECT slug, subject, body_html, body_text, variables, updated_at, updated_by
         FROM email_templates
         WHERE slug = $1`,
      slug,
    );

    if (!template) {
      res.status(404).json(errorResponse('Template not found', 'not_found'));
      return;
    }

    const result = {
      ...template,
      updated_at: template.updated_at instanceof Date ? template.updated_at.toISOString() : String(template.updated_at),
    };

    res.json({ success: true, template: result });
  }, { operation: 'updateTemplate' }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Email Log
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/email/log
 * List recent email send log entries.
 * Query params: limit (default 100, max 500), status (sent|failed|skipped)
 */
router.get('/log', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const emailService = await getEmailService();

  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const status = req.query.status ? String(req.query.status) : undefined;

  const log = await emailService.listLog({
    limit: Math.min(Math.max(limit, 1), 500),
    status: status as 'sent' | 'failed' | 'skipped' | undefined,
  });

  res.json({ success: true, log });
}, { operation: 'listLog' }));

export default router;
