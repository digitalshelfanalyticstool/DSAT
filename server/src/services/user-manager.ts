/**
 * User Manager — CRUD operations, validation, profile management, and password changes.
 *
 * Handles:
 *   - Admin user management (create, update, soft-delete, reactivate, list, get)
 *   - User self-service (profile view/update, password change)
 *   - Input validation (username, email, password, uniqueness)
 *   - Audit logging for admin actions
 *   - Refresh token revocation on password change / user deletion
 */

import bcrypt from 'bcrypt';
import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import { validatePasswordStrength } from '../utils/password-validator.js';
import type { UserRow, UserResponse } from './auth-service';
export type { UserResponse };
import { invalidateUserCache } from './user-cache';
import type { AuditLogger, AuditRequestContext } from './audit-service';
import { MANUAL_LOCK_UNTIL, UserManagerError, hashPassword, mustChangePasswordOnCreate, toUserResponse, validateEmail, validateUsername } from './user-records';

export { UserManagerError, validateEmail, validateUsername };

const logger = createLogger('user-manager');

/**
 * End a deactivated account's access: revoke its refresh tokens and stop its
 * schedules (including any pending retry). `scheduled_jobs.updated_at` is in
 * milliseconds, `refresh_tokens.revoked_at` in seconds.
 */
export async function revokeAccountAccess(
  db: { run(sql: string, ...p: unknown[]): Promise<unknown> },
  userIds: number[],
  nowSec: number,
): Promise<void> {
  if (userIds.length === 0) return;
  await db.run(
    'UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = ANY($2::int[]) AND revoked_at IS NULL',
    nowSec, userIds,
  );
  await db.run(
    'UPDATE scheduled_jobs SET enabled = 0, next_retry_at = NULL, updated_at = $1 WHERE user_id = ANY($2::int[]) AND enabled = 1',
    nowSec * 1000, userIds,
  );
}

// --- Types ---

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
  password?: string;
  role?: 'admin' | 'user';
  is_active?: boolean;
}

export interface UserFilters {
  role?: 'admin' | 'user';
  is_active?: boolean;
  search?: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** Optional request context for audit logging. */
/**
 * Check that a username is unique in the database.
 * Optionally excludes a specific user ID (for updates where the user keeps their own name).
 * @param db - Database service instance
 * @param username - The username to check
 * @param excludeUserId - User ID to exclude from the uniqueness check (optional)
 * @throws {UserManagerError} 409 if the username is already taken by another user
 */
async function checkUsernameUnique(db: DatabaseService, username: string, excludeUserId?: number): Promise<void> {
  const query = excludeUserId
    ? 'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2'
    : 'SELECT id FROM users WHERE LOWER(username) = LOWER($1)';
  const params = excludeUserId ? [username, excludeUserId] : [username];
  const existing = await db.get<{ id: number }>(query, ...params);
  if (existing) {
    throw new UserManagerError('Username already exists', 409);
  }
}

/**
 * Check that an email is unique in the database.
 * Optionally excludes a specific user ID (for updates where the user keeps their own email).
 * @param db - Database service instance
 * @param email - The email to check
 * @param excludeUserId - User ID to exclude from the uniqueness check (optional)
 * @throws {UserManagerError} 409 if the email is already taken by another user
 */
async function checkEmailUnique(db: DatabaseService, email: string, excludeUserId?: number): Promise<void> {
  const query = excludeUserId
    ? 'SELECT id FROM users WHERE email = $1 AND id != $2'
    : 'SELECT id FROM users WHERE email = $1';
  const params = excludeUserId ? [email, excludeUserId] : [email];
  const existing = await db.get<{ id: number }>(query, ...params);
  if (existing) {
    throw new UserManagerError('Email already exists', 409);
  }
}

// --- Admin Operations ---

/**
 * Create a new user account. Admin-only operation.
 * Validates all input fields, checks username/email uniqueness, hashes the password
 *, and logs the action to the audit trail.
 * @param db - Database service instance
 * @param input - New user data (username, email, password, role)
 * @param adminUserId - ID of the admin performing the action
 * @param audit - Optional audit service for logging the create_user action
 * @param ctx - Optional request context (IP address, user agent) for audit records
 * @returns The created user (without password_hash)
 * @throws {UserManagerError} 400 if validation fails (username/email/password rules)
 * @throws {UserManagerError} 409 if username or email already exists
 */
export async function createUser(
  db: DatabaseService,
  input: CreateUserInput,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  validateUsername(input.username);
  validateEmail(input.email);

  // Use strong password policy for new user creation
  const pwResult = validatePasswordStrength(input.password);
  if (!pwResult.valid) {
    throw new UserManagerError(pwResult.errors.join('; '), 400);
  }

  const username = input.username.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();

  await checkUsernameUnique(db, username);
  await checkEmailUnique(db, email);

  const passwordHash = await hashPassword(input.password);
  const now = Math.floor(Date.now() / 1000);
  const mustChangePassword = mustChangePasswordOnCreate(input.role) ? 1 : 0;

  const user = (await db.get<UserRow>(
    'INSERT INTO users (username, email, password_hash, role, created_at, updated_at, is_active, must_change_password) VALUES ($1, $2, $3, $4, $5, $6, 1, $7) RETURNING *',
    username, email, passwordHash, input.role, now, now, mustChangePassword,
  ))!;

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'create_user',
      resourceType: 'user',
      resourceId: String(user.id),
      details: JSON.stringify({ username, email, role: input.role }),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User created', { operation: 'createUser', userId: user.id, username });

  return toUserResponse(user);
}

/**
 * Update an existing user. Admin-only operation.
 * Supports partial updates: only provided fields are changed.
 * When the password is changed, all refresh tokens for the user are revoked.
 * @param db - Database service instance
 * @param userId - ID of the user to update
 * @param updates - Fields to update (username, email, password, role, is_active)
 * @param adminUserId - ID of the admin performing the action
 * @param audit - Optional audit service for logging the update_user action
 * @param ctx - Optional request context (IP address, user agent) for audit records
 * @returns The updated user (without password_hash)
 * @throws {UserManagerError} 404 if user not found
 * @throws {UserManagerError} 400 if validation fails
 * @throws {UserManagerError} 409 if updated username or email conflicts with another user
 */
/**
 * Shared helper: validate update fields, build SET clauses, and execute the UPDATE.
 */
async function validateAndApplyUpdates(
  db: DatabaseService,
  userId: number,
  updates: UpdateUserInput,
): Promise<UserRow> {
  const existing = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!existing) {
    throw new UserManagerError('User not found', 404);
  }

