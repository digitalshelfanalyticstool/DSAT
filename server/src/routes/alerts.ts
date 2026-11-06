/**
 * Alerts API.
 *
 *   GET  /api/alerts                 — alerts, newest first; filter by kind, site, brand, unread
 *   GET  /api/alerts/unread-count    — for the nav badge
 *   POST /api/alerts/read            — mark read: { ids } or { filter }
 *
 * Admin only:
 *   GET|POST /api/alerts/rules, PUT|DELETE /api/alerts/rules/:id
 *   GET|POST /api/alerts/webhooks, PUT|DELETE /api/alerts/webhooks/:id, POST /api/alerts/webhooks/:id/test
 *
 * Single-tenant: every signed-in user sees and reads the same alerts.
 * Webhook secrets are stored encrypted and never returned.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../middleware/auth';
import { validate, idParams, type ValidatedRequest } from '../middleware/validate';
import { DatabaseService } from '../services/database';
import { encrypt } from '../services/secrets';
import { buildPayload, deliver } from '../services/alerts/webhooks';
import { asyncHandler, httpError } from '../utils/async-handler';

const router = Router();
router.use(authMiddleware);
const adminOnly = requireRole('admin');

const KINDS = ['price_below', 'price_drop', 'out_of_stock', 'broken_image'] as const;
const TARGETS = ['all', 'brand', 'site', 'product'] as const;

// ─── Alerts ──────────────────────────────────────────────────────

const filterSchema = z.object({
  kind: z.enum(KINDS).optional(),
  site: z.string().min(1).optional(),
  brand: z.string().min(1).optional(),
  unread: z.enum(['true', 'false']).optional(),
});
type AlertFilter = z.infer<typeof filterSchema>;

/** WHERE clause for a filter; pushes values onto params. */
function whereFor(filter: AlertFilter, params: unknown[]): string {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (filter.kind) add('a.kind = ?', filter.kind);
  if (filter.site) add('LOWER(a.retailer) = LOWER(?)', filter.site);
  if (filter.brand) add('LOWER(a.brand) = LOWER(?)', filter.brand);
  if (filter.unread === 'true') clauses.push('a.read_at IS NULL');
  if (filter.unread === 'false') clauses.push('a.read_at IS NOT NULL');
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

const listSchemas = {
  query: filterSchema.extend({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
};

router.get('/', validate(listSchemas), asyncHandler(async (req: ValidatedRequest<typeof listSchemas>, res) => {
  const { page, limit, ...filter } = req.query;
  const db = await DatabaseService.getInstance();
  const params: unknown[] = [];
  const where = whereFor(filter, params);
  const total = await db.get<{ n: string }>(`SELECT COUNT(*) AS n FROM alerts a ${where}`, ...params);
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.rule_id, a.rule_name, a.kind, a.product_id, a.retailer, a.brand, a.details, a.read_at, a.created_at,
            p.title AS product_title, p.url AS product_url, p.style_id
     FROM alerts a JOIN products p ON p.id = a.product_id
     ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    ...params, limit, (page - 1) * limit,
  );
  res.json({
    success: true,
    total: Number(total?.n ?? 0),
    alerts: rows.map((r) => ({ ...r, id: Number(r.id), read: r.read_at !== null })),
  });
}, { operation: 'listAlerts' }));

router.get('/unread-count', asyncHandler(async (_req, res) => {
  const db = await DatabaseService.getInstance();
  const row = await db.get<{ n: string }>('SELECT COUNT(*) AS n FROM alerts WHERE read_at IS NULL');
  res.json({ success: true, count: Number(row?.n ?? 0) });
}, { operation: 'unreadAlertCount' }));

const readSchemas = {
  body: z.union([
    z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000) }),
    z.object({ filter: filterSchema.omit({ unread: true }) }),
  ]),
};

router.post('/read', validate(readSchemas), asyncHandler(async (req: ValidatedRequest<typeof readSchemas>, res) => {
  const db = await DatabaseService.getInstance();
  let result;
  if ('ids' in req.body) {
    result = await db.run('UPDATE alerts SET read_at = NOW() WHERE read_at IS NULL AND id = ANY($1)', req.body.ids);
  } else {
    const params: unknown[] = [];
    const where = whereFor({ ...req.body.filter, unread: 'true' }, params);
    result = await db.run(`UPDATE alerts a SET read_at = NOW() ${where}`, ...params);
  }
  res.json({ success: true, updated: result.changes });
}, { operation: 'markAlertsRead' }));

