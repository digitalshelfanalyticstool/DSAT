/**
 * Page fetching for the scraping pipeline, provider-neutral: the HTTP fetch
 * with its render retry, backoff and typed failures (`fetchViaUnlocker`), and
 * the rendering browser pool. Both go through the active scraping provider
 * (`scraping-provider.ts` does the wire work for each one).
 */

import type { Browser } from 'playwright-core';
import { Agent } from 'undici';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { getBandwidthTracker } from '../services/bandwidth-tracker';
import { AdaptiveDelay, createDefaultConfig } from '../services/adaptive-delay';
import { recordUnlockerRequest, unlockerSiteLabel, type UnlockerOutcome } from '../services/prom-metrics';
import { recordUnlockerLatency } from '../services/unlocker-latency-reporter';
import { getActiveProvider, onProviderChange } from '../services/scraping-provider-settings';
import { providerFor } from '../providers';
import { fetchHtml, openBrowser, renderPage } from './scraping-provider';
import { isPermanentFailure, isRateLimitedError, shouldRetryWithRender, type FetchFailure } from './fetch-failure';

export { FetchError, type FetchFailure } from './fetch-failure';

const logger = createLogger('page-fetcher');

/**
 * Shared keep-alive dispatcher for Bright Data Web Unlocker calls.
 * Reuses connections to api.brightdata.com across requests instead of
 * doing a fresh TLS handshake every call (~100-150ms saved per request
 * after the first warm connection). The keepAliveMaxTimeout safety valve
 * rotates connections after 10 minutes so a stale connection cannot wedge
 * the pool indefinitely.
 */
const unlockerDispatcher = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
});

/** CDP connection timeout (ms) — shorter than NAV_TIMEOUT to fail fast on proxy issues */
const CDP_CONNECT_TIMEOUT = 30_000;

export interface FetchResult {
  url: string;
  success: boolean;
  content: string;
  error?: string;
  /** Why it failed, for retry decisions. `error` is the same thing in words. */
  failure?: FetchFailure;
  /**
   * True when the failure is permanent (HTTP 404 / 410 / 451 or a config
   * error), so the orchestrator's retry phase skips the URL instead of paying
   * for it again. Unset on success.
   */
  permanent?: boolean;
}

/**
 * The pool opens browsers with the active provider's settings. Only providers
 * that cannot render remotely (Direct, Apify) use it; see fetchViaUnlockerOnceInner.
 */
async function connectBrowser(): Promise<Browser> {
  return openBrowser(await getActiveProvider(), CDP_CONNECT_TIMEOUT);
}

// ── CDP Connection Pool ─────────────────────────────────────────────

export interface PooledConnection {
  browser: Browser;
  createdAt: number;
  inUse: boolean;
}

