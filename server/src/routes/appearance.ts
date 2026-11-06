/**
 * Site colour palette.
 *
 *   GET /api/settings/appearance  → { palette }, public: the login and setup pages need it before sign-in
 *   PUT /api/admin/appearance     → save; mounted by admin.ts after requireRole('admin')
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { DatabaseService } from '../services/database';
import { PALETTE_IDS, getPalette, setPalette } from '../services/appearance';
import { getAuditContext } from './audit-context';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ success: true, palette: await getPalette(await DatabaseService.getInstance()) });
}, { operation: 'getAppearance' }));

export const adminAppearanceRouter = Router();

const schemas = { body: z.object({ palette: z.enum(PALETTE_IDS) }) };

adminAppearanceRouter.put('/', validate(schemas), asyncHandler(async (req: ValidatedRequest<typeof schemas, AuthenticatedRequest>, res) => {
  const { db, audit, ctx } = await getAuditContext(req);
  const { palette } = req.body;
  await setPalette(db, palette, req.user!.id);
  await audit.log({
    userId: req.user!.id,
    action: 'update_appearance',
    resourceType: 'app_settings',
    resourceId: 'palette',
    details: JSON.stringify({ palette }),
    ...ctx,
  });
  res.json({ success: true, palette });
}, { operation: 'updateAppearance' }));

export default router;
