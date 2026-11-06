/**
 * ProductQueryService — read-only queries for persisted product/variant data.
 *
 * Backs the Data API (/api/data) and scrape-run summaries. All methods are read-only SELECT queries against
 * the products, product_snapshots, and scrape_runs tables.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { stripTotalCount } from './strip-total-count';

const logger = createLogger('product-query');

// ── Shared types ────────────────────────────────────────────────────────

export interface ProductRecord {
  id: number;
  retailer: string;
  style_id: string;
  title: string | null;
  description: string | null;
  url: string | null;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface SnapshotRecord {
  id: number;
  scrape_run_id: number;
  sku: string;
  upc: string;
  color: string;
  size: string;
  list_price: string | null;
  selling_price: string | null;
  inventory: string;
  item_number: string;
  scraped_at: string;
}

export interface PriceChange {
  color: string;
  size: string;
  old_list_price: string | null;
  new_list_price: string | null;
  old_selling_price: string | null;
  new_selling_price: string | null;
  scraped_at: string;
}

export interface ScrapeRunSummary {
  id: number;
  job_id: string;
  site: string;
  brand: string;
  variant_count: number;
  products_upserted: number;
  new_products: number;
  price_changes_detected: number;
  new_sellouts_detected: number;
  scraped_at: string;
  created_at: string;
}

// ── Service ─────────────────────────────────────────────────────────────

export class ProductQueryService {
  private readonly db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Get summary for a specific scrape run by job_id.
   */
  async getScrapeRunSummary(jobId: string): Promise<ScrapeRunSummary | null> {
    logger.info('Fetching scrape run summary', {
      operation: 'getScrapeRunSummary', jobId,
    });

    const row = await this.db.get<ScrapeRunSummary>(
      `SELECT id, job_id::TEXT, site, brand, variant_count,
              products_upserted, new_products, price_changes_detected,
              new_sellouts_detected, scraped_at::TEXT, created_at::TEXT
       FROM scrape_runs
       WHERE job_id = $1
       ORDER BY id DESC LIMIT 1`,
      jobId,
    );

    return row ?? null;
  }

  /**
   * Newest-first pages over one id column. Offset and cursor pages share that
   * order, so next_cursor from any page continues where the page ended.
   * `conditions` use $1..$n for `params`.
   */
  private async page<T extends { id: number }>(q: {
    select: string;
    from: string;
    idColumn: string;
    conditions: string[];
    params: unknown[];
    filters: { limit?: number; offset?: number; cursor?: number };
  }): Promise<{ data: T[]; total: number; next_cursor?: number }> {
    const limit = Math.min(500, Math.max(1, q.filters.limit ?? 50));
    const conditions = [...q.conditions];
    const params = [...q.params];
    if (q.filters.cursor) {
      params.push(q.filters.cursor);
      conditions.push(`${q.idColumn} < $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = q.filters.cursor ? 0 : Math.max(0, q.filters.offset ?? 0);
    params.push(limit, offset);

    const rows = await this.db.all<T & { total_count: string }>(
      `SELECT ${q.select}, COUNT(*) OVER() AS total_count
       FROM ${q.from} ${where}
       ORDER BY ${q.idColumn} DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params,
    );
    const total = rows.length > 0 ? Number.parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(stripTotalCount) as unknown as T[];
    const lastRow = data.at(-1);
    return { data, total, next_cursor: data.length === limit && lastRow ? lastRow.id : undefined };
  }

  // ── Data API query methods ──────────────────────────────────────────

  /**
   * List products with filters and pagination.
   * Supports cursor-based pagination (pass cursor from previous next_cursor) or offset.
   */
  async listProducts(filters: {
    retailer?: string;
    last_seen_after?: string;
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: number;
  }): Promise<{ data: ProductRecord[]; total: number; next_cursor?: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.retailer) {
      conditions.push(`retailer = $${paramIdx++}`);
      params.push(filters.retailer);
    }
    if (filters.last_seen_after) {
      conditions.push(`last_seen_at >= $${paramIdx++}`);
      params.push(filters.last_seen_after);
    }
    if (filters.search) {
      conditions.push(`title ILIKE $${paramIdx++}`);
      params.push(`%${filters.search}%`);
    }

    return this.page<ProductRecord>({
      select: `id, retailer, style_id, title, description, url, source,
               first_seen_at::TEXT, last_seen_at::TEXT`,
      from: 'products',
      idColumn: 'id',
      conditions, params, filters,
    });
  }

  /**
   * Get a single product by retailer + style_id with full snapshot history.
   */
  async getProductDetail(
    retailer: string,
    styleId: string,
    snapshot_limit: number = 50,
    snapshot_offset: number = 0,
  ): Promise<{ product: ProductRecord | null; snapshots: SnapshotRecord[]; snapshot_total: number }> {
    const product = await this.db.get<ProductRecord>(
      `SELECT id, retailer, style_id, title, description, url, source,
              first_seen_at::TEXT, last_seen_at::TEXT
       FROM products WHERE retailer = $1 AND style_id = $2`,
      retailer, styleId,
    );

    if (!product) {
      return { product: null, snapshots: [], snapshot_total: 0 };
    }

    const clampedLimit = Math.min(Math.max(1, snapshot_limit), 500);
    const clampedOffset = Math.max(0, snapshot_offset);

    // Partition-prune bound: scan-time lower bound so the planner prunes
    // to the retention window's partitions; result-preserving given retention.
    const rows = await this.db.all<SnapshotRecord & { total_count: string }>(
      `SELECT ps.id, ps.scrape_run_id, ps.sku, ps.upc, ps.color, ps.size,
              ps.list_price::TEXT, ps.selling_price::TEXT, ps.inventory,
              ps.item_number, ps.scraped_at::TEXT,
              COUNT(*) OVER() AS total_count
       FROM product_snapshots ps
       WHERE ps.product_id = $1
         AND ps.scraped_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY ps.scraped_at DESC
       LIMIT $3 OFFSET $4`,
      product.id, String(config.scraping.snapshotRetentionDays), clampedLimit, clampedOffset,
    );
    const snapshot_total = rows.length > 0 ? Number.parseInt(rows[0].total_count, 10) : 0;
    const snapshots = rows.map(stripTotalCount);

    return { product, snapshots, snapshot_total };
  }

  /**
   * List variant snapshots with filters and pagination.
   * Supports cursor-based pagination (pass cursor from previous next_cursor) or offset.
   */
  async listVariants(filters: {
    retailer?: string;
    scrape_run_id?: number;
    color?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
    cursor?: number;
  }): Promise<{ data: Array<SnapshotRecord & { retailer: string; style_id: string; title: string | null }>; total: number; next_cursor?: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.retailer) {
      conditions.push(`p.retailer = $${paramIdx++}`);
      params.push(filters.retailer);
    }
    if (filters.scrape_run_id) {
      conditions.push(`ps.scrape_run_id = $${paramIdx++}`);
      params.push(filters.scrape_run_id);
    }
    if (filters.color) {
      conditions.push(`ps.color = $${paramIdx++}`);
      params.push(filters.color);
    }
    if (filters.from_date) {
      conditions.push(`ps.scraped_at >= $${paramIdx++}`);
      params.push(filters.from_date);
    } else {
      // Partition-prune bound — see getProductHistory for rationale.
      conditions.push(`ps.scraped_at >= NOW() - ($${paramIdx++} || ' days')::INTERVAL`);
      params.push(String(config.scraping.snapshotRetentionDays));
    }
    if (filters.to_date) {
      conditions.push(`ps.scraped_at <= $${paramIdx++}`);
      params.push(filters.to_date);
    }

    return this.page<SnapshotRecord & { retailer: string; style_id: string; title: string | null }>({
      select: `ps.id, ps.scrape_run_id, ps.sku, ps.upc, ps.color, ps.size,
               ps.list_price::TEXT, ps.selling_price::TEXT, ps.inventory,
               ps.item_number, ps.scraped_at::TEXT,
               p.retailer, p.style_id, p.title`,
      from: 'product_snapshots ps JOIN products p ON ps.product_id = p.id',
      idColumn: 'ps.id',
      conditions, params, filters,
    });
  }

  /**
   * List scrape runs with filters and pagination.
   * Supports cursor-based pagination (pass cursor from previous next_cursor) or offset.
   */
  async listScrapeRuns(filters: {
    site?: string;
    brand?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
    cursor?: number;
  }): Promise<{ data: ScrapeRunSummary[]; total: number; next_cursor?: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.site) {
      conditions.push(`site = $${paramIdx++}`);
      params.push(filters.site);
    }
    if (filters.brand) {
      conditions.push(`brand = $${paramIdx++}`);
      params.push(filters.brand);
    }
    if (filters.from_date) {
      conditions.push(`scraped_at >= $${paramIdx++}`);
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      conditions.push(`scraped_at <= $${paramIdx++}`);
      params.push(filters.to_date);
    }

    return this.page<ScrapeRunSummary>({
      select: `id, job_id::TEXT, site, brand, variant_count,
               products_upserted, new_products, price_changes_detected,
               new_sellouts_detected, scraped_at::TEXT, created_at::TEXT`,
      from: 'scrape_runs',
      idColumn: 'id',
      conditions, params, filters,
    });
  }

  /**
   * List price change events between consecutive scrape runs.
   */
  async listPriceChanges(filters: {
    retailer?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ data: Array<PriceChange & { retailer: string; style_id: string; title: string | null }>; total: number }> {
    // Default to last 30 days if no date filter provided
    const effectiveFromDate = filters.from_date ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Push date and retailer filters inside the window function subquery
    // to avoid scanning the entire product_snapshots table.
    const innerConditions: string[] = [];
    const outerConditions: string[] = [
      '(sub.old_list_price IS DISTINCT FROM sub.new_list_price OR sub.old_selling_price IS DISTINCT FROM sub.new_selling_price)',
      'sub.has_prev',
    ];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.retailer) {
      innerConditions.push(`p.retailer = $${paramIdx++}`);
      params.push(filters.retailer);
    }

    innerConditions.push(`ps.scraped_at >= $${paramIdx}`);
    outerConditions.push(`sub.scraped_at >= $${paramIdx}`);
    paramIdx++;
    params.push(effectiveFromDate);

    if (filters.to_date) {
      // Push the value once per placeholder rather than back-referencing
      // $${paramIdx - 1}: each $N maps to exactly one params[] slot, so the
      // alignment stays trivially auditable and reordering can't desync it.
      innerConditions.push(`ps.scraped_at <= $${paramIdx++}`);
      params.push(filters.to_date);
      outerConditions.push(`sub.scraped_at <= $${paramIdx++}`);
      params.push(filters.to_date);
    }

    const innerWhere = innerConditions.length > 0 ? 'WHERE ' + innerConditions.join(' AND ') : '';
    const outerWhere = 'WHERE ' + outerConditions.join(' AND ');
    const limit = Math.min(500, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);

    const baseQuery = `
      FROM (
        SELECT ps.product_id, ps.color, ps.size,
               LAG(ps.list_price) OVER w AS old_list_price, ps.list_price AS new_list_price,
               LAG(ps.selling_price) OVER w AS old_selling_price, ps.selling_price AS new_selling_price,
               ps.scraped_at,
               LAG(ps.list_price) OVER w IS NOT NULL AS has_prev
        FROM product_snapshots ps
        JOIN products p ON ps.product_id = p.id
        ${innerWhere}
        WINDOW w AS (PARTITION BY ps.product_id, ps.color, ps.size ORDER BY ps.scraped_at, ps.id)
      ) sub
      JOIN products p ON sub.product_id = p.id
      ${outerWhere}`;

    const rows = await this.db.all<PriceChange & { retailer: string; style_id: string; title: string | null; total_count: string }>(
      `SELECT sub.color, sub.size,
              sub.old_list_price::TEXT, sub.new_list_price::TEXT,
              sub.old_selling_price::TEXT, sub.new_selling_price::TEXT,
              sub.scraped_at::TEXT,
              p.retailer, p.style_id, p.title,
              COUNT(*) OVER() AS total_count
       ${baseQuery}
       ORDER BY sub.scraped_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      ...params, limit, offset,
    );
    const total = rows.length > 0 ? Number.parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(stripTotalCount);

    return { data, total };
  }
}

// ── Singleton accessor ──────────────────────────────────────────────────

let serviceInstance: ProductQueryService | null = null;

export async function getProductQueryService(): Promise<ProductQueryService> {
  if (!serviceInstance) {
    const db = await DatabaseService.getInstance();
    serviceInstance = new ProductQueryService(db);
  }
  return serviceInstance;
}