interface Waiter {
  resolve: (browser: Browser) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class CDPConnectionPool {
  private pool: PooledConnection[] = [];
  private readonly waitQueue: Waiter[] = [];
  private closing = false;
  private readonly maxSize: number;
  private readonly acquireTimeoutMs: number;

  constructor(maxSize?: number, acquireTimeoutMs?: number) {
    this.maxSize = maxSize ?? config.scraping.browserPoolSize;
    this.acquireTimeoutMs = acquireTimeoutMs ?? config.scraping.cdpAcquireTimeoutMs;
  }

  /**
   * A provider switch can drain this pool while a connect is in flight; a
   * browser that lands afterwards would sit in an unreachable pool forever.
   */
  private async connectUnlessClosed(): Promise<Browser> {
    const browser = await connectBrowser();
    if (this.closing) {
      await browser.close().catch(() => undefined);
      throw new Error('CDP pool closed');
    }
    return browser;
  }

  /**
   * Acquire a live browser connection.
   *
   * Returns an idle browser if available, otherwise creates a new one if the
   * pool has room. When the pool is full, the caller is queued (FIFO) until
   * a release() hands a browser over or the acquire times out. The cap is
   * hard because each browser can be a billable session: without it, a burst
   * of jobs opens sessions without bound, and a stuck pool surfaces as a job
   * error instead of a hang.
   */
  async acquire(): Promise<Browser> {
    if (this.closing) {
      throw new Error('CDP pool is closing');
    }
    await this.evictStale();

    const idle = this.pool.find(c => !c.inUse && c.browser.isConnected());
    if (idle) {
      idle.inUse = true;
      return idle.browser;
    }

    if (this.pool.length < this.maxSize) {
      const browser = await this.connectUnlessClosed();
      this.pool.push({ browser, createdAt: Date.now(), inUse: true });
      return browser;
    }

    // Pool full — queue the caller. Resolves when a release() hands a browser
    // to this waiter (FIFO), or rejects on acquireTimeoutMs.
    return new Promise<Browser>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const idx = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        reject(new Error(
          `CDP pool acquire timed out after ${this.acquireTimeoutMs}ms ` +
          `(maxSize=${this.maxSize}, pendingWaiters=${this.waitQueue.length})`,
        ));
      }, this.acquireTimeoutMs);
      // Avoid keeping the event loop alive solely for this timer.
      if (typeof timeoutHandle === 'object' && timeoutHandle !== null && 'unref' in timeoutHandle) {
        (timeoutHandle as { unref: () => void }).unref();
      }
      this.waitQueue.push({ resolve, reject, timeoutHandle });
    });
  }

  /**
   * Return a connection to the pool.
   *
   * If a waiter is queued and the browser is still connected, the browser is
   * handed directly to the next waiter (entry stays inUse — ownership simply
   * transfers). If the browser is disconnected, it is removed and the pool's
   * freed slot is used to mint a new browser for the next waiter.
   */
  async release(browser: Browser): Promise<void> {
    const entry = this.pool.find(c => c.browser === browser);
    if (!entry) return;

    if (browser.isConnected()) {
      // Hand to next waiter if any (transfer ownership, don't mark idle)
      const next = this.waitQueue.shift();
      if (next) {
        clearTimeout(next.timeoutHandle);
        next.resolve(browser);
        return;
      }
      entry.inUse = false;
      return;
    }

    // Browser is dead — drop it from the pool, then try to fulfill a waiter.
    this.pool = this.pool.filter(c => c.browser !== browser);
    try {
      await browser.close();
    } catch {
      // Already disconnected.
    }
    await this.fulfillNextWaiter();
  }

  /**
   * After a slot frees up (e.g., a dead browser was dropped), try to mint a
   * new connection for the next waiter. On connect failure, reject that waiter
   * and recurse — a transient connect error shouldn't poison the queue.
   */
  private async fulfillNextWaiter(): Promise<void> {
    const next = this.waitQueue.shift();
    if (!next) return;

    if (this.pool.length >= this.maxSize) {
      // Another caller raced us to the slot — re-queue at the head and bail.
      this.waitQueue.unshift(next);
      return;
    }

    try {
      const browser = await this.connectUnlessClosed();
      this.pool.push({ browser, createdAt: Date.now(), inUse: true });
      clearTimeout(next.timeoutHandle);
      next.resolve(browser);
    } catch (err) {
      clearTimeout(next.timeoutHandle);
      next.reject(err instanceof Error ? err : new Error(String(err)));
      // Try the next waiter — they should not inherit this connect failure.
      await this.fulfillNextWaiter();
    }
  }

  /**
   * Close all pooled connections. Called during graceful shutdown.
   * Rejects every pending waiter so callers don't hang forever on shutdown.
   */
  async closeAll(): Promise<void> {
    this.closing = true;

    // Reject all pending waiters first so they don't hang on closing pool.
    while (this.waitQueue.length > 0) {
      const w = this.waitQueue.shift()!;
      clearTimeout(w.timeoutHandle);
      w.reject(new Error('CDP pool closed'));
    }

    await Promise.allSettled(
      this.pool.map(async (c) => {
        try {
          await c.browser.close();
        } catch {
          // Ignore close errors
        }
      }),
    );
    this.pool = [];
    // `closing` stays true so post-close acquire calls fail fast. Production
    // creates a fresh pool via getCdpPool() after closePool() nulls the
    // singleton, so one-shot semantics are appropriate here.
  }

  /** Number of callers currently queued waiting for a free browser. Test/observability hook. */
  getWaitQueueLength(): number {
    return this.waitQueue.length;
  }

  /** Configured max pool size. Test/observability hook. */
  getMaxSize(): number {
    return this.maxSize;
  }

  /** Current pool occupancy. Test/observability hook. */
  getPoolSize(): number {
    return this.pool.length;
  }

  /**
   * Remove disconnected connections from the pool.
   */
  private async evictStale(): Promise<void> {
    this.pool = this.pool.filter(c => c.browser.isConnected());
  }
}

