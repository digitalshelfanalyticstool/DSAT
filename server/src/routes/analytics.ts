/**
 * Analytics API Routes — aggregated visualization data for completed jobs.
 *
 * GET /api/jobs/:id/analytics
 *   Returns price distribution, discount summary, variant heatmap,
 *   data completeness metrics, and phase timings for a single job.
 *
 * GET /api/analytics/overview
 *   Returns aggregated KPIs, daily activity, retailer breakdown,
 *   price trends, catalog growth, and top price movers for a date range.
 *
 * Requires authentication. Regular users can only access their own jobs;
 * admins can access any job.
 */

import { Router } from 'express';
import { z } from 'zod';
import Bottleneck from 'bottleneck';
import { config } from '../config';
import { DatabaseService } from '../services/database';
import { authMiddleware } from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/auth';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { createLogger } from '../utils/logger';
import { getCachedOrFetch } from '../services/redis-cache';
import { isOwnerOrAdmin } from '../services/user-records';
import { diffRunPairs, sumRunDiffs, snapshotWindow, type RunRef } from '../services/run-diff';

const logger = createLogger('analytics-routes');
const router = Router();

/**
 * Redis TTLs for the analytics aggregations. Short-lived: the dashboard
 * polls these frequently and stale-by-a-minute is acceptable for aggregate KPIs.
 */
const OVERVIEW_CACHE_TTL_SECS = 60;
const CHANGES_CACHE_TTL_SECS = 30;

// --- Validation Schemas ---

const jobIdSchema = z.object({
  id: z.guid('Job ID must be a valid UUID'),
});
const jobAnalyticsSchemas = { params: jobIdSchema };

// --- Types ---

interface VariantRow {
  color: string | null;
  size: string | null;
  selling_price: number | null;
  list_price: number | null;
  upc: string | null;
  inventory: number | null;
  item_number: string | null;
}

interface JobRow {
  job_id: string;
  user_id: string;
  status: string;
  phase_timings: Record<string, number> | null;
  /** scraped_at of the job's first and last scrape run; null when it has none. */
  first_run_at: string | null;
  last_run_at: string | null;
}

interface PriceBucket {
  label: string;
  min: number;
  max: number | null;
  count: number;
}

interface DiscountSummary {
  avg_discount_pct: number;
  on_sale_count: number;
  full_price_count: number;
}

interface VariantHeatmap {
  colors: string[];
  sizes: string[];
  matrix: number[][];
}

interface DataCompleteness {
  upc: number;
  selling_price: number;
  list_price: number;
  inventory: number;
  item_number: number;
}

// --- Price distribution buckets definition ---

const PRICE_BUCKETS: Array<{ label: string; min: number; max: number | null }> = [
  { label: '$0–$25',    min: 0,   max: 25 },
  { label: '$25–$50',   min: 25,  max: 50 },
  { label: '$50–$75',   min: 50,  max: 75 },
  { label: '$75–$100',  min: 75,  max: 100 },
  { label: '$100–$150', min: 100, max: 150 },
  { label: '$150–$200', min: 150, max: 200 },
  { label: '$200+',     min: 200, max: null },
];

// --- Pure aggregation functions ---

/**
 * Build a price-distribution histogram from variant rows.
 * Only variants with a positive selling_price are included.
 */
export function buildPriceDistribution(variants: VariantRow[]): PriceBucket[] {
  const buckets: PriceBucket[] = PRICE_BUCKETS.map(b => ({ ...b, count: 0 }));

  for (const v of variants) {
    const price = v.selling_price;
    if (!price || price <= 0) continue;

    for (const bucket of buckets) {
      if (price >= bucket.min && (bucket.max === null || price < bucket.max)) {
        bucket.count++;
        break;
      }
    }
  }

  return buckets;
}

/**
 * Build discount summary metrics from variant rows.
 * A variant is "on sale" when selling_price < list_price (both non-null/positive).
 */
