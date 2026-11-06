/**
 * Rolling latency summary for Bright Data Web Unlocker calls.
 *
 * Why this exists rather than just the Prometheus histogram: retailer fetches
 * run in the BullMQ workers (scraper-worker-1/2), and only the API process serves
 * /api/metrics/prometheus. A histogram populated inside a worker is never
 * scraped, so it would answer nothing. This logs a periodic per-retailer
 * summary instead, which is readable today with `pm2 logs` in whichever process
 * did the work.
 *
 * The Prometheus metrics are still recorded alongside these — they light up for
 * free if a worker-side scrape endpoint ever lands (the same gap already noted
 * for pgPoolConnections).
 *
 * Context: a ~4x latency regression against one retailer (median ~5.7s, tail
 * past the request timeout) was once diagnosed by hand and then went
 * unwatched. Telling whether such a regression persists, recovers or spreads
 * needs a number per retailer over time, not a one-off probe.
 */

import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('unlocker-latency');

export interface UnlockerLatencySummary {
  site: string;
  /** Which client issued the calls (see UnlockerChannel in prom-metrics). */
  channel: string;
  render: boolean;
  count: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  timeouts: number;
  httpErrors: number;
  errors: number;
}

interface Bucket {
  site: string;
  channel: string;
  render: boolean;
  durations: number[];
  timeouts: number;
  httpErrors: number;
  errors: number;
}

/** Module-level state: every caller reaches this through a hot-path function. */
const buckets = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;

/**
 * Nearest-rank percentile over an already-sorted array. Exact rather than
 * interpolated: these are latency samples read by a human deciding whether an
 * upstream regressed, and an exact observed sample is easier to reason about
 * than a synthesised one.
 */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function summarize(bucket: Bucket): UnlockerLatencySummary {
  const sorted = [...bucket.durations].sort((a, b) => a - b);
  return {
    site: bucket.site,
    channel: bucket.channel,
    render: bucket.render,
    count: sorted.length,
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p90Ms: Math.round(percentile(sorted, 0.9)),
    maxMs: Math.round(sorted.at(-1) ?? 0),
    timeouts: bucket.timeouts,
    httpErrors: bucket.httpErrors,
    errors: bucket.errors,
  };
}

/** Record one call. Cheap: an array push plus a counter. */
export function recordUnlockerLatency(
  site: string,
  render: boolean,
  outcome: 'success' | 'http_error' | 'timeout' | 'error',
  durationMs: number,
  channel: string = 'unlocker',
): void {
  const key = `${site}|${channel}|${render}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { site, channel, render, durations: [], timeouts: 0, httpErrors: 0, errors: 0 };
    buckets.set(key, bucket);
  }

  // Duration is recorded for every outcome, including failures: a request that
  // burns the full timeout before aborting is the most important sample in a
  // latency regression, and dropping it would flatter the distribution.
  bucket.durations.push(durationMs);
  if (outcome === 'timeout') bucket.timeouts++;
  else if (outcome === 'http_error') bucket.httpErrors++;
  else if (outcome === 'error') bucket.errors++;

  ensureReporterStarted();
}

/** Drain the accumulated buckets into summaries, resetting the window. */
export function flushUnlockerLatency(): UnlockerLatencySummary[] {
  const summaries = [...buckets.values()].map(summarize);
  buckets.clear();
  return summaries;
}

/**
 * Start the periodic flush on first use rather than from an entry point, so
 * this works identically in the API, both workers, and any script that happens
 * to fetch — none of which share a startup path.
 *
 * The timer is unref'd: it must never be the reason a process stays alive.
 */
function ensureReporterStarted(): void {
  if (timer !== null) return;
  const intervalMs = config.worker.unlockerLatencyLogIntervalMs;
  if (intervalMs <= 0) return;

  timer = setInterval(() => {
    for (const summary of flushUnlockerLatency()) {
      // Silence is deliberate when a window saw no traffic — summarize() is only
      // reached for buckets that recorded at least one call.
      logger.info('Web Unlocker latency window', {
        operation: 'unlockerLatency',
        windowMs: intervalMs,
        ...summary,
      });
    }
  }, intervalMs);
  timer.unref();
}
