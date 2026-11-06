import { http } from './http';

export interface GlobalMessage {
  id: number;
  user_id: number | null;
  title: string | null;
  message: string;
  type: 'info' | 'warning' | 'error';
  active: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  author?: string;
}

export const messagesApi = {
  async getMessages() {
    return http.request<{
      success: true;
      messages: GlobalMessage[];
    }>('/admin/messages');
  },

  async createMessage(data: { title?: string; message: string; type?: string; expires_at?: number | null }) {
    return http.request<{
      success: true;
      message: GlobalMessage;
    }>('/admin/messages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateMessage(id: number, updates: Partial<{ title: string; message: string; type: string; active: boolean; expires_at: number | null }>) {
    return http.request<{
      success: true;
      message: GlobalMessage;
    }>(`/admin/messages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteMessage(id: number) {
    return http.request<{
      success: true;
      message: string;
    }>(`/admin/messages/${id}`, {
      method: 'DELETE',
    });
  },

  async getActiveMessages() {
    return http.request<{
      success: true;
      messages: GlobalMessage[];
    }>('/messages/active');
  },
};
