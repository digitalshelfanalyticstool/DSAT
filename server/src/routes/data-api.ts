/**
 * Data API Routes — read-only endpoints for external systems to pull
 * structured product, variant, and scrape run data.
 *
 * All routes require authentication (JWT).
 *
 *   GET /api/data/products                    — paginated product list
 *   GET /api/data/products/:retailer/:styleId — single product + snapshot history
 *   GET /api/data/variants                    — paginated variant snapshots
 *   GET /api/data/scrape-runs                 — paginated scrape run summaries
 *   GET /api/data/price-changes               — price change events
 */

import { Router } from 'express';
import { z } from 'zod';
import { getProductQueryService } from '../services/product-query-service';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { getCachedOrFetch } from '../services/redis-cache';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { dataApiPaginationSchema } from '../utils/schemas';

const router = Router();

const MAX_OFFSET = 10_000;

function validateOffset(offset: number, res: import('express').Response): boolean {
  if (offset > MAX_OFFSET) {
    res.status(400).json(errorResponse(
      `Offset exceeds maximum (${MAX_OFFSET}). Use cursor-based pagination for deep pages.`,
      'validation_error',
    ));
    return false;
  }
  return true;
}

// Validation schemas for each data-api route
const listProductsSchema = dataApiPaginationSchema.extend({
  retailer: z.string().optional(),
  last_seen_after: z.string().optional(),
  search: z.string().optional(),
});

const productDetailSchema = z.object({
  retailer: z.string(),
  styleId: z.string(),
});

const productDetailQuerySchema = z.object({
  snapshot_limit: z.coerce.number().int().min(1).max(500).default(50),
  snapshot_offset: z.coerce.number().int().min(0).default(0),
});

const listVariantsSchema = dataApiPaginationSchema.extend({
  retailer: z.string().optional(),
  scrape_run_id: z.coerce.number().int().optional(),
  color: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

const listScrapeRunsSchema = dataApiPaginationSchema.extend({
  site: z.string().optional(),
  brand: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

const listPriceChangesSchema = dataApiPaginationSchema.extend({
  retailer: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

/**
 * @openapi
 * /data/products:
 *   get:
 *     summary: List products with filters and pagination
 *     tags: [Data API]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: retailer
 *         schema: { type: string }
 *         description: Filter by retailer name
 *       - in: query
 *         name: last_seen_after
 *         schema: { type: string, format: date-time }
 *         description: Only products seen after this date
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search product titles (case-insensitive)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 500 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated product list
 */
router.get('/products',
  validate({ query: listProductsSchema }),
  asyncHandler(async (req: ValidatedRequest<{ query: typeof listProductsSchema }>, res) => {
    const { offset, limit, cursor, retailer, last_seen_after, search } = req.query;
    if (!validateOffset(offset, res)) return;
    const svc = await getProductQueryService();
    const result = await svc.listProducts({
      retailer,
      last_seen_after,
      search,
      limit,
      offset,
      cursor: cursor || undefined,
    });

    res.json({ success: true, ...result, limit, offset });
  }));

/**
 * @openapi
 * /data/products/{retailer}/{styleId}:
 *   get:
 *     summary: Get product detail with snapshot history
 *     tags: [Data API]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: retailer
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: styleId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: snapshot_limit
 *         schema: { type: integer, default: 50, maximum: 500 }
 *       - in: query
 *         name: snapshot_offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Product with snapshot history
 *       404:
 *         description: Product not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/products/:retailer/:styleId',
  validate({ params: productDetailSchema, query: productDetailQuerySchema }),
  asyncHandler(async (req: ValidatedRequest<{ params: typeof productDetailSchema; query: typeof productDetailQuerySchema }>, res) => {
    const { retailer, styleId } = req.params;
    const { snapshot_limit: snapshotLimit, snapshot_offset: snapshotOffset } = req.query;
    const cacheKey = `cache:product:${retailer}:${styleId}:${snapshotLimit}:${snapshotOffset}`;
    const result = await getCachedOrFetch(cacheKey, 3600, async () => {
      const svc = await getProductQueryService();
      return svc.getProductDetail(retailer, styleId, snapshotLimit, snapshotOffset);
    });

    if (!result.product) {
      res.status(404).json(errorResponse('Product not found', 'not_found'));
      return;
    }

    res.json({ success: true, ...result, snapshot_limit: snapshotLimit, snapshot_offset: snapshotOffset });
  }));

/**
 * @openapi
 * /data/variants:
 *   get:
 *     summary: List variant snapshots with filters and pagination
 *     tags: [Data API]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: retailer
 *         schema: { type: string }
 *       - in: query
 *         name: scrape_run_id
 *         schema: { type: integer }
 *       - in: query
 *         name: color
 *         schema: { type: string }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 500 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated variant snapshot list
 */
router.get('/variants',
  validate({ query: listVariantsSchema }),
  asyncHandler(async (req: ValidatedRequest<{ query: typeof listVariantsSchema }>, res) => {
    const { offset, limit, cursor, retailer, scrape_run_id, color, from_date, to_date } = req.query;
    if (!validateOffset(offset, res)) return;
    const svc = await getProductQueryService();
    const result = await svc.listVariants({
      retailer,
      scrape_run_id,
      color,
      from_date,
      to_date,
      limit,
      offset,
      cursor: cursor || undefined,
    });

    res.json({ success: true, ...result, limit, offset });
  }));

/**
 * @openapi
 * /data/scrape-runs:
 *   get:
 *     summary: List scrape run summaries with filters and pagination
 *     tags: [Data API]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: site
 *         schema: { type: string }
 *       - in: query
 *         name: brand
 *         schema: { type: string }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 500 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated scrape run list
 */
router.get('/scrape-runs',
  validate({ query: listScrapeRunsSchema }),
  asyncHandler(async (req: ValidatedRequest<{ query: typeof listScrapeRunsSchema }>, res) => {
    const { offset, limit, cursor, site, brand, from_date, to_date } = req.query;
    if (!validateOffset(offset, res)) return;
    const filters = {
      site,
      brand,
      from_date,
      to_date,
      limit,
      offset,
      cursor: cursor || undefined,
    };
    const cacheKey = `cache:scrape-runs:${JSON.stringify(filters)}`;
    const result = await getCachedOrFetch(cacheKey, 300, async () => {
      const svc = await getProductQueryService();
      return svc.listScrapeRuns(filters);
    });

    res.json({ success: true, ...result, limit, offset });
  }));

/**
 * @openapi
 * /data/price-changes:
 *   get:
 *     summary: List price change events between consecutive scrape runs
 *     tags: [Data API]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: retailer
 *         schema: { type: string }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 500 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Paginated price change events
 */
router.get('/price-changes',
  validate({ query: listPriceChangesSchema }),
  asyncHandler(async (req: ValidatedRequest<{ query: typeof listPriceChangesSchema }>, res) => {
    const { offset, limit, retailer, from_date, to_date } = req.query;
    if (!validateOffset(offset, res)) return;
    const svc = await getProductQueryService();
    const result = await svc.listPriceChanges({
      retailer,
      from_date,
      to_date,
      limit,
      offset,
    });

    res.json({ success: true, ...result, limit, offset });
  }));

export default router;