// ─── Rules (admin) ───────────────────────────────────────────────

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  kind: z.enum(KINDS),
  target_type: z.enum(TARGETS),
  target_site: z.string().trim().min(1).nullish(),
  target_brand: z.string().trim().min(1).nullish(),
  target_style_id: z.string().trim().min(1).nullish(),
  threshold: z.number().positive().nullish(),
  percent: z.number().positive().max(100).nullish(),
}).superRefine((r, ctx) => {
  const need = (ok: unknown, path: string, message: string) => { if (!ok) ctx.addIssue({ code: 'custom', path: [path], message }); };
  if (r.kind === 'price_below') need(r.threshold, 'threshold', 'A price floor is required');
  if (r.target_type === 'site' || r.target_type === 'product') need(r.target_site, 'target_site', 'Pick a retailer');
  if (r.target_type === 'brand') need(r.target_brand, 'target_brand', 'Pick a brand');
  if (r.target_type === 'product') need(r.target_style_id, 'target_style_id', 'Enter the style ID');
});
type RuleInput = z.infer<typeof ruleSchema>;

const ruleBodySchemas = { body: ruleSchema };
const ruleUpdateSchemas = { params: idParams, body: ruleSchema };
const idSchemas = { params: idParams };

const RULE_COLUMNS = 'id, name, enabled, kind, target_type, target_site, target_brand, target_style_id, threshold, percent, created_at, updated_at';

function ruleOut(r: Record<string, unknown>) {
  return { ...r, threshold: r.threshold === null ? null : Number(r.threshold), percent: r.percent === null ? null : Number(r.percent) };
}

/** Only the target fields the target type uses are kept, so a retargeted rule doesn't carry stale ones. */
function ruleValues(r: RuleInput): unknown[] {
  const t = r.target_type;
  return [
    r.name, r.enabled, r.kind, t,
    t === 'site' || t === 'product' ? r.target_site : null,
    t === 'brand' ? r.target_brand : null,
    t === 'product' ? r.target_style_id : null,
    r.kind === 'price_below' ? r.threshold : null,
    r.kind === 'price_drop' ? (r.percent ?? null) : null,
  ];
}

router.get('/rules', adminOnly, asyncHandler(async (_req, res) => {
  const db = await DatabaseService.getInstance();
  const rows = await db.all<Record<string, unknown>>(`SELECT ${RULE_COLUMNS} FROM alert_rules ORDER BY id`);
  res.json({ success: true, rules: rows.map(ruleOut) });
}, { operation: 'listAlertRules' }));

router.post('/rules', adminOnly, validate(ruleBodySchemas), asyncHandler(async (req: ValidatedRequest<typeof ruleBodySchemas>, res) => {
  const db = await DatabaseService.getInstance();
  const row = await db.get<Record<string, unknown>>(
    `INSERT INTO alert_rules (name, enabled, kind, target_type, target_site, target_brand, target_style_id, threshold, percent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${RULE_COLUMNS}`,
    ...ruleValues(req.body),
  );
  res.status(201).json({ success: true, rule: ruleOut(row!) });
}, { operation: 'createAlertRule' }));

router.put('/rules/:id', adminOnly, validate(ruleUpdateSchemas), asyncHandler(async (req: ValidatedRequest<typeof ruleUpdateSchemas>, res) => {
  const db = await DatabaseService.getInstance();
  const row = await db.get<Record<string, unknown>>(
    `UPDATE alert_rules SET name = $1, enabled = $2, kind = $3, target_type = $4, target_site = $5, target_brand = $6,
       target_style_id = $7, threshold = $8, percent = $9, updated_at = NOW()
     WHERE id = $10 RETURNING ${RULE_COLUMNS}`,
    ...ruleValues(req.body), req.params.id,
  );
  if (!row) throw httpError(new Error('Rule not found'), 404, 'not_found');
  // A changed rule starts fresh: products currently in its old condition shouldn't stay muted.
  await db.run('DELETE FROM alert_state WHERE rule_id = $1', req.params.id);
  res.json({ success: true, rule: ruleOut(row) });
}, { operation: 'updateAlertRule' }));

router.delete('/rules/:id', adminOnly, validate(idSchemas), asyncHandler(async (req: ValidatedRequest<typeof idSchemas>, res) => {
  const db = await DatabaseService.getInstance();
  const result = await db.run('DELETE FROM alert_rules WHERE id = $1', req.params.id);
  if (result.changes === 0) throw httpError(new Error('Rule not found'), 404, 'not_found');
  res.json({ success: true });
}, { operation: 'deleteAlertRule' }));

