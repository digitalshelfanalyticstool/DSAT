/**
 * Scrape Run API Routes — endpoint for scrape run summary by job ID.
 *
 * All routes require authentication via Bearer token.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { getProductQueryService } from '../services/product-query-service';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';

const router = Router();

// --- Validation Schemas ---

const jobIdParamsSchema = z.object({
  jobId: z.guid(),
});
const jobSummarySchemas = { params: jobIdParamsSchema };

// --- Routes ---

/**
 * GET /api/scrape-runs/:jobId/summary
 * Summary metrics for a scrape run identified by its job_id.
 */
router.get(
  '/:jobId/summary',
  authMiddleware,
  validate(jobSummarySchemas),
  asyncHandler(async (req: ValidatedRequest<typeof jobSummarySchemas>, res) => {
    const { jobId } = req.params;

    const service = await getProductQueryService();
    const summary = await service.getScrapeRunSummary(jobId);

    if (!summary) {
      res.status(404).json(errorResponse(`No scrape run found for job "${jobId}"`, 'not_found'));
      return;
    }

    res.json({ success: true, summary });
  }, { operation: 'getScrapeRunSummary', message: 'Failed to fetch scrape run summary' }),
);

export default router;
