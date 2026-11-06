/**
 * Real User Monitoring (RUM) — Web Vitals capture.
 *
 * Captures Core Web Vitals (CLS, INP, LCP, TTFB, FCP) using the official
 * `web-vitals` library and ships each metric to the server via
 * `navigator.sendBeacon` (with a `fetch` fallback for browsers without
 * Beacon support).
 *
 * IMPORTANT: We send a `Blob` with `type: 'application/json'` rather than a
 * raw string. Plain `sendBeacon(url, "...")` defaults to
 * `Content-Type: text/plain`, which Express's global `express.json()` parser
 * ignores — `req.body` would be `{}` and the server would reject every
 * beacon. Wrapping the payload in a typed Blob forces the correct content
 * type so the server can parse it.
 *
 * The server-side handler is mounted at POST /api/metrics/web-vitals (no
 * auth, IP-rate-limited).
 */
import { onCLS, onINP, onLCP, onTTFB, onFCP } from 'web-vitals';

const ENDPOINT = '/api/metrics/web-vitals';

interface WebVitalsMetric {
  name: string;
  value: number;
  rating: string;
  id: string;
}

/** Build the JSON payload sent to the server for a single metric sample. */
export function buildWebVitalsPayload(
  metric: WebVitalsMetric,
  pathname: string,
  now: number,
): string {
  return JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    id: metric.id,
    route: pathname,
    ts: now,
  });
}

/**
 * Ship a single metric sample. Exposed for testing; production callers go
 * through `reportWebVitals()`.
 */
export function sendWebVitalsMetric(metric: WebVitalsMetric): void {
  if (typeof globalThis.window === 'undefined') return;

  const body = buildWebVitalsPayload(metric, globalThis.window.location.pathname, Date.now());

  // Use a Blob so sendBeacon sets Content-Type: application/json (raw
  // strings default to text/plain which our express.json() parser ignores).
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      const ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
    } catch {
      // Fall through to fetch
    }
  }

  // Fallback for browsers without sendBeacon or when sendBeacon was rejected
  // (e.g. payload too large). `keepalive: true` lets the request survive page
  // unload, which is important for visibilitychange-fired LCP/CLS samples.
  // Best-effort — never let RUM break the app. fetch() can reject async
  // (network error, AbortController, CORS); the prior try/catch around
  // `void fetch(...)` only caught sync throws. Attach .catch() so async
  // rejections are swallowed too. (Closes Sonar S4822.)
  fetch(ENDPOINT, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
  }).catch(() => {});
}

/**
 * Subscribe to all five Core Web Vitals and forward each sample to the
 * server. Idempotent: callers should still gate on a "first call" guard
 * (the React component does this) because each `onX(...)` listener stays
 * registered for the page's lifetime.
 */
export function reportWebVitals(): void {
  onCLS(sendWebVitalsMetric);
  onINP(sendWebVitalsMetric);
  onLCP(sendWebVitalsMetric);
  onTTFB(sendWebVitalsMetric);
  onFCP(sendWebVitalsMetric);
}