// ─── Webhooks (admin) ────────────────────────────────────────────

const webhookUrl = z.string().url().refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), 'URL must be http or https');
const webhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: webhookUrl,
  enabled: z.boolean().default(true),
  /** Omitted: keep the stored secret. null or '': remove it. */
  secret: z.string().max(500).nullish(),
});
const webhookBodySchemas = { body: webhookSchema };
const webhookUpdateSchemas = { params: idParams, body: webhookSchema };

const WEBHOOK_COLUMNS = `id, name, url, enabled, secret_encrypted IS NOT NULL AS has_secret,
  last_status, last_error, last_attempt_at, created_at`;

router.get('/webhooks', adminOnly, asyncHandler(async (_req, res) => {
  const db = await DatabaseService.getInstance();
  res.json({ success: true, webhooks: await db.all(`SELECT ${WEBHOOK_COLUMNS} FROM alert_webhooks ORDER BY id`) });
}, { operation: 'listAlertWebhooks' }));

router.post('/webhooks', adminOnly, validate(webhookBodySchemas), asyncHandler(async (req: ValidatedRequest<typeof webhookBodySchemas>, res) => {
  const { name, url, enabled, secret } = req.body;
  const db = await DatabaseService.getInstance();
  const row = await db.get(
    `INSERT INTO alert_webhooks (name, url, enabled, secret_encrypted) VALUES ($1, $2, $3, $4) RETURNING ${WEBHOOK_COLUMNS}`,
    name, url, enabled, secret ? JSON.stringify(encrypt(secret)) : null,
  );
  res.status(201).json({ success: true, webhook: row });
}, { operation: 'createAlertWebhook' }));

router.put('/webhooks/:id', adminOnly, validate(webhookUpdateSchemas), asyncHandler(async (req: ValidatedRequest<typeof webhookUpdateSchemas>, res) => {
  const { name, url, enabled, secret } = req.body;
  const db = await DatabaseService.getInstance();
  const keepSecret = secret === undefined;
  const row = await db.get(
    `UPDATE alert_webhooks SET name = $1, url = $2, enabled = $3,
       secret_encrypted = CASE WHEN $4 THEN secret_encrypted ELSE $5::jsonb END
     WHERE id = $6 RETURNING ${WEBHOOK_COLUMNS}`,
    name, url, enabled, keepSecret, secret ? JSON.stringify(encrypt(secret)) : null, req.params.id,
  );
  if (!row) throw httpError(new Error('Webhook not found'), 404, 'not_found');
  res.json({ success: true, webhook: row });
}, { operation: 'updateAlertWebhook' }));

router.delete('/webhooks/:id', adminOnly, validate(idSchemas), asyncHandler(async (req: ValidatedRequest<typeof idSchemas>, res) => {
  const db = await DatabaseService.getInstance();
  const result = await db.run('DELETE FROM alert_webhooks WHERE id = $1', req.params.id);
  if (result.changes === 0) throw httpError(new Error('Webhook not found'), 404, 'not_found');
  res.json({ success: true });
}, { operation: 'deleteAlertWebhook' }));

const SAMPLE_ALERT = {
  id: 0, kind: 'price_drop' as const, rule_name: 'Test alert', retailer: 'example', brand: 'Example Brand',
  product: { id: 0, title: 'Sample product', style_id: 'SAMPLE', url: 'https://example.com/products/sample' },
  details: { old_price: 60, new_price: 48 },
};

router.post('/webhooks/:id/test', adminOnly, validate(idSchemas), asyncHandler(async (req: Request & ValidatedRequest<typeof idSchemas>, res) => {
  const db = await DatabaseService.getInstance();
  const exists = await db.get('SELECT 1 FROM alert_webhooks WHERE id = $1', req.params.id);
  if (!exists) throw httpError(new Error('Webhook not found'), 404, 'not_found');
  const body = JSON.stringify(buildPayload([{ ...SAMPLE_ALERT, created_at: new Date().toISOString() }]));
  try {
    const status = await deliver(db, req.params.id, body);
    res.json({ success: true, status, error: null });
  } catch (err) {
    const row = await db.get<{ last_status: number | null }>('SELECT last_status FROM alert_webhooks WHERE id = $1', req.params.id);
    res.json({ success: false, status: row?.last_status ?? null, error: err instanceof Error ? err.message : String(err) });
  }
}, { operation: 'testAlertWebhook' }));

export default router;
