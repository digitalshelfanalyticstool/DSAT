import { http, qs } from './http';

export interface EmailSettings {
  provider: 'disabled' | 'smtp';
  from_address: string | null;
  from_name: string | null;
  has_credentials: boolean;
  is_enabled: boolean;
  updated_at: string;
  updated_by: number | null;
}

export interface EmailSettingsInput {
  provider?: 'disabled' | 'smtp';
  from_address?: string | null;
  from_name?: string | null;
  smtp_credentials?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    requireTls?: boolean;
  };
  is_enabled?: boolean;
}

export interface EmailTemplate {
  slug: string;
  subject: string;
  body_html: string;
  body_text: string;
  variables: string[];
  updated_at: string;
  updated_by: number | null;
}

export type EmailTemplateInput = Pick<EmailTemplate, 'subject' | 'body_html' | 'body_text' | 'variables'>;

export interface EmailLogEntry {
  id: number;
  to_address: string;
  template_slug: string | null;
  subject: string | null;
  provider: string;
  status: 'sent' | 'skipped' | 'failed';
  message_id: string | null;
  error: string | null;
  latency_ms: number | null;
  sent_at: string;
}

export const emailApi = {
  async getEmailSettings() {
    return http.request<{ success: boolean; settings: EmailSettings }>('/admin/email/settings');
  },

  async updateEmailSettings(input: EmailSettingsInput) {
    return http.request<{ success: boolean; settings: EmailSettings }>('/admin/email/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async sendTestEmail(to: string) {
    return http.request<{
      success: boolean;
      result: { status: 'sent' | 'skipped' | 'failed'; error?: string; messageId?: string };
    }>('/admin/email/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    });
  },

  async listEmailTemplates() {
    return http.request<{ success: boolean; templates: EmailTemplate[] }>('/admin/email/templates');
  },

  async getEmailTemplate(slug: string) {
    return http.request<{ success: boolean; template: EmailTemplate }>(`/admin/email/templates/${slug}`);
  },

  async updateEmailTemplate(slug: string, input: EmailTemplateInput) {
    return http.request<{ success: boolean; template: EmailTemplate }>(`/admin/email/templates/${slug}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async listEmailLog(opts?: { status?: string; limit?: number }) {
    return http.request<{ success: boolean; log: EmailLogEntry[] }>(`/admin/email/log${qs(opts)}`);
  },
};
