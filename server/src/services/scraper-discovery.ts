/**
 * Scraper Discovery — Phase 1 of the scraping pipeline.
 *
 * Responsible for finding product URLs by scraping brand pages via Bright Data.
 * Exports pure/isolated functions so they can be tested independently.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('scraper-discovery');

/**
 * Merge and deduplicate product URLs from parallel discovery runs.
 *
 * Exported as a pure function so it can be property-tested independently.
 * Throws if every run rejected (no data to work with).
 */
export function mergeDiscoveryResults(results: PromiseSettledResult<string[]>[]): string[] {
  const succeeded = results.filter(
    (r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled',
  );

  if (succeeded.length === 0) {
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason?.message || String(r.reason));
    throw new Error(`All discovery runs failed: ${reasons.join('; ')}`);
  }

  return [...new Set(succeeded.flatMap(r => r.value))];
}

/**
 * Execute a discovery function N times in parallel and merge results.
 *
 * When runs === 1, calls the function directly (no Promise.allSettled wrapper).
 * When runs > 1, launches all concurrently, logs warnings for failures,
 * and merges/deduplicates the successful results.
 */
export async function runDiscovery(
  discoveryFn: () => Promise<string[]>,
  runs: number,
): Promise<string[]> {
  if (runs <= 1) {
    return discoveryFn();
  }

  const promises = Array.from({ length: runs }, () => discoveryFn());
  const results = await Promise.allSettled(promises);

  // Log warnings for failed runs
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('Discovery run failed', {
        operation: 'runDiscovery',
        error: r.reason?.message || String(r.reason),
      });
    }
  }

  return mergeDiscoveryResults(results);
}

