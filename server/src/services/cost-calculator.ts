/**
 * CostCalculator — Aggregates bandwidth by retailer and converts to dollar costs.
 *
 * Provides:
 * - Per-retailer cost aggregation over configurable time periods
 * - Single-job cost lookup
 * - Configurable cost rate ($/GB) stored in app_settings
 * - CSV export generation
 *
 * All queries use parameterized $N placeholders — no string interpolation.
 */

import { DatabaseService } from './database';
import { JobBandwidthStore, type JobBandwidthRecord } from './job-bandwidth-store';
import { knownRetailers } from './retailers';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { csvRow } from '../utils/csv';

const logger = createLogger('cost-calculator');

// --- Constants ---

const BYTES_PER_GB = 1_073_741_824;
const SETTINGS_KEY = 'brightdata_cost_per_gb';

// --- Data Types ---

export type TimePeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month';

interface RetailerCostSummary {
  site: string;
  bytesDownloaded: number;
  bytesUploaded: number;
  totalBytes: number;
  totalGigabytes: number;
  requestCount: number;
  jobCount: number;
  estimatedCost: number;
}

export interface CostAggregation {
  period: { from: string; to: string };
  retailers: RetailerCostSummary[];
  totalCost: number;
  totalGigabytes: number;
  costRate: number;
}

// --- Helper: resolve date range from a TimePeriod ---

function resolveDateRange(period: TimePeriod): { from: Date; to: Date } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'today':
      return { from: startOfToday, to: now };

    case 'yesterday': {
      const yesterday = new Date(startOfToday);
      yesterday.setDate(yesterday.getDate() - 1);
      const endOfYesterday = new Date(startOfToday.getTime() - 1);
      return { from: yesterday, to: endOfYesterday };
    }

    case '7d': {
      const sevenDaysAgo = new Date(startOfToday);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      return { from: sevenDaysAgo, to: now };
    }

    case '30d': {
      const thirtyDaysAgo = new Date(startOfToday);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return { from: thirtyDaysAgo, to: now };
    }

    case 'month':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1),
        to: now,
      };

    case 'last_month': {
      const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: firstOfLastMonth, to: lastOfLastMonth };
    }
  }
}

// --- CostCalculator class ---

export class CostCalculator {
  private readonly db: DatabaseService;
  private readonly bandwidthStore: JobBandwidthStore;

  constructor(db: DatabaseService, bandwidthStore: JobBandwidthStore) {
    this.db = db;
    this.bandwidthStore = bandwidthStore;
  }

  /**
   * Get aggregated costs by retailer for a time period.
   * Accepts either a named period or a custom { from, to } range.
   * Returns all known retailers, with zero values for those without data.
   * Results sorted by total bytes descending.
   */
  async getRetailerCosts(
    period: TimePeriod | { from: string; to: string },
    excludeAdmin = false,
  ): Promise<CostAggregation> {
    let from: Date;
    let to: Date;

    if (typeof period === 'string') {
      const range = resolveDateRange(period);
      from = range.from;
      to = range.to;
    } else {
      from = new Date(period.from);
      to = new Date(period.to);
    }

    const costRate = await this.getCostRate();
    const aggregations = await this.bandwidthStore.aggregateByRetailer(from, to, excludeAdmin);

    // Build a map from DB results
    const aggMap = new Map(aggregations.map((a) => [a.site, a]));

    // Ensure all known retailers appear, even with zero data
    const retailers: RetailerCostSummary[] = [];
    for (const site of await knownRetailers()) {
      const agg = aggMap.get(site);
      if (agg) {
        aggMap.delete(site); // remove so we don't double-add
      }
      const bytesDown = agg?.bytesDownloaded ?? 0;
      const bytesUp = agg?.bytesUploaded ?? 0;
      const totalBytes = bytesDown + bytesUp;
      const totalGigabytes = totalBytes / BYTES_PER_GB;
      retailers.push({
        site,
        bytesDownloaded: bytesDown,
        bytesUploaded: bytesUp,
        totalBytes,
        totalGigabytes,
        requestCount: agg?.requestCount ?? 0,
        jobCount: agg?.jobCount ?? 0,
        estimatedCost: totalGigabytes * costRate,
      });
    }

    // Include any unknown retailers that appeared in the data
    for (const [site, agg] of aggMap) {
      const totalBytes = agg.bytesDownloaded + agg.bytesUploaded;
      const totalGigabytes = totalBytes / BYTES_PER_GB;
      retailers.push({
        site,
        bytesDownloaded: agg.bytesDownloaded,
        bytesUploaded: agg.bytesUploaded,
        totalBytes,
        totalGigabytes,
        requestCount: agg.requestCount,
        jobCount: agg.jobCount,
        estimatedCost: totalGigabytes * costRate,
      });
    }

    // Sort by total bytes descending
    retailers.sort((a, b) => b.totalBytes - a.totalBytes);

    const totalGigabytes = retailers.reduce((sum, r) => sum + r.totalGigabytes, 0);
    const totalCost = retailers.reduce((sum, r) => sum + r.estimatedCost, 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      retailers,
      totalCost,
      totalGigabytes,
      costRate,
    };
  }

