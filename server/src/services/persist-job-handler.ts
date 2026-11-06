/**
 * Persist Job Handler — moves DB persistence (Phase 4.5) off the scrape pipeline's hot path.
 *
 * Persist (variant-persistence-service.persistVariants — bulk INSERT into product_snapshots,
 * upsert into products, change-detection JOIN) is a large disk-write burst. Like Excel
 * generation, it runs on its own queue so simultaneous
 * persist transactions across multiple concurrent scrapes are serialised by a low concurrency
 * cap (PERSIST_WORKER_CONCURRENCY, default 1 per worker process).
 *
 * Payload contains mergedVariants directly (BullMQ serialises to JSON in Redis). Typical size
 * is 25–125KB per job (100–500 variants × ~250 bytes JSON each). At a 4-brand × 4-retailer
 * burst that's ~1–2 MB transient Redis memory — acceptable. If brand catalogs grow past
 * ~1k products per (brand, retailer), revisit by streaming variants to a temp Redis key
 * referenced from the payload instead of inlining them.
 *
 * Failure semantics: persistence failure is treated as non-fatal at the orchestrator level
 * (matching the pre-queue inline behavior). On permanent failure (after BullMQ's 3 retries),
 * the orchestrator catches, logs, and returns scrape_run_id = null — Excel falls back to
 * inline generation against in-memory variants.
 */

import { getVariantPersistenceService } from './variant-persistence-service';
import { createLogger } from '../utils/logger';
import { runAlerts } from './alerts/alert-service';
import { enqueueWebhookDelivery } from './alerts/webhooks';
import type { PersistJobPayload, PersistJobResult } from './queues';

const logger = createLogger('persist-job-handler');

export async function handlePersistJob(payload: PersistJobPayload): Promise<PersistJobResult> {
  const { jobId, siteName, brand, variants } = payload;

  logger.info('Processing persist job', {
    operation: 'handlePersistJob', jobId, siteName, brand, variantCount: variants.length,
  });

  const persistService = await getVariantPersistenceService();
  const result = await persistService.persistVariants(jobId, siteName, brand, variants);

  logger.info('Persist job completed', {
    operation: 'handlePersistJob', jobId,
    scrape_run_id: result.scrape_run_id,
    products_upserted: result.products_upserted,
    snapshots_inserted: result.snapshots_inserted,
    duration_ms: result.duration_ms,
  });

  // Alerts are a side effect of the run: a failure here must not fail (and so
  // retry) the persist job, which has already committed.
  await runAlerts(result.scrape_run_id, { notify: enqueueWebhookDelivery }).catch((err: unknown) => {
    logger.warn('Alert evaluation failed', {
      operation: 'handlePersistJob', jobId, scrape_run_id: result.scrape_run_id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return result;
}
