import { http, qs } from './http';

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  created_at: string;
  updated_at: string;
  is_active: boolean | number;
  last_login: string | null;
  locked_until: string | null;
}

export interface AuditLogEntry {
  id: number;
  user: { id: number; username: string } | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

export const usersApi = {
  async getAdminUsers(filters?: { role?: string; is_active?: string; search?: string }) {
    return http.request<{
      success: true;
      users: AdminUser[];
    }>(`/admin/users${qs(filters)}`);
  },

  async createAdminUser(data: { username: string; email: string; password: string; role: string }) {
    return http.request<{
      success: true;
      user: AdminUser;
    }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateAdminUser(userId: number, updates: Record<string, unknown>) {
    return http.request<{
      success: true;
      user: AdminUser;
    }>(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteAdminUser(userId: number) {
    return http.request<{
      success: true;
      message: string;
    }>(`/admin/users/${userId}`, {
      method: 'DELETE',
    });
  },

  async reactivateAdminUser(userId: number) {
    return http.request<{
      success: true;
      user: AdminUser;
    }>(`/admin/users/${userId}/reactivate`, {
      method: 'POST',
    });
  },

  async lockAdminUser(userId: number) {
    return http.request<{
      success: true;
      user: AdminUser;
    }>(`/admin/users/${userId}/lock`, {
      method: 'POST',
    });
  },

  async unlockAdminUser(userId: number) {
    return http.request<{
      success: true;
      user: AdminUser;
    }>(`/admin/users/${userId}/unlock`, {
      method: 'POST',
    });
  },

  async getAuditLogs(filters?: {
    user_id?: number;
    action?: string;
    resource_type?: string;
    start_date?: string;
    end_date?: string;
    page?: number;
    limit?: number;
  }) {
    return http.request<{
      success: true;
      logs: AuditLogEntry[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(`/admin/audit-logs${qs(filters)}`);
  },

  /** Download an authenticated export (users, audit logs, import template). */
  downloadExport(endpoint: string, fallbackFilename = 'download'): Promise<void> {
    return http.download(endpoint, fallbackFilename);
  },

  async importUsers(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    return http.request<{
      success: true;
      created: number;
      updated: number;
      errors: Array<{ row: number; error: string }>;
    }>('/admin/users/import', {
      method: 'POST',
      body: formData,
      // Don't set Content-Type — browser sets it with boundary for multipart
    });
  },
};