export function buildDiscountSummary(variants: VariantRow[]): DiscountSummary {
  let onSale = 0;
  let fullPrice = 0;
  let totalDiscountPct = 0;
  let discountCount = 0;

  for (const v of variants) {
    const sell = v.selling_price;
    const list = v.list_price;

    if (!sell || sell <= 0 || !list || list <= 0) continue;

    if (sell < list) {
      onSale++;
      const pct = ((list - sell) / list) * 100;
      totalDiscountPct += pct;
      discountCount++;
    } else {
      fullPrice++;
    }
  }

  return {
    avg_discount_pct: discountCount > 0
      ? Math.round((totalDiscountPct / discountCount) * 10) / 10
      : 0,
    on_sale_count: onSale,
    full_price_count: fullPrice,
  };
}

/**
 * Build variant heatmap data (colors × sizes matrix).
 * Matrix cell is 1 when that color+size combination exists, 0 otherwise.
 */
export function buildVariantHeatmap(variants: VariantRow[]): VariantHeatmap {
  if (variants.length === 0) {
    return { colors: [], sizes: [], matrix: [] };
  }

  // Collect unique colors and sizes in insertion order
  const colorSet = new Set<string>();
  const sizeSet = new Set<string>();

  for (const v of variants) {
    if (v.color) colorSet.add(v.color);
    if (v.size) sizeSet.add(v.size);
  }

  const colors = Array.from(colorSet);
  const sizes = Array.from(sizeSet);

  // Build presence set: "color||size"
  const present = new Set<string>();
  for (const v of variants) {
    if (v.color && v.size) {
      present.add(`${v.color}||${v.size}`);
    }
  }

  // Build matrix[color_idx][size_idx]
  const matrix: number[][] = colors.map(color =>
    sizes.map(size => (present.has(`${color}||${size}`) ? 1 : 0)),
  );

  return { colors, sizes, matrix };
}

/**
 * Calculate data completeness percentages for key fields.
 * Returns 0–100 for each field indicating the % of variants with a non-null value.
 */
export function buildDataCompleteness(variants: VariantRow[]): DataCompleteness {
  const total = variants.length;

  if (total === 0) {
    return { upc: 0, selling_price: 0, list_price: 0, inventory: 0, item_number: 0 };
  }

  const pct = (count: number): number => Math.round((count / total) * 100);

  let upcCount = 0;
  let sellingCount = 0;
  let listCount = 0;
  let inventoryCount = 0;
  let itemCount = 0;

  for (const v of variants) {
    if (v.upc != null && v.upc !== '') upcCount++;
    if (v.selling_price != null) sellingCount++;
    if (v.list_price != null) listCount++;
    if (v.inventory != null) inventoryCount++;
    if (v.item_number != null && v.item_number !== '') itemCount++;
  }

  return {
    upc: pct(upcCount),
    selling_price: pct(sellingCount),
    list_price: pct(listCount),
    inventory: pct(inventoryCount),
    item_number: pct(itemCount),
  };
}

// --- Route ---

/**
 * GET /api/jobs/:id/analytics
 *
 * Returns aggregated visualization data for a single job.
 * The requesting user must own the job, or be an admin.
 */
