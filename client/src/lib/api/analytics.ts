import { http, qs } from './http';

export interface AnalyticsOverview {
  kpi: {
    total_jobs: number; total_jobs_prev: number;
    products_scraped: number; products_scraped_prev: number;
    variants_extracted: number; variants_extracted_prev: number;
    success_rate: number; success_rate_prev: number;
  };
  daily_activity: { date: string; jobs: number; products: number }[];
  by_retailer: { site: string; job_count: number; product_count: number }[];
  price_trend: { date: string; avg_list_price: number; avg_selling_price: number }[];
  catalog_growth: { date: string; cumulative_products: number; new_products: number }[];
  success_by_retailer: { site: string; success_rate: number }[];
  recent_jobs: { job_id: string; site: string; brand: string; status: string; products_discovered: number; variants_extracted: number; completed_at: string | null }[];
  top_products: { product_name: string; product_url: string | null; retailer: string; variant_count: number; colors: string[] }[];
}

export interface ChangeSummary {
  new_products: number;
  dropped_products: number;
  price_increases: number;
  price_decreases: number;
  new_sellouts: number;
  restocked: number;
  retailers_compared: string[];
  has_data: boolean;
}

export interface SystemHealth {
  active_workers: number;
  queue_waiting: number;
  queue_active: number;
  queue_completed_total: number;
  queue_failed_total: number;
}

export interface WorkerInfo {
  id: string;
  concurrency_max: number;
  concurrency_active: number;
  last_heartbeat: string | null;
  pid: number | null;
}

export interface PhaseTimingEntry {
  phase: string;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  job_count: number;
}

export interface RetailerCompleteness {
  site: string;
  total_variants: number;
  upc_pct: number;
  selling_price_pct: number;
  list_price_pct: number;
  inventory_pct: number;
  item_number_pct: number;
}

export interface StaleProduct {
  style_id: string;
  // title/url are null for products that have only ever failed — they never get
  // a products row, so there's no metadata to enrich from. The UI falls back to
  // style_id and renders a non-link when url is null.
  title: string | null;
  url: string | null;
  retailer: string;
  consecutive_failures: number;
  last_seen_at: string;
}

export interface FailureModeEntry {
  site: string;
  failure_category: string;
  count: number;
}

export interface CacheHitRateEntry {
  site: string;
  total_runs: number;
  /** Fraction of runs (0-1) where the discovery phase served from catalog cache. */
  discovery_hit_rate: number;
  discovery_hits: number;
  variant_cache_hits: number;
  variant_cache_misses: number;
  /** Fraction (0-1) of products served from cache vs needing fresh fetch in Phase 2. */
  variant_hit_rate: number;
  cache_fill_hits: number;
  cache_fill_misses: number;
  /** Fraction (0-1) of failed products successfully filled from cache in Phase 4. */
  cache_fill_rate: number;
}

/** Scrape slots held for a site across all workers, against its configured maximum. */
export interface RateLimitInfo {
  site: string;
  in_use: number;
  max_concurrent: number;
  pct_used: number;
}

export interface CostEfficiencyRetailer {
  site: string;
  avg_cost_per_job: number;
  avg_cost_per_variant: number;
  total_jobs: number;
}

export interface CostEfficiencyTrend {
  date: string;
  avg_cost_per_job: number;
}

// Web Vitals admin chart row.
export interface WebVitalsP75Entry {
  route: string;
  name: string;
  p75: number;
  sample_count: number;
}

export const analyticsApi = {
  async getAnalyticsOverview(params: {
    from: string; to: string; site?: string; brand?: string;
  }): Promise<{ success: boolean; analytics: AnalyticsOverview }> {
    return http.request(`/analytics/overview${qs(params)}`);
  },

  async getChangeSummary(site?: string): Promise<ChangeSummary> {
    return http.request<ChangeSummary>(`/analytics/changes${qs({ site })}`);
  },

  async getAdminSystemHealth() {
    return http.request<{
      success: true;
      health: SystemHealth;
    }>('/admin/analytics/system-health');
  },

  async getAdminWorkers() {
    return http.request<{
      success: true;
      workers: WorkerInfo[];
    }>('/admin/analytics/workers');
  },

  async getAdminPhaseTiming(from: string, to: string) {
    return http.request<{
      success: true;
      phases: PhaseTimingEntry[];
    }>(`/admin/analytics/phase-timing${qs({ from, to })}`);
  },

  async getAdminDataCompleteness(from: string, to: string) {
    return http.request<{
      success: true;
      retailers: RetailerCompleteness[];
    }>(`/admin/analytics/data-completeness${qs({ from, to })}`);
  },

  async getAdminStaleProducts(from: string, to: string, site?: string) {
    return http.request<{
      success: true;
      products: StaleProduct[];
      total: number;
    }>(`/admin/analytics/stale-products${qs({ from, to, site })}`);
  },

  async getAdminRateLimits() {
    return http.request<{
      success: true;
      retailers: RateLimitInfo[];
    }>('/admin/analytics/rate-limits');
  },

  async getAdminFailures(days = 7) {
    return http.request<{
      success: true;
      days: number;
      breakdown: FailureModeEntry[];
    }>(`/admin/analytics/failures${qs({ days })}`);
  },

  async getAdminCacheHitRate(days = 7) {
    return http.request<{
      success: true;
      days: number;
      per_site: CacheHitRateEntry[];
    }>(`/admin/analytics/cache-hit-rate${qs({ days })}`);
  },

  async getAdminCostEfficiency(from: string, to: string, excludeAdmin = false) {
    return http.request<{
      success: true;
      by_retailer: CostEfficiencyRetailer[];
      trend: CostEfficiencyTrend[];
    }>(`/admin/analytics/cost-efficiency${qs({ from, to, exclude_admin: excludeAdmin || undefined })}`);
  },

  // Admin chart endpoint — p75 of each Core Web Vital per route.
  async getAdminWebVitals(days = 7, limit = 20) {
    return http.request<{
      success: true;
      data: WebVitalsP75Entry[];
      days: number;
      limit: number;
    }>(`/admin/analytics/web-vitals${qs({ days, limit })}`);
  },
};
