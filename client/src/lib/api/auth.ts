import { http } from './http';
import type { PaletteId } from '../palettes';
import type { AdminUser } from './users';

/** The signed-in user as /auth/session describes them. */
export interface SessionUser {
  user_id: string;
  username: string;
  role: string;
  must_change_password?: boolean;
  has_completed_onboarding?: boolean;
}

export const authApi = {
  setToken(token: string | null): void {
    http.setToken(token);
  },

  /** The API base URL, for links the browser follows itself (SSO start). */
  getBaseUrl(): string {
    return http.baseUrl;
  },

  /**
   * Picks up the session an SSO callback left in the refresh cookie. The callback
   * never puts a token in the URL, so this is how the access token arrives.
   */
  refreshSession(): Promise<boolean> {
    return http.refresh();
  },

  async login(username: string, password: string) {
    const response = await http.request<{
      success: true;
      token: string;
      user: { user_id: string; username: string; role: string; has_completed_onboarding?: boolean };
      must_change_password: boolean;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    // Access token in memory only; the refresh token is an httpOnly cookie.
    http.setToken(response.token);
    return response;
  },

  /** A 60s single-use ticket for /auth/sso/start?link=, which connects SSO to this account. */
  async getSsoLinkTicket() {
    return http.request<{ success: true; ticket: string }>('/auth/sso/link-ticket', { method: 'POST' });
  },

  async disconnectSso() {
    return http.request<{ success: true }>('/auth/sso/link', { method: 'DELETE' });
  },

  /** Whether the sign-in page shows a "Sign in with <label>" button. */
  async getSsoConfig(): Promise<{ enabled: boolean; label: string }> {
    return http.request<{ success: true; enabled: boolean; label: string }>('/auth/sso/config');
  },

  async getSetupStatus(): Promise<{ needsSetup: boolean }> {
    return http.request<{ success: true; needsSetup: boolean }>('/auth/setup-status');
  },

  /** Creates the first admin on a fresh install and signs them in. */
  async completeSetup(body: { setupCode: string; username: string; email: string; password: string; palette?: PaletteId }) {
    const response = await http.request<{ success: true; token: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    http.setToken(response.token);
    return response;
  },

  /** Revokes every refresh token server-side, so the caller signs in again. */
  async changePassword(currentPassword: string, newPassword: string) {
    return http.request<{ success: true; message: string }>('/auth/account/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  async logout(): Promise<void> {
    try {
      await http.request('/auth/logout', { method: 'POST' });
    } finally {
      http.setToken(null);
    }
  },

  async getSession() {
    return http.request<{
      success: true;
      user: SessionUser;
    }>('/auth/session');
  },

  async getAccount() {
    return http.request<{
      success: true;
      user: AdminUser;
      ssoLinked: boolean;
    }>('/auth/account');
  },

  async completeOnboarding() {
    return http.request<{ success: true }>('/auth/onboarding-complete', { method: 'PATCH' });
  },

  /**
   * Mint a short-lived ticket for EventSource. Access tokens must never go in
   * a URL — Nginx logs query strings.
   */
  async getSseTicket(): Promise<string> {
    const res = await http.request<{ success: true; ticket: string }>('/auth/sse-ticket', { method: 'POST' });
    return res.ticket;
  },
};
