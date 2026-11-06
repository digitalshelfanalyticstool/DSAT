/**
 * Bright Data Usage Service - fetches account status and bandwidth stats
 * from the Bright Data Account Management API.
 *
 * API Reference:
 *   - GET https://api.brightdata.com/zone/bw?zone=<name>  - bandwidth stats
 *   - GET https://api.brightdata.com/status                - account status
 *
 * Results are cached in-memory with a configurable TTL to avoid hammering
 * the Bright Data API on every admin page load.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('brightdata-usage');

const BD_API_BASE = 'https://api.brightdata.com';
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface BrightDataAccountStatus {
  status: string;
  customer: string;
  can_make_requests: boolean;
  auth_fail_reason?: string;
  ip?: string;
}

export interface BandwidthSums {
  bw_sum: number;
  bw_dn: number;
  bw_up: number;
  http_direct_req: number;
  https_direct_req: number;
  bw_api: number;
}

export interface ZoneBandwidthStats {
  customer_id: string;
  from: string;
  to: string;
  daily_bw: number[];
  sums: {
    current_month: BandwidthSums;
    previous_month: BandwidthSums;
    today: BandwidthSums;
    yesterday: BandwidthSums;
  };
}

export interface BrightDataUsageSummary {
  account: BrightDataAccountStatus;
  zones: Array<{ name: string; bandwidth: ZoneBandwidthStats }>;
  fetched_at: string;
}

interface CacheEntry<T> {
  data: T;
  expires_at: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expires_at) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expires_at: Date.now() + CACHE_TTL_MS });
}

async function bdFetch<T>(apiPath: string, apiKey: string): Promise<T> {
  const url = BD_API_BASE + apiPath;
  logger.info('Fetching Bright Data API', { operation: 'bdFetch', path: apiPath });

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(no body)');
    logger.error('Bright Data API error', {
      operation: 'bdFetch',
      path: apiPath,
      status: response.status,
      body: body.slice(0, 500),
    });
    throw new Error('Bright Data API returned ' + response.status + ': ' + body.slice(0, 200));
  }

  return response.json() as Promise<T>;
}

export async function getAccountStatus(apiKey: string): Promise<BrightDataAccountStatus> {
  const cacheKey = 'bd:status';
  const cached = getCached<BrightDataAccountStatus>(cacheKey);
  if (cached) return cached;

  const data = await bdFetch<BrightDataAccountStatus>('/status', apiKey);
  setCache(cacheKey, data);
  return data;
}

export async function getZoneBandwidth(
  apiKey: string,
  zone: string,
): Promise<ZoneBandwidthStats> {
  const cacheKey = 'bd:bw:' + zone;
  const cached = getCached<ZoneBandwidthStats>(cacheKey);
  if (cached) return cached;

  const raw = await bdFetch<Record<string, unknown>>(
    '/zone/bw?zone=' + encodeURIComponent(zone),
    apiKey,
  );

  const entries = Object.values(raw);
  if (entries.length === 0) {
    throw new Error('No bandwidth data returned for zone: ' + zone);
  }

  const entry = entries[0] as Record<string, unknown>;
  const dataBlock = entry.data as Record<string, Record<string, number[]>> | undefined;
  const sumsBlock = entry.sums as Record<string, Record<string, BandwidthSums>> | undefined;

  let dailyBw: number[] = [];
  if (dataBlock) {
    const firstCategory = Object.values(dataBlock)[0];
    if (firstCategory?.bw_sum) {
      dailyBw = firstCategory.bw_sum;
    }
  }

  const emptySums: BandwidthSums = {
    bw_sum: 0, bw_dn: 0, bw_up: 0, http_direct_req: 0, https_direct_req: 0, bw_api: 0,
  };

  let currentMonth = { ...emptySums };
  let previousMonth = { ...emptySums };
  let today = { ...emptySums };
  let yesterday = { ...emptySums };

  if (sumsBlock) {
    const firstSumCategory = Object.values(sumsBlock)[0];
    if (firstSumCategory) {
      currentMonth = firstSumCategory.back_m0 ?? currentMonth;
      previousMonth = firstSumCategory.back_m1 ?? previousMonth;
      today = firstSumCategory.back_d0 ?? today;
      yesterday = firstSumCategory.back_d1 ?? yesterday;
    }
  }

  const stats: ZoneBandwidthStats = {
    customer_id: (entry.customer_id as string) ?? '',
    from: (entry.from as string) ?? '',
    to: (entry.to as string) ?? '',
    daily_bw: dailyBw,
    sums: { current_month: currentMonth, previous_month: previousMonth, today, yesterday },
  };

  setCache(cacheKey, stats);
  return stats;
}

export async function getUsageSummary(
  apiKey: string,
  zoneNames: string[],
): Promise<BrightDataUsageSummary> {
  const cacheKey = 'bd:summary:' + zoneNames.join(',');
  const cached = getCached<BrightDataUsageSummary>(cacheKey);
  if (cached) return cached;

  const [account, ...bandwidthResults] = await Promise.allSettled([
    getAccountStatus(apiKey),
    ...zoneNames.map((z) => getZoneBandwidth(apiKey, z)),
  ]);

  if (account.status === 'rejected') {
    throw new Error('Failed to fetch account status: ' + account.reason);
  }

  const zones: BrightDataUsageSummary['zones'] = [];
  for (let i = 0; i < zoneNames.length; i++) {
    const result = bandwidthResults[i];
    if (result.status === 'fulfilled') {
      zones.push({ name: zoneNames[i], bandwidth: result.value });
    } else {
      logger.warn('Failed to fetch bandwidth for zone', {
        operation: 'getUsageSummary',
        zone: zoneNames[i],
        error: (result.reason as Error).message,
      });
    }
  }

  const summary: BrightDataUsageSummary = {
    account: account.value,
    zones,
    fetched_at: new Date().toISOString(),
  };

  setCache(cacheKey, summary);
  return summary;
}

export function clearUsageCache(): void {
  for (const key of cache.keys()) {
    if (key.startsWith('bd:')) {
      cache.delete(key);
    }
  }
}
