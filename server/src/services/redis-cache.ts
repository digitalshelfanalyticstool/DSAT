/**
 * Redis-backed caching utility for expensive queries.
 *
 * Wraps a fetcher function with Redis GET/SETEX — returns cached data
 * on hit, calls the fetcher and stores the result on miss.
 *
 * Includes cache stampede protection via a Redis SETNX lock to prevent
 * multiple concurrent requests from hitting the database simultaneously
 * when the cache expires.
 */

import { getRedisClient } from './redis-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('redis-cache');

/** How long the stampede lock is held (seconds). Should be longer than the slowest fetcher. */
const LOCK_TTL_SECS = 30;

/** How long to wait between retries when another process holds the lock (ms). */
const LOCK_RETRY_INTERVAL_MS = 100;

/** Maximum time to wait for the lock holder to populate the cache (ms). */
const LOCK_MAX_WAIT_MS = 10_000;

/** Try to read a value from Redis. Returns null on miss or error. */
async function tryReadCache(key: string): Promise<string | null> {
  try {
    return await getRedisClient().getQueueConnection().get(key);
  } catch (err) {
    logger.debug('Cache read failed', {
      operation: 'getCachedOrFetch', key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Fetch value, write to cache, and release the stampede lock. */
async function fetchAndCache<T>(
  key: string, lockKey: string, ttlSecs: number, fetcher: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fetcher();
    try {
      await getRedisClient().getQueueConnection().setex(key, ttlSecs, JSON.stringify(result));
    } catch (err) {
      logger.debug('Cache write failed', {
        operation: 'getCachedOrFetch', key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return result;
  } finally {
    try { await getRedisClient().getQueueConnection().del(lockKey); } catch { /* expires via TTL */ }
  }
}

/** Wait for another process to populate the cache, polling until deadline. */
async function waitForCache<T>(key: string): Promise<T | null> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    try {
      const cached = await getRedisClient().getQueueConnection().get(key);
      if (cached) return JSON.parse(cached) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Return cached result if available, otherwise call fetcher and cache the result.
 *
 * When multiple requests miss the cache simultaneously, only one acquires a
 * short-lived Redis lock and calls the fetcher. The others wait for the cache
 * to be populated, avoiding a database thundering herd.
 *
 * @param key     - Redis key (prefix with `cache:` by convention)
 * @param ttlSecs - Time-to-live in seconds
 * @param fetcher - Async function that produces the value on cache miss
 */
export function getCachedOrFetch<T>(
  key: string,
  ttlSecs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  // Same-process callers for the same key share one computation. The Redis
  // lock alone stops covering them once a fetcher outruns LOCK_MAX_WAIT_MS
  // or Redis is down; this map is empty whenever nothing is in flight.
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const p = readOrFetch(key, ttlSecs, fetcher).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const inFlight = new Map<string, Promise<unknown>>();

async function readOrFetch<T>(
  key: string,
  ttlSecs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = await tryReadCache(key);
  if (cached) return JSON.parse(cached) as T;

  // Attempt to acquire a stampede lock
  const lockKey = `${key}:lock`;
  let lockAcquired = false;
  try {
    const acquired = await getRedisClient().getQueueConnection().set(lockKey, '1', 'EX', LOCK_TTL_SECS, 'NX');
    lockAcquired = acquired === 'OK';
  } catch {
    lockAcquired = true; // Degrade to no stampede protection
  }

  if (lockAcquired) {
    return fetchAndCache(key, lockKey, ttlSecs, fetcher);
  }

  // Another process holds the lock — wait for cache or fall back to direct fetch
  const waited = await waitForCache<T>(key);
  if (waited !== null) return waited;

  logger.debug('Lock wait timed out, fetching directly', { operation: 'getCachedOrFetch', key });
  return fetcher();
}

/**
 * Invalidate the cached /jobs/stats responses tied to a user.
 *
 * Busts both the user's own cache entry and every admin's entry, since
 * admins see all users' jobs in their stats response. Intended to be
 * called from BullMQ worker event hooks when a job changes state.
 */
export async function invalidateJobStatsCache(userId: string): Promise<void> {
  const client = getRedisClient().getQueueConnection();
  const keysToDelete: string[] = [`cache:job-stats:user:${userId}`];

  let cursor = '0';
  try {
    do {
      const [next, found] = await client.scan(
        cursor, 'MATCH', 'cache:job-stats:admin:*', 'COUNT', 100,
      );
      cursor = next;
      keysToDelete.push(...found);
    } while (cursor !== '0');

    if (keysToDelete.length > 0) {
      await client.del(...keysToDelete);
    }
  } catch (err) {
    logger.debug('Cache invalidation failed', {
      operation: 'invalidateJobStatsCache', userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