// ── Module-level CDP pool singleton ─────────────────────────────────

let cdpPool: CDPConnectionPool | null = null;

/** Lazily initialize and return the module-level CDP connection pool. */
function getCdpPool(): CDPConnectionPool {
  cdpPool ??= new CDPConnectionPool();
  return cdpPool;
}

/** Close all pooled CDP connections and reset the singleton. */
export async function closePool(): Promise<void> {
  await cdpPool?.closeAll();
  cdpPool = null;
}

// Graceful shutdown: close all pooled connections on SIGTERM
process.on('SIGTERM', async () => {
  await closePool();
});

// Pooled browsers are bound to the provider that opened them; drop them when an
// admin switches provider. ponytail: in-flight pages on the old pool fail and are
// retried by the job — fine for a rare admin action.
onProviderChange(closePool);

/** Run `action` on a browser from the pool, releasing it afterwards. */
async function withBrowser<T>(action: (browser: Browser) => Promise<T>): Promise<T> {
  // Resolve the provider first so a switch drains the old pool before we pick one.
  await getActiveProvider();
  const pool = getCdpPool();
  let browser: Browser | null = null;

  try {
    try {
      browser = await pool.acquire();
    } catch (connectErr) {
      const message = connectErr instanceof Error ? connectErr.message : String(connectErr);
      // Redact credentials from error messages (CDP errors may include the WSS URL)
      const safeMessage = message.replace(/wss:\/\/[^@]*@/, 'wss://[REDACTED]@');
      logger.error('Browser connection failed', {
        operation: 'withBrowser',
        error: safeMessage,
        timeout: CDP_CONNECT_TIMEOUT,
      });
      throw connectErr;
    }
    return await action(browser);
  } finally {
    if (browser) {
      await pool.release(browser);
    }
  }
}

// ── Web Unlocker API ────────────────────────────────────────────────
// Faster and cheaper than Scraping Browser for pages that don't need
// interactive browser automation (server-rendered product pages).
// Uses Bright Data's Unlocker API which handles JS rendering, CAPTCHA
// solving, and returns rendered HTML via a simple HTTP POST.

/** Default timeout for Web Unlocker requests (30 seconds) */
const UNLOCKER_TIMEOUT_MS = 30_000;

/** Track bandwidth for a job request. No-op if jobId is absent or tracker unavailable. */
function trackBandwidth(jobId: string | undefined, requestBody: string, responseBody: string | null): void {
  if (!jobId) return;
  const tracker = getBandwidthTracker();
  if (!tracker) return;
  const bytesUp = Buffer.byteLength(requestBody, 'utf-8');
  const bytesDown = responseBody ? Buffer.byteLength(responseBody, 'utf-8') : 0;
  tracker.recordRequest(jobId, bytesDown, bytesUp);
}

/**
 * Single instrumentation chokepoint for Web Unlocker calls.
 *
 * Every retailer fetch — discovery, PDP, and the render=true retry — funnels
 * through here, so timing it once keeps the samples comparable. The outcome is
 * classified from the returned error rather than by throwing, because
 * fetchViaUnlockerOnceInner reports failures in-band via FetchResult.
 */
