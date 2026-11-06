/**
 * Access-token denylist.
 *
 * Access tokens are short-lived (15 min) HS256 JWTs. On logout we revoke the
 * refresh token, but the access token would otherwise stay valid until it
 * expires. This module lets a `jti` be placed on a Redis denylist for the
 * token's *remaining* lifetime, so the next request carrying that token is
 * rejected by `authMiddleware`.
 *
 * Failure model: **fail open.** The denylist is a belt-and-suspenders narrowing
 * of an already-short window, not the primary control (the refresh token is
 * already revoked on logout). If Redis is unavailable, logout still succeeds
 * (the denylist write is dropped) and `authMiddleware` does not reject tokens
 * it can't check — auth must not hard-fail because a cache layer blipped. Every
 * such case is logged.
 */

import { getRedisClient } from './redis-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('access-token-denylist');

const KEY_PREFIX = 'denylist:jti:';

/** Guard against an ioredis command hanging when the connection drops mid-flight. */
const REDIS_OP_TIMEOUT_MS = 250;

/** Minimal shape of the verified JWT claims this module needs. */
interface AccessTokenClaims {
  /** JWT ID — present on tokens issued since the denylist shipped; absent on older ones. */
  jti?: string;
  /** Expiry, seconds since epoch (standard `exp` claim). */
  exp: number;
}

function denylistKey(jti: string): string {
  return `${KEY_PREFIX}${jti}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis op timed out')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Add a token's `jti` to the denylist for its remaining lifetime. No-op if the
 * token has no `jti` (an older token) or is already expired. Never throws —
 * a Redis failure is logged and swallowed so logout still completes.
 */
export async function denylistAccessToken(claims: AccessTokenClaims): Promise<void> {
  if (!claims.jti) {
    logger.debug('Access token has no jti — nothing to denylist', { operation: 'denylistAccessToken' });
    return;
  }
  const ttlSeconds = claims.exp - Math.floor(Date.now() / 1000);
  if (ttlSeconds <= 0) {
    return; // already expired — the token is useless regardless
  }

  try {
    const redis = getRedisClient().getPublisherConnection();
    if (redis.status !== 'ready') {
      logger.warn('Redis not ready — access token not added to denylist (logout still completes)', {
        operation: 'denylistAccessToken',
        redisStatus: redis.status,
      });
      return;
    }
    await withTimeout(redis.set(denylistKey(claims.jti), '1', 'EX', ttlSeconds), REDIS_OP_TIMEOUT_MS);
    logger.info('Access token denylisted', { operation: 'denylistAccessToken', ttlSeconds });
  } catch (err) {
    logger.warn('Failed to denylist access token (logout still completes)', {
      operation: 'denylistAccessToken',
      error: (err as Error).message,
    });
  }
}

/**
 * True iff `jti` is on the denylist. Returns `false` when `jti` is undefined,
 * when Redis is unavailable, or on any error (fail open).
 */
export async function isAccessTokenDenylisted(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;

  try {
    const redis = getRedisClient().getPublisherConnection();
    if (redis.status !== 'ready') {
      logger.debug('Redis not ready — skipping denylist check (fail open)', {
        operation: 'isAccessTokenDenylisted',
        redisStatus: redis.status,
      });
      return false;
    }
    const value = await withTimeout(redis.get(denylistKey(jti)), REDIS_OP_TIMEOUT_MS);
    return value !== null;
  } catch (err) {
    logger.warn('Denylist check failed — allowing request (fail open)', {
      operation: 'isAccessTokenDenylisted',
      error: (err as Error).message,
    });
    return false;
  }
}
