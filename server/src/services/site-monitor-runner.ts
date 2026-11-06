/**
 * Site monitor runner: starts a run (at most one at a time), samples each
 * enabled site's recent products, fetches them through the configured
 * scraping provider, and records structural changes against the baseline.
 * Fingerprinting and diff detection live in change-monitor-service.
 */

import { createLogger } from '../utils/logger';
import { DatabaseService } from './database';
import { fetchViaUnlocker } from '../scrapers/page-fetcher';
import { getProgressBus, type MonitorProgressEvent } from './progress-bus';
import {
  extractFingerprint,
  serializeFingerprint,
  deserializeFingerprint,
  compareFingerprints,
  computeHtmlHash,
  type StructuralFingerprint,
} from './change-monitor-service';
import { getSites, type SiteConfig } from './config-manager';
import { config as appConfig } from '../config';
import { getAdapter } from '../adapters';
import { createGlobalMessage } from './global-messages';

const logger = createLogger('site-monitor-runner');

// ─── Types ───────────────────────────────────────────────────────────

interface SampledProduct {
  id: number;
  url: string;
  retailer: string;
}

interface ProductResult {
  fetched: boolean;
  changesCount: number;
  criticalCount: number;
}

interface RetailerResult {
  checked: boolean;
  totalChanges: number;
  criticalChanges: number;
}

type ProgressFn = (event: Omit<MonitorProgressEvent, 'runId' | 'timestamp'>) => void;

export interface MonitorScheduleConfig {
  enabled: boolean;
  schedule_time: string; // "HH:MM"
  schedule_days: number[]; // 0=Sun … 6=Sat
}

/** A product page fetch, including a render, through the provider. */
const MONITOR_FETCH_TIMEOUT_MS = 60_000;
const CRITICAL_BANNER_TTL_SECONDS = 7 * 24 * 3600;
/** Serialises run creation, so two triggers can't both see "nothing running". */
const MONITOR_RUN_LOCK_KEY = 4_215_002;

// ─── Product sampling ────────────────────────────────────────────────

/**
 * The site's most recent products, at the URL each was last scraped from.
 * `products.retailer` is the site name (migration 60).
 */
async function sampleProducts(site: SiteConfig): Promise<SampledProduct[]> {
  const db = await DatabaseService.getInstance();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const rows = await db.all<{ id: number; url: string | null }>(
    `SELECT id, url FROM products
     WHERE retailer = $1
       AND last_seen_at >= $2 AND url IS NOT NULL AND url <> ''
     ORDER BY last_seen_at DESC
     LIMIT 3`,
    site.name,
    thirtyDaysAgo.toISOString(),
  );
  return rows.map((r) => ({ id: r.id, url: r.url as string, retailer: site.name }));
}

// ─── Baseline capture ────────────────────────────────────────────────

async function captureBaseline(
  site: SiteConfig,
  productId: number,
  url: string,
  html: string,
): Promise<void> {
  const retailer = site.name;
  const db = await DatabaseService.getInstance();
  const htmlHash = computeHtmlHash(html);
  const fingerprint = extractFingerprint(html, site, url);
  const serialized = serializeFingerprint(fingerprint);

  await db.run(
    `INSERT INTO site_monitor_baselines (retailer, product_id, url, html_hash, structural_fingerprint, captured_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (retailer, product_id)
     DO UPDATE SET url = $3, html_hash = $4, structural_fingerprint = $5, captured_at = NOW(), updated_at = NOW()`,
    retailer,
    productId,
    url,
    htmlHash,
    serialized,
  );
}

// ─── Monitor run orchestration ───────────────────────────────────────

/**
 * Start a monitor run: insert it as 'running' unless one already is. Returns
 * its id, or null when a run is in progress. The only way a run is created,
 * for the trigger endpoint and the schedule alike.
 */
