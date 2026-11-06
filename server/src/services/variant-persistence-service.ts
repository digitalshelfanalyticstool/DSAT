/**
 * VariantPersistenceService — bulk-persists scraped product variant data to PostgreSQL.
 *
 * Called as Phase 4.5 in the scraper orchestrator pipeline, between cache fill
 * and Excel generation. Writes all variant data within a single transaction:
 *   1. Creates a scrape_runs record linking to the job
 *   2. Upserts products (keyed by retailer + style_id)
 *   3. Bulk-inserts product_snapshots (one row per variant)
 *   4. Computes change detection metrics (price changes, sell-outs)
 *
 * Multi-process safe via ON CONFLICT upserts and per-job transactions.
 */

import { config } from '../config';
import { DatabaseService } from './database';
import type { ProductVariant } from '../scrapers/site-adapter';
import { createLogger } from '../utils/logger';
import { ensurePartitions } from './partition-manager';
import { getRedisClient } from './redis-client';
import type { PersistJobResult } from './queues';
import { getCacheMetricsTracker } from './cache-metrics-tracker';
import {
  canonicalizeImageUrl,
  type RejectReason,
} from '../scrapers/image-url-canonicalizer';
import { classifyProductType } from '../scrapers/product-type-classifier';
import { snapshotWindow } from './run-diff';

const logger = createLogger('variant-persistence');

/**
 * Batch size for multi-row UPSERT of products and INSERT of product_snapshots.
 * Both queries use unnest() with array parameters, so PostgreSQL's 65,535 bind
 * parameter limit is not the constraint. The actual cost is per-query payload
 * size and PG plan memory. Default 2000 cuts round-trips ~4x vs the previous
 * 500. Override via PERSIST_BATCH_SIZE env var (min 1).
 */
function getPersistBatchSize(): number {
  return config.scraping.persistBatchSize;
}

/** Outcome of persisting one run; its shape is the persist queue's result. */
export type PersistResult = PersistJobResult;

/**
 * Parse a price string into a number suitable for NUMERIC(10,2), or null if unparseable.
 */