router.get(
  '/jobs/:id/analytics',
  authMiddleware,
  validate(jobAnalyticsSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof jobAnalyticsSchemas, AuthenticatedRequest>, res) => {
    const { id: jobId } = req.params;
    const db = await DatabaseService.getInstance();

    // Fetch job (including phase_timings JSONB column)
    const job = await db.get<JobRow>(
      `SELECT job_id, user_id, status, phase_timings,
              (SELECT MIN(scraped_at) FROM scrape_runs WHERE job_id = $1) AS first_run_at,
              (SELECT MAX(scraped_at) FROM scrape_runs WHERE job_id = $1) AS last_run_at
       FROM jobs WHERE job_id = $1`,
      jobId,
    );

    if (!job) {
      res.status(404).json(errorResponse(`Job "${jobId}" not found`, 'not_found'));
      return;
    }

    // Ownership check
    const userId = String(req.user!.id);
    const userRole = req.user!.role;
    if (!isOwnerOrAdmin(job.user_id, userId, userRole)) {
      res.status(403).json(errorResponse('Forbidden: you do not own this job', 'forbidden'));
      return;
    }

    // Variant data for this job, bounded to its runs' snapshot window so the
    // planner prunes product_snapshots partitions (see snapshotWindow).
    let variants: VariantRow[] = [];
    if (job.first_run_at && job.last_run_at) {
      const { from, to } = snapshotWindow(job.first_run_at, job.last_run_at);
      variants = await db.all<VariantRow>(
        `SELECT ps.color, ps.size, ps.selling_price, ps.list_price,
                ps.upc, ps.inventory, ps.item_number
         FROM product_snapshots ps
         JOIN scrape_runs sr ON sr.id = ps.scrape_run_id
         WHERE sr.job_id = $1
           AND ps.scraped_at >= $2::timestamptz
           AND ps.scraped_at < $3::timestamptz`,
        jobId, from, to,
      );
    }

    // Aggregate
    const analytics = {
      price_distribution: buildPriceDistribution(variants),
      discount_summary:   buildDiscountSummary(variants),
      variant_heatmap:    buildVariantHeatmap(variants),
      data_completeness:  buildDataCompleteness(variants),
      phase_timings:      job.phase_timings ?? null,
    };

    logger.info('Analytics fetched for job', {
      operation: 'getJobAnalytics',
      jobId,
      variantCount: variants.length,
    });

    res.json({ success: true, analytics });
  }, { operation: 'getJobAnalytics', message: 'Failed to fetch job analytics' }),
);

// --- Overview analytics types ---

interface KpiRow {
  total_jobs: string;
  products_scraped: string;
  variants_extracted: string;
  success_rate: string;
}

interface DailyActivityRow {
  date: string;
  jobs: string;
  products: string;
}

interface ByRetailerRow {
  site: string;
  job_count: string;
  product_count: string;
}

interface PriceTrendRow {
  date: string;
  avg_list_price: string | null;
  avg_selling_price: string | null;
}

interface CatalogGrowthRow {
  date: string;
  cumulative_products: string;
  new_products: string;
}

interface SuccessByRetailerRow {
  site: string;
  success_rate: string;
}

interface RecentJobRow {
  job_id: string;
  site: string;
  brand: string;
  status: string;
  products_discovered: string;
  variants_extracted: string;
  completed_at: string | null;
}

interface TopProductRow {
  product_name: string | null;
  product_url: string | null;
  retailer: string;
  variant_count: string;
  colors: string | null;
}

// --- Overview validation ---

const DAY_MS = 24 * 60 * 60 * 1000;
// Truncate to the UTC day: the queries are day-grained anyway (`to` is read
// as `$2::date`), and a millisecond-precise value would give every request
// its own cache key.
const utcDay = z.coerce.date().transform((d) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS));

const overviewQuerySchema = z
  .object({
    from: utcDay,
    to: utcDay,
    site: z.string().optional(),
    brand: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['from'] })
  .refine(
    (q) => q.to.getTime() - q.from.getTime() <= config.analytics.overviewMaxRangeDays * DAY_MS,
    { message: `range is too wide (max ${config.analytics.overviewMaxRangeDays} days)`, path: ['from'] },
  );

// Bounds how many overview aggregations hit the shared pool at once, however
// many distinct cache keys the requests use.
const overviewLimiter = new Bottleneck({ maxConcurrent: config.analytics.overviewConcurrency });
const overviewSchemas = { query: overviewQuerySchema };

/**
 * Calculate the comparison (previous) period that mirrors the selected date range.
 * E.g. Mar 1–27 (27 days) → comparison is Feb 2–28 (prior 27 days ending the day before `from`).
 */
