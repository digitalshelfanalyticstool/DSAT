/**
 * Scraper Orchestrator — coordinates the end-to-end scraping workflow.
 *
 * 5-phase workflow with cumulative product catalog and variant caching:
 *   1. Product discovery — the site's adapter turns brand listing pages into product
 *      URLs, merged into the persistent product catalog (products accumulate across runs)
 *   2. Variant fetch — each product page is fetched through the scraping provider and
 *      turned into variant rows by the adapter
 *   3. Retry pass — re-fetches any products that failed in phase 2
 *   4. Cache fill — for any products still failed after retry, uses cached variant
 *      data from the last successful fetch (ensures consistent output every run)
 *   5. Excel generation from merged results
 *
 * The variant cache means product/variant counts are identical across runs unless
 * a retailer genuinely adds or removes products from their catalog.
 */

import { config } from '../config';
import { fetchViaUnlocker } from '../scrapers/page-fetcher';
import { getAdapter, type RetailerAdapter, type SiteConfig } from '../adapters';
import { generateExcel, buildOutputPath } from './excel-generator';
import { exportableVariants } from './excel-job-handler';
import { getSites } from './config-manager';
import { saveCheckpoint, deleteCheckpoint } from './checkpoint-manager';
import type { Checkpoint } from './checkpoint-manager';
import type { ProductVariant } from '../scrapers/site-adapter';
import { createLogger } from '../utils/logger';
import { mergeCatalog, getCatalogUrls, recordFailures, loadVariantCache, updateVariantCache, getCachedVariants, isDiscoveryCacheFresh, getStaleProductIds, normalizeCacheEntry } from './product-catalog';
import { getJobStore, type ProgressUpdate } from './job-store';
import type { QueueService } from './queue-service';
import { getProgressBus } from './progress-bus';
import { getBandwidthTracker } from './bandwidth-tracker';
import { getCacheMetricsTracker } from './cache-metrics-tracker';
import { getVariantPersistenceService } from './variant-persistence-service';
import { runDiscovery } from './scraper-discovery';
import {
  fetchPDPVariants,
  computeRetryConcurrency,
} from './scraper-extraction';

const logger = createLogger('scraper-orchestrator');

/** Number of parallel discovery runs. Defaults to 2 for redundancy; set to 1 to save API costs. */
const DISCOVERY_RUNS = config.scraping.discoveryRuns;

/** Discovery cache TTL in ms. Skip discovery if the last one is younger than this. Default: 24 hours. */
const DISCOVERY_CACHE_TTL_MS = config.scraping.discoveryCacheTtlHours * 3_600_000;

/** Variant cache TTL in ms. Skip re-fetching products whose cached variants are younger than this. Default: 24 hours. */
const VARIANT_CACHE_TTL_MS = config.scraping.variantCacheTtlHours * 3_600_000;

/** Retry concurrency multiplier. Defaults to 2; set to 1 to use same concurrency as initial fetch. */
const RETRY_CONCURRENCY_MULTIPLIER = config.scraping.retryConcurrencyMultiplier;

/** Listing pages walked per discovery run. */
const DISCOVERY_MAX_PAGES = 8;

/** Fetch one page for an adapter's discovery, through the active scraping provider. */
function discoveryFetcher(adapter: RetailerAdapter, jobId: string) {
  return async (url: string, opts?: { render?: boolean }): Promise<string> => {
    const result = await fetchViaUnlocker(url, undefined, jobId, opts?.render ?? adapter.needsRender ?? false);
    if (!result.success) throw new Error(result.error ?? `Fetch failed: ${url}`);
    return result.content;
  };
}

/**
 * Product page URLs for the given ids: the URL discovery recorded in the
 * catalog, else the adapter's `productUrl` rebuild. Ids with neither are skipped.
 */
async function resolveProductUrls(
  ids: string[], adapter: RetailerAdapter, site: SiteConfig, brand: string,
): Promise<{ urls: string[]; unresolved: string[] }> {
  const known = await getCatalogUrls(site.name, brand, adapter.id);
  const urls = new Set<string>();
  const unresolved: string[] = [];
  for (const id of ids) {
    const url = known.get(id) ?? adapter.productUrl?.(id, site) ?? null;
    if (url) urls.add(url);
    else unresolved.push(id);
  }
  return { urls: [...urls], unresolved };
}

