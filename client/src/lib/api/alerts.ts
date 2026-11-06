import { http, qs } from './http';

export type AlertKind = 'price_below' | 'price_drop' | 'out_of_stock' | 'broken_image';

export type AlertTargetType = 'all' | 'brand' | 'site' | 'product';

export interface AlertItem {
  id: number;
  rule_id: number | null;
  rule_name: string;
  kind: AlertKind;
  product_id: number;
  retailer: string;
  brand: string;
  details: Record<string, unknown>;
  read: boolean;
  created_at: string;
  product_title: string | null;
  product_url: string | null;
  style_id: string;
}

export interface AlertFilter { kind?: AlertKind; site?: string; brand?: string }

export interface AlertRuleInput {
  name: string;
  enabled: boolean;
  kind: AlertKind;
  target_type: AlertTargetType;
  target_site?: string | null;
  target_brand?: string | null;
  target_style_id?: string | null;
  threshold?: number | null;
  percent?: number | null;
}

export interface AlertRule extends AlertRuleInput { id: number }

export interface AlertWebhookInput {
  name: string;
  url: string;
  enabled: boolean;
  /** Omitted: keep the stored secret. null: remove it. */
  secret?: string | null;
}

export interface AlertWebhook {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  has_secret: boolean;
  last_status: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
}

export const alertsApi = {
  async getAlerts(filters: AlertFilter & { unread?: boolean; page?: number; limit?: number } = {}) {
    return http.request<{ success: true; total: number; alerts: AlertItem[] }>(`/alerts${qs(filters)}`);
  },

  async getUnreadAlertCount() {
    return http.request<{ success: true; count: number }>('/alerts/unread-count');
  },

  async markAlertsRead(body: { ids: number[] } | { filter: AlertFilter }) {
    return http.request<{ success: true; updated: number }>('/alerts/read', { method: 'POST', body: JSON.stringify(body) });
  },

  async getAlertRules() {
    return http.request<{ success: true; rules: AlertRule[] }>('/alerts/rules');
  },

  async createAlertRule(rule: AlertRuleInput) {
    return http.request<{ success: true; rule: AlertRule }>('/alerts/rules', { method: 'POST', body: JSON.stringify(rule) });
  },

  async updateAlertRule(id: number, rule: AlertRuleInput) {
    return http.request<{ success: true; rule: AlertRule }>(`/alerts/rules/${id}`, { method: 'PUT', body: JSON.stringify(rule) });
  },

  async deleteAlertRule(id: number) {
    return http.request<{ success: true }>(`/alerts/rules/${id}`, { method: 'DELETE' });
  },

  async getAlertWebhooks() {
    return http.request<{ success: true; webhooks: AlertWebhook[] }>('/alerts/webhooks');
  },

  async createAlertWebhook(hook: AlertWebhookInput) {
    return http.request<{ success: true; webhook: AlertWebhook }>('/alerts/webhooks', { method: 'POST', body: JSON.stringify(hook) });
  },

  async updateAlertWebhook(id: number, hook: AlertWebhookInput) {
    return http.request<{ success: true; webhook: AlertWebhook }>(`/alerts/webhooks/${id}`, { method: 'PUT', body: JSON.stringify(hook) });
  },

  async deleteAlertWebhook(id: number) {
    return http.request<{ success: true }>(`/alerts/webhooks/${id}`, { method: 'DELETE' });
  },

  async testAlertWebhook(id: number) {
    return http.request<{ success: boolean; status: number | null; error: string | null }>(`/alerts/webhooks/${id}/test`, { method: 'POST' });
  },
};
