/**
 * In-memory user cache for the auth middleware — leaf module.
 *
 * Owns the single per-process Map that `authMiddleware` reads on every
 * authenticated request and that user-mutation code paths invalidate.
 * Extracted from `middleware/auth.ts` so services (e.g. `user-manager.ts`)
 * can invalidate without importing middleware — keeping middleware a true
 * leaf layer with no service→middleware back-edge.
 *
 * This module has ZERO runtime project imports (type-only imports are
 * erased at compile time), so it can never participate in an import cycle.
 */

import type { DatabaseService } from './database';
import type { UserRow } from '../types/auth';

/**
 * Column allow-list for the per-request user lookup. `SELECT *` would fetch
 * `password_hash` (60-byte bcrypt) on every authenticated request, even though
 * the middleware only needs the columns required by `is_active` checks and
 * `toUserResponse()`. Excluded:
 *   - password_hash      — never read by the middleware; OWASP A02 minimization
 *   - refresh_token      — same as above
 * Type narrows to `Omit<UserRow, 'password_hash'>` so accidental access to
 * `user.password_hash` is a compile error, not silent `undefined` at runtime.
 */
const MIDDLEWARE_USER_COLUMNS =
  'id, username, email, role, created_at, updated_at, is_active, last_login, must_change_password, locked_until, has_completed_onboarding, sso_issuer, sso_subject';

export type MiddlewareUserRow = Omit<UserRow, 'password_hash'>;

/**
 * 30 second TTL for cached user rows. Trades staleness for per-request DB round-trip elimination.
 * Security/ops note: safe with current single-instance deployment; in multi-instance deployments,
 * user status changes (for example disable/delete) may take up to USER_CACHE_TTL_MS to propagate
 * unless cache invalidation is distributed (for example Redis or pub/sub).
 */
const USER_CACHE_TTL_MS = 30_000;

/** Cache entry structure with expiration timestamp. */
interface CacheEntry {
  user: MiddlewareUserRow;
  expiresAt: number;
}

/**
 * In-memory user cache keyed by user_id.
 *
 * TODO(scale): this cache is per-process. The deployment runs a single API
 * instance (server/ecosystem.config.js), so invalidateUserCache() reaches the
 * only process that authenticates requests. If the API tier is ever scaled
 * horizontally, a disabled/deleted user could keep authenticating for up to
 * USER_CACHE_TTL_MS on instances whose cache wasn't invalidated — move to a
 * Redis-backed cache or pub/sub invalidation at that point.
 */
const userCache = new Map<string, CacheEntry>();

/**
 * Fetch a user with in-process caching. Hits the cache if within TTL, otherwise
 * queries the database and caches the result for 30 seconds.
 * @param db - DatabaseService instance
 * @param userId - User ID (string because it comes from JWT payload)
 * @returns The user row, or undefined if not found
 */
export async function getCachedUser(
  db: DatabaseService,
  userId: string,
): Promise<MiddlewareUserRow | undefined> {
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const user = await db.get<MiddlewareUserRow>(
    `SELECT ${MIDDLEWARE_USER_COLUMNS} FROM users WHERE id = $1`,
    userId,
  );

  if (user) {
    userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  }

  return user;
}

/**
 * Invalidate cache entries by user ID, or clear the entire cache if no ID provided.
 * Called after user mutations (admin updates, password changes, locks, etc.) to ensure
 * subsequent requests see fresh data immediately.
 * @param userId - Optional user ID to invalidate. If omitted, clears the entire cache.
 */
export function invalidateUserCache(userId?: string): void {
  if (userId) {
    userCache.delete(userId);
  } else {
    userCache.clear();
  }
}