  if (updates.username !== undefined) {
    validateUsername(updates.username);
    await checkUsernameUnique(db, updates.username.trim().toLowerCase(), userId);
  }
  if (updates.email !== undefined) {
    validateEmail(updates.email);
    await checkEmailUnique(db, updates.email.trim().toLowerCase(), userId);
  }
  if (updates.password !== undefined) {
    const pwResult = validatePasswordStrength(updates.password);
    if (!pwResult.valid) {
      throw new UserManagerError(pwResult.errors.join('; '), 400);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const setClauses: string[] = [];
  const params: unknown[] = [];
  setClauses.push(`updated_at = $${params.push(now)}`);

  if (updates.username !== undefined) {
    setClauses.push(`username = $${params.push(updates.username.trim().toLowerCase())}`);
  }
  if (updates.email !== undefined) {
    setClauses.push(`email = $${params.push(updates.email.trim().toLowerCase())}`);
  }
  if (updates.role !== undefined) {
    setClauses.push(`role = $${params.push(updates.role)}`);
  }
  if (updates.is_active !== undefined) {
    setClauses.push(`is_active = $${params.push(updates.is_active ? 1 : 0)}`);
  }
  if (updates.password !== undefined) {
    const hash = await hashPassword(updates.password);
    setClauses.push(`password_hash = $${params.push(hash)}`);
  }

  params.push(userId);
  const updated = (await db.get<UserRow>(
    'UPDATE users SET ' + setClauses.join(', ') + ' WHERE id = $' + params.length + ' RETURNING *',
    ...params,
  ))!;

  return updated;
}

export async function updateUser(
  db: DatabaseService,
  userId: number,
  updates: UpdateUserInput,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  const updated = await validateAndApplyUpdates(db, userId, updates);

  // Revoke all refresh tokens when password is changed by admin
  if (updates.password !== undefined) {
    const revokeNow = Math.floor(Date.now() / 1000);
    await db.run(
      'UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
      revokeNow, userId,
    );
  }

  if (updates.is_active === false) {
    await revokeAccountAccess(db, [userId], Math.floor(Date.now() / 1000));
  }

  if (audit) {
    const changedFields = Object.keys(updates).filter(k => k !== 'password');
    if (updates.password !== undefined) changedFields.push('password');
    await audit.log({
      userId: adminUserId,
      action: 'update_user',
      resourceType: 'user',
      resourceId: String(userId),
      details: JSON.stringify({ changedFields }),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User updated', { operation: 'updateUser', userId });

  invalidateUserCache(String(userId));

  return toUserResponse(updated);
}

/**
 * Soft-delete a user (set is_active to 0). Admin-only operation.
 * Prevents an admin from deleting their own account (returns 400).
 * Revokes the user's refresh tokens and disables their schedules.
 * @param db - Database service instance
 * @param userId - ID of the user to soft-delete
 * @param adminUserId - ID of the admin performing the action
 * @param audit - Optional audit service for logging the delete_user action
 * @param ctx - Optional request context (IP address, user agent) for audit records
 * @throws {UserManagerError} 400 if admin tries to delete their own account
 * @throws {UserManagerError} 404 if user not found
 */
export async function deleteUser(
  db: DatabaseService,
  userId: number,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<void> {
  if (userId === adminUserId) {
    throw new UserManagerError('Cannot delete your own account', 400);
  }

  const existing = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!existing) {
    throw new UserManagerError('User not found', 404);
  }

  const now = Math.floor(Date.now() / 1000);
  await db.run('UPDATE users SET is_active = 0, updated_at = $1 WHERE id = $2', now, userId);

  await revokeAccountAccess(db, [userId], now);

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'delete_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User soft-deleted', { operation: 'deleteUser', userId });

  invalidateUserCache(String(userId));
}

/**
 * Reactivate a soft-deleted user (set is_active to 1). Admin-only operation.
 * @param db - Database service instance
 * @param userId - ID of the user to reactivate
 * @param adminUserId - ID of the admin performing the action
 * @param audit - Optional audit service for logging the reactivate_user action
 * @param ctx - Optional request context (IP address, user agent) for audit records
 * @returns The reactivated user (without password_hash)
 * @throws {UserManagerError} 404 if user not found
 */
export async function reactivateUser(
  db: DatabaseService,
  userId: number,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  const existing = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!existing) {
    throw new UserManagerError('User not found', 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const updated = (await db.get<UserRow>(
    `UPDATE users SET is_active = 1,
       locked_until = CASE WHEN locked_until = $3 THEN NULL ELSE locked_until END,
       updated_at = $1
     WHERE id = $2 RETURNING *`,
    now, userId, MANUAL_LOCK_UNTIL,
  ))!;

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'reactivate_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User reactivated', { operation: 'reactivateUser', userId });

  invalidateUserCache(String(userId));

  return toUserResponse(updated);
}

/**
 * Lock a user account until an admin unlocks it. Admins cannot lock themselves
 * or other admin accounts.
 */
export async function lockUser(
  db: DatabaseService,
  userId: number,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  if (userId === adminUserId) {
    throw new UserManagerError('Cannot lock your own account', 400);
  }

  const existing = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!existing) {
    throw new UserManagerError('User not found', 404);
  }

  if (existing.role === 'admin') {
    throw new UserManagerError('Cannot lock admin accounts', 400);
  }

  if (existing.is_active === 0) {
    throw new UserManagerError('User is already inactive or locked', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const updated = (await db.get<UserRow>(
    'UPDATE users SET is_active = 0, locked_until = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    MANUAL_LOCK_UNTIL, now, userId,
  ))!;

  await revokeAccountAccess(db, [userId], now);

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'lock_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User locked by admin', { operation: 'lockUser', userId, adminUserId });

  invalidateUserCache(String(userId));

  return toUserResponse(updated);
}

/**
 * Lift an admin lock or a failed-sign-in throttle. A deleted account that was
 * also throttled loses the throttle but stays deleted.
 */
export async function unlockUser(
  db: DatabaseService,
  userId: number,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  const existing = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!existing) {
    throw new UserManagerError('User not found', 404);
  }

  if (existing.locked_until === null) {
    throw new UserManagerError('User is not locked', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const updated = (await db.get<UserRow>(
    `UPDATE users SET
       is_active = CASE WHEN locked_until = $3 THEN 1 ELSE is_active END,
       locked_until = NULL, failed_login_attempts = 0, updated_at = $1
     WHERE id = $2 RETURNING *`,
    now, userId, MANUAL_LOCK_UNTIL,
  ))!;

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'unlock_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('User unlocked', { operation: 'unlockUser', userId });

  invalidateUserCache(String(userId));

  return toUserResponse(updated);
}

/**
 * List users with optional filters. Admin-only operation.
 * Supports filtering by role, active status, and search (username or email substring).
 * @param db - Database service instance
 * @param filters - Optional filters: role, is_active, search term
 * @returns Array of users matching the filters (without password_hash)
 */
export async function listUsers(db: DatabaseService, filters: UserFilters = {}): Promise<UserResponse[]> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  if (filters.role !== undefined) {
    whereClauses.push(`role = $${params.push(filters.role)}`);
  }
  if (filters.is_active !== undefined) {
    whereClauses.push(`is_active = $${params.push(filters.is_active ? 1 : 0)}`);
  }
  if (filters.search) {
    const n = params.push(`%${filters.search}%`);
    whereClauses.push(`(username ILIKE $${n} OR email ILIKE $${n})`);
  }

  const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
  const rows = await db.all<UserRow>(
    `SELECT * FROM users ${whereStr} ORDER BY id ASC LIMIT $${params.push(1000)}`,
    ...params,
  );

  return rows.map(toUserResponse);
}

/**
 * Get a user by ID. Admin-only operation.
 * Logs a view_user audit event when an admin views another user's details.
 * @param db - Database service instance
 * @param userId - ID of the user to retrieve
 * @param adminUserId - ID of the requesting admin (used for audit logging)
 * @param audit - Optional audit service for logging the view_user action
 * @param ctx - Optional request context (IP address, user agent) for audit records
 * @returns The requested user (without password_hash)
 * @throws {UserManagerError} 404 if user not found
 */
export async function getUserById(
  db: DatabaseService,
  userId: number,
  adminUserId?: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<UserResponse> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!row) {
    throw new UserManagerError('User not found', 404);
  }

  if (audit && adminUserId !== undefined && adminUserId !== userId) {
    await audit.log({
      userId: adminUserId,
      action: 'view_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  return toUserResponse(row);
}

// --- User Self-Service Operations ---

/**
 * Get the authenticated user's own profile.
 * @param db - Database service instance
 * @param userId - ID of the authenticated user
 * @returns The user's profile data (without password_hash)
 * @throws {UserManagerError} 404 if user not found
 */
export async function getProfile(db: DatabaseService, userId: number): Promise<UserResponse> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!row) {
    throw new UserManagerError('User not found', 404);
  }
  return toUserResponse(row);
}

/** Fields that change outside the admin edit form. */
export interface UserFieldChanges {
  has_completed_onboarding?: 1;
  must_change_password?: 0 | 1;
  sso_issuer?: string | null;
  sso_subject?: string | null;
}

/**
 * Write account flags and make the change visible on the user's next request.
 * Rejects with the database error (e.g. 23505 when an SSO identity is already linked).
 */
export async function setUserFields(
  db: Pick<DatabaseService, 'run'>,
  userId: number,
  changes: UserFieldChanges,
): Promise<void> {
  const params: unknown[] = [];
  const sets = Object.entries(changes).map(([column, value]) => `${column} = $${params.push(value)}`);
  if (sets.length === 0) return;
  sets.push(`updated_at = $${params.push(Math.floor(Date.now() / 1000))}`);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.push(userId)}`, ...params);
  invalidateUserCache(String(userId));
}

/**
 * Change the authenticated user's password.
 * Verifies the current password matches, validates the new password,
 * hashes it, and revokes all existing refresh tokens
 * to force re-authentication on all devices.
 * @param db - Database service instance
 * @param userId - ID of the authenticated user
 * @param input - Current and new password
 * @throws {UserManagerError} 404 if user not found
 * @throws {UserManagerError} 401 if current password is incorrect
 * @throws {UserManagerError} 400 if new password fails validation (min 8 characters)
 */
export async function changePassword(
  db: DatabaseService,
  userId: number,
  input: ChangePasswordInput,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<void> {
  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!user) {
    throw new UserManagerError('User not found', 404);
  }

  // Verify current password — async to avoid blocking the event loop
  const valid = await bcrypt.compare(input.currentPassword, user.password_hash);
  if (!valid) {
    throw new UserManagerError('Current password is incorrect', 401);
  }

  // Validate new password with strong policy
  const pwResult = validatePasswordStrength(input.newPassword);
  if (!pwResult.valid) {
    throw new UserManagerError(pwResult.errors.join('; '), 400);
  }

  // Hash and update — async to avoid blocking the event loop
  const hash = await hashPassword(input.newPassword);
  const now = Math.floor(Date.now() / 1000);
  await db.run('UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = $2 WHERE id = $3', hash, now, userId);

  // Revoke all refresh tokens
  await db.run(
    'UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
    now, userId,
  );

  if (audit) {
    await audit.log({
      userId,
      action: 'change_password',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('Password changed', { operation: 'changePassword', userId });

  invalidateUserCache(String(userId));
}

// --- Bulk Operations (delegated to user-bulk-ops.ts) ---


