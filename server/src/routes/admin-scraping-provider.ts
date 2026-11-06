/**
 * Admin scraping-provider settings.
 *
 *   GET  /api/admin/scraping-provider       → active provider, secrets masked
 *   PUT  /api/admin/scraping-provider       → save (encrypted) and apply
 *   POST /api/admin/scraping-provider/test  → try the submitted settings, save nothing
 *
 * Mounted by admin.ts, so every route inherits authMiddleware + requireRole('admin').
 * Secrets never leave the server: GET masks them, and a PUT/test that sends a
 * masked or blank secret back keeps the stored value.
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';
import { asyncHandler, httpError } from '../utils/async-handler';
import { createLogger } from '../utils/logger';
import { DatabaseService } from '../services/database';
import { loadStoredProvider, saveProviderSettings } from '../services/scraping-provider-settings';
import { providerCatalog, providerFor, providerModules } from '../providers';
import type { ProviderSettings } from '../scrapers/scraping-provider';
import { getAuditContext } from './audit-context';

const router = Router();
const logger = createLogger('admin-scraping-provider-routes');

const [first, ...rest] = providerModules.map((m) => z.object({ provider: z.literal(m.kind), fields: m.schema }));
const bodySchema = z.discriminatedUnion('provider', [first, ...rest]);
const schemas = { body: bodySchema };
type Body = z.infer<typeof bodySchema>;

const mergeSubmitted = (body: Body, stored: ProviderSettings): ProviderSettings => providerFor(body.provider).merge(body.fields, stored);

/** The response every read and write returns: secrets masked, plus what the form needs to draw itself. */
function view(settings: ProviderSettings, source: 'db' | 'env') {
  const mod = providerFor(settings);
  return {
    success: true,
    provider: settings.kind,
    source,
    fields: mod.display(settings),
    bills_bandwidth: mod.billsBandwidth,
    catalog: providerCatalog(),
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  const { settings, source } = await loadStoredProvider(await DatabaseService.getInstance());
  res.json(view(settings, source));
}, { operation: 'getScrapingProvider' }));

router.put('/', validate(schemas), asyncHandler(async (req: ValidatedRequest<typeof schemas, AuthenticatedRequest>, res) => {
  const { db, audit, ctx } = await getAuditContext(req);
  const settings = mergeSubmitted(req.body, (await loadStoredProvider(db)).settings);

  await saveProviderSettings(db, settings, req.user!.id).catch((err: unknown) => {
    // The only caller-fixable failure: the encryption key is missing or malformed.
    if (err instanceof Error && err.message.includes('EMAIL_CONFIG_ENCRYPTION_KEY')) {
      throw httpError(err, 400, 'configuration_error');
    }
    throw err;
  });

  await audit.log({
    userId: req.user!.id,
    action: 'update_scraping_provider',
    resourceType: 'scraping_provider_settings',
    resourceId: '1',
    details: JSON.stringify({ provider: settings.kind }),
    ...ctx,
  });
  logger.info('Scraping provider updated', { operation: 'updateScrapingProvider', adminId: req.user!.id, provider: settings.kind });

  res.json(view(settings, 'db'));
}, { operation: 'updateScrapingProvider' }));

router.post('/test', validate(schemas), asyncHandler(async (req: ValidatedRequest<typeof schemas>, res) => {
  const stored = (await loadStoredProvider(await DatabaseService.getInstance())).settings;
  const settings = mergeSubmitted(req.body, stored);
  res.json(await providerFor(settings).test(settings));
}, { operation: 'testScrapingProvider' }));

export default router;