export function calcComparisonRange(from: Date, to: Date): { prevFrom: Date; prevTo: Date } {
  const rangeDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
  const prevTo = new Date(from.getTime() - 24 * 60 * 60 * 1000); // day before `from`
  const prevFrom = new Date(prevTo.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  return { prevFrom, prevTo };
}

/**
 * GET /api/analytics/overview
 *
 * Returns aggregated analytics for a date range with optional site/brand filters.
 * All authenticated users see the same global aggregates regardless of role —
 * scraping output is shared across the team, not per-user. (Per-job analytics
 * at /api/jobs/:id/analytics still enforces ownership; that's a separate concern.)
 */
router.get(
  '/analytics/overview',
  authMiddleware,
  validate(overviewSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof overviewSchemas, AuthenticatedRequest>, res) => {
    const { from: fromDate, to: toDate, site, brand } = req.query;

    const userId = req.user!.id;

    // Cache the ~9-query aggregation. Key is derived from the exact
    // filter params the handler reads ({from,to,site,brand}); a cache hit
    // returns the identical `analytics` payload a miss would compute.
    const cacheKey = `cache:analytics:overview:${fromDate.toISOString()}:${toDate.toISOString()}:${site ?? ''}:${brand ?? ''}`;
    const analytics = await getCachedOrFetch(cacheKey, OVERVIEW_CACHE_TTL_SECS, () => overviewLimiter.schedule(async () => {
    const { prevFrom, prevTo } = calcComparisonRange(fromDate, toDate);

    const db = await DatabaseService.getInstance();

    // Build dynamic WHERE conditions for the optional site/brand query params.
    // `cols` selects which SQL columns each query filters on — they vary
    // (j.site/p.retailer/site, j.brand/brand) and some queries intentionally
    // omit one (e.g. by-retailer groups BY site, so it takes no site filter).
    // The string-union types are a compile-time allowlist: only these literals
    // type-check, so the column interpolation can never receive user input.
    // `cols` is REPLACED, not merged — passing `{ brand: 'j.brand' }` yields a
    // brand-only filter; do not "fix" this into a spread-merge.
    type SiteColumn = 'j.site' | 'p.retailer' | 'site';
    type BrandColumn = 'j.brand' | 'brand';
    const buildSiteBrandFilter = (
      baseParams: unknown[],
      cols: { site?: SiteColumn; brand?: BrandColumn } = { site: 'j.site', brand: 'j.brand' },
    ): { conditions: string[]; params: unknown[] } => {
      const conditions: string[] = [];
      const params: unknown[] = [...baseParams];

      if (cols.site && site) {
        params.push(site);
        conditions.push(`${cols.site} = $${params.length}`);
      }
      if (cols.brand && brand) {
        params.push(brand);
        conditions.push(`${cols.brand} = $${params.length}`);
      }

      return { conditions, params };
    };

    // ── KPI: current period ──────────────────────────────────────────────────
    const kpiQuery = (periodFrom: Date, periodTo: Date) => {
      const baseParams: unknown[] = [periodFrom.toISOString(), periodTo.toISOString()];
      const { conditions, params } = buildSiteBrandFilter(baseParams);
      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.get<KpiRow>(
        `SELECT
           COUNT(*) AS total_jobs,
           COALESCE(SUM(j.products_discovered), 0) AS products_scraped,
           COALESCE(SUM(j.variants_extracted), 0) AS variants_extracted,
           CASE WHEN COUNT(*) = 0 THEN 0
                ELSE ROUND(
                  COUNT(*) FILTER (WHERE j.status = 'completed')::numeric / COUNT(*) * 100,
                  1
                )
           END AS success_rate
         FROM jobs j
         WHERE j.created_at >= $1 AND j.created_at < ($2::date + INTERVAL '1 day')
           ${whereClause}`,
        ...params,
      );
    };

    // ── Daily activity ────────────────────────────────────────────────────────
    const dailyActivityQuery = () => {
      const baseParams: unknown[] = [fromDate.toISOString(), toDate.toISOString()];
      const { conditions, params } = buildSiteBrandFilter(baseParams);
      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.all<DailyActivityRow>(
        `SELECT
           TO_CHAR(DATE_TRUNC('day', j.created_at), 'YYYY-MM-DD') AS date,
           COUNT(*) AS jobs,
           COALESCE(SUM(j.products_discovered), 0) AS products
         FROM jobs j
         WHERE j.created_at >= $1 AND j.created_at < ($2::date + INTERVAL '1 day')
           ${whereClause}
         GROUP BY DATE_TRUNC('day', j.created_at)
         ORDER BY DATE_TRUNC('day', j.created_at)`,
        ...params,
      );
    };

    // ── By retailer ───────────────────────────────────────────────────────────
    // Note: no site filter here — we're grouping by site to show all retailers.
    const byRetailerQuery = () => {
      const { conditions, params } = buildSiteBrandFilter(
        [fromDate.toISOString(), toDate.toISOString()],
        { brand: 'j.brand' },
      );

      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.all<ByRetailerRow>(
        `SELECT
           j.site,
           COUNT(*) AS job_count,
           COALESCE(SUM(j.products_discovered), 0) AS product_count
         FROM jobs j
         WHERE j.created_at >= $1 AND j.created_at < ($2::date + INTERVAL '1 day')
           ${whereClause}
         GROUP BY j.site
         ORDER BY job_count DESC`,
        ...params,
      );
    };

    // ── Price trend ───────────────────────────────────────────────────────────
    const priceTrendQuery = () => {
      const { conditions, params } = buildSiteBrandFilter([
        fromDate.toISOString(),
        toDate.toISOString(),
      ]);

      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.all<PriceTrendRow>(
        `SELECT
           TO_CHAR(DATE_TRUNC('day', ps.scraped_at), 'YYYY-MM-DD') AS date,
           ROUND(AVG(ps.list_price)::numeric, 2) AS avg_list_price,
           ROUND(AVG(ps.selling_price)::numeric, 2) AS avg_selling_price
         FROM product_snapshots ps
         JOIN scrape_runs sr ON sr.id = ps.scrape_run_id
         JOIN jobs j ON j.job_id = sr.job_id
         WHERE ps.scraped_at >= $1 AND ps.scraped_at < ($2::date + INTERVAL '1 day')
           AND ps.list_price IS NOT NULL AND ps.selling_price IS NOT NULL
           ${whereClause}
         GROUP BY DATE_TRUNC('day', ps.scraped_at)
         ORDER BY DATE_TRUNC('day', ps.scraped_at)`,
        ...params,
      );
    };

    // ── Catalog growth ────────────────────────────────────────────────────────
    const catalogGrowthQuery = () => {
      const { conditions, params } = buildSiteBrandFilter(
        [fromDate.toISOString(), toDate.toISOString()],
        { site: 'p.retailer' },
      );

      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.all<CatalogGrowthRow>(
        `SELECT
           TO_CHAR(DATE_TRUNC('day', p.first_seen_at), 'YYYY-MM-DD') AS date,
           SUM(COUNT(*)) OVER (ORDER BY DATE_TRUNC('day', p.first_seen_at)) AS cumulative_products,
           COUNT(*) AS new_products
         FROM products p
         WHERE p.first_seen_at >= $1 AND p.first_seen_at < ($2::date + INTERVAL '1 day')
           ${whereClause}
         GROUP BY DATE_TRUNC('day', p.first_seen_at)
         ORDER BY DATE_TRUNC('day', p.first_seen_at)`,
        ...params,
      );
    };

    // ── Success rate by retailer ──────────────────────────────────────────────
    // Note: no site filter here — we're grouping by site to show all retailers.
    const successByRetailerQuery = () => {
      const { conditions, params } = buildSiteBrandFilter(
        [fromDate.toISOString(), toDate.toISOString()],
        { brand: 'j.brand' },
      );

      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
      return db.all<SuccessByRetailerRow>(
        `SELECT
           j.site,
           CASE WHEN COUNT(*) = 0 THEN 0
                ELSE ROUND(
                  COUNT(*) FILTER (WHERE j.status = 'completed')::numeric / COUNT(*) * 100,
                  1
                )
           END AS success_rate
         FROM jobs j
         WHERE j.created_at >= $1 AND j.created_at < ($2::date + INTERVAL '1 day')
           ${whereClause}
         GROUP BY j.site
         ORDER BY j.site`,
        ...params,
      );
    };

    // ── Recent jobs ──────────────────────────────────────────────────────
    const recentJobsQuery = () => {
      const { conditions, params } = buildSiteBrandFilter(
        [fromDate.toISOString(), toDate.toISOString()],
        { site: 'site', brand: 'brand' },
      );

      return db.all<RecentJobRow>(
        `SELECT job_id, site, brand, status,
                COALESCE(products_discovered, 0) AS products_discovered,
                COALESCE(variants_extracted, 0) AS variants_extracted,
                completed_at
         FROM jobs
         WHERE created_at >= $1 AND created_at < ($2::date + INTERVAL '1 day')
           ${conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''}
         ORDER BY created_at DESC
         LIMIT 10`,
        ...params,
      );
    };

    // Top products by variant count
    const topProductsQuery = async (): Promise<TopProductRow[]> => {
      const { conditions, params } = buildSiteBrandFilter(
        [fromDate.toISOString(), toDate.toISOString()],
        { site: 'p.retailer' },
      );

      return db.all<TopProductRow>(
        `SELECT p.title AS product_name, p.url AS product_url, p.retailer,
                COUNT(DISTINCT ROW(ps.color, ps.size)) AS variant_count,
                STRING_AGG(DISTINCT ps.color, ', ' ORDER BY ps.color) AS colors
         FROM product_snapshots ps
         JOIN scrape_runs sr ON sr.id = ps.scrape_run_id
         JOIN jobs j ON j.job_id = sr.job_id
         JOIN products p ON p.id = ps.product_id
         WHERE ps.scraped_at >= $1 AND ps.scraped_at < ($2::date + INTERVAL '1 day')
           ${conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''}
         GROUP BY p.id, p.title, p.url, p.retailer
         ORDER BY variant_count DESC
         LIMIT 100`,
        ...params,
      );
    };

    // Execute all queries in parallel
    const [
      kpiCurrent,
      kpiPrev,
      dailyActivity,
      byRetailer,
      priceTrend,
      catalogGrowth,
      successByRetailer,
      recentJobs,
      topProducts,
    ] = await Promise.all([
      kpiQuery(fromDate, toDate),
      kpiQuery(prevFrom, prevTo),
      dailyActivityQuery(),
      byRetailerQuery(),
      priceTrendQuery(),
      catalogGrowthQuery(),
      successByRetailerQuery(),
      recentJobsQuery(),
      topProductsQuery(),
    ]);

    const parseNum = (v: string | null | undefined, fallback = 0): number =>
      v == null ? fallback : Number.parseFloat(v);

    return {
      kpi: {
        total_jobs: parseNum(kpiCurrent?.total_jobs),
        total_jobs_prev: parseNum(kpiPrev?.total_jobs),
        products_scraped: parseNum(kpiCurrent?.products_scraped),
        products_scraped_prev: parseNum(kpiPrev?.products_scraped),
        variants_extracted: parseNum(kpiCurrent?.variants_extracted),
        variants_extracted_prev: parseNum(kpiPrev?.variants_extracted),
        success_rate: parseNum(kpiCurrent?.success_rate),
        success_rate_prev: parseNum(kpiPrev?.success_rate),
      },
      daily_activity: dailyActivity.map((row: DailyActivityRow) => ({
        date: row.date,
        jobs: parseNum(row.jobs),
        products: parseNum(row.products),
      })),
      by_retailer: byRetailer.map((row: ByRetailerRow) => ({
        site: row.site,
        job_count: parseNum(row.job_count),
        product_count: parseNum(row.product_count),
      })),
      price_trend: priceTrend.map((row: PriceTrendRow) => ({
        date: row.date,
        avg_list_price: row.avg_list_price == null ? null : parseNum(row.avg_list_price),
        avg_selling_price: row.avg_selling_price == null ? null : parseNum(row.avg_selling_price),
      })),
      catalog_growth: catalogGrowth.map((row: CatalogGrowthRow) => ({
        date: row.date,
        cumulative_products: parseNum(row.cumulative_products),
        new_products: parseNum(row.new_products),
      })),
      success_by_retailer: successByRetailer.map((row: SuccessByRetailerRow) => ({
        site: row.site,
        success_rate: parseNum(row.success_rate),
      })),
      recent_jobs: recentJobs.map((row: RecentJobRow) => ({
        job_id: row.job_id,
        site: row.site,
        brand: row.brand,
        status: row.status,
        products_discovered: parseNum(row.products_discovered),
        variants_extracted: parseNum(row.variants_extracted),
        completed_at: row.completed_at,
      })),
      top_products: topProducts.map((row: TopProductRow) => ({
        product_name: row.product_name ?? null,
        product_url: row.product_url ?? null,
        retailer: row.retailer,
        variant_count: parseNum(row.variant_count),
        colors: row.colors ? row.colors.split(', ').filter(Boolean) : [],
      })),
    };
    }));

    logger.info('Overview analytics fetched', {
      operation: 'getAnalyticsOverview',
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      site,
      brand,
      userId,
    });

    res.json({ success: true, analytics });
  }, { operation: 'getAnalyticsOverview', message: 'Failed to fetch overview analytics' }),
);

