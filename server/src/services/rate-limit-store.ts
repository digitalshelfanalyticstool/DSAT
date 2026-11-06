/**
 * PostgreSQL-Backed Rate Limit Store
 *
 * Persists rate limit attempts in the `rate_limit_attempts` table so that
 * rate-limit state survives server restarts. Supports both IP-based and
 * username-based tracking.
 *
 * Fails open: if a DB write fails, the request is allowed through and the
 * error is logged.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';

const logger = createLogger('rate-limit-store');

export class RateLimitStoreError extends Error {
  public statusCode: number;
  public retryAfter?: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'RateLimitStoreError';
    this.statusCode = statusCode;
  }
}

type AttemptType = 'ip' | 'username';

export async function recordAttempt(db: DatabaseService, key: string, type: AttemptType): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      'INSERT INTO rate_limit_attempts (key, type, attempted_at) VALUES ($1, $2, $3)',
      key, type, now,
    );
  } catch (err) {
    // Fail open — allow the request through
    logger.error('Failed to record rate limit attempt', {
      operation: 'recordAttempt',
      key,
      type,
      error: (err as Error).message,
    });
  }
}
export async function checkRateLimit(
  db: DatabaseService,
  key: string,
  type: AttemptType,
  maxAttempts: number,
  windowMs: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - Math.floor(windowMs / 1000);

  const result = await db.get<{ count: number | string }>(
    `SELECT COUNT(*) as count FROM rate_limit_attempts
     WHERE key = $1 AND type = $2 AND attempted_at > $3`,
    key, type, windowStart,
  );

  const count = Number(result?.count ?? 0);

  if (count >= maxAttempts) {
    throw new RateLimitStoreError('Too many attempts. Please try again later.', 429);
  }

  // Record this attempt — fail open if INSERT fails
  try {
    await db.run(
      'INSERT INTO rate_limit_attempts (key, type, attempted_at) VALUES ($1, $2, $3)',
      key, type, now,
    );
  } catch (insertErr) {
    logger.error('Failed to record rate limit attempt during check', {
      operation: 'checkRateLimit',
      key,
      type,
      error: (insertErr as Error).message,
    });
  }
}

export async function cleanupAttempts(db: DatabaseService, olderThanMs: number): Promise<number> {
  const cutoff = Math.floor((Date.now() - olderThanMs) / 1000);
  const result = await db.run(
    'DELETE FROM rate_limit_attempts WHERE attempted_at < $1',
    cutoff,
  );
  return result.changes;
}