export interface ScrapeResult {
  file_path: string;
  /**
   * scrape_runs.id from Phase 4.5 persist. When non-null, the worker dispatches
   * Excel generation to the excel-jobs queue (low-concurrency, off the hot path).
   * When null, scrapeSite has already generated the file inline at file_path.
   */
  scrape_run_id: number | null;
  products_discovered: number;
  products_processed: number;
  variants_extracted: number;
  failed_products: string[];
  phase_timings: PhaseTimings;
}

/** Per-phase duration map (ms). */
export interface PhaseTimings {
  [phaseName: string]: number;
}

/**
 * Start a phase timer. Returns a stop function that records the duration
 * into the provided `timings` map and returns the elapsed ms.
 */
export function startPhaseTimer(phase: string, timings: PhaseTimings): () => number {
  const start = Date.now();
  return () => {
    const duration = Date.now() - start;
    timings[phase] = duration;
    return duration;
  };
}

/**
 * Publish a progress update to both PostgreSQL and Redis Pub/Sub.
 * Only writes progress-related fields — never lifecycle fields (status, started_at, completed_at).
 */
async function updateProgress(
  jobId: string,
  progress: ProgressUpdate,
  queueService?: QueueService,
): Promise<void> {
  const store = await getJobStore();
  await store.update(jobId, progress);

  if (queueService) {
    await getProgressBus().publishProgress(jobId, {
      jobId,
      status: 'running',
      ...progress,
    });
  }
}

export interface ScraperOptions {
  checkpoint?: Checkpoint;
  queueService?: QueueService;
  /**
   * Best-effort hook fired after the last Bright-Data-billing phase completes
   * (Phase 4: cache-fill) and before Phase 4.5 (DB persist) begins. Used by the
   * worker to release the per-retailer rate-limit token early — persist + Excel
   * run via separate queues and shouldn't pin the rate-limit slot for their wait
   * time. Errors thrown by the callback are caught and logged; they do not
   * abort the scrape pipeline.
   */
  onBrightDataPhasesComplete?: () => Promise<void>;
  /**
   * Aborted when the job is cancelled or times out. Checked at every phase
   * boundary and between product-page fetches; the run then throws the
   * signal's reason instead of continuing to spend provider requests.
   */
  signal?: AbortSignal;
}

/**
 * Invoke the optional onBrightDataPhasesComplete hook with try/catch.
 * Exported so tests can exercise the contract directly without setting up the
 * full scrapeSite() pipeline. Hook errors are warned, never re-thrown — the
 * scrape pipeline must continue even if the worker's rate-limit release fails.
 */
export async function tryInvokeOnBrightDataPhasesComplete(
  hook: (() => Promise<void>) | undefined,
  jobId: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch (hookErr) {
    logger.warn('onBrightDataPhasesComplete hook failed (non-fatal)', {
      operation: 'scrapeSite',
      jobId,
      error: hookErr instanceof Error ? hookErr.message : String(hookErr),
    });
  }
}

/**
 * Run Phase 4.5 (variant persistence) — via the persist-jobs queue when queueService
 * is provided (production), inline otherwise (tests / direct invocation). Returns
 * scrape_run_id on success or null on failure (non-fatal — Excel falls back to
 * inline generation against in-memory variants when scrape_run_id is null).
 *
 * Pulled out of scrapeSite() to keep that function's body linear (no branching for
 * Phase 4.5) — preserves the pre-existing cognitive complexity baseline.
 */
async function runPersistPhase(
  jobId: string,
  siteName: string,
  brand: string,
  mergedVariants: ProductVariant[],
  queueService: QueueService | undefined,
): Promise<number | null> {
  try {
    const result = queueService
      ? await queueService.runPersistJob({ jobId, siteName, brand, variants: mergedVariants })
      : await (await getVariantPersistenceService()).persistVariants(jobId, siteName, brand, mergedVariants);

    logger.info('Phase 4.5 complete: Variant data persisted to database', {
      operation: 'scrapeSite', jobId,
      scrape_run_id: result.scrape_run_id,
      products_upserted: result.products_upserted,
      snapshots_inserted: result.snapshots_inserted,
      duration_ms: result.duration_ms,
      mode: queueService ? 'queued' : 'inline',
    });
    return result.scrape_run_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Phase 4.5 failed: Variant persistence error (non-fatal)', {
      operation: 'scrapeSite', jobId, error: message,
    });
    return null;
  }
}

