import { http, qs } from './http';

export interface DlqJob {
  id: string;
  site: string;
  brand: string;
  jobId: string;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
}

export interface DiskCategory {
  name: 'excels' | 'variant_cache' | 'logs' | 'other';
  label: string;
  path: string | null;
  bytes: number;
  gb: number;
  percent_of_used: number;
  count?: number;
  actionable: boolean;
}

export interface DiskInfo {
  total_gb: number;
  used_gb: number;
  available_gb: number;
  used_percent: number;
  available_percent: number;
  warning: boolean;
  categories: DiskCategory[];
}

export interface ExcelReport {
  job_id: string;
  site: string;
  brand: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  file_path: string;
  file_size_bytes: number | null;
  file_missing: boolean;
}

export interface PagePagination {
  page: number;
  limit: number;
  total: number;
}

/** Live health from GET /admin/health/stream/poll and the `health` SSE event. */
export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  checks: {
    postgresql: { ok: boolean; poolSize: number; activeConnections: number };
    redis: { ok: boolean; memoryUsageMb: number; connectedClients: number };
    queue: { ok: boolean; waiting: number; active: number; stalled: number };
    workers: { ok: boolean; activeWorkers: number; expectedWorkers: number };
  };
}

export interface HealthSnapshot {
  bucket: string;
  status: string;
  uptime: number;
  pg_ok: boolean;
  pg_pool_size: number;
  pg_active_connections: number;
  redis_ok: boolean;
  redis_memory_mb: number;
  redis_clients: number;
  queue_waiting: number;
  queue_active: number;
  queue_stalled: number;
  workers_active: number;
  workers_expected: number;
}

export type HealthRange = '24h' | '7d' | '30d';

/** One site/brand pair's catalog caches (GET /admin/health/cache). */
export interface CacheInventoryEntry {
  site: string;
  brand: string;
  discoveryBytes: number;
  discoveryAgeHours: number | null;
  variantBytes: number;
  variantProductCount: number;
  suspectedPoisoned: boolean;
}

export const systemApi = {
  async getDiskSpace() {
    return http.request<{
      success: true;
      disk: DiskInfo;
    }>('/admin/disk-space');
  },

  async getAdminExcelReports(page = 1, limit = 50) {
    return http.request<{
      success: true;
      reports: ExcelReport[];
      pagination: PagePagination;
      /** Days a report stays on disk before the cleanup sweep (REPORT_RETENTION_DAYS). */
      retention_days?: number;
    }>(`/admin/reports/excels${qs({ page, limit })}`);
  },

  async deleteAdminExcelReport(jobId: string) {
    return http.request<{
      success: true;
      message: string;
      deleted: boolean;
      bytes_freed: number;
    }>(`/admin/reports/excels/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  },

  async getFailedJobs(page = 1, pageSize = 20) {
    return http.request<{
      success: true;
      jobs: DlqJob[];
      total: number;
      page: number;
      page_size: number;
    }>(`/admin/dlq${qs({ page, page_size: pageSize })}`);
  },

  async retryFailedJob(jobId: string) {
    return http.request<{ success: true; message: string }>(
      `/admin/dlq/${encodeURIComponent(jobId)}/retry`,
      { method: 'POST' },
    );
  },

  async discardFailedJob(jobId: string) {
    return http.request<{ success: true; message: string }>(
      `/admin/dlq/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
    );
  },

  async retryAllFailedJobs() {
    return http.request<{ success: true; retried: number; failed: number }>(
      '/admin/dlq/retry-all',
      { method: 'POST' },
    );
  },

  async discardAllFailedJobs() {
    return http.request<{ success: true; discarded: number; failed: number }>(
      '/admin/dlq/discard-all',
      { method: 'POST' },
    );
  },

  async getHealthHistory(range: HealthRange = '24h') {
    return http.request<{
      success: true;
      range: string;
      snapshots: HealthSnapshot[];
    }>(`/admin/health/history${qs({ range })}`);
  },

  async healthPoll() {
    return http.request<HealthReport>('/admin/health/stream/poll');
  },

  async healthAction(action: string, body?: Record<string, unknown>) {
    return http.request<{ success: true; message: string }>(
      `/admin/health/actions/${action}`,
      {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
  },

  async getCacheInventory() {
    return http.request<{
      success: true;
      caches: CacheInventoryEntry[];
    }>('/admin/health/cache');
  },
};
