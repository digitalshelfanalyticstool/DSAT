/**
 * Admin single sign-on (OIDC) settings.
 *
 *   GET  /api/admin/sso       → settings, client secret masked, plus the redirect URI
 *   PUT  /api/admin/sso       → save
 *   POST /api/admin/sso/test  → check the issuer's discovery document, save nothing
 *
 * Mounted by admin.ts after requireRole('admin'). The client secret never
 * leaves the server: GET masks it, and a masked or blank secret sent back
 * keeps the stored one.
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';
import { asyncHandler, httpError } from '../utils/async-handler';
import { DatabaseService } from '../services/database';
import { maskToken } from '../services/credential-manager';
import { discoverIssuer, loadSsoSettings, saveSsoSettings, ssoRedirectUri, type SsoSettings } from '../services/sso-settings';
import { getAuditContext } from './audit-context';

const router = Router();

const bodySchema = z.object({
  fields: z.object({
    enabled: z.boolean(),
    issuerUrl: z.string().regex(/^(https:\/\/\S+|http:\/\/localhost(:\d+)?(\/\S*)?)$/, 'Issuer URL must start with https://'),
    clientId: z.string().trim().min(1, 'Client ID is required'),
    clientSecret: z.string().optional(),
    allowedEmailDomains: z.array(
      z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Allowed domains must look like example.com'),
    ),
    buttonLabel: z.string().trim().max(40, 'Button label must be 40 characters or fewer').optional(),
  }),
});
const schemas = { body: bodySchema };

function displayFields(s: SsoSettings | null) {
  return {
    enabled: s?.enabled ?? false,
    issuerUrl: s?.issuerUrl ?? '',
    clientId: s?.clientId ?? '',
    clientSecret: s ? maskToken(s.clientSecret) : '',
    allowedEmailDomains: s?.allowedEmailDomains ?? [],
    buttonLabel: s?.buttonLabel ?? '',
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  const s = await loadSsoSettings(await DatabaseService.getInstance());
  res.json({ success: true, configured: s !== null, redirectUri: ssoRedirectUri(), fields: displayFields(s) });
}, { operation: 'getSsoSettings' }));

router.put('/', validate(schemas), asyncHandler(async (req: ValidatedRequest<typeof schemas, AuthenticatedRequest>, res) => {
  const { db, audit, ctx } = await getAuditContext(req);
  const stored = await loadSsoSettings(db);
  const f = req.body.fields;
  const sent = f.clientSecret ?? '';
  const keepsStored = !sent || (stored && sent === maskToken(stored.clientSecret));
  // The stored secret only ever goes to the issuer and client it was entered for, so a
  // changed issuer or client ID cannot be pointed at it without the admin knowing it.
  const sameClient = stored?.issuerUrl === f.issuerUrl && stored?.clientId === f.clientId;
  if (keepsStored && stored && !sameClient) {
    throw httpError(new Error('Enter the client secret again when the issuer URL or client ID changes'), 400, 'validation_error');
  }
  const clientSecret = keepsStored ? stored?.clientSecret : sent;
  if (!clientSecret) throw httpError(new Error('Client secret is required'), 400, 'validation_error');

  const settings: SsoSettings = {
    enabled: f.enabled,
    issuerUrl: f.issuerUrl,
    clientId: f.clientId,
    clientSecret,
    allowedEmailDomains: f.allowedEmailDomains,
    ...(f.buttonLabel ? { buttonLabel: f.buttonLabel } : {}),
  };
  await saveSsoSettings(db, settings, req.user!.id);
  await audit.log({
    userId: req.user!.id,
    action: 'update_sso_settings',
    resourceType: 'sso_settings',
    resourceId: '1',
    details: JSON.stringify({ enabled: settings.enabled, issuerUrl: settings.issuerUrl }),
    ...ctx,
  });
  res.json({ success: true, configured: true, redirectUri: ssoRedirectUri(), fields: displayFields(settings) });
}, { operation: 'updateSsoSettings' }));

router.post('/test', validate(schemas), asyncHandler(async (req: ValidatedRequest<typeof schemas>, res) => {
  const r = await discoverIssuer(req.body.fields.issuerUrl);
  res.json(r.ok
    ? { success: true, message: 'The issuer is reachable and supports sign-in.' }
    : { success: false, message: r.message });
}, { operation: 'testSsoSettings' }));

export default router;
