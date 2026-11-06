import { http, qs } from './http';

export interface Job {
  job_id: string;
  site: string;
  brand: string;
  user_id: string;
  username?: string;
  owner?: { id: number; username: string; email: string };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase?: string | null;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  products_discovered?: number;
  products_processed?: number;
  variants_extracted?: number;
  failed_products?: string[];
  error_message?: string;
  file_path?: string;
  restart_count?: number;
  restart_parent_id?: string | null;
}

export interface ScheduledJobEntry {
  id: number;
  user_id: number;
  site: string;
  brand: string;
  schedule_time: string;
  schedule_days: string;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  max_retries: number;
  retry_delay_minutes: number;
  current_retry_count: number;
  next_retry_at: number | null;
  last_failure_reason: string | null;
}

export interface JobAnalytics {
  price_distribution: { range: string; count: number }[];
  discount_summary: { avg_discount_pct: number; on_sale_count: number; full_price_count: number };
  variant_heatmap: { colors: string[]; sizes: string[]; matrix: number[][] };
  data_completeness: Record<string, number>;
  phase_timings: Record<string, number> | null;
}

/** Dashboard counters from GET /jobs/stats. */
export interface JobStats {
  jobsToday: number;
  activeJobs: number;
  recentCompletions: number;
}

export const jobsApi = {
  async createJob(site: string, brand: string) {
    return http.request<{
      success: true;
      job: Job;
    }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ site, brand }),
    });
  },

  async getJobs(filters?: {
    site?: string;
    brand?: string;
    status?: string;
    date_from?: string;
    date_to?: string;
    page?: number;
    page_size?: number;
  }) {
    return http.request<{
      success: true;
      jobs: Job[];
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    }>(`/jobs${qs(filters)}`);
  },

  async getJobStats() {
    return http.request<{
      success: true;
      stats: JobStats;
      recentJobs: Job[];
    }>('/jobs/stats');
  },

  async getJob(jobId: string) {
    return http.request<{
      success: true;
      job: Job;
    }>(`/jobs/${jobId}`);
  },

  async cancelJob(jobId: string) {
    return http.request<{
      success: true;
      job: Job;
    }>(`/jobs/${jobId}`, {
      method: 'DELETE',
    });
  },

  async deleteJob(jobId: string) {
    return http.request<{
      success: true;
      message: string;
    }>(`/jobs/${jobId}/purge`, {
      method: 'DELETE',
    });
  },

  async restartJob(jobId: string) {
    return http.request<{
      success: true;
      job_id: string;
      original_job_id: string;
      status: string;
      restart_count: number;
    }>(`/jobs/${jobId}/restart`, {
      method: 'POST',
    });
  },

  async continueJob(jobId: string) {
    return http.request<{
      success: true;
      job_id: string;
      status: string;
      restart_count: number;
      checkpoint_phase: string | null;
    }>(`/jobs/${jobId}/continue`, {
      method: 'POST',
    });
  },

  async checkJobCheckpoint(jobId: string) {
    return http.request<{
      success: true;
      has_checkpoint: boolean;
    }>(`/jobs/${jobId}/checkpoint`);
  },


  /** Throws FileExpiredError when the file was cleaned up; reExportFile() re-creates it. */
  downloadFile(jobId: string): Promise<void> {
    return http.download(`/jobs/${jobId}/download`, `job-${jobId}.xlsx`);
  },

  async reExportFile(jobId: string): Promise<{ success: boolean; file?: { filename: string; download_url: string } }> {
    return http.request<{ success: boolean; file?: { filename: string; download_url: string } }>(
      `/jobs/${jobId}/re-export`,
      { method: 'POST' },
    );
  },

  async getSchedules() {
    return http.request<{
      success: true;
      schedules: ScheduledJobEntry[];
    }>('/jobs/schedules/list');
  },

  async createSchedule(data: {
    site: string;
    brand: string;
    schedule_time: string;
    schedule_days: number[];
    max_retries?: number;
    retry_delay_minutes?: number;
  }) {
    return http.request<{
      success: true;
      schedule: ScheduledJobEntry;
    }>('/jobs/schedules', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateSchedule(scheduleId: number, updates: {
    schedule_time?: string;
    schedule_days?: number[];
    enabled?: boolean;
    max_retries?: number;
    retry_delay_minutes?: number;
  }) {
    return http.request<{
      success: true;
      schedule: ScheduledJobEntry;
    }>(`/jobs/schedules/${scheduleId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteSchedule(scheduleId: number) {
    return http.request<{
      success: true;
      message: string;
    }>(`/jobs/schedules/${scheduleId}`, {
      method: 'DELETE',
    });
  },

  async getJobAnalytics(jobId: string): Promise<{ success: boolean; analytics: JobAnalytics }> {
    return http.request(`/jobs/${jobId}/analytics`);
  },
};
