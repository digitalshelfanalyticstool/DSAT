import { http, qs } from './http';

export interface BrightDataAccountStatus {
  status: string;
  customer: string;
  can_make_requests: boolean;
  auth_fail_reason?: string;
}

export interface BandwidthSums {
  bw_sum: number;
  bw_dn: number;
  bw_up: number;
  http_direct_req: number;
  https_direct_req: number;
  bw_api: number;
}

export interface BrightDataZoneUsage {
  name: string;
  bandwidth: {
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
  };
}

/** Response from `getBrightDataUsage()`. */
export interface BrightDataUsageResponse {
  success: true;
  account: BrightDataAccountStatus;
  zones: BrightDataZoneUsage[];
  fetched_at: string;
}

export interface RetailerCostSummary {
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

export interface JobBandwidthRecord {
  jobId: string;
  site: string;
  bytesDownloaded: number;
  bytesUploaded: number;
  requestCount: number;
  createdAt: string;
}

// Several dashboard widgets ask for usage within milliseconds of each
// other; one upstream Bright Data fetch per 60s is enough.
const USAGE_CACHE_TTL_MS = 60_000;
let usageCache: { value: BrightDataUsageResponse; cachedAt: number } | null = null;
let usageInflight: Promise<BrightDataUsageResponse> | null = null;

function retailerCostsQuery(period: string, from?: string, to?: string, excludeAdmin = false): string {
  return qs({ period, from, to, exclude_admin: excludeAdmin || undefined });
}

export const brightdataApi = {
  /**
   * Bright Data account and zone usage, cached for 60s with in-flight dedup:
   * callers inside one fetch share its promise, callers after it get the
   * cached body until the TTL passes. `refresh` bypasses the cache and
   * repopulates it. A failed fetch leaves nothing cached.
   */
  getBrightDataUsage(refresh = false): Promise<BrightDataUsageResponse> {
    if (!refresh) {
      if (usageCache && Date.now() - usageCache.cachedAt < USAGE_CACHE_TTL_MS) {
        return Promise.resolve(usageCache.value);
      }
      if (usageInflight) return usageInflight;
    }
    const inflight = http
      .request<BrightDataUsageResponse>(`/admin/brightdata/usage${qs({ refresh: refresh || undefined })}`)
      .then((value) => {
        usageCache = { value, cachedAt: Date.now() };
        return value;
      })
      .finally(() => {
        if (usageInflight === inflight) usageInflight = null;
      });
    if (!refresh) usageInflight = inflight;
    return inflight;
  },

  /** Test-only: clear the usage cache between cases. */
  _resetBrightDataUsageCacheForTests(): void {
    usageCache = null;
    usageInflight = null;
  },

  downloadRetailerCostsCsv(period: string, from?: string, to?: string, excludeAdmin = false): Promise<void> {
    return http.download(
      `/admin/brightdata/retailer-costs/export${retailerCostsQuery(period, from, to, excludeAdmin)}`,
      'retailer-costs.csv',
    );
  },

  async getRetailerCosts(period: string, from?: string, to?: string, excludeAdmin = false) {
    return http.request<{
      success: true;
      data: CostAggregation;
    }>(`/admin/brightdata/retailer-costs${retailerCostsQuery(period, from, to, excludeAdmin)}`);
  },

  async updateCostRate(costPerGb: number) {
    return http.request<{
      success: true;
      cost_per_gb: number;
    }>('/admin/brightdata/cost-rate', {
      method: 'PUT',
      body: JSON.stringify({ cost_per_gb: costPerGb }),
    });
  },

  async getJobCost(jobId: string) {
    return http.request<{
      success: true;
      bandwidth: JobBandwidthRecord;
      estimatedCost: number;
    }>(`/admin/brightdata/job-costs/${jobId}`);
  },

  async getJobsBandwidth(ids: string[]) {
    return http.request<{
      success: true;
      results: Record<string, { bandwidth: JobBandwidthRecord; estimatedCost: number }>;
    }>('/admin/brightdata/job-costs/batch', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
};
