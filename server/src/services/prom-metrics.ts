/**
 * Prometheus metric registry for the API + workers.
 *
 * Errors-only Sentry covers exception aggregation; this module covers the
 * RED method (Rate, Errors, Duration) for HTTP traffic plus default Node
 * process metrics (heap, GC, event-loop lag).
 *
 * Cost: ~sub-millisecond per request to record histogram + counter, plus
 * a one-shot scrape from Prometheus every 15s. Memory is bounded by label
 * cardinality — keep `route` and `status_code` low-cardinality.
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

export const promRegistry = new Registry();

// Default Node process metrics: heap, GC, event-loop lag, active handles.
collectDefaultMetrics({ register: promRegistry, prefix: 'scraper_' });

export const httpRequestsTotal = new Counter({
  name: 'scraper_http_requests_total',
  help: 'Total HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [promRegistry],
});

// PDP variant-extraction failures (thrown parse errors — a schema break, NOT a
// legitimately-empty product), by retailer site. A spike signals the adapter can
// no longer parse the retailer's PDP; Grafana alerts on the rate.
export const scrapeExtractionFailuresTotal = new Counter({
  name: 'scraper_scrape_extraction_failures_total',
  help: 'PDP variant-extraction failures (thrown parse errors, i.e. schema breaks) by retailer site',
  labelNames: ['site'] as const,
  registers: [promRegistry],
});

// Default buckets target typical web-API distributions: 10ms → 30s.
export const httpRequestDurationSeconds = new Histogram({
  name: 'scraper_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [promRegistry],
});

// --- Real User Monitoring (Web Vitals) ----------------------------------
//
// CLS is a unitless cumulative-layout-shift score; LCP/INP/TTFB/FCP are
// durations. A single histogram can't bucket both meaningfully (a "0.1"
// bucket is a great CLS score but a 100ms duration), and histogram_quantile
// is bucket-sensitive — so the score and the durations get separate
// histograms. `route` is the client pathname (low cardinality — the app's
// routes are mostly static).

export const webVitalScore = new Histogram({
  name: 'scraper_web_vital_score',
  help: 'Cumulative Layout Shift (CLS) score reported by browsers',
  labelNames: ['metric', 'route'] as const,
  // Google CLS thresholds: good ≤ 0.1, poor > 0.25.
  buckets: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5],
  registers: [promRegistry],
});

export const webVitalDurationSeconds = new Histogram({
  name: 'scraper_web_vital_duration_seconds',
  help: 'Core Web Vitals timing metrics (LCP, INP, TTFB, FCP) in seconds',
  labelNames: ['metric', 'route'] as const,
  // Buckets straddle the Google good/needs-improvement/poor thresholds:
  // INP 0.2/0.5, TTFB 0.8/1.8, FCP 1.8/3, LCP 2.5/4 (seconds).
  buckets: [0.05, 0.1, 0.2, 0.5, 0.8, 1, 1.8, 2.5, 3, 4, 6, 10],
  registers: [promRegistry],
});

export const webVitalSamplesTotal = new Counter({
  name: 'scraper_web_vital_samples_total',
  help: 'Web Vitals samples received, by metric name and rating',
  labelNames: ['metric', 'rating'] as const,
  registers: [promRegistry],
});

const WEB_VITAL_DURATION_METRICS = new Set(['LCP', 'INP', 'TTFB', 'FCP']);

// The client beacon sends `window.location.pathname`, which for dynamic
// routes (/jobs/[id], /products/[id]) is a unique string per record. Each
// distinct value would become a permanent Prometheus series — unbounded,
// since Prom never GCs series until the process restarts. Collapse the
// id-looking segments and cap the shape before it reaches a label.
const MAX_NORMALIZED_SEGMENTS = 6;
const MAX_NORMALIZED_ROUTE_LEN = 128;

/**
 * Normalize a client-supplied pathname into a low-cardinality route label.
 * Numeric segments and UUID/long-hex segments collapse to `:id`; the path is
 * truncated to {@link MAX_NORMALIZED_SEGMENTS} segments / {@link
 * MAX_NORMALIZED_ROUTE_LEN} chars. `''` and `'/'` map to `'/'`.
 */
export function normalizeRoute(route: string): string {
  if (!route || route === '/') return '/';
  const segments = route.split('/').filter((s) => s.length > 0);
  const normalized = segments.slice(0, MAX_NORMALIZED_SEGMENTS).map((seg) => {
    if (/^\d+$/.test(seg)) return ':id';
    // UUID-ish: only [0-9a-f-], at least 8 chars, and contains a digit (a
    // pure-letter "hex" word like "facade" is almost certainly a real route).
    if (seg.length >= 8 && /^[0-9a-fA-F-]+$/.test(seg) && /\d/.test(seg)) return ':id';
    return seg;
  });
  const result = '/' + normalized.join('/');
  return result.length > MAX_NORMALIZED_ROUTE_LEN
    ? result.slice(0, MAX_NORMALIZED_ROUTE_LEN)
    : result;
}

