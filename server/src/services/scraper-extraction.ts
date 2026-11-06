/**
 * Scraper Extraction — Phases 2–4 of the scraping pipeline.
 *
 * Fetches product pages through the scraping provider and turns each into
 * variant rows with the site's adapter.
 */

import { config } from '../config';
import { fetchViaUnlockerBatch } from '../scrapers/page-fetcher';
import type { Adapter, ProductVariant, SiteConfig } from '../adapters';
import { createLogger } from '../utils/logger';
import { scrapeExtractionFailuresTotal } from './prom-metrics';

const logger = createLogger('scraper-extraction');

/**
 * Compute the concurrency to use during the retry phase.
 *
 * Returns `min(baseConcurrency × multiplier, maxConcurrency)`.
 */
export function computeRetryConcurrency(baseConcurrency: number, multiplier: number, maxConcurrency: number): number {
  return Math.min(baseConcurrency * multiplier, maxConcurrency);
}

/** Process a single unlocker result — extract variants or record failure. */
function processUnlockerResult(
  result: { url: string; success: boolean; content: string; error?: string; permanent?: boolean },
  adapter: Adapter,
  site: SiteConfig,
  byProduct: Record<string, ProductVariant[]>,
  failed: string[],
  permanentFailed: string[],
  extractionErrors: string[],
): void {
  const productId = adapter.productId(result.url);

  if (!result.success) {
    logger.warn('Bright Data fetch failed for product', {
      operation: 'fetchBrightDataVariants', productId, url: result.url, error: result.error,
      permanent: result.permanent === true,
    });
    if (result.permanent) {
      permanentFailed.push(productId);
    } else {
      failed.push(productId);
    }
    return;
  }

  // A POSITIVELY-identified discontinued/not-found page is a delisted product — mark permanent so we stop retrying it
  // every job at render cost, instead of waiting for MAX_CONSECUTIVE_FAILURES.
  // Checked on raw content BEFORE extraction. Conservative by construction: only
  // a positive marker triggers this; a merely-empty or unparseable page stays a
  // retryable failure below, so a schema change can never tombstone the catalog.
  if (adapter.isDiscontinued?.(result.content)) {
    logger.info('PDP indicates a discontinued/not-found product — marking permanent', {
      operation: 'fetchBrightDataVariants', productId, url: result.url,
    });
    permanentFailed.push(productId);
    return;
  }

  // Parse / extraction failures are NOT marked permanent — a retailer schema
  // change (HTML restructure) is the typical cause, and a future deploy with
  // an updated adapter would make the same URL succeed.
  try {
    const productVariants = adapter.extract({ url: result.url, html: result.content, site });
    if (productVariants.length === 0) {
      logger.warn('No variants extracted from product', {
        operation: 'fetchBrightDataVariants', productId, url: result.url,
      });
      failed.push(productId);
    } else {
      byProduct[productId] = [...(byProduct[productId] ?? []), ...productVariants];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Variant extraction failed for product', {
      operation: 'fetchBrightDataVariants', productId, url: result.url, error: message,
    });
    // A THROWN extraction error is a schema break (the adapter can't parse the
    // PDP), distinct from a legitimately-empty product above. Track it separately
    // so the batch-level schema-drift signal can distinguish it from normal churn.
    // It still goes into `failed` so it's retried like any failure.
    failed.push(productId);
    extractionErrors.push(productId);
  }
}

export interface PDPResult {
  variants: ProductVariant[];
  /** The same variants keyed by catalog product id (`adapter.productId`), the variant cache's key. */
  byProduct: Record<string, ProductVariant[]>;
  failed: string[];
  permanentFailed: string[];
  extractionErrors: string[];
}

/**
 * Fetch each product page through the scraping provider and extract its
 * variants with the site's adapter.
 */
export async function fetchPDPVariants(
  productUrls: string[],
  /** From `getAdapter`, so rows come back stamped and canonicalized. */
  adapter: Adapter,
  site: SiteConfig,
  onProgress?: (fetched: number, total: number, variantCount: number) => void,
  jobId?: string,
  concurrency?: number,
  signal?: AbortSignal,
): Promise<PDPResult> {
  if (productUrls.length === 0) return { variants: [], byProduct: {}, failed: [], permanentFailed: [], extractionErrors: [] };

  const siteName = site.name;
  const renderUpfront = adapter.needsRender ?? false;
  const timeoutMs = renderUpfront ? config.worker.pdpRenderTimeoutMs : undefined;
  logger.info('Starting variant fetch via Bright Data Web Unlocker', {
    operation: 'fetchBrightDataVariants', siteName,
    totalProducts: productUrls.length,
    adapter: adapter.id, renderUpfront, timeoutMs,
  });

  const byProduct: Record<string, ProductVariant[]> = {};
  const failed: string[] = [];
  const permanentFailed: string[] = [];
  const extractionErrors: string[] = [];

  // Fetch with progress tracking. An adapter may fetch a different URL (e.g. JSON);
  // results are mapped back so rows and failures carry the product URL.
  const productUrlOf = new Map(productUrls.map((u) => [adapter.fetchUrl?.(u) ?? u, u]));
  const results = await fetchViaUnlockerBatch(
    [...productUrlOf.keys()],
    concurrency,
    onProgress ? (fetched, total) => onProgress(fetched, total, 0) : undefined,
    jobId,
    renderUpfront,
    timeoutMs,
    signal,
  );
  // A cancelled batch stops early and leaves holes in `results`.
  signal?.throwIfAborted();

  // Process all results and extract variants
  for (const result of results) {
    result.url = productUrlOf.get(result.url) ?? result.url;
    processUnlockerResult(result, adapter, site, byProduct, failed, permanentFailed, extractionErrors);
  }
  const variants = Object.values(byProduct).flat();

  if (onProgress) {
    onProgress(productUrls.length, productUrls.length, variants.length);
  }

  // Schema-drift signal: count extraction errors per site so Grafana
  // can alert on the rate, and — when a large fraction of THIS batch threw parse
  // errors — log at ERROR so the live run surfaces a likely retailer schema break
  // immediately, instead of it hiding for up to 6 days until the weekly monitor.
  if (extractionErrors.length > 0) {
    scrapeExtractionFailuresTotal.inc({ site: siteName }, extractionErrors.length);
    const errorRate = extractionErrors.length / productUrls.length;
    if (errorRate >= config.worker.extractionFailureAlertThreshold) {
      logger.error('High PDP extraction-failure rate — possible retailer schema break', {
        operation: 'fetchBrightDataVariants', siteName,
        totalProducts: productUrls.length,
        extractionErrors: extractionErrors.length,
        errorRatePct: Math.round(errorRate * 100),
        threshold: config.worker.extractionFailureAlertThreshold,
      });
    }
  }

  logger.info('Bright Data variant fetch complete', {
    operation: 'fetchBrightDataVariants', siteName,
    totalProducts: productUrls.length,
    successfulProducts: productUrls.length - failed.length - permanentFailed.length,
    totalVariants: variants.length,
    failedProducts: failed.length,
    permanentFailedProducts: permanentFailed.length,
    extractionErrors: extractionErrors.length,
  });

  return { variants, byProduct, failed, permanentFailed, extractionErrors };
}