async function fetchViaUnlockerOnce(url: string, timeoutMs: number, jobId: string | undefined, render: boolean): Promise<FetchResult> {
  const startedAt = Date.now();
  const record = (outcome: UnlockerOutcome) => {
    const durationMs = Date.now() - startedAt;
    recordUnlockerRequest(url, render, outcome, durationMs);
    // Prometheus only scrapes the API process, and these calls run in the
    // workers — so the histogram alone would be unreadable. The rolling log
    // summary is what actually surfaces a latency regression today.
    recordUnlockerLatency(unlockerSiteLabel(url), render, outcome, durationMs);
  };

  try {
    const result = await fetchViaUnlockerOnceInner(url, timeoutMs, jobId, render);
    record(classifyUnlockerOutcome(result));
    return result;
  } catch (err) {
    // Defensive: the inner function is written to return rather than throw, but
    // an unexpected throw must not silently vanish from the distribution.
    record('error');
    throw err;
  }
}

function classifyUnlockerOutcome(result: FetchResult): UnlockerOutcome {
  if (result.success) return 'success';
  const failure = result.failure;
  if (failure?.kind === 'timeout') return 'timeout';
  if (failure?.kind === 'http') return 'http_error';
  // Transport errors (undici's connect timeout, an aborted render) still count as timeouts on the dashboard.
  if (/abort|timeout|timed out/i.test(result.error ?? '')) return 'timeout';
  return 'error';
}

class BodyTooLargeError extends Error {}

/**
 * The decoded body as UTF-8 text (what `response.text()` gives), failing once
 * it passes `maxBytes`. A compressed body is decoded before it reaches us, so
 * only the decoded size is a real bound.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`Response body exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * One fetch attempt through the active provider. `timeoutMs` covers the body
 * as well as the headers, and the body is size-capped. Failures are returned,
 * not thrown.
 */
async function fetchViaUnlockerOnceInner(url: string, timeoutMs: number, jobId: string | undefined, render: boolean): Promise<FetchResult> {
  const provider = await getActiveProvider();
  const capabilities = providerFor(provider);
  const missing = capabilities.missingConfig?.(provider);
  if (missing) return { url, success: false, content: '', error: missing, failure: { kind: 'config' } };
  const tracksBandwidth = capabilities.billsBandwidth;
  let requestBody = '';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // A plain proxy cannot run JavaScript, so its renders use a pooled browser
      // rather than one launched per request. Some providers render on their side.
      const fetched = render && !capabilities.rendersRemotely
        ? { response: await withBrowser((browser) => renderPage(browser, url, timeoutMs, controller.signal)) }
        : await fetchHtml(provider, url, {
          timeoutMs,
          render,
          // Forwarded to the origin so it compresses its response to Bright Data's edge.
          headers: { 'Accept-Encoding': 'gzip, br' },
          signal: controller.signal,
          dispatcher: unlockerDispatcher,
        });
      const response = fetched.response;
      requestBody = fetched.requestBody ?? '';

      if (!response.ok) {
        const body = await readBodyCapped(response, config.scraping.maxBodyBytes).catch(() => '');
        if (tracksBandwidth) trackBandwidth(jobId, requestBody, body);
        return {
          url,
          success: false,
          content: '',
          error: `Web Unlocker returned ${response.status}: ${body.slice(0, 200)}`,
          failure: { kind: 'http', status: response.status },
        };
      }

      const html = await readBodyCapped(response, config.scraping.maxBodyBytes);
      if (tracksBandwidth) trackBandwidth(jobId, requestBody, html);
      return { url, success: true, content: html };
    } catch (err) {
      if (tracksBandwidth) trackBandwidth(jobId, requestBody, null);
      if (err instanceof BodyTooLargeError) {
        return { url, success: false, content: '', error: err.message, failure: { kind: 'network' } };
      }

      if (err instanceof Error && err.name === 'AbortError') {
        return {
          url,
          success: false,
          content: '',
          error: `Request timeout after ${timeoutMs}ms`,
          failure: { kind: 'timeout' },
        };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Web Unlocker fetch error', {
      operation: 'fetchViaUnlocker', url, error: message,
    });
    return { url, success: false, content: '', error: message, failure: { kind: 'network' } };
  }
}

