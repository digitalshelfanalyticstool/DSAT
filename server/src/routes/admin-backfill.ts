/**
 * Admin Backfill Routes — maintenance and bulk re-scraping operations.
 *
 * Mounted at /api/admin/backfill by the parent admin router.
 *
 * Image URL Backfill:
 *   - POST /image-urls                — dry-run cost estimate or confirm backfill job
 */

import { Router } from 'express';
import { runBackfillImageUrls } from '../jobs/backfill-image-urls';
import { createJob } from '../services/job-lifecycle';
import { DatabaseService } from '../services/database';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { asyncHandler } from '../utils/async-handler';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('admin-backfill-routes');
const router = Router();

/**
 * POST /api/admin/backfill/image-urls
 * Dry-run estimate (default) or confirm backfill of product image URLs.
 * Body: { confirm?: boolean }
 *
 * Without confirm or with confirm=false: returns estimated bandwidth cost (200).
 * With confirm=true: enqueues scrape jobs and returns enqueued count (202).
 */
router.post('/image-urls', asyncHandler(async (req: AuthenticatedRequest, res) => {
    const confirm = req.body?.confirm === true;

    // Each pair becomes an ordinary job owned by the requesting admin. A pair
    // whose site or brand is no longer enabled is rejected and skipped.
    const enqueueScrapeJob = async (params: { retailer: string; brand: string; reason: string }): Promise<void> => {
      // An admin's explicit bulk re-scrape; the per-user active-job limit would cut it short.
      await createJob({ site: params.retailer, brand: params.brand, userId: String(req.user!.id), bypassActiveLimit: true });
    };

    const db = await DatabaseService.getInstance();

    const result = await runBackfillImageUrls({
      db,
      enqueueScrape: enqueueScrapeJob,
      maxProducts: config.scraping.backfillMaxProducts,
      dryRun: !confirm,
    });

    logger.info('Backfill image-URLs request processed', {
      operation: 'backfillImageUrls',
      adminId: req.user!.id,
      dryRun: !confirm,
      pairCount: result.pairs.length,
      enqueued: result.enqueued,
      estimatedBytes: result.estimatedBytes,
    });

    res.status(confirm ? 202 : 200).json({
      success: true,
      dryRun: !confirm,
      pairCount: result.pairs.length,
      enqueued: result.enqueued,
      estimatedBytes: result.estimatedBytes,
    });
  }, { operation: 'backfillImageUrls', message: 'Backfill failed' }),
);

export default router;