/**
 * Generate Excel inline only when Phase 4.5 (DB persist) failed and the worker
 * therefore can't reload variants from PG via the excel-jobs queue. When persist
 * succeeded, this is a no-op pass-through that returns the deterministic outputPath;
 * the worker dispatches generation to the queue after scrapeSite returns.
 *
 * Pulled out of scrapeSite() to keep that function's body linear (no branching
 * for Phase 5) — preserves the pre-existing cognitive complexity baseline.
 */
async function maybeGenerateExcelInline(
  scrapeRunId: number | null,
  mergedVariants: ProductVariant[],
  outputPath: string,
  siteName: string,
  brand: string,
  jobId: string,
  queueService: QueueService | undefined,
  phaseTimings: PhaseTimings,
): Promise<string> {
  if (scrapeRunId !== null) return outputPath;

  // Degraded path: DB persistence failed (scrapeRunId is null), so variants come
  // from in-memory data only.
  const stopExcel = startPhaseTimer('excel', phaseTimings);
  await updateProgress(jobId, { phase: 'excel' }, queueService);
  logger.warn('Generating Excel inline (Phase 4.5 persist failed)', {
    operation: 'scrapeSite', jobId, variantCount: mergedVariants.length,
  });
  const filePath = await generateExcel(exportableVariants(mergedVariants), outputPath, siteName, brand);
  const excelDuration = stopExcel();
  await updateProgress(jobId, {
    phase_name: 'excel', phase_duration_ms: excelDuration,
  }, queueService);
  return filePath;
}