export async function startMonitorRun(): Promise<number | null> {
  const db = await DatabaseService.getInstance();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MONITOR_RUN_LOCK_KEY]);
    // A run left 'running' by a crashed process would otherwise block every
    // later run; past the cutoff it is failed so monitoring recovers.
    await tx.run(
      `UPDATE site_monitor_runs
       SET status = 'failed', error_message = 'Marked failed: stale (still running past the cutoff)', completed_at = NOW()
       WHERE status = 'running' AND started_at < NOW() - make_interval(secs => $1)`,
      appConfig.siteMonitor.staleRunMs / 1000,
    );
    const row = await tx.get<{ id: number }>(
      `INSERT INTO site_monitor_runs (status, started_at)
       SELECT 'running', NOW()
       WHERE NOT EXISTS (SELECT 1 FROM site_monitor_runs WHERE status = 'running')
       RETURNING id`,
    );
    return row?.id ?? null;
  });
}

async function processProduct(
  db: DatabaseService,
  runId: number,
  site: SiteConfig,
  product: SampledProduct,
  publishProgress: ProgressFn,
): Promise<ProductResult> {
  const retailer = site.name;
  publishProgress({
    type: 'product_fetch_start',
    message: `Fetching PDP for product ${product.id}`,
    retailer,
    product_id: product.id,
    url: product.url,
  });

  // The page the scrape itself would fetch, through the same provider: a direct
  // fetch from a datacenter IP is often answered with a block page.
  const adapter = getAdapter(site.adapter);
  const fetchResult = await fetchViaUnlocker(
    adapter.fetchUrl?.(product.url) ?? product.url, MONITOR_FETCH_TIMEOUT_MS, undefined, adapter.needsRender ?? false,
  );

  if (!fetchResult.success) {
    logger.warn('Failed to fetch PDP for monitoring', {
      operation: 'runMonitor', retailer, productId: product.id, url: product.url, error: fetchResult.error,
    });
    publishProgress({
      type: 'product_fetch_error',
      message: `Failed to fetch: ${fetchResult.error ?? 'unknown error'}`,
      retailer, product_id: product.id, url: product.url, error: fetchResult.error ?? 'unknown error',
    });
    await db.run(
      `INSERT INTO site_monitor_changes
       (run_id, retailer, product_id, url, change_type, selector_or_field, severity, description, detected_at)
       VALUES ($1, $2, $3, $4, 'fetch_error', 'page_fetch', 'warning', $5, NOW())`,
      runId, retailer, product.id, product.url,
      `Failed to fetch page: ${fetchResult.error ?? 'unknown error'}`,
    );
    return { fetched: false, changesCount: 1, criticalCount: 0 };
  }

  const baseline = await db.get<{ html_hash: string; structural_fingerprint: string }>(
    `SELECT html_hash, structural_fingerprint FROM site_monitor_baselines WHERE retailer = $1 AND product_id = $2`,
    retailer, product.id,
  );

  if (!baseline) {
    logger.info('Capturing initial baseline', { operation: 'runMonitor', retailer, productId: product.id });
    await captureBaseline(site, product.id, product.url, fetchResult.content);
    publishProgress({
      type: 'product_baseline_captured',
      message: `Initial baseline captured for product ${product.id}`,
      retailer, product_id: product.id,
    });
    return { fetched: true, changesCount: 0, criticalCount: 0 };
  }

  let baselineFingerprint: StructuralFingerprint;
  try {
    baselineFingerprint = deserializeFingerprint(baseline.structural_fingerprint);
  } catch (err) {
    logger.error('Corrupt baseline fingerprint, re-capturing', {
      operation: 'runMonitor', retailer, productId: product.id, error: err instanceof Error ? err.message : String(err),
    });
    await captureBaseline(site, product.id, product.url, fetchResult.content);
    return { fetched: true, changesCount: 0, criticalCount: 0 };
  }

  const currentFingerprint = extractFingerprint(fetchResult.content, site, product.url);
  const changes = compareFingerprints(baselineFingerprint, currentFingerprint);

  if (changes.length > 0) {
    await db.transaction(async (tx) => {
      for (const change of changes) {
        await tx.run(
          `INSERT INTO site_monitor_changes
           (run_id, retailer, product_id, url, change_type, selector_or_field, severity, description, before_value, after_value, detected_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          runId, retailer, product.id, product.url,
          change.changeType, change.selectorOrField, change.severity, change.description,
          change.beforeValue, change.afterValue,
        );
      }
    });
  }

  const criticalCount = changes.filter(c => c.severity === 'critical').length;
  publishProgress({
    type: 'product_compare_done',
    message: changes.length > 0
      ? `${changes.length} changes detected (${criticalCount} critical)`
      : 'No changes detected',
    retailer, product_id: product.id, changes_found: changes.length, critical_count: criticalCount,
  });

  await captureBaseline(site, product.id, product.url, fetchResult.content);
  return { fetched: true, changesCount: changes.length, criticalCount };
}

async function processRetailer(
  db: DatabaseService,
  runId: number,
  site: SiteConfig,
  publishProgress: ProgressFn,
): Promise<RetailerResult> {
  const retailer = site.name;
  publishProgress({ type: 'retailer_start', message: `Checking ${retailer}...`, retailer });

  const products = await sampleProducts(site);
  if (products.length === 0) {
    logger.info('No recent products for site', { operation: 'runMonitor', retailer, runId });
    publishProgress({ type: 'retailer_no_products', message: `No eligible products for ${retailer}, skipping`, retailer });
    return { checked: false, totalChanges: 0, criticalChanges: 0 };
  }

  let retailerProcessed = false;
  let totalChanges = 0;
  let criticalChanges = 0;

  for (const product of products) {
    try {
      const result = await processProduct(db, runId, site, product, publishProgress);
      if (result.fetched) retailerProcessed = true;
      totalChanges += result.changesCount;
      criticalChanges += result.criticalCount;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error processing product for monitoring', { operation: 'runMonitor', retailer, productId: product.id, error: errMsg });
      publishProgress({ type: 'product_error', message: `Error processing product ${product.id}: ${errMsg}`, retailer, product_id: product.id, error: errMsg });
    }
  }

  publishProgress({ type: 'retailer_complete', message: `Finished ${retailer}: ${products.length} products checked`, retailer });

  return { checked: retailerProcessed || products.length > 0, totalChanges, criticalChanges };
}

/** Run the monitor for a run started with `startMonitorRun`. */
export async function runMonitor(runId: number): Promise<number> {
  const db = await DatabaseService.getInstance();

  // Best-effort progress publishing — never blocks the monitor
  const publishProgress = (event: Omit<MonitorProgressEvent, 'runId' | 'timestamp'>): void => {
    const full: MonitorProgressEvent = {
      runId,
      timestamp: new Date().toISOString(),
      ...event,
    };
    getProgressBus().publishMonitorProgress(runId, full).catch(() => {
      // Swallow — progress is best-effort
    });
  };

  logger.info('Starting site change monitor run', { operation: 'runMonitor', runId });

  let retailersChecked = 0;
  let totalChanges = 0;
  let criticalChanges = 0;
  const criticalRetailers: string[] = [];

  try {
    const sites = (await getSites()).filter((s) => s.enabled);

    publishProgress({
      type: 'run_start',
      message: `Starting monitor run across ${sites.length} retailers`,
    });

    for (const site of sites) {
      const retailer = site.name;
      try {
        const result = await processRetailer(db, runId, site, publishProgress);
        if (result.checked) retailersChecked++;
        totalChanges += result.totalChanges;
        criticalChanges += result.criticalChanges;
        if (result.criticalChanges > 0 && !criticalRetailers.includes(retailer)) {
          criticalRetailers.push(retailer);
        }
      } catch (err) {
        logger.error('Error processing retailer for monitoring', {
          operation: 'runMonitor', retailer, runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update run as completed
    await db.run(
      `UPDATE site_monitor_runs
       SET status = 'completed', retailers_checked = $1, total_changes_detected = $2,
           critical_changes = $3, completed_at = NOW()
       WHERE id = $4`,
      retailersChecked,
      totalChanges,
      criticalChanges,
      runId,
    );

    // Alert for critical changes
    if (criticalChanges > 0) {
      const retailerList = criticalRetailers.join(', ');
      await createGlobalMessage(db, {
        type: 'warning',
        title: `Site Changes Detected: ${retailerList}`,
        message: `${criticalChanges} critical structural change(s) detected on ${retailerList}. Review the site monitor dashboard for details.`,
        expiresAt: Math.floor(Date.now() / 1000) + CRITICAL_BANNER_TTL_SECONDS,
      });
    }

    logger.info('Site change monitor run completed', {
      operation: 'runMonitor',
      runId,
      retailersChecked,
      totalChanges,
      criticalChanges,
    });

    publishProgress({
      type: 'run_complete',
      message: `Run complete: ${retailersChecked} retailers, ${totalChanges} changes (${criticalChanges} critical)`,
      changes_found: totalChanges,
      critical_count: criticalChanges,
    });

    return runId;

  } catch (err) {
    // Unrecoverable error
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Site change monitor run failed', {
      operation: 'runMonitor',
      runId,
      error: errorMessage,
    });

    publishProgress({
      type: 'run_error',
      message: `Run failed: ${errorMessage}`,
      error: errorMessage,
    });

    await db.run(
      `UPDATE site_monitor_runs
       SET status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      errorMessage,
      runId,
    ).catch(() => { /* ignore if this also fails */ });

    return runId;
  }
}

// ─── Schedule config (stored in app_settings) ────────────────────────

const DEFAULT_SCHEDULE: MonitorScheduleConfig = {
  enabled: true,
  schedule_time: '02:00',
  schedule_days: [0], // Sunday
};

/**
 * Read the monitor schedule from app_settings.
 * Returns defaults if no row exists or the value is invalid.
 */
export async function getMonitorSchedule(): Promise<MonitorScheduleConfig> {
  try {
    const db = await DatabaseService.getInstance();
    const row = await db.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = $1',
      'site_monitor_schedule',
    );
    if (!row) return { ...DEFAULT_SCHEDULE };
    const parsed = JSON.parse(row.value);
    if (
      typeof parsed.enabled !== 'boolean' ||
      typeof parsed.schedule_time !== 'string' ||
      !Array.isArray(parsed.schedule_days)
    ) {
      return { ...DEFAULT_SCHEDULE };
    }
    return parsed as MonitorScheduleConfig;
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

// ─── Scheduler registration ──────────────────────────────────────────

export const MONITOR_CHECK_INTERVAL_MS = 60_000; // Check every minute

/**
 * A once-a-minute check that runs the monitor when its configured day and time
 * come round, at most once per day. Scheduled by background-tasks.ts.
 */
export function createMonitorScheduleCheck(): () => Promise<void> {
  let lastRunDate = '';

  return async () => {
    const config = await getMonitorSchedule();
    if (!config.enabled) return;

    const now = new Date();
    // Compare in the scheduling timezone
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: appConfig.scheduling.timezone }));
    const currentDay = eastern.getDay();
    if (!config.schedule_days.includes(currentDay)) return;

    const currentHH = String(eastern.getHours()).padStart(2, '0');
    const currentMM = String(eastern.getMinutes()).padStart(2, '0');
    if (`${currentHH}:${currentMM}` !== config.schedule_time) return;

    const dateStr = now.toISOString().slice(0, 10);
    if (dateStr === lastRunDate) return; // Already ran today
    lastRunDate = dateStr;

    const runId = await startMonitorRun();
    if (runId === null) {
      logger.warn('Scheduled site monitor run skipped: a run is already in progress', { operation: 'monitorScheduleCheck' });
      return;
    }
    logger.info('Triggering scheduled site change monitor run', {
      operation: 'monitorScheduleCheck',
      runId,
      schedule_time: config.schedule_time,
      schedule_days: config.schedule_days,
    });
    await runMonitor(runId);
  };
}