// The beacon is public, so normalizeRoute alone is not a bound: any
// non-id-looking segment ('/q7', '/r1x/p') survives it. Only the client's
// real pages get their own label; everything else folds into 'other'.
// Add a new client page here or its vitals are reported as 'other'.
const WEB_VITAL_ROUTES = new Set([
  '/', '/login', '/setup', '/account', '/change-password', '/config', '/alerts',
  '/analytics', '/jobs/history', '/jobs/create', '/jobs/:id', '/sites/new',
  '/admin/analytics', '/admin/audit-logs', '/admin/dlq', '/admin/email-settings',
  '/admin/email-settings/templates/:slug', '/admin/health', '/admin/messages',
  '/admin/site-monitor', '/admin/users',
]);

/** Map a client pathname onto the closed set of web-vital route labels. */
function webVitalRouteLabel(route: string): string {
  const r = normalizeRoute(route)
    .replace(/^\/jobs\/(?!history$|create$)[^/]+$/, '/jobs/:id')
    .replace(/^(\/admin\/email-settings\/templates\/)[^/]+$/, '$1:slug');
  return WEB_VITAL_ROUTES.has(r) ? r : 'other';
}

/**
 * Record one Web Vitals sample into the Prometheus registry.
 *
 * `value` arrives in the unit the `web-vitals` library reports: milliseconds
 * for the timing metrics, a unitless score for CLS. Timing values are
 * converted to seconds (Prometheus convention). The `route` is mapped onto a
 * closed label set ({@link webVitalRouteLabel}) to keep cardinality bounded.
 * Unknown metric names are counted but not bucketed — callers should validate
 * the name first.
 */
export function recordWebVital(
  metric: string,
  value: number,
  rating: string,
  route: string,
): void {
  webVitalSamplesTotal.inc({ metric, rating });
  const normalizedRoute = webVitalRouteLabel(route);
  if (metric === 'CLS') {
    webVitalScore.observe({ metric, route: normalizedRoute }, value);
  } else if (WEB_VITAL_DURATION_METRICS.has(metric)) {
    webVitalDurationSeconds.observe({ metric, route: normalizedRoute }, value / 1000);
  }
}

// --- Bright Data Web Unlocker ------------------------------------------
//
// Every retailer fetch goes through the scraping provider. A ~4x latency
// regression against one retailer (median ~5.7s, tail past the request timeout)
// was once diagnosed by hand and then went unwatched, so these metrics make the
// per-site latency visible.
//
// Metrics only, deliberately no per-request log line: a single job issues
// thousands of these calls.

/**
 * Collapse a fetch URL to a low-cardinality `site` label: its last two host
 * labels. Bounded because the pipeline only fetches configured sites'
 * pages — Prometheus never reclaims series until the process restarts.
 * ponytail: two-label heuristic, so `shop.co.uk` labels as `co.uk`; use a
 * public-suffix list if such sites need separate series.
 */
export function unlockerSiteLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  return host.split('.').slice(-2).join('.');
}

/** Which client issued the call: 'unlocker' is page-fetcher.fetchViaUnlocker. */
export type UnlockerChannel = 'unlocker';

export const unlockerRequestDurationSeconds = new Histogram({
  name: 'scraper_unlocker_request_duration_seconds',
  help: 'Bright Data request duration in seconds, by issuing client',
  labelNames: ['site', 'render', 'outcome', 'channel'] as const,
  // Spans the healthy case (~1-3s) through the observed regression (median
  // ~5.7s) to the request timeout, so a shift in the tail stays visible
  // instead of collapsing into +Inf.
  buckets: [0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 60, 90],
  registers: [promRegistry],
});

export const unlockerRequestsTotal = new Counter({
  name: 'scraper_unlocker_requests_total',
  help: 'Bright Data requests by site, render mode, outcome and issuing client',
  labelNames: ['site', 'render', 'outcome', 'channel'] as const,
  registers: [promRegistry],
});

/** Outcome buckets for a single Unlocker call. */
export type UnlockerOutcome = 'success' | 'http_error' | 'timeout' | 'error';

/**
 * Record one Web Unlocker call. `render` is a label rather than a separate
 * metric because a render=true retry is legitimately slower — mixing the two
 * would make the healthy distribution look bimodal.
 */
export function recordUnlockerRequest(
  url: string,
  render: boolean,
  outcome: UnlockerOutcome,
  durationMs: number,
  channel: UnlockerChannel = 'unlocker',
): void {
  const labels = { site: unlockerSiteLabel(url), render: String(render), outcome, channel };
  unlockerRequestsTotal.inc(labels);
  unlockerRequestDurationSeconds.observe(labels, durationMs / 1000);
}

// --- BullMQ queue depth (sampled periodically by observability-sampler) ---
export const bullmqJobs = new Gauge({
  name: 'scraper_bullmq_jobs',
  help: 'BullMQ job counts by queue and state, sampled periodically',
  labelNames: ['queue', 'state'] as const,
  registers: [promRegistry],
});

// --- PostgreSQL connection pool for THIS process ------------------------
// Each process owns its own pg.Pool, so this only reflects the process that
// exposes /api/metrics/prometheus (currently the API). Worker pools need a
// worker-side scrape endpoint — tracked as a follow-up.
export const pgPoolConnections = new Gauge({
  name: 'scraper_pg_pool_connections',
  help: 'pg Pool connection counts for this process by state (total, idle, waiting)',
  labelNames: ['state'] as const,
  registers: [promRegistry],
});
