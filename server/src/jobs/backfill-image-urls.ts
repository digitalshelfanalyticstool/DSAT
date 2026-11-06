import type { DatabaseService } from '../services/database';
import { createLogger } from '../utils/logger';

const logger = createLogger('backfill-image-urls');

// Rough average bytes per product page fetch: HTML (~200KB)
// plus ~6 image requests at ~300KB each. Used until a real per-run
// bytes column lands on scrape_runs. Conservative high-side estimate.
const AVG_BYTES_PER_PRODUCT = 2_000_000;
const LOOKBACK_DAYS = 60;

interface RunOpts {
  db: Pick<DatabaseService, 'all'>;
  enqueueScrape: (params: { retailer: string; brand: string; reason: string }) => Promise<void>;
  maxProducts: number;
  dryRun?: boolean;
}

interface RunResult {
  pairs: Array<{ retailer: string; brand: string }>;
  enqueued: number;
  estimatedBytes: number;
}

export async function runBackfillImageUrls(opts: RunOpts): Promise<RunResult> {
  const { db, enqueueScrape, maxProducts, dryRun = false } = opts;

  const allPairs = await db.all<{ retailer: string; brand: string }>(`
    SELECT DISTINCT p.retailer, sr.brand
    FROM products p
    JOIN product_snapshots ps ON ps.product_id = p.id
    JOIN scrape_runs sr        ON sr.id = ps.scrape_run_id
    WHERE p.last_seen_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
    ORDER BY p.retailer, sr.brand
  `);
  const pairs = allPairs.slice(0, maxProducts);

  if (dryRun) {
    const estimatedBytes = AVG_BYTES_PER_PRODUCT * pairs.length;
    logger.info('Backfill dry run', { pairCount: pairs.length, estimatedBytes });
    return { pairs, enqueued: 0, estimatedBytes };
  }

  let enqueued = 0;
  for (const { retailer, brand } of pairs) {
    try {
      await enqueueScrape({ retailer, brand, reason: 'backfill-image-urls' });
      enqueued++;
    } catch (err) {
      logger.warn('Backfill enqueue failed for one pair', {
        retailer, brand, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Backfill enqueued', { pairCount: pairs.length, enqueued });
  return { pairs, enqueued, estimatedBytes: 0 };
}
