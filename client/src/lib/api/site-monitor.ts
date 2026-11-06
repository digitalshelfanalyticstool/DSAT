import { http, qs } from './http';

export interface MonitorSchedule {
  enabled: boolean;
  schedule_time: string;
  schedule_days: number[];
}

export interface SiteMonitorRun {
  id: number;
  status: 'running' | 'completed' | 'failed';
  retailers_checked: number;
  total_changes_detected: number;
  critical_changes: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface SiteMonitorChange {
  id: number;
  retailer: string;
  product_id: number;
  url: string;
  change_type: string;
  selector_or_field: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  before_value: string | null;
  after_value: string | null;
  detected_at: string;
}

export interface SiteMonitorRetailerSummary {
  retailer: string;
  last_check_date: string | null;
  change_count: number;
  highest_severity: 'critical' | 'warning' | 'info' | null;
}

export interface MonitorProgressEvent {
  runId: number;
  type: string;
  timestamp: string;
  message: string;
  retailer?: string;
  product_id?: number;
  url?: string;
  changes_found?: number;
  critical_count?: number;
  error?: string;
}

export const siteMonitorApi = {
  async getSiteMonitorRuns(page = 1, limit = 20) {
    return http.request<{
      success: true;
      runs: SiteMonitorRun[];
      pagination: { page: number; limit: number; total: number };
    }>(`/site-monitor/runs${qs({ page, limit })}`);
  },

  async getSiteMonitorRunChanges(runId: number, retailer?: string, severity?: string) {
    const endpoint = `/site-monitor/runs/${runId}/changes${qs({ retailer, severity })}`;
    return http.request<{
      success: true;
      changes: SiteMonitorChange[];
    }>(endpoint);
  },

  async getSiteMonitorSummary() {
    return http.request<{
      success: true;
      retailers: SiteMonitorRetailerSummary[];
    }>('/site-monitor/summary');
  },

  async getSiteMonitorSchedule() {
    return http.request<{
      success: true;
      schedule: MonitorSchedule;
    }>('/site-monitor/schedule');
  },

  async updateSiteMonitorSchedule(schedule: MonitorSchedule) {
    return http.request<{
      success: true;
      schedule: MonitorSchedule;
    }>('/site-monitor/schedule', {
      method: 'PUT',
      body: JSON.stringify(schedule),
    });
  },

  async triggerSiteMonitorRun() {
    return http.request<{
      success: true;
      run_id: number;
      status: 'running';
    }>('/site-monitor/trigger', { method: 'POST' });
  },

};