// ---------------------------------------------------------------------------
// GET /api/analytics/changes
// Auto-compares the latest 2 completed scrape runs per retailer and brand (a
// job scrapes one brand at one site, so a site's runs alternate brands) and returns
// aggregated change metrics (new/dropped products, price changes,
// sellouts/restocks). Optional `site` query param to filter to one retailer.
// ---------------------------------------------------------------------------

router.get('/analytics/changes', authMiddleware, asyncHandler(
  async (req: AuthenticatedRequest, res) => {
    const site = typeof req.query['site'] === 'string' ? req.query['site'] : undefined;

    // Cache the ROW_NUMBER()-over-all-scrape_runs comparison. This is
    // polled ~every 30s; the key is derived from the only filter param the
    // handler reads (`site`, or 'all'). A cache hit returns the identical payload.
    const cacheKey = `cache:analytics:changes:${site ?? 'all'}`;
    const payload = await getCachedOrFetch(cacheKey, CHANGES_CACHE_TTL_SECS, async () => {
    const db = await DatabaseService.getInstance();

    // Find the latest 2 completed runs per site and brand (variant_count > 0 means data exists)
    const siteFilter = site ? 'AND site = $1' : '';
    const params: string[] = site ? [site] : [];

    const rankedRows = await db.all<{ id: string; site: string; brand: string; rn: string; scraped_at: string }>(
      `WITH ranked AS (
        SELECT id, site, brand, scraped_at,
          ROW_NUMBER() OVER (PARTITION BY site, brand ORDER BY scraped_at DESC) AS rn
        FROM scrape_runs
        WHERE variant_count > 0 ${siteFilter}
      )
      SELECT id, site, brand, rn, scraped_at FROM ranked WHERE rn <= 2`,
      ...params,
    );

    // Group by site and brand into (previous, latest) pairs
    const bysite: Record<string, { site: string; a?: RunRef; b?: RunRef }> = {};
    for (const row of rankedRows) {
      const key = JSON.stringify([row.site, row.brand]);
      bysite[key] ??= { site: row.site };
      const run = { id: Number(row.id), scraped_at: row.scraped_at };
      if (Number(row.rn) === 1) bysite[key].b = run;
      else bysite[key].a = run;
    }

    // Only site+brand pairs that have both runs
    const comparableSites = Object.values(bysite).filter(
      (pair): pair is { site: string; a: RunRef; b: RunRef } => pair.a !== undefined && pair.b !== undefined,
    );

    if (comparableSites.length === 0) {
      return {
        success: true,
        new_products: 0,
        dropped_products: 0,
        price_increases: 0,
        price_decreases: 0,
        new_sellouts: 0,
        restocked: 0,
        retailers_compared: [] as string[],
        has_data: false,
      };
    }

    const retailersCompared: string[] = [...new Set(comparableSites.map((pair) => pair.site))];
    const totals = sumRunDiffs(await diffRunPairs(db, comparableSites));

    logger.info('Changes analytics fetched', {
      operation: 'getAnalyticsChanges',
      site: site ?? 'all',
      retailers_compared: retailersCompared,
    });

    return {
      success: true,
      ...totals,
      retailers_compared: retailersCompared,
      has_data: true,
    };
    });

    res.json(payload);
  }, { operation: 'getAnalyticsChanges', message: 'Failed to fetch changes analytics' }),
);

export { router as analyticsRouter };