export function parsePrice(value: string): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replaceAll(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

interface ChangeMetrics {
  priceChangesDetected: number;
  newSelloutsDetected: number;
}

/**
 * Compute change detection metrics by comparing current and previous scrape runs.
 */
async function computeChangeMetrics(
  db: DatabaseService,
  site: string,
  brand: string,
  scrapeRunId: number,
): Promise<ChangeMetrics> {
  const prevRun = await db.get<{ id: number; created_at: Date }>(
    `SELECT id, created_at FROM scrape_runs
     WHERE site = $1 AND brand = $2 AND id < $3
     ORDER BY id DESC LIMIT 1`,
    site, brand, scrapeRunId,
  );

  if (!prevRun) return { priceChangesDetected: 0, newSelloutsDetected: 0 };

  const currRun = await db.get<{ created_at: Date }>(
    `SELECT created_at FROM scrape_runs WHERE id = $1`,
    scrapeRunId,
  );

  if (!currRun) return { priceChangesDetected: 0, newSelloutsDetected: 0 };

  // Bound each side to its run's snapshot window so the planner prunes
  // product_snapshots partitions (see snapshotWindow).
  const curr = snapshotWindow(currRun.created_at);
  const prev = snapshotWindow(prevRun.created_at);
  const row = await db.get<{ price_changes: string; sellouts: string }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE curr.list_price IS DISTINCT FROM prev.list_price
            OR curr.selling_price IS DISTINCT FROM prev.selling_price
       ) AS price_changes,
       COUNT(*) FILTER (
         WHERE inventory_in_stock(prev.inventory) AND inventory_in_stock(curr.inventory) IS FALSE
       ) AS sellouts
     FROM product_snapshots curr
     JOIN product_snapshots prev
       ON curr.product_id = prev.product_id
       AND curr.color = prev.color AND curr.size = prev.size
     WHERE curr.scrape_run_id = $1
       AND prev.scrape_run_id = $2
       AND curr.scraped_at >= $3::timestamptz AND curr.scraped_at < $4::timestamptz
       AND prev.scraped_at >= $5::timestamptz AND prev.scraped_at < $6::timestamptz`,
    scrapeRunId, prevRun.id, curr.from, curr.to, prev.from, prev.to,
  );

  return {
    priceChangesDetected: Number.parseInt(row?.price_changes ?? '0', 10),
    newSelloutsDetected: Number.parseInt(row?.sellouts ?? '0', 10),
  };
}

export class VariantPersistenceService {
  private readonly db: DatabaseService;
  private static readonly MV_REFRESH_DEBOUNCE_KEY = 'mv_refresh:mv_latest_snapshots';
  private static readonly MV_REFRESH_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Persist all variants from a scrape run in a single transaction.
   * Creates a scrape_run record, upserts products, and bulk-inserts snapshots.
   */
  async persistVariants(
    jobId: string,
    site: string,
    brand: string,
    variants: ProductVariant[],
  ): Promise<PersistResult> {
    const start = Date.now();
    const batchSize = getPersistBatchSize();

    logger.info('Starting variant persistence', {
      operation: 'persistVariants',
      jobId,
      site,
      brand,
      variantCount: variants.length,
    });

    // Ensure next month's partition exists before inserting
    await ensurePartitions(1);

    // eslint-disable-next-line sonarjs/cognitive-complexity -- intrinsic complexity: single atomic DB transaction over 3 batch-loops (products upsert, snapshots insert, image canonicalization with per-batch metrics) feeding a write-through cache contract. Extracting helpers would (a) require threading tx/scrapeRunId/productIdMap/batchSize through every call, and (b) risk cache-schema drift (CLAUDE.md, "Write-through caches and shape changes"). NOSONAR(typescript:S3776) — refactor risk outweighs the metric.
    const result = await this.db.transaction(async (tx) => {
      // Step 1: Create scrape_run record. Pulls cache hit/miss counters from
      // the per-job tracker so they land in the same row that downstream
      // analytics already aggregates from.
      const scrapedAt = new Date().toISOString();
      const cacheMetrics = getCacheMetricsTracker().getMetrics(jobId);
      const scrapeRunRow = await tx.get<{ id: number }>(
        `INSERT INTO scrape_runs
           (job_id, site, brand, variant_count, scraped_at,
            discovery_cache_hit, variant_cache_hits, variant_cache_misses,
            cache_fill_hits, cache_fill_misses)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        jobId, site, brand, variants.length, scrapedAt,
        cacheMetrics.discoveryCacheHit,
        cacheMetrics.variantCacheHits,
        cacheMetrics.variantCacheMisses,
        cacheMetrics.cacheFillHits,
        cacheMetrics.cacheFillMisses,
      );
      const scrapeRunId = scrapeRunRow!.id;

      // Step 2: Deduplicate products by (retailer, style_id) and upsert
      const uniqueProducts = new Map<string, ProductVariant>();
      for (const v of variants) {
        const key = `${v.retailer}:${v.style_id}`;
        if (!uniqueProducts.has(key)) {
          uniqueProducts.set(key, v);
        }
      }

      const productIdMap = new Map<string, number>();
      let newProducts = 0;

      // Batch upsert products using unnest() for plan-cacheable SQL
      const productEntries = Array.from(uniqueProducts.entries());

      for (let i = 0; i < productEntries.length; i += batchSize) {
        const batch = productEntries.slice(i, i + batchSize);

        const retailers: string[] = [];
        const styleIds: string[] = [];
        const titles: string[] = [];
        const descriptions: string[] = [];
        const urls: string[] = [];
        const sources: string[] = [];
        const timestamps: string[] = [];
        const productTypes: string[] = [];

        for (const [, v] of batch) {
          retailers.push(v.retailer);
          styleIds.push(v.style_id);
          titles.push(v.title);
          descriptions.push(v.description);
          urls.push(v.url);
          sources.push(v.source);
          timestamps.push(scrapedAt);
          productTypes.push(classifyProductType(v.title));
        }

        const rows = await tx.all<{ id: number; retailer: string; style_id: string; is_new: boolean }>(
          `INSERT INTO products (retailer, style_id, title, description, url, source, product_type, first_seen_at, last_seen_at, created_at, updated_at)
           SELECT retailer, style_id, title, description, url, source, product_type, scraped_at, scraped_at, scraped_at, scraped_at
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
             AS t(retailer, style_id, title, description, url, source, product_type, scraped_at)
           ON CONFLICT (retailer, style_id) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             url = EXCLUDED.url,
             source = EXCLUDED.source,
             product_type = EXCLUDED.product_type,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = EXCLUDED.updated_at
           RETURNING id, retailer, style_id, (xmax = 0) AS is_new`,
          retailers, styleIds, titles, descriptions, urls, sources, productTypes, timestamps,
        );

        for (const row of rows) {
          productIdMap.set(`${row.retailer}:${row.style_id}`, row.id);
          if (row.is_new) newProducts++;
        }
      }

      // Step 3: Bulk-insert snapshots using unnest() for plan-cacheable SQL
      let snapshotsInserted = 0;

      for (let i = 0; i < variants.length; i += batchSize) {
        const batch = variants.slice(i, i + batchSize);

        const runIds: number[] = [];
        const productIds: number[] = [];
        const skus: string[] = [];
        const upcs: string[] = [];
        const colors: string[] = [];
        const sizes: string[] = [];
        const listPrices: (number | null)[] = [];
        const sellingPrices: (number | null)[] = [];
        const inventories: string[] = [];
        const itemNumbers: string[] = [];
        const scrapedAts: string[] = [];
        const imageUrls: (string | null)[] = [];

        // Per-batch counters for image_url canonicalization rejections.
        // A poisoned variant cache that merges old-shape URLs back into
        // mergedVariants in Phase 4 surfaces here as a rejection count, not
        // as silent customer-visible white tiles.
        const canonRejections: Record<RejectReason, number> = {
          parse_error: 0,
          not_https: 0,
          whitespace: 0,
        };

        for (const v of batch) {
          const productId = productIdMap.get(`${v.retailer}:${v.style_id}`);
          runIds.push(scrapeRunId);
          productIds.push(productId!);
          skus.push(v.sku);
          upcs.push(v.upc);
          colors.push(v.color);
          sizes.push(v.size);
          listPrices.push(parsePrice(v.list_price));
          sellingPrices.push(parsePrice(v.selling_price));
          inventories.push(v.inventory);
          itemNumbers.push(v.item_number);
          scrapedAts.push(scrapedAt);

          // Canonicalize at write time: covers every adapter, and the Phase 4
          // cache-fill path that merges entries from data/catalogs/*_variants.json
          // which may pre-date a contract change.
          const result = canonicalizeImageUrl(v.image_url);
          if (result.rejected) canonRejections[result.rejected]++;
          imageUrls.push(result.url || null);
        }

        const totalRejected =
          canonRejections.parse_error + canonRejections.not_https + canonRejections.whitespace;
        if (totalRejected > 0) {
          logger.info('image_url canonicalization summary', {
            scrapeRunId,
            batch_size: batch.length,
            rejected_parse_error: canonRejections.parse_error,
            rejected_not_https: canonRejections.not_https,
            rejected_whitespace: canonRejections.whitespace,
          });
        }

        await tx.query(
          `INSERT INTO product_snapshots
             (scrape_run_id, product_id, sku, upc, color, size, list_price, selling_price, inventory, item_number, scraped_at, image_url)
           SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::text[], $11::timestamptz[], $12::text[])`,
          [runIds, productIds, skus, upcs, colors, sizes, listPrices, sellingPrices, inventories, itemNumbers, scrapedAts, imageUrls],
        );
        snapshotsInserted += batch.length;
      }

      // Step 3b: Point each product touched by this run at its newest snapshot
      // (the highest snapshot `id` for that product among the rows just
      // inserted — all share this run's `scraped_at`, so `id DESC` is the
      // tie-break, matching what the /products browse query expects). This
      // denormalized pointer lets that list be a plain indexed join instead of
      // a DISTINCT ON over the whole partitioned snapshots table. The
      // `sub.id > p.latest_snapshot_id` guard makes this safe if two runs for
      // the same product ever commit out of scrape order, and idempotent on a
      // transaction retry: BIGSERIAL ids are allocated monotonically, so a
      // larger id always means a newer snapshot.
      // scraped_at = $2 is a scan-time partition-prune bound: every row
      // this run inserted shares the single scrapedAt above, so the predicate
      // is exact and lets the planner prune to one monthly partition instead
      // of scanning all of them on every persist.
      await tx.query(
        `UPDATE products p SET latest_snapshot_id = sub.id
         FROM (
           SELECT DISTINCT ON (product_id) id, product_id
           FROM product_snapshots
           WHERE scrape_run_id = $1
             AND scraped_at = $2
           ORDER BY product_id, id DESC
         ) sub
         WHERE sub.product_id = p.id
           AND (p.latest_snapshot_id IS NULL OR sub.id > p.latest_snapshot_id)`,
        [scrapeRunId, scrapedAt],
      );

      return {
        scrape_run_id: scrapeRunId,
        products_upserted: uniqueProducts.size,
        snapshots_inserted: snapshotsInserted,
        new_products: newProducts,
        duration_ms: Date.now() - start,
      };
    });

    // Step 4+5: Compute change metrics OUTSIDE transaction (non-critical)
    try {
      if (variants.length > 0) {
        const { priceChangesDetected, newSelloutsDetected } = await computeChangeMetrics(
          this.db, site, brand, result.scrape_run_id,
        );

        await this.db.run(
          `UPDATE scrape_runs SET
             products_upserted = $1, new_products = $2,
             price_changes_detected = $3, new_sellouts_detected = $4
           WHERE id = $5`,
          result.products_upserted, result.new_products,
          priceChangesDetected, newSelloutsDetected,
          result.scrape_run_id,
        );
      }
    } catch (err) {
      logger.warn('Change metric computation failed (data was persisted successfully)', {
        operation: 'persistVariants',
        jobId,
        scrapeRunId: result.scrape_run_id,
        error: (err as Error).message,
      });
    }

    // Refresh materialized view (debounced to once per 5 minutes, fire-and-forget)
    await this.maybeRefreshMaterializedView();

    logger.info('Variant persistence complete', {
      operation: 'persistVariants',
      jobId,
      site,
      brand,
      scrape_run_id: result.scrape_run_id,
      products_upserted: result.products_upserted,
      snapshots_inserted: result.snapshots_inserted,
      duration_ms: result.duration_ms,
    });

    return result;
  }

  /**
   * Debounced refresh of mv_latest_snapshots materialized view.
   *
   * Uses Redis SET NX EX to gate refreshes: at most once per 5 minutes.
   * Returns immediately — refresh runs fire-and-forget in the background.
   * Failures (Redis unreachable, MV refresh error) are logged but do not
   * propagate to the caller, ensuring persist always completes.
   */
  private async maybeRefreshMaterializedView(): Promise<void> {
    try {
      const redis = getRedisClient().getQueueConnection();
      // SET NX EX = "set if not exists, with expiry". Returns 'OK' only if we
      // acquired the slot; null if another caller already triggered within the window.
      const acquired = await redis.set(
        VariantPersistenceService.MV_REFRESH_DEBOUNCE_KEY,
        '1',
        'PX',
        VariantPersistenceService.MV_REFRESH_DEBOUNCE_MS,
        'NX',
      );
      if (!acquired) {
        // Already refreshed within the window; return immediately
        return;
      }

      // Fire-and-forget: don't await, don't block persist return.
      this.db
        .run('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_latest_snapshots')
        .catch((err: Error) => {
          logger.warn('MV refresh failed (will retry on next debounce window)', {
            operation: 'maybeRefreshMaterializedView',
            error: err.message,
          });
        });
    } catch (err) {
      // Redis itself failed — log and skip the refresh. Persist must not fail
      // because the refresh debounce is unreachable.
      logger.warn('MV refresh debounce check failed (persist proceeds)', {
        operation: 'maybeRefreshMaterializedView',
        error: (err as Error).message,
      });
    }
  }
}

// ── Singleton accessor ──────────────────────────────────────────────────

let serviceInstance: VariantPersistenceService | null = null;

export async function getVariantPersistenceService(): Promise<VariantPersistenceService> {
  if (!serviceInstance) {
    const db = await DatabaseService.getInstance();
    serviceInstance = new VariantPersistenceService(db);
  }
  return serviceInstance;
}
