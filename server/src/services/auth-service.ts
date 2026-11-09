/**
 * Auth Service — authentication, token management, rate limiting, and account lockout.
 *
 * Implements:
 *   - JWT access tokens (15-minute expiration)
 *   - Refresh tokens (7-day expiration, stored as bcrypt hashes in DB)
 *   - Login throttling: 5 attempts per account per client IP per 15 minutes,
 *     and a 15-minute account lock after 20 failed attempts from any source
 *   - Token cleanup for expired refresh tokens
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import { config } from '../config';
export type { UserRow, UserResponse } from '../types/auth';
import type { UserRow, UserResponse } from '../types/auth';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './session-lifetimes';
import { toUserResponse } from './user-records';

const logger = createLogger('auth-service');

// --- Constants ---

/**
 * Cost factor for hashes this process WRITES. Configurable per environment
 * (see config.auth.bcryptCost) because cost 12 dominates the test suite's
 * runtime; production keeps 12, which is the default.
 *
 * Read lazily, NOT captured in a module-level const. Seven test files
 * `vi.mock('../config')` with partial factories, and a module-load-time
 * `config.auth.bcryptCost` throws "Cannot read properties of undefined" on
 * import for every one of them — the failure is an unmockable import error,
 * not a test assertion, so it takes the whole file down. Reading at call time
 * also means an env change inside a test is actually honoured.
 */
function saltRounds(): number {
  return config.auth.bcryptCost;
}

/**
 * The cost floor below which a STORED hash is treated as legacy and gets
 * opportunistically rehashed.
 *
 * Deliberately a separate literal rather than saltRounds(). The two were the
 * same constant until the write cost became configurable, and collapsing them
 * again would mean that lowering BCRYPT_COST in an environment silently
 * narrows what counts as a weak stored hash — a security control quietly
 * following a performance knob. 12 has been this app's cost for its lifetime,
 * so it is the correct historical floor regardless of what we write today.
 */
const LEGACY_BCRYPT_COST_BELOW = 12;

/**
 * Detect bcrypt hashes that use a cost factor lower
 * than LEGACY_BCRYPT_COST_BELOW. Format reference: `$2b$10$<22-char-salt><31-char-hash>`.
 * Cost 12 has been the default for the lifetime of this app, but a
 * hash imported from an older system could still be on cost 10 (older bcrypt
 * default) — materially weaker against modern GPU brute-forcing. The fix is
 * a silent, opportunistic rehash on the next successful authentication.
 */
function isLegacyBcryptHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  const parts = hash.split('$');
  // ['', '2b', '10', '<salt+hash>'] for a valid bcrypt string.
  if (parts.length < 4) return false;
  if (!/^2[abxy]$/.test(parts[1])) return false;
  const cost = Number.parseInt(parts[2], 10);
  return Number.isFinite(cost) && cost < LEGACY_BCRYPT_COST_BELOW;
}
/**
 * Dummy comparison target for invalid users — not a real credential.
 *
 * Pre-computed bcrypt hash for timing-attack mitigation. Memoised on first use
 * rather than computed at module load, for the same reason saltRounds() is a
 * function: the cost now comes from config, and touching config at import time
 * breaks every test that mocks it. The memo keeps the original property that
 * the hash is computed once per process, not once per failed login.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash('timing-attack-mitigation-dummy', saltRounds());
  return dummyHashPromise;
}
/** Password evaluations per (account, client IP) per window. */
const LOGIN_ATTEMPTS_PER_SOURCE = 5;
/** Password evaluations per account, across all sources, before it locks. */
const ACCOUNT_LOCKOUT_ATTEMPTS = 20;
// Window for the per-source count and length of an account lock.
const ACCOUNT_LOCKOUT_DURATION_S = 15 * 60; // 15 minutes in seconds

// --- Configuration ---

function getJwtSecret(): string {
  return config.auth.jwtSecret;
}

// --- Types ---

export interface TokenPayload {
  user_id: number;
  username: string;
  role: 'admin' | 'user';
  /**
   * JWT ID — a per-token random UUID, used by the access-token denylist
   * to revoke a single token on logout. Optional because tokens
   * issued before the denylist shipped have no `jti`; the denylist check treats a
   * missing `jti` as "not revoked".
   */
  jti?: string;
  iat: number;
  exp: number;
}