  /**
   * Get cost data for a single job.
   * Returns null if no bandwidth record exists for the job.
   */
  async getJobCost(jobId: string): Promise<{
    bandwidth: JobBandwidthRecord;
    estimatedCost: number;
  } | null> {
    const bandwidth = await this.bandwidthStore.getByJobId(jobId);
    if (!bandwidth) return null;

    const costRate = await this.getCostRate();
    const totalBytes = bandwidth.bytesDownloaded + bandwidth.bytesUploaded;
    const totalGigabytes = totalBytes / BYTES_PER_GB;
    const estimatedCost = totalGigabytes * costRate;

    return { bandwidth, estimatedCost };
  }

  /**
   * Get current cost rate ($/GB) from app_settings.
   * Falls back to config.scraping.defaultCostPerGb if not configured or on error.
   */
  async getCostRate(): Promise<number> {
    return getCostRate(this.db);
  }

  /**
   * Update cost rate in app_settings with audit logging.
   * Uses UPSERT to handle both initial insert and subsequent updates.
   */
  async setCostRate(costPerGb: number, adminId: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    await this.db.run(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      SETTINGS_KEY,
      String(costPerGb),
      now,
      adminId,
    );

    logger.info('Cost rate updated', {
      operation: 'setCostRate',
      costPerGb,
      adminId,
    });
  }

  /**
   * Generate a CSV string from a CostAggregation result.
   * Columns: Retailer, Bytes Downloaded, Bytes Uploaded, Total Bytes, Total GB,
   *          Request Count, Job Count, Estimated Cost ($)
   */
  generateCsv(aggregation: CostAggregation): string {
    const header = 'Retailer,Bytes Downloaded,Bytes Uploaded,Total Bytes,Total GB,Request Count,Job Count,Estimated Cost ($)';
    const rows = aggregation.retailers.map((r) =>
      csvRow([
        r.site,
        r.bytesDownloaded,
        r.bytesUploaded,
        r.totalBytes,
        r.totalGigabytes.toFixed(2),
        r.requestCount,
        r.jobCount,
        r.estimatedCost.toFixed(2),
      ]),
    );
    return [header, ...rows].join('\n');
  }
}

/** $/GB from app_settings, or config.scraping.defaultCostPerGb if unset or unreadable. */
export async function getCostRate(db: DatabaseService): Promise<number> {
  try {
    const row = await db.get<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = $1',
      SETTINGS_KEY,
    );
    if (row) {
      const parsed = Number.parseFloat(row.value);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
  } catch (err) {
    logger.warn('Failed to read cost rate from app_settings, using default', {
      operation: 'getCostRate',
      error: (err as Error).message,
    });
  }
  return config.scraping.defaultCostPerGb;
}
