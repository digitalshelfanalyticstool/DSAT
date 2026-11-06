/**
 * CacheMetricsTracker — accumulates per-job cache hit/miss counters so operators
 * can tune DISCOVERY_CACHE_TTL_HOURS and VARIANT_CACHE_TTL_HOURS based on real
 * data instead of guessing.
 *
 * Three decision points are recorded per scrape job:
 *   1. Discovery cache (hit | miss) — boolean, single decision per job
 *   2. Variant cache TTL skip (hit count, miss count) — Phase 2
 *   3. Cache-fill (hit count, miss count) — Phase 4 substitutes cached snapshots
 *      for products that failed Phase 2 + retry
 *
 * Persistence: counters are read by VariantPersistenceService at scrape_runs
 * INSERT time and written into the new columns added by migration 39. Lifecycle
 * matches BandwidthTracker — start at job entry, finalize at job completion,
 * clear if cancelled.
 *
 * On unknown jobId, all setters log a warn and no-op so a forgotten startJob
 * doesn't break the scrape pipeline.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('cache-metrics-tracker');

export interface CacheMetrics {
  /** True if the discovery phase was served entirely from the catalog cache. */
  discoveryCacheHit: boolean;
  /** Products skipped in Phase 2 because their variant cache was within TTL. */
  variantCacheHits: number;
  /** Products that needed a fresh variant fetch in Phase 2. */
  variantCacheMisses: number;
  /** Failed products in Phase 4 substituted by a cached snapshot. */
  cacheFillHits: number;
  /** Failed products in Phase 4 still missing after the cache lookup. */
  cacheFillMisses: number;
}

const ZERO_METRICS: CacheMetrics = Object.freeze({
  discoveryCacheHit: false,
  variantCacheHits: 0,
  variantCacheMisses: 0,
  cacheFillHits: 0,
  cacheFillMisses: 0,
});

export class CacheMetricsTracker {
  private readonly jobContexts: Map<string, CacheMetrics> = new Map();

  /** Initialize a fresh metrics context for a job. Idempotent. */
  startJob(jobId: string): void {
    this.jobContexts.set(jobId, { ...ZERO_METRICS });
    logger.debug('Cache metrics tracking started', { operation: 'startJob', jobId });
  }

  recordDiscoveryDecision(jobId: string, hit: boolean): void {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) {
      logger.warn('recordDiscoveryDecision called for unknown job, ignoring', {
        operation: 'recordDiscoveryDecision', jobId,
      });
      return;
    }
    ctx.discoveryCacheHit = hit;
  }

  recordVariantCacheDecision(jobId: string, hits: number, misses: number): void {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) {
      logger.warn('recordVariantCacheDecision called for unknown job, ignoring', {
        operation: 'recordVariantCacheDecision', jobId,
      });
      return;
    }
    ctx.variantCacheHits += hits;
    ctx.variantCacheMisses += misses;
  }

  recordCacheFillDecision(jobId: string, hits: number, misses: number): void {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) {
      logger.warn('recordCacheFillDecision called for unknown job, ignoring', {
        operation: 'recordCacheFillDecision', jobId,
      });
      return;
    }
    ctx.cacheFillHits += hits;
    ctx.cacheFillMisses += misses;
  }

  /**
   * Read accumulated metrics for a job. Returns the zero-record (all defaults)
   * when the job was never started — keeps the persistence layer simple
   * (always-present, never undefined).
   */
  getMetrics(jobId: string): CacheMetrics {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) return { ...ZERO_METRICS };
    return { ...ctx };
  }

  /** Drop the in-memory context. Call after persisting. */
  clearJob(jobId: string): void {
    this.jobContexts.delete(jobId);
  }
}

let instance: CacheMetricsTracker | null = null;

export function getCacheMetricsTracker(): CacheMetricsTracker {
  instance ??= new CacheMetricsTracker();
  return instance;
}