export interface AuthResult {
  user: UserResponse;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface LoginInput {
  username: string;
  password: string;
  ipAddress: string;
  userAgent: string;
}

// --- Helpers ---


// --- Legacy Bcrypt Cost-Factor Scan ---

/**
 * Scan users.password_hash and refresh_tokens.token_hash
 * for hashes using a cost factor lower than LEGACY_BCRYPT_COST_BELOW, and emit a single
 * warning at startup.
 *
 * This is a non-blocking observability pass — it does NOT rehash. Rehashing
 * happens on the next successful login (password) or refresh-token validation.
 * The startup count answers "how many users do I still need to rotate
 * through this app before they all get a strong hash?".
 *
 * The function is intentionally tolerant of missing tables / SQL errors:
 * we log and return a zero count rather than blocking process startup.
 */
export async function checkLegacyBcryptHashes(db: DatabaseService): Promise<{
  legacyPasswordCount: number;
  legacyRefreshTokenCount: number;
}> {
  let legacyPasswordCount = 0;
  let legacyRefreshTokenCount = 0;

  try {
    // Use Postgres regex (~) to match any '$2[abxy]$0?[0-9]$' prefix.
    // The cost-factor portion is `[0-9]` (single digit) or `0[0-9]` (leading
    // zero) — both indicate <10 cost, which is below our 12 baseline.
    // We additionally match cost 10 and 11 explicitly. The 10|11 alternation
    // encodes LEGACY_BCRYPT_COST_BELOW=12 in SQL; if that constant ever moves,
    // this pattern must move with it.
    const userRow = await db.get<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users
       WHERE password_hash ~ '^\\$2[abxy]\\$(0[0-9]|10|11)\\$'`,
    );
    legacyPasswordCount = Number.parseInt(userRow?.count ?? '0', 10) || 0;
  } catch (err) {
    logger.warn('checkLegacyBcryptHashes: users scan failed (non-fatal)', {
      operation: 'checkLegacyBcryptHashes',
      error: (err as Error).message,
    });
  }

  try {
    const tokenRow = await db.get<{ count: string }>(
      `SELECT COUNT(*) AS count FROM refresh_tokens
       WHERE token_hash ~ '^\\$2[abxy]\\$(0[0-9]|10|11)\\$'
         AND revoked_at IS NULL`,
    );
    legacyRefreshTokenCount = Number.parseInt(tokenRow?.count ?? '0', 10) || 0;
  } catch (err) {
    logger.warn('checkLegacyBcryptHashes: refresh_tokens scan failed (non-fatal)', {
      operation: 'checkLegacyBcryptHashes',
      error: (err as Error).message,
    });
  }

  if (legacyPasswordCount > 0 || legacyRefreshTokenCount > 0) {
    logger.warn('Legacy bcrypt cost factors detected — will be re-hashed on next use', {
      operation: 'checkLegacyBcryptHashes',
      legacyPasswordCount,
      legacyRefreshTokenCount,
      currentCost: saltRounds(),
    });
  } else {
    logger.info('No legacy bcrypt hashes detected', {
      operation: 'checkLegacyBcryptHashes',
      currentCost: saltRounds(),
    });
  }

  return { legacyPasswordCount, legacyRefreshTokenCount };
}

// --- Token Generation & Validation ---

type AccessTokenSubject = Pick<UserRow, 'id' | 'username' | 'role'>;

/**
 * Generate a short-lived JWT access token (15 minutes).
 */
export function generateAccessToken(user: AccessTokenSubject): string {
  return jwt.sign(
    { user_id: user.id, username: user.username, role: user.role, jti: crypto.randomUUID() },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
}

/**
 * Generate a cryptographically secure random refresh token (base64url, 48 bytes).
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Validate and decode a JWT access token.
 * Throws on invalid signature or expiration.
 *
 * `algorithms: ['HS256']` is an explicit allow-list. jsonwebtoken@9 already rejects `alg=none` and HS/RS confusion
 * when the secret is a string, so this is defense in depth — guarding against
 * a future RS256 migration, library downgrade, or accidental broadening.
 */
export function validateAccessToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as TokenPayload;
  } catch (err) {
    const error = err as Error;
    if (error.name === 'TokenExpiredError') {
      throw new AuthError('Token expired', 401);
    }
    throw new AuthError('Invalid token', 401);
  }
}

/**
 * Validate a refresh token against the database.
 * Uses O(1) indexed lookup by token_prefix, then a single bcrypt compare.
 * Falls back to legacy O(n) scan for pre-migration tokens with NULL token_prefix.
 * Returns the associated user row.
 */
interface RefreshTokenResult {
  user: UserRow;
  /**
   * Database id of the matched `refresh_tokens` row. Returned so callers
   * (refreshAccessToken) can revoke the old token via primary-key UPDATE
   * instead of re-running the prefix lookup + bcrypt.compare a second time.
   */
  tokenId: number;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- security-sensitive auth: refresh-token validation with prefix lookup and bcrypt compare. Hard-excluded in CLAUDE.md (no AI refactors on auth). NOSONAR(typescript:S3776).
export async function validateRefreshToken(db: DatabaseService, token: string): Promise<RefreshTokenResult> {
  const now = Math.floor(Date.now() / 1000);
  const prefix = token.slice(0, 8);

  // O(1) indexed lookup by prefix
  const row = await db.get<{ id: number; token_hash: string; user_id: number }>(
    `SELECT id, token_hash, user_id FROM refresh_tokens
     WHERE token_prefix = $1 AND revoked_at IS NULL AND expires_at > $2`,
    prefix, now,
  );

  if (row) {
    // Async bcrypt compare — does not block the event loop
    const match = await bcrypt.compare(token, row.token_hash);
    if (!match) {
      throw new AuthError('Invalid or expired refresh token', 401);
    }

    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', row.user_id);
    if (!user) {
      throw new AuthError('User not found', 401);
    }
    if (user.is_active !== 1) {
      throw new AuthError('Account is disabled', 401);
    }

    // Opportunistically re-hash legacy refresh-token hashes to
    // the current cost. Same model as the login-time rehash for password
    // hashes — only after we've validated the token is real.
    if (isLegacyBcryptHash(row.token_hash)) {
      try {
        const newTokenHash = await bcrypt.hash(token, saltRounds());
        await db.run(
          'UPDATE refresh_tokens SET token_hash = $1 WHERE id = $2',
          newTokenHash, row.id,
        );
        logger.info('Re-hashed legacy refresh token to current cost', {
          operation: 'validateRefreshToken.rehashLegacy',
          tokenId: row.id,
          userId: user.id,
          newCost: saltRounds(),
        });
      } catch (err) {
        logger.warn('Legacy refresh token rehash failed; keeping existing hash', {
          operation: 'validateRefreshToken.rehashLegacy',
          tokenId: row.id,
          error: (err as Error).message,
        });
      }
    }

    return {
      user,
      tokenId: row.id,
    };
  }

  // Fallback: legacy O(n) scan for pre-migration tokens with NULL token_prefix
  const legacyRows = await db.all<{ id: number; token_hash: string; user_id: number }>(
    `SELECT id, token_hash, user_id FROM refresh_tokens
     WHERE token_prefix IS NULL AND revoked_at IS NULL AND expires_at > $1`,
    now,
  );

  let matchedTokenId: number | null = null;
  let matchedUserId: number | null = null;
  for (const legacyRow of legacyRows) {
    const legacyMatch = await bcrypt.compare(token, legacyRow.token_hash);
    if (legacyMatch) {
      matchedTokenId = legacyRow.id;
      matchedUserId = legacyRow.user_id;
      break;
    }
  }

  if (matchedUserId === null || matchedTokenId === null) {
    throw new AuthError('Invalid or expired refresh token', 401);
  }

  const user = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', matchedUserId);
  if (!user) {
    throw new AuthError('User not found', 401);
  }
  if (user.is_active !== 1) {
    throw new AuthError('Account is disabled', 401);
  }

  return { user, tokenId: matchedTokenId };
}

// --- Account Lockout ---

/**
 * Reserve one password evaluation for `username` from `ipAddress`, BEFORE the
 * password is compared. Returns the user row when the caller may compare, or a
 * Retry-After (seconds) when it must answer 423 without comparing.
 *
 * Two limits, both counted in the same transaction under a row lock on the
 * user (SELECT ... FOR UPDATE), so concurrent requests cannot all pass a stale
 * check and each get a compare:
 *   - per source: LOGIN_ATTEMPTS_PER_SOURCE per (username, client IP) per
 *     window, kept in rate_limit_attempts. A client spamming wrong passwords
 *     locks only itself out, not the owner signing in from elsewhere.
 *   - per account: ACCOUNT_LOCKOUT_ATTEMPTS on users.failed_login_attempts,
 *     which sets locked_until and blocks every source. This caps guessing
 *     spread across many IPs; locking an account this way takes several IPs.
 *
 * The attempt is counted whether or not the password turns out to be right;
 * a successful login clears both counters (resetFailedLogins). Unknown and
 * disabled usernames are not counted: there is nothing to protect.
 */
async function reserveLoginAttempt(
  db: DatabaseService,
  username: string,
  ipAddress: string,
): Promise<{ user?: UserRow; retryAfter?: number }> {
  return db.transaction(async (tx) => {
    const now = Math.floor(Date.now() / 1000);
    const user = await tx.get<UserRow & { failed_login_attempts: number }>(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE', username,
    );
    if (!user || user.is_active !== 1) return { user };

    // Account-wide lock: failed-login threshold or an admin lock.
    if (user.locked_until !== null && user.locked_until > now) {
      return { retryAfter: user.locked_until - now };
    }

    const sourceKey = loginSourceKey(user.id, ipAddress);
    const recent = await tx.get<{ count: number; oldest: number | null }>(
      `SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest FROM rate_limit_attempts
        WHERE key = $1 AND type = 'username' AND attempted_at > $2`,
      sourceKey, now - ACCOUNT_LOCKOUT_DURATION_S,
    );
    if (recent && Number(recent.count) >= LOGIN_ATTEMPTS_PER_SOURCE) {
      return { retryAfter: Math.max(1, Number(recent.oldest) + ACCOUNT_LOCKOUT_DURATION_S - now) };
    }
    await tx.run(
      'INSERT INTO rate_limit_attempts (key, type, attempted_at) VALUES ($1, $2, $3)',
      sourceKey, 'username', now,
    );

    // An expired lock starts a fresh count.
    const attempts = (user.locked_until === null ? user.failed_login_attempts : 0) + 1;
    const lockedUntil = attempts >= ACCOUNT_LOCKOUT_ATTEMPTS ? now + ACCOUNT_LOCKOUT_DURATION_S : null;
    await tx.run(
      'UPDATE users SET failed_login_attempts = $1, locked_until = $2, updated_at = $3 WHERE id = $4',
      attempts, lockedUntil, now, user.id,
    );
    if (lockedUntil !== null) {
      logger.warn('Account locked due to repeated failed login attempts', {
        operation: 'reserveLoginAttempt',
        username,
        ipAddress,
        attempts,
        lockedUntil: new Date(lockedUntil * 1000).toISOString(),
      });
    }
    return { user };
  });
}

function loginSourceKey(userId: number, ipAddress: string): string {
  return `login:${userId}:${ipAddress}`;
}

/**
 * Clear failed-login state after a successful authentication: the account
 * counter, any expired lock, and this source's attempts.
 */
async function resetFailedLogins(db: DatabaseService, userId: number, ipAddress: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `UPDATE users
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = $1
     WHERE id = $2`,
    now, userId,
  );
  await db.run(
    "DELETE FROM rate_limit_attempts WHERE key = $1 AND type = 'username'",
    loginSourceKey(userId, ipAddress),
  );
}

/**
 * Clear expired lockouts on server startup. Only resets
 * `locked_until` (and `failed_login_attempts`); does NOT toggle `is_active`,
 * which is reserved for admin-deactivated accounts. A user that was
 * locked-out at the moment of restart will be unlocked at the next login
 * attempt regardless, but pre-clearing here keeps the table tidy.
 */
export async function reactivateExpiredLockouts(db: DatabaseService): Promise<number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await db.run(
    `UPDATE users
       SET locked_until = NULL, failed_login_attempts = 0, updated_at = $1
     WHERE locked_until IS NOT NULL
       AND locked_until <= $2`,
    nowSeconds, nowSeconds,
  );

  const count = result.changes;
  if (count > 0) {
    logger.info('Cleared expired lockouts on startup', {
      operation: 'reactivateExpiredLockouts',
      count,
    });
  }

  return count;
}

// --- Login Flow ---

/**
 * Authenticate a user with username and password.
 * Enforces rate limiting and account lockout.
 * On success: generates access token + refresh token, stores refresh token hash in DB.
 *
 * A locked account returns 423 Locked with a
 * `retryAfter` value (seconds until the lockout expires). This is a
 * deliberate trade-off — it makes lockout state observable to an attacker
 * (mild username enumeration) in exchange for honest signaling to a
 * legitimate user. See reserveLoginAttempt for the per-source and
 * per-account limits.
 */
export async function login(db: DatabaseService, input: LoginInput): Promise<AuthResult> {
  const { password, ipAddress } = input;
  const username = input.username.trim();

  // Generic error for ALL auth failures EXCEPT lockout — prevents user enumeration
  const GENERIC_AUTH_ERROR = 'Invalid username or password';

  const dummyHash = await getDummyHash();

  // Reserve the attempt before comparing, so the lockout holds under concurrency.
  const { user, retryAfter } = await reserveLoginAttempt(db, username, ipAddress);
  if (retryAfter !== undefined) {
    // Equalize timing with the bcrypt-compare path so the lockout response
    // doesn't reveal "this username exists AND was recently brute-forced"
    // measurably faster than other paths.
    await bcrypt.compare(password, dummyHash);
    const err = new AuthError('Account is temporarily locked. Try again later.', 423);
    err.retryAfter = retryAfter;
    throw err;
  }

  // The lookup in reserveLoginAttempt is case-insensitive on BOTH sides. Write
  // paths normalize to lowercase today, but rows predating that normalization
  // are still stored mixed-case. Migration 50 backs the LOWER(username)
  // predicate with idx_users_username_lower, a unique functional index, so it
  // stays SARGable and case-insensitive uniqueness is enforced by the database.
  if (!user) {
    // Async dummy bcrypt compare to prevent timing attacks (equalizes response time)
    await bcrypt.compare(password, dummyHash);
    throw new AuthError(GENERIC_AUTH_ERROR, 401);
  }

  if (user.is_active !== 1) {
    // Admin-disabled accounts share the generic 401 (no enumeration leak).
    // Disabled is distinct from locked — no Retry-After here.
    throw new AuthError(GENERIC_AUTH_ERROR, 401);
  }

  // Verify password — async to avoid blocking the event loop (~250ms per call).
  // The attempt is already counted; a failure needs no further write.
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logger.warn('Failed login attempt', { operation: 'login', username, ipAddress });
    throw new AuthError(GENERIC_AUTH_ERROR, 401);
  }

  await resetFailedLogins(db, user.id, ipAddress);

  // Opportunistic re-hash to current cost factor when the stored
  // hash uses an older cost. We do this AFTER verifying the password (so we
  // know it's correct) and AFTER setting valid=true (so a re-hash failure
  // doesn't block the user from logging in — we just leave the legacy hash
  // in place and try again next time).
  if (isLegacyBcryptHash(user.password_hash)) {
    try {
      const newHash = await bcrypt.hash(password, saltRounds());
      const updateNow = Math.floor(Date.now() / 1000);
      await db.run(
        'UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3',
        newHash, updateNow, user.id,
      );
      logger.info('Re-hashed legacy bcrypt password to current cost', {
        operation: 'login.rehashLegacy',
        userId: user.id,
        username: user.username,
        newCost: saltRounds(),
      });
      // Update in-memory user.password_hash so any subsequent lookup
      // in this request uses the fresh value.
      user.password_hash = newHash;
    } catch (err) {
      logger.warn('Legacy bcrypt rehash failed; keeping existing hash', {
        operation: 'login.rehashLegacy',
        userId: user.id,
        error: (err as Error).message,
      });
    }
  }

  return issueSession(db, user);
}

/**
 * Mint an access token and a stored refresh token for a user who has already
 * proved who they are (password login, first-run setup, SSO callback).
 */
export async function issueSession(db: DatabaseService, user: UserRow): Promise<AuthResult> {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();

  const tokenHash = await bcrypt.hash(refreshToken, saltRounds());
  const tokenPrefix = refreshToken.slice(0, 8);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TOKEN_TTL_SECONDS;

  await db.run(
    `INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    user.id, tokenHash, tokenPrefix, expiresAt, now,
  );

  await db.run('UPDATE users SET last_login = $1, updated_at = $2 WHERE id = $3', now, now, user.id);

  logger.info('Session issued', {
    operation: 'issueSession',
    username: user.username,
    userId: user.id,
  });

  const accessTokenExpiresAt = new Date((now + ACCESS_TOKEN_TTL_SECONDS) * 1000).toISOString();

  return {
    user: toUserResponse(user),
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiresAt,
  };
}

// --- Logout & Token Refresh ---

/**
 * Revoke a single refresh token by marking it as revoked in the database.
 * Uses O(1) prefix-based lookup, with fallback for pre-migration tokens.
 */
export async function logout(db: DatabaseService, refreshToken: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const prefix = refreshToken.slice(0, 8);

  const row = await db.get<{ id: number; token_hash: string }>(
    'SELECT id, token_hash FROM refresh_tokens WHERE token_prefix = $1 AND revoked_at IS NULL',
    prefix,
  );

  if (row) {
    const match = await bcrypt.compare(refreshToken, row.token_hash);
    if (match) {
      await db.run('UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2', now, row.id);
      logger.info('Refresh token revoked', { operation: 'logout', tokenId: row.id });
      return;
    }
  }

  // Fallback: legacy O(n) scan for pre-migration tokens with NULL token_prefix
  const legacyRows = await db.all<{ id: number; token_hash: string }>(
    'SELECT id, token_hash FROM refresh_tokens WHERE token_prefix IS NULL AND revoked_at IS NULL',
  );

  for (const legacyRow of legacyRows) {
    const legacyMatch = await bcrypt.compare(refreshToken, legacyRow.token_hash);
    if (legacyMatch) {
      await db.run('UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2', now, legacyRow.id);
      logger.info('Refresh token revoked (legacy)', { operation: 'logout', tokenId: legacyRow.id });
      return;
    }
  }

  logger.warn('Logout called with unknown refresh token', { operation: 'logout' });
}

/**
 * Revoke all refresh tokens for a given user.
 */
export async function logoutAll(db: DatabaseService, userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.run(
    'UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
    now, userId,
  );

  logger.info('All refresh tokens revoked for user', {
    operation: 'logoutAll',
    userId,
    revokedCount: result.changes,
  });
}

/**
 * Refresh an access token using a valid refresh token.
 * Implements token rotation: revokes the old refresh token and issues a new one.
 * This prevents the session from silently extending forever.
 */
export async function refreshAccessToken(
  db: DatabaseService,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const { user, tokenId } = await validateRefreshToken(db, refreshToken);

  // Issue a new refresh token (rotation). Bcrypt-hashing the new token and
  // revoking the old one (by the id validateRefreshToken already found, so no
  // second prefix lookup + bcrypt.compare) are independent, so run them in
  // parallel; at cost 12 that keeps /api/auth/refresh around 300ms.
  const newRefreshToken = generateRefreshToken();
  const tokenPrefix = newRefreshToken.slice(0, 8);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + REFRESH_TOKEN_TTL_SECONDS;

  const [tokenHash] = await Promise.all([
    bcrypt.hash(newRefreshToken, saltRounds()),
    db.run('UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2', now, tokenId),
  ]);

  await db.run(
    `INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    user.id, tokenHash, tokenPrefix, expiresAt, now,
  );

  const accessToken = generateAccessToken(user);

  const accessTokenExpiresAt = new Date((now + ACCESS_TOKEN_TTL_SECONDS) * 1000).toISOString();

  logger.info('Access token refreshed with token rotation', {
    operation: 'refreshAccessToken',
    userId: user.id,
    username: user.username,
  });

  return { accessToken, refreshToken: newRefreshToken, expiresAt: accessTokenExpiresAt };
}

// --- Custom Error Class ---

export class AuthError extends Error {
  public statusCode: number;
  public retryAfter?: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}
