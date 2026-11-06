/**
 * Admin Hub Router — applies auth middleware and delegates to sub-routers.
 *
 * All admin routes require authentication + admin role, enforced here.
 *
 * Sub-routers:
 *   - admin-users.ts       → /api/admin/users
 *   - admin-audit.ts       → /api/admin/audit-logs
 *   - admin-settings.ts    → /api/admin/disk-space
 *   - admin-brightdata.ts  → /api/admin/brightdata
 *   - admin-messages.ts    → /api/admin/messages
 *   - admin-analytics.ts   → /api/admin/analytics
 *   - admin-dlq.ts         → /api/admin/dlq
 *   - admin-health.ts      → /api/admin/health
 *   - admin-backfill.ts    → /api/admin/backfill
 *   - admin-email.ts       → /api/admin/email
 *   - admin-scraping-provider.ts → /api/admin/scraping-provider
 *   - admin-sso.ts → /api/admin/sso
 *   - appearance.ts (adminAppearanceRouter) → /api/admin/appearance
 */

import { Router } from 'express';
import { authMiddleware, requireRole } from '../middleware/auth';
import adminUsersRouter from './admin-users';
import adminAuditRouter from './admin-audit';
import adminSettingsRouter from './admin-settings';
import brightdataRouter from './admin-brightdata';
import messagesRouter from './admin-messages';
import { adminAnalyticsRouter } from './admin-analytics';
import dlqRouter from './admin-dlq';
import adminHealthRouter, { adminHealthStreamRouter } from './admin-health';
import backfillRouter from './admin-backfill';
import adminEmailRouter from './admin-email';
import scrapingProviderRouter from './admin-scraping-provider';
import ssoRouter from './admin-sso';
import { adminAppearanceRouter } from './appearance';
import adminReportsRouter from './admin-reports';

const router = Router();

// Mounted BEFORE the blanket authMiddleware below, and gated route-by-route
// with sseAuthMiddleware instead: an SSE ticket must authenticate exactly
// the health stream, never the rest of /api/admin. See admin-health.ts.
router.use('/health', adminHealthStreamRouter);

// All other admin routes require authentication + admin role
router.use(authMiddleware);
router.use(requireRole('admin'));

// Sub-routers
router.use('/users', adminUsersRouter);
router.use('/audit-logs', adminAuditRouter);
router.use(adminSettingsRouter);          // mounts /disk-space at root
router.use('/brightdata', brightdataRouter);
router.use('/messages', messagesRouter);
router.use('/analytics', adminAnalyticsRouter);
router.use('/dlq', dlqRouter);
router.use('/health', adminHealthRouter);
router.use('/backfill', backfillRouter);
router.use('/email', adminEmailRouter);
router.use('/scraping-provider', scrapingProviderRouter);
router.use('/sso', ssoRouter);
router.use('/appearance', adminAppearanceRouter);
router.use('/reports', adminReportsRouter);

export default router;
