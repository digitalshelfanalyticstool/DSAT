/**
 * Rules for a `users` row that every writer shares: field validation, password
 * hashing, and the row → API shape. No database access, so any module that
 * creates or edits users can import it without an import cycle.
 */
import bcrypt from 'bcrypt';
import { config } from '../config';
import type { UserRow, UserResponse } from '../types/auth';

export class UserManagerError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'UserManagerError';
  }
}

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 50;

export function validateUsername(username: string): void {
  if (!username || typeof username !== 'string') {
    throw new UserManagerError('Username is required', 400);
  }
  const trimmed = username.trim();
  if (trimmed.length < USERNAME_MIN) {
    throw new UserManagerError(`Username must be at least ${USERNAME_MIN} characters`, 400);
  }
  if (trimmed.length > USERNAME_MAX) {
    throw new UserManagerError(`Username must be at most ${USERNAME_MAX} characters`, 400);
  }
}

export function validateEmail(email: string): void {
  if (!email || typeof email !== 'string') {
    throw new UserManagerError('Email is required', 400);
  }
  const trimmed = email.trim();
  // Length guard prevents polynomial backtracking on adversarial input
  if (trimmed.length > 254) {
    throw new UserManagerError('Invalid email format', 400);
  }
  const atIndex = trimmed.indexOf('@');
  const lastAt = trimmed.lastIndexOf('@');
  if (atIndex < 1 || atIndex !== lastAt || atIndex === trimmed.length - 1) {
    throw new UserManagerError('Invalid email format', 400);
  }
  const domain = trimmed.slice(atIndex + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    throw new UserManagerError('Invalid email format', 400);
  }
  if (/\s/.test(trimmed)) {
    throw new UserManagerError('Invalid email format', 400);
  }
}

/**
 * locked_until value an admin lock writes (2100-01-01). A failed-sign-in
 * throttle writes a time minutes ahead; is_active = 0 alone is a deleted account.
 */
export const MANUAL_LOCK_UNTIL = 4102444800;

/** Admins may act on anything; everyone else only on what they own. */
export function isOwnerOrAdmin(ownerId: string | number | null, userId: string | number, role: string): boolean {
  return role === 'admin' || (ownerId != null && String(ownerId) === String(userId));
}

/** Whether an account created with a password someone else chose must replace it on first sign-in. */
export function mustChangePasswordOnCreate(role: string): boolean {
  return role !== 'admin';
}

/** Read at call time so BCRYPT_COST changes (and test overrides) apply. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.auth.bcryptCost);
}

export function toUserResponse(row: Omit<UserRow, 'password_hash'>): UserResponse {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    created_at: new Date(row.created_at * 1000).toISOString(),
    updated_at: new Date(row.updated_at * 1000).toISOString(),
    is_active: row.is_active === 1,
    last_login: row.last_login ? new Date(row.last_login * 1000).toISOString() : null,
    must_change_password: row.must_change_password === 1,
    locked_until: row.locked_until ? new Date(row.locked_until * 1000).toISOString() : null,
    has_completed_onboarding: row.has_completed_onboarding === 1,
  };
}