/**
 * Fetch a single URL through the active provider with timeout. By default
 * fetches raw HTML without browser rendering, which is enough for SSR pages
 * that embed data in script tags.
 *
 * If the non-rendered request fails AND the failure class plausibly benefits
 * from browser rendering (see `shouldRetryWithRender`), retries with
 * render=true. Otherwise returns the first-pass failure, to avoid paying the
 * render rate on permanent failures or rate limits.
 *
 * Set render=true on the caller side to skip the non-rendered attempt entirely.
 */
export async function fetchViaUnlocker(url: string, timeoutMs = UNLOCKER_TIMEOUT_MS, jobId?: string, render = false): Promise<FetchResult> {
  const result = await fetchViaUnlockerOnce(url, timeoutMs, jobId, render);

  if (!result.success && isPermanentFailure(result.failure)) {
    result.permanent = true;
  }

  if (!result.success && !render) {
    const { retry, reason } = shouldRetryWithRender(result.failure);
    if (retry) {
      logger.warn('Retrying Web Unlocker fetch with render=true', {
        operation: 'fetchViaUnlocker',
        url,
        originalError: result.error,
        renderRetryReason: reason,
      });
      const retryResult = await fetchViaUnlockerOnce(url, timeoutMs, jobId, true);
      if (!retryResult.success && isPermanentFailure(retryResult.failure)) {
        retryResult.permanent = true;
      }
      return retryResult;
    }
    logger.debug('Skipping render=true retry — first-pass failure not retry-eligible', {
      operation: 'fetchViaUnlocker',
      url,
      originalError: result.error,
      skipReason: reason,
    });
  }

  return result;
}

/**
 * Fetch multiple URLs via Web Unlocker with controlled concurrency.
 * Uses a concurrency pool pattern to ensure we always have N requests in flight.
 * Much faster than Scraping Browser batch (~6s vs ~30s per URL).
 *
 * @param urls - URLs to fetch
 * @param concurrency - Max parallel requests (default 20)
 * @param onProgress - Optional progress callback
 */
export async function fetchViaUnlockerBatch(
  urls: string[],
  concurrency = config.worker.unlockerConcurrency,
  onProgress?: (completed: number, total: number) => void,
  jobId?: string,
  render = false,
  timeoutMs = UNLOCKER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<FetchResult[]> {
  if (urls.length === 0) return [];

  logger.info('Starting batch fetch via Web Unlocker', {
    operation: 'fetchViaUnlockerBatch',
    totalUrls: urls.length,
    concurrency,
  });

  const results: FetchResult[] = new Array(urls.length);
  let completed = 0;
  let successCount = 0;
  let nextIndex = 0;

  // Adaptive backoff shared across the worker pool. Under a sustained
  // anti-bot stretch (403/503/429), the delay ramps up exponentially so all
  // workers wait before their next fetch instead of hammering at full
  // concurrency; it decays back to 0 after consecutive successes. In the common
  // healthy case currentMs stays 0, so there is no added latency. JS is
  // single-threaded, so the shared counter needs no locking between awaits.
  const backoff = new AdaptiveDelay(createDefaultConfig());

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    // An aborted signal (job cancelled or timed out) stops new fetches.
    while (nextIndex < urls.length && !signal?.aborted) {
      const index = nextIndex++;
      const url = urls[index];

      if (backoff.currentMs > 0) await backoff.wait();

      try {
        const result = await fetchViaUnlocker(url, timeoutMs, jobId, render);
        results[index] = result;
        if (result.success) {
          successCount++;
          backoff.recordSuccess();
        } else if (isRateLimitedError(result.failure)) {
          backoff.recordRateLimit();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[index] = { url, success: false, content: '', error: message, failure: { kind: 'network' } };
      }

      completed++;
      if (onProgress) {
        onProgress(completed, urls.length);
      }
    }
  });

  await Promise.all(workers);

  logger.info('Batch Web Unlocker fetch complete', {
    operation: 'fetchViaUnlockerBatch',
    totalUrls: urls.length,
    successful: successCount,
    failed: urls.length - successCount,
  });

  return results;
}