/**
 * Run the full scraping workflow for a job.
 *
 * Phase 1: Run e-commerce scraping tool Nx in parallel → merge & dedupe product IDs
 * Phase 2: Fetch each product page and extract variants with the site's adapter
 * Phase 3: Retry failed products
 * Phase 4: Cache fill from previous runs
 * Phase 5: Generate Excel
 *
 * If options.checkpoint is provided, skips completed phases and resumes from the
 * checkpoint phase using persisted data.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- scraper hot path: 5-phase orchestrator with checkpoint resume; each phase reads best top to bottom. NOSONAR(typescript:S3776).
export async function scrapeSite(
  jobId: string,
  siteName: string,
  brand: string,
  options?: ScraperOptions,
): Promise<ScrapeResult> {
  const queueService = options?.queueService;
  const onBrightDataPhasesComplete = options?.onBrightDataPhasesComplete;
  const signal = options?.signal;

  // Per-phase timing accumulator, reported with progress events.
  const phaseTimings: PhaseTimings = {};

  // Start bandwidth tracking for this job
  const bandwidthTracker = getBandwidthTracker();
  if (bandwidthTracker) {
    bandwidthTracker.startJob(jobId);
  }

  // Start cache hit/miss tracking for this job — counters persist into
  // scrape_runs at end-of-pipeline so operators can tune cache TTLs.
  const cacheMetricsTracker = getCacheMetricsTracker();
  cacheMetricsTracker.startJob(jobId);

  try {

    // ── Checkpoint resume logic ─────────────────────────────────────
    // Every checkpoint is written after discovery; 'variants' and 'retry' are
    // also written after the product pages were fetched.
    const checkpoint = options?.checkpoint;
    const fetchCheckpoint = checkpoint && checkpoint.phase !== 'processing' ? checkpoint.data : undefined;

    if (checkpoint) {
      logger.info('Resuming job from checkpoint', {
        operation: 'scrapeSite', jobId,
        checkpointPhase: checkpoint.phase,
      });
    }

    // ── Phase 1: Product Discovery ──────────────────────────────────

    // These variables are populated by Phase 1 or loaded from checkpoint
    let discoveredIds: string[] = [];
    let perRunStats: { items: number; products: number }[] = [];
    let productIds: string[] = [];
    let newIds: string[] = [];
    let totalKnown = 0;

    const sites = await getSites();
    const siteConfig = sites.find(s => s.name.toLowerCase() === siteName.toLowerCase());
    if (!siteConfig) throw new Error(`Site configuration not found for "${siteName}"`);
    if (!siteConfig.enabled) throw new Error(`Site "${siteName}" is disabled`);
    const adapter = getAdapter(siteConfig.adapter);

    if (checkpoint) {
      // Resume from checkpoint — skip discovery, load checkpoint data
      // No discovery timer — phase was skipped
      productIds = checkpoint.data.product_ids;
      if (checkpoint.phase === 'processing') discoveredIds = checkpoint.data.discovered_ids;

      logger.info('Skipping Phase 1: Using checkpoint data', {
        operation: 'scrapeSite', jobId,
        checkpointPhase: checkpoint.phase,
        productIds: productIds.length,
      });

      await updateProgress(jobId, {
        products_discovered: productIds.length,
        phase: 'processing',
      }, queueService);
    } else {
      // Normal discovery flow — check discovery cache first
    const stopDiscovery = startPhaseTimer('discovery', phaseTimings);
    signal?.throwIfAborted();
    await updateProgress(jobId, { phase: 'discovery' }, queueService);

    // Check if discovery cache is fresh enough to skip discovery entirely
    let discoveryCacheUsed = false;
    if (DISCOVERY_CACHE_TTL_MS > 0) {
      const cacheResult = await isDiscoveryCacheFresh(siteName, brand, adapter.id, DISCOVERY_CACHE_TTL_MS);
      if (cacheResult.fresh && cacheResult.activeIds.length > 0) {
        discoveryCacheUsed = true;
        productIds = cacheResult.activeIds;
        discoveredIds = [];
        newIds = [];
        totalKnown = productIds.length;

        logger.info('Phase 1: Skipping discovery — discovery cache is fresh', {
          operation: 'scrapeSite', jobId, siteName, brand,
          activeProducts: productIds.length,
          cacheTtlHours: DISCOVERY_CACHE_TTL_MS / 3_600_000,
        });
      }
    }
    cacheMetricsTracker.recordDiscoveryDecision(jobId, discoveryCacheUsed);

    if (!discoveryCacheUsed) {
    logger.info('Phase 1: Starting product discovery', {
      operation: 'scrapeSite', jobId, siteName, brand,
      method: 'bright-data',
    });

    const brandUrl = siteConfig.brand_urls?.[brand.toLowerCase()];
    logger.info('Running product discovery', {
      operation: 'scrapeSite', jobId, siteName, adapter: adapter.id,
      brandUrlSource: brandUrl ? 'brand_urls' : 'listing_url_template',
    });
    const fetchPage = discoveryFetcher(adapter, jobId);
    const productUrls = await runDiscovery(
      () => adapter.discover({ brand, brandUrl, site: siteConfig, fetchPage, maxPages: DISCOVERY_MAX_PAGES }),
      DISCOVERY_RUNS,
    );

    // Extract product IDs from discovered URLs
    const urlById: Record<string, string> = {};
    for (const url of productUrls) urlById[adapter.productId(url)] ??= url;
    discoveredIds = Object.keys(urlById);

    perRunStats = [{ items: productUrls.length, products: discoveredIds.length }];

    logger.info('Product discovery complete', {
      operation: 'scrapeSite', jobId, siteName,
      urlsFound: productUrls.length,
      uniqueProducts: discoveredIds.length,
    });

    // Merge with cumulative catalog — includes products from all previous runs
    const catalogResult = await mergeCatalog(
      siteName, brand, adapter.id, discoveredIds, urlById,
    );
    productIds = catalogResult.activeIds;
    newIds = catalogResult.newIds;
    totalKnown = catalogResult.totalKnown;

    if (productIds.length === 0) {
      throw new Error('No products found — discovery returned 0 and no existing catalog products available');
    }
    } // end if (!discoveryCacheUsed)

    await updateProgress(jobId, {
      products_discovered: productIds.length,
      phase: 'processing',
    }, queueService);

    logger.info('Phase 1 complete: Discovery + catalog merge', {
      operation: 'scrapeSite', jobId,
      discoveryRuns: DISCOVERY_RUNS,
      discoveryCacheUsed,
      perRunStats,
      discoveredThisRun: discoveredIds.length,
      newProducts: newIds.length,
      totalCatalogKnown: totalKnown,
      activeForFetch: productIds.length,
    });

    const discoveryDuration = stopDiscovery();
    logger.info('Phase timing: discovery', {
      operation: 'scrapeSite', jobId,
      phase: 'discovery',
      phase_duration_ms: discoveryDuration,
    });

    // Publish discovery phase timing in progress event
    await updateProgress(jobId, {
      phase: 'processing',
      phase_name: 'discovery',
      phase_duration_ms: discoveryDuration,
    }, queueService);

    // Save discovery/processing checkpoint
    try {
      await saveCheckpoint(jobId, 'processing', {
        discovered_ids: discoveredIds,
        product_ids: productIds,
        new_ids: newIds,
        total_known: totalKnown,
      });
    } catch (cpErr) {
      logger.warn('Failed to save processing checkpoint — continuing without', {
        operation: 'scrapeSite', jobId, error: (cpErr as Error).message,
      });
    }

    } // end of else (normal discovery flow)

    // ── Phase 2: Variant Fetch ──────────────────────────────────────

    let allVariants: ProductVariant[] = [];
    let failedProducts: string[] = [];
    // Permanent failures (HTTP 404/410/451 etc.), tracked separately so
    // Phase 3 can skip retrying them.
    let permanentFailedProducts: string[] = [];
    // Variants fetched this attempt by catalog product id: what the variant cache stores.
    let fetchedByProduct: Record<string, ProductVariant[]> = {};
    // Variants served from the variant cache's TTL instead of fetched.
    const ttlCachedVariants: ProductVariant[] = [];

    if (fetchCheckpoint) {
      // Skip variant fetch — load from checkpoint
      // No variants timer — phase was skipped
      fetchedByProduct = fetchCheckpoint.fetched;
      ttlCachedVariants.push(...fetchCheckpoint.cached);
      allVariants = [...Object.values(fetchedByProduct).flat(), ...ttlCachedVariants];
      failedProducts = fetchCheckpoint.failed_products;
      permanentFailedProducts = fetchCheckpoint.permanent_failed;

      logger.info('Skipping Phase 2: Using checkpoint variant data', {
        operation: 'scrapeSite', jobId,
        variants: allVariants.length,
        failedProducts: failedProducts.length,
        permanentFailed: permanentFailedProducts.length,
      });
    } else {
    const stopVariants = startPhaseTimer('variants', phaseTimings);
    signal?.throwIfAborted();
    await updateProgress(jobId, { phase: 'variants' }, queueService);

    // ── Variant Cache TTL: skip products with fresh cached data ──
    let variantCacheTtlSkipped = 0;
    let idsToFetch = productIds;

    if (VARIANT_CACHE_TTL_MS > 0) {
      const variantCache = await loadVariantCache(siteName, brand, adapter.id);
      const { staleIds, freshIds } = getStaleProductIds(variantCache, productIds, VARIANT_CACHE_TTL_MS);

      cacheMetricsTracker.recordVariantCacheDecision(jobId, freshIds.length, staleIds.length);

      if (freshIds.length > 0) {
        variantCacheTtlSkipped = freshIds.length;
        idsToFetch = staleIds;

        // Collect cached variants for fresh products
        for (const id of freshIds) {
          const raw = variantCache.products[id];
          if (raw) {
            const entry = normalizeCacheEntry(raw);
            ttlCachedVariants.push(...entry.variants);
          }
        }

        logger.info('Variant cache TTL: skipping fresh products', {
          operation: 'scrapeSite', jobId,
          totalProducts: productIds.length,
          freshSkipped: freshIds.length,
          staleToFetch: staleIds.length,
          cachedVariants: ttlCachedVariants.length,
          ttlHours: VARIANT_CACHE_TTL_MS / 3_600_000,
        });
      }
    } else {
      // TTL disabled — every product is a "miss" (forced fresh fetch). Recording
      // this keeps the hit-rate denominator honest for ops dashboards.
      cacheMetricsTracker.recordVariantCacheDecision(jobId, 0, productIds.length);
    }

    logger.info('Phase 2: Fetching variants via product pages', {
      operation: 'scrapeSite', jobId, siteName, adapter: adapter.id,
      skippedByCache: variantCacheTtlSkipped,
    });

    const { urls: productUrls, unresolved } = await resolveProductUrls(idsToFetch, adapter, siteConfig, brand);
    if (unresolved.length > 0) {
      // No URL to fetch: count them as permanent failures so they go stale instead of lingering.
      logger.warn('Products with no known URL skipped', {
        operation: 'scrapeSite', jobId, siteName, unresolved: unresolved.length,
      });
    }

    const pdpResult = await fetchPDPVariants(
      productUrls,
      adapter,
      siteConfig,
      async (fetched: number) => {
        await updateProgress(jobId, {
          products_processed: variantCacheTtlSkipped + fetched,
          variants_extracted: 0,
        }, queueService).catch((err) => { logger.warn('Failed to update progress', { operation: 'updateProgress', error: err instanceof Error ? err.message : String(err) }); });
      },
      jobId,
      undefined,
      signal,
    );

    allVariants = [...pdpResult.variants, ...ttlCachedVariants];
    fetchedByProduct = pdpResult.byProduct;
    failedProducts = pdpResult.failed;
    // Capture permanent failures separately so Phase 3 can skip
    // retrying URLs that returned 404/410/451 — saves render=true cost.
    permanentFailedProducts = [...pdpResult.permanentFailed, ...unresolved];

    logger.info('Phase 2 complete: Initial fetch done', {
      operation: 'scrapeSite', jobId,
      productsProcessed: productIds.length,
      variantsExtracted: allVariants.length,
      failedProducts: failedProducts.length,
    });

    const variantsDuration = stopVariants();
    logger.info('Phase timing: variants', {
      operation: 'scrapeSite', jobId,
      phase: 'variants',
      phase_duration_ms: variantsDuration,
    });

    // Publish variants phase timing in progress event
    await updateProgress(jobId, {
      phase: 'retry',
      phase_name: 'variants',
      phase_duration_ms: variantsDuration,
    }, queueService);

    // Save variants checkpoint
    try {
      await saveCheckpoint(jobId, 'variants', {
        product_ids: productIds,
        fetched: fetchedByProduct,
        cached: ttlCachedVariants,
        failed_products: failedProducts,
        permanent_failed: permanentFailedProducts,
      });
    } catch (cpErr) {
      logger.warn('Failed to save variants checkpoint — continuing without', {
        operation: 'scrapeSite', jobId, error: (cpErr as Error).message,
      });
    }

    } // end of else (normal variant fetch)

    // ── Phase 3: Retry Failed Products ────────────────────────────
    const stopRetry = startPhaseTimer('retry', phaseTimings);
    let retryVariants: ProductVariant[] = [];
    // After the retry: transient failures, and products the retry found permanently gone.
    let stillFailed: string[] = failedProducts;
    let retryPermanent: string[] = [];

    // Products that returned permanent failures
    // (HTTP 404/410/451) in Phase 2 are excluded from retry — render=true
    // fetches won't rescue a dead URL. They still count as failures and flow
    // into recordFailures at end of pipeline so consecutive_failures advances.
    if (permanentFailedProducts.length > 0) {
      logger.info('Phase 3: Skipping retry for permanently failed products', {
        operation: 'scrapeSite', jobId,
        permanentSkipped: permanentFailedProducts.length,
        retryInput: failedProducts.length,
      });
    }

    // Compute retry concurrency: base × multiplier, capped at max
    const retryConcurrency = computeRetryConcurrency(
      20, // base concurrency (unlocker default)
      RETRY_CONCURRENCY_MULTIPLIER,
      200, // max concurrency cap
    );

    if (failedProducts.length > 0) {
      const { urls: retryUrls } = await resolveProductUrls(failedProducts, adapter, siteConfig, brand);

      if (retryUrls.length > 0) {
        logger.info('Phase 3: Retrying failed products via product pages', {
          operation: 'scrapeSite', jobId, failedCount: retryUrls.length,
          retryConcurrency: retryConcurrency,
        });

        const retryResult = await fetchPDPVariants(
          retryUrls,
          adapter,
          siteConfig,
          async (fetched) => {
            await updateProgress(jobId, {
              products_processed: (productIds.length - failedProducts.length) + fetched,
            }, queueService).catch((err) => { logger.warn('Failed to update progress', { operation: 'updateProgress', error: err instanceof Error ? err.message : String(err) }); });
          },
          jobId,
          retryConcurrency,
          signal,
        );

        retryVariants = retryResult.variants;
        fetchedByProduct = { ...fetchedByProduct, ...retryResult.byProduct };
        stillFailed = retryResult.failed;
        retryPermanent = retryResult.permanentFailed;
      }

      logger.info('Phase 3 complete: Retry results', {
        operation: 'scrapeSite', jobId,
        retried: failedProducts.length,
        recovered: failedProducts.length - stillFailed.length - retryPermanent.length,
        stillFailed: stillFailed.length + retryPermanent.length,
        retryVariants: retryVariants.length,
      });
    }

    // Every failure, including the Phase-2 permanent ones that skipped retry,
    // is persisted, recorded into the catalog (consecutive_failures) and
    // surfaced in stats.
    let finalFailed = [...stillFailed, ...retryPermanent, ...permanentFailedProducts];

    const retryDuration = stopRetry();
    logger.info('Phase timing: retry', {
      operation: 'scrapeSite', jobId,
      phase: 'retry',
      phase_duration_ms: retryDuration,
    });

    // Publish retry phase timing in progress event
    await updateProgress(jobId, {
      phase: 'cache_fill',
      phase_name: 'retry',
      phase_duration_ms: retryDuration,
    }, queueService);

    // Merge all fresh variants
    const freshVariants = [...allVariants, ...retryVariants];

    // Save retry checkpoint
    try {
      await saveCheckpoint(jobId, 'retry', {
        product_ids: productIds,
        fetched: fetchedByProduct,
        cached: ttlCachedVariants,
        failed_products: stillFailed,
        permanent_failed: [...permanentFailedProducts, ...retryPermanent],
      });
    } catch (cpErr) {
      logger.warn('Failed to save retry checkpoint — continuing without', {
        operation: 'scrapeSite', jobId, error: (cpErr as Error).message,
      });
    }

    // Save fresh variants to cache for future fallback
    await updateVariantCache(siteName, brand, adapter.id, fetchedByProduct);

    // ── Phase 4: Fill gaps from cache ───────────────────────────────
    const stopCacheFill = startPhaseTimer('cache_fill', phaseTimings);
    let mergedVariants = freshVariants;
    let cachedFillCount = 0;

    if (finalFailed.length > 0) {
      const cache = await loadVariantCache(siteName, brand, adapter.id);
      const { cachedVariants, uncachedIds } = getCachedVariants(cache, finalFailed);

      // Hits = failed products successfully filled from cache; misses = still missing.
      cacheMetricsTracker.recordCacheFillDecision(
        jobId,
        finalFailed.length - uncachedIds.length,
        uncachedIds.length,
      );

      if (cachedVariants.length > 0) {
        mergedVariants = [...freshVariants, ...cachedVariants];
        cachedFillCount = finalFailed.length - uncachedIds.length;

        logger.info('Phase 4: Filled gaps from variant cache', {
          operation: 'scrapeSite', jobId,
          failedProducts: finalFailed.length,
          filledFromCache: cachedFillCount,
          cachedVariants: cachedVariants.length,
          stillMissing: uncachedIds.length,
        });

        finalFailed = uncachedIds;
      }
    }

    const productsProcessed = productIds.length - finalFailed.length;

    // Record failures in catalog (increments consecutive_failures counter)
    await recordFailures(siteName, brand, adapter.id, finalFailed);

    const cacheFillDuration = stopCacheFill();
    logger.info('Phase timing: cache_fill', {
      operation: 'scrapeSite', jobId,
      phase: 'cache_fill',
      phase_duration_ms: cacheFillDuration,
    });

    // Publish cache_fill phase timing in progress event
    await updateProgress(jobId, {
      phase: 'excel',
      phase_name: 'cache_fill',
      phase_duration_ms: cacheFillDuration,
    }, queueService);

    await updateProgress(jobId, {
      products_processed: productsProcessed,
      variants_extracted: mergedVariants.length,
    }, queueService);

    // ── Bright-Data billing phases done ─────────────────────────────
    // Phases 1–4 are the only ones that hit Bright Data; persist (4.5) and
    // Excel (5) run through separate queues at low concurrency. Signal the
    // worker so it can release the per-retailer rate-limit token now, before
    // those queue waits; holding it through them cuts effective retailer
    // concurrency.
    await tryInvokeOnBrightDataPhasesComplete(onBrightDataPhasesComplete, jobId);

    // ── Phase 4.5: Persist to Database ──────────────────────────────
    // When a queueService is available (production worker path), persist runs in
    // the persist-jobs queue at low concurrency (PERSIST_WORKER_CONCURRENCY,
    // default 1 per process) so concurrent persist transactions are serialised —
    // flattening the disk-write burst from stacked INSERT batches during multi-
    // brand bursts. When queueService is missing (test path), persist runs inline.
    // Failures stay non-fatal: scrapeRunId remains null and Phase 5 falls back
    // to inline Excel generation against in-memory variants.
    const stopDbPersist = startPhaseTimer('db_persist', phaseTimings);
    signal?.throwIfAborted();
    await updateProgress(jobId, { phase: 'db_persist' }, queueService);
    const scrapeRunId = await runPersistPhase(jobId, siteName, brand, mergedVariants, queueService);
    const dbPersistDuration = stopDbPersist();
    logger.info('Phase timing: db_persist', {
      operation: 'scrapeSite', jobId,
      phase: 'db_persist',
      phase_duration_ms: dbPersistDuration,
    });

    await updateProgress(jobId, {
      phase: 'excel',
      phase_name: 'db_persist',
      phase_duration_ms: dbPersistDuration,
    }, queueService);

    // ── Phase 5: Excel ───────────────────────────────────────────────
    // When Phase 4.5 succeeded, the Worker dispatches Excel via the excel-jobs
    // queue after scrapeSite returns. When persist failed (scrapeRunId === null),
    // maybeGenerateExcelInline falls back to inline generation since variants
    // can't be reloaded from PG.
    const outputPath = buildOutputPath(config.scraping.storageDir, jobId, siteName, brand);
    const filePath = await maybeGenerateExcelInline(
      scrapeRunId, mergedVariants, outputPath, siteName, brand, jobId,
      queueService, phaseTimings,
    );

    // ── Complete ────────────────────────────────────────────────────
    const stats = {
      products_discovered: productIds.length,
      products_processed: productsProcessed,
      variants_extracted: mergedVariants.length,
      failed_products: finalFailed,
    };

    // Publish final completion event with full phase_timings map
    await updateProgress(jobId, {
      products_discovered: productIds.length,
      products_processed: productsProcessed,
      variants_extracted: mergedVariants.length,
      phase_timings: phaseTimings,
    }, queueService);

    // Clean up checkpoint now that the job succeeded (Worker handles lifecycle)
    await deleteCheckpoint(jobId);

    logger.info('Scraping completed', {
      operation: 'scrapeSite', jobId, ...stats,
      discoveryRuns: DISCOVERY_RUNS,
      perRunStats,
      discoveredThisRun: discoveredIds.length,
      newProducts: newIds.length,
      totalCatalogKnown: totalKnown,
      retriedProducts: failedProducts.length,
      recoveredProducts: failedProducts.length - finalFailed.length,
      filledFromCache: cachedFillCount,
      phaseTimings,
    });

    // Finalize bandwidth tracking — persist accumulated metrics to database
    if (bandwidthTracker) {
      await bandwidthTracker.finalizeJob(jobId, siteName);
    }

    // Cache metrics were already persisted into scrape_runs at INSERT time;
    // just clean up the in-memory context so we don't leak per long-running workers.
    cacheMetricsTracker.clearJob(jobId);

    return { file_path: filePath, scrape_run_id: scrapeRunId, ...stats, phase_timings: phaseTimings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Scraping workflow failed', {
      operation: 'scrapeSite', jobId, error: message,
    });

    // Persist bandwidth data even on failure
    if (bandwidthTracker) {
      await bandwidthTracker.finalizeJob(jobId, siteName).catch((finalizeErr) => {
        logger.warn('Failed to finalize bandwidth on job failure', {
          operation: 'scrapeSite', jobId,
          error: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        });
      });
    }

    // Drop cache metrics on failure — pipeline never reached scrape_runs INSERT,
    // so the counters were never persisted; releasing them prevents memory leaks.
    cacheMetricsTracker.clearJob(jobId);

    throw err;
  }
}
