/**
 * Shared authentication types used across middleware and services.
 *
 * Centralises the four cross-module auth types so any file in the codebase
 * can import from a single, well-known location.
 */

import type { Request } from 'express';

// --- Request augmentation ---

/**
 * Extend Express Request to include authenticated user.
 */
export interface AuthenticatedRequest extends Request {
  user?: UserResponse;
  /**
   * The verified JWT claims for the access token on this request (only the
   * fields the logout flow needs). Set by `authMiddleware` for JWT-authenticated
   * requests. Used by `/logout` to denylist the token's `jti`.
   */
  accessTokenPayload?: { jti?: string; exp: number };
}

// --- Database row type ---

export interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: number;
  updated_at: number;
  is_active: number;
  last_login: number | null;
  must_change_password: number;
  locked_until: number | null;
  has_completed_onboarding: number;
  /** OIDC issuer and subject of the linked SSO identity; NULL when not linked. */
  sso_issuer: string | null;
  sso_subject: string | null;
}

// --- Safe response type ---

export interface UserResponse {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  created_at: string;
  updated_at: string;
  is_active: boolean;
  last_login: string | null;
  must_change_password: boolean;
  locked_until: string | null;
  has_completed_onboarding: boolean;
}
