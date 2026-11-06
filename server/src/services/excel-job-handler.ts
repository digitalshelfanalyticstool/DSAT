/**
 * Excel Job Handler — moves Excel generation off the scrape pipeline's hot path.
 *
 * Excel generation inline on the scrape worker adds to its disk/CPU burst. By
 * dispatching it to a separate BullMQ queue with a
 * low concurrency cap (EXCEL_WORKER_CONCURRENCY, default 1 per process), simultaneous
 * Excel generations are serialized — flattening the burst into a longer plateau
 * without changing total work.
 *
 * Contract: the scrape orchestrator awaits this job (option "c"), so file_path on the
 * jobs row still means "file exists on disk." Future work can switch to fire-and-forget
 * (options "a"/"b") if scrape-throughput needs to be decoupled from Excel I/O too.
 *
 * Source of truth: variants are re-read from product_snapshots (joined with products)
 * by scrape_run_id, written by Phase 4.5. This keeps the BullMQ payload constant-size
 * regardless of brand catalog size and makes Excel jobs re-runnable for old scrapes.
 */

import { DatabaseService } from './database';
import { generateExcel } from './excel-generator';
import type { ProductVariant } from '../scrapers/site-adapter';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { inventoryInStock } from './inventory';
import type { ExcelJobPayload, ExcelJobResult } from './queues';

const logger = createLogger('excel-job-handler');


interface VariantRow {
  retailer: string;
  style_id: string;
  sku: string | null;
  upc: string | null;
  title: string;
  color: string | null;
  size: string | null;
  description: string | null;
  list_price: string | null;
  selling_price: string | null;
  url: string;
  source: string | null;
  item_number: string | null;
  inventory: string | null;
  product_type: string | null;
}

/**
 * Re-read the variants persisted in Phase 4.5 for a given scrape_run.
 * Returns rows shaped to ProductVariant (string fields, never null) so generateExcel
 * sees the same input it would have received from the in-memory pipeline.
 *
 * The WHERE clause adds an explicit
 *   ps.scraped_at >= NOW() - (snapshotRetentionDays || ' days')::INTERVAL
 * predicate. `scrape_run_id` alone is logically tight, but the planner can
 * not infer a partition-prune bound from it because product_snapshots is
 * RANGE-partitioned by `scraped_at` and there's no FK index that maps
 * scrape_run_id → scraped_at. Adding the explicit time bound lets Postgres
 * eliminate every monthly partition older than the retention window — the
 * difference between scanning 1 partition and scanning all of them.
 *
 * Retention bound source: `config.scraping.snapshotRetentionDays` (defaults
 * to 90, configurable via SNAPSHOT_RETENTION_DAYS env var). This intentionally
 * matches the db-retention reaper so we never request rows it would have
 * already pruned.
 */
export async function loadVariantsForScrapeRun(
  db: DatabaseService,
  scrapeRunId: number,
): Promise<ProductVariant[]> {
  const retentionDays = config.scraping.snapshotRetentionDays;
  const rows = await db.all<VariantRow>(
    `SELECT p.retailer, p.style_id, ps.sku, ps.upc, p.title,
            ps.color, ps.size, p.description, ps.list_price, ps.selling_price,
            p.url, p.source, ps.item_number, ps.inventory,
            p.product_type
       FROM product_snapshots ps
       JOIN products p ON p.id = ps.product_id
      WHERE ps.scrape_run_id = $1
        AND ps.scraped_at >= NOW() - ($2 || ' days')::INTERVAL
      ORDER BY p.style_id, ps.color, ps.size`,
    scrapeRunId, String(retentionDays),
  );

  return exportableVariants(rows.map((r) => ({
    retailer: r.retailer ?? '',
    style_id: r.style_id ?? '',
    sku: r.sku ?? '',
    upc: r.upc ?? '',
    title: r.title ?? '',
    color: r.color ?? '',
    size: r.size ?? '',
    description: r.description ?? '',
    list_price: r.list_price ?? '',
    selling_price: r.selling_price ?? '',
    url: r.url ?? '',
    source: r.source ?? '',
    item_number: r.item_number ?? '',
    inventory: r.inventory ?? '',
    image_url: '',
    product_type: r.product_type ?? '',
  })), scrapeRunId);
}

/**
 * The variants an export contains: every variant except those positively out
 * of stock. The one content rule for every Excel file, including the inline
 * fallback when persist failed and nothing is in Postgres to read.
 */
export function exportableVariants(variants: ProductVariant[], scrapeRunId?: number): ProductVariant[] {
  const kept = variants.filter((v) => inventoryInStock(v.inventory) !== false);
  if (kept.length < variants.length) {
    logger.info('Excluded out-of-stock variants from Excel export', {
      operation: 'exportableVariants', scrapeRunId, excludedCount: variants.length - kept.length,
    });
  }
  return kept;
}

/** Write the Excel file for one persisted scrape run. The one export path. */
export async function exportScrapeRun(
  scrapeRunId: number,
  outputPath: string,
  siteName: string,
  brand: string,
): Promise<{ filePath: string; variantCount: number }> {
  const db = await DatabaseService.getInstance();
  const variants = await loadVariantsForScrapeRun(db, scrapeRunId);
  if (variants.length === 0) {
    logger.warn('Scrape run has no exportable variants — generating empty workbook', {
      operation: 'exportScrapeRun', scrapeRunId,
    });
  }
  const filePath = await generateExcel(variants, outputPath, siteName, brand);
  return { filePath, variantCount: variants.length };
}

export async function handleExcelJob(payload: ExcelJobPayload): Promise<ExcelJobResult> {
  const start = Date.now();
  const { jobId, siteName, brand, scrapeRunId, outputPath } = payload;

  logger.info('Processing excel job', {
    operation: 'handleExcelJob', jobId, siteName, brand, scrapeRunId, outputPath,
  });

  const { filePath, variantCount } = await exportScrapeRun(scrapeRunId, outputPath, siteName, brand);
  const durationMs = Date.now() - start;

  logger.info('Excel job completed', {
    operation: 'handleExcelJob', jobId, scrapeRunId, filePath, variantCount, durationMs,
  });

  return { filePath, variantCount, durationMs };
}
