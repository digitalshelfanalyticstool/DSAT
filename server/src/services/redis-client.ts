/**
 * Redis Connection Manager — singleton ioredis connection factory.
 *
 * Provides separate connections for BullMQ queue operations, Pub/Sub publishing,
 * and Pub/Sub subscribing. Connections are lazy-initialized from the REDIS_URL
 * environment variable (default: redis://localhost:6379).
 *
 * Reconnection uses exponential backoff. All lifecycle events are logged via Winston.
 */

import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { WORKER_HEARTBEAT_PATTERN, parseWorkerHeartbeat, type WorkerHeartbeat } from './worker-heartbeat';

const logger = createLogger('redis-client');

/** Base reconnection config for exponential backoff */
const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Build ioredis options with exponential backoff reconnection strategy.
 *
 * @param label - Connection label for logging
 * @param lazyConnect - Whether to defer connection until `.connect()` is called.
 *   Defaults to `true` for RedisClientManager (which calls `.connect()` explicitly).
 *   Pass `false` when handing options to BullMQ, which creates its own internal
 *   ioredis instance and expects it to auto-connect.
 */
function buildRedisOptions(label: string, lazyConnect = true): RedisOptions {
  const redisUrl = config.redis.url;

  // Parse the URL to extract components — ioredis accepts these directly
  const parsed = new URL(redisUrl);

  const options: RedisOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: true,
    lazyConnect,
    connectionName: `scraper-${label}`,
    retryStrategy(times: number): number | null {
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (times - 1), RECONNECT_MAX_DELAY_MS);
      logger.warn('Redis reconnecting', {
        operation: 'retryStrategy',
        label,
        attempt: times,
        delayMs: delay,
      });
      return delay;
    },
  };

  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username && parsed.username !== 'default') {
    options.username = decodeURIComponent(parsed.username);
  }
  // Select DB from path (e.g. redis://localhost:6379/2)
  const dbIndex = parsed.pathname?.replace('/', '');
  if (dbIndex?.length) {
    options.db = Number.parseInt(dbIndex, 10);
  }

  if (parsed.protocol === 'rediss:') {
    options.tls = { rejectUnauthorized: true };
  } else if (config.isProduction) {
    logger.warn('Redis connection without TLS in production — use rediss:// protocol', {
      operation: 'buildRedisOptions',
      label,
    });
  }

  return options;
}

/**
 * Attach Winston lifecycle event handlers to a Redis connection.
 */
function attachLifecycleLogging(connection: Redis, label: string): void {
  connection.on('connect', () => {
    logger.info('Redis connection established', {
      operation: 'connect',
      label,
    });
  });

  connection.on('ready', () => {
    logger.info('Redis connection ready', {
      operation: 'ready',
      label,
    });
  });

  connection.on('close', () => {
    logger.info('Redis connection closed', {
      operation: 'close',
      label,
    });
  });

  connection.on('reconnecting', (delayMs: number) => {
    logger.warn('Redis connection reconnecting', {
      operation: 'reconnecting',
      label,
      delayMs,
    });
  });

  connection.on('error', (err: Error) => {
    logger.error('Redis connection error', {
      operation: 'error',
      label,
      error: err.message,
    });
  });

  connection.on('end', () => {
    logger.info('Redis connection ended', {
      operation: 'end',
      label,
    });
  });
}

/**
 * Singleton Redis connection manager.
 *
 * Provides three separate lazy-initialized connections:
 * - queue: for BullMQ queue/worker operations
 * - subscriber: dedicated Pub/Sub subscriber (cannot share with queue)
 * - publisher: Pub/Sub publisher for progress events
 */
class RedisClientManager {
  private queueConnection: Redis | null = null;
  private subscriberConnection: Redis | null = null;
  private publisherConnection: Redis | null = null;
  private shutdownInProgress = false;

  /**
   * Get or create the connection used for BullMQ queue operations.
   * BullMQ requires `maxRetriesPerRequest: null` which is set in buildRedisOptions.
   */
  getQueueConnection(): Redis {
    if (this.shutdownInProgress) {
      throw new Error('RedisClientManager is shutting down');
    }
    if (!this.queueConnection) {
      logger.info('Initializing Redis queue connection', { operation: 'getQueueConnection' });
      this.queueConnection = new Redis(buildRedisOptions('queue'));
      attachLifecycleLogging(this.queueConnection, 'queue');
      this.queueConnection.connect().catch((err: Error) => {
        logger.error('Failed to connect Redis queue connection', {
          operation: 'getQueueConnection',
          error: err.message,
        });
      });
    }
    return this.queueConnection;
  }

  /**
   * Get or create the dedicated Pub/Sub subscriber connection.
   * A subscriber connection enters "subscriber mode" and cannot be used for
   * regular commands — hence the separate connection.
   */
  getSubscriberConnection(): Redis {
    if (this.shutdownInProgress) {
      throw new Error('RedisClientManager is shutting down');
    }
    if (!this.subscriberConnection) {
      logger.info('Initializing Redis subscriber connection', { operation: 'getSubscriberConnection' });
      this.subscriberConnection = new Redis(buildRedisOptions('subscriber'));
      attachLifecycleLogging(this.subscriberConnection, 'subscriber');
      this.subscriberConnection.connect().catch((err: Error) => {
        logger.error('Failed to connect Redis subscriber connection', {
          operation: 'getSubscriberConnection',
          error: err.message,
        });
      });
    }
    return this.subscriberConnection;
  }

  /**
   * Get or create the Pub/Sub publisher connection.
   * Separate from the queue connection to avoid interference with BullMQ internals.
   */
  getPublisherConnection(): Redis {
    if (this.shutdownInProgress) {
      throw new Error('RedisClientManager is shutting down');
    }
    if (!this.publisherConnection) {
      logger.info('Initializing Redis publisher connection', { operation: 'getPublisherConnection' });
      this.publisherConnection = new Redis(buildRedisOptions('publisher'));
      attachLifecycleLogging(this.publisherConnection, 'publisher');
      this.publisherConnection.connect().catch((err: Error) => {
        logger.error('Failed to connect Redis publisher connection', {
          operation: 'getPublisherConnection',
          error: err.message,
        });
      });
    }
    return this.publisherConnection;
  }

  /**
   * PING all active (initialized) connections and return true only if every one responds.
   * Connections that were never initialized are skipped — they don't affect health.
   */
  async healthCheck(): Promise<boolean> {
    const checks: Array<{ label: string; connection: Redis }> = [];

    if (this.queueConnection) {
      checks.push({ label: 'queue', connection: this.queueConnection });
    }
    // Skip subscriber — it enters Pub/Sub mode after subscribing to channels,
    // which changes PING response format (lowercase "pong" as a message, not "PONG").
    // Checking queue + publisher is sufficient to verify Redis connectivity.
    if (this.publisherConnection) {
      checks.push({ label: 'publisher', connection: this.publisherConnection });
    }

    if (checks.length === 0) {
      logger.debug('No active Redis connections to health-check', { operation: 'healthCheck' });
      return true;
    }

    const results = await Promise.allSettled(
      checks.map(async ({ label, connection }) => {
        const result = await connection.ping();
        if (result !== 'PONG') {
          // Defensive: ioredis types narrow `result` to `never` after this guard
          // (ping() is typed as Promise<'PONG'>), but at runtime an unexpected
          // value could still appear if the wire protocol is in an odd state.
          throw new Error(`Unexpected PING response from ${label}: ${String(result)}`);
        }
      }),
    );

    let healthy = true;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        healthy = false;
        logger.error('Redis health check failed', {
          operation: 'healthCheck',
          label: checks[i].label,
          error: (result.reason as Error).message,
        });
      }
    }

    return healthy;
  }

  /**
   * Gracefully close all active Redis connections.
   * Calls `quit()` (sends QUIT command and waits for pending replies) rather than
   * `disconnect()` which drops immediately.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) {
      logger.warn('Redis shutdown already in progress', { operation: 'shutdown' });
      return;
    }
    this.shutdownInProgress = true;
    logger.info('Shutting down Redis connections', { operation: 'shutdown' });

    const closeConnection = async (label: string, connection: Redis | null): Promise<void> => {
      if (!connection) return;
      try {
        await connection.quit();
        logger.info('Redis connection closed gracefully', { operation: 'shutdown', label });
      } catch (err) {
        logger.warn('Redis connection quit failed, forcing disconnect', {
          operation: 'shutdown',
          label,
          error: (err as Error).message,
        });
        connection.disconnect();
      }
    };

    await Promise.allSettled([
      closeConnection('queue', this.queueConnection),
      closeConnection('subscriber', this.subscriberConnection),
      closeConnection('publisher', this.publisherConnection),
    ]);

    this.queueConnection = null;
    this.subscriberConnection = null;
    this.publisherConnection = null;
    this.shutdownInProgress = false;

    logger.info('All Redis connections shut down', { operation: 'shutdown' });
  }
}

// --- SCAN helpers ---

/**
 * Parse a Redis SCAN reply into [cursor, keys] regardless of the shape
 * ioredis returns for the version in use.
 */
function parseScanResult(result: unknown): [string, string[]] {
  if (Array.isArray(result) && result.length >= 2) {
    const keys = Array.isArray(result[1]) ? (result[1] as string[]) : [];
    return [String(result[0]), keys];
  }
  if (result && typeof result === 'object') {
    const r = result as { cursor?: unknown; keys?: unknown };
    return [
      typeof r.cursor === 'string' ? r.cursor : '0',
      Array.isArray(r.keys) ? (r.keys as string[]) : [],
    ];
  }
  return ['0', []];
}

/**
 * Iterate Redis keys matching `pattern` via cursor-based SCAN. Prefer this
 * over `KEYS` — which is O(N) across the entire keyspace and blocks Redis
 * for all other clients while it runs.
 *
 * @param connection - A non-subscriber Redis connection (queue or publisher).
 * @param pattern    - Glob-style pattern, e.g. `worker:*:heartbeat`.
 * @param count      - Matches-per-iteration hint (default 100). Does not cap total results.
 */
export async function scanByPattern(
  connection: Redis,
  pattern: string,
  count = 100,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    const [nextCursor, batch] = parseScanResult(result);
    cursor = nextCursor;
    for (const key of batch) keys.push(key);
  } while (cursor !== '0');
  return keys;
}

/** Every live worker's heartbeat (missing or malformed entries are skipped). */
export async function readWorkerHeartbeats(connection: Redis): Promise<WorkerHeartbeat[]> {
  const keys = await scanByPattern(connection, WORKER_HEARTBEAT_PATTERN);
  if (keys.length === 0) return [];
  const values = await connection.mget(...keys);
  return keys
    .map((key, i) => parseWorkerHeartbeat(key, values[i] ?? null))
    .filter((hb): hb is WorkerHeartbeat => hb !== null);
}

// --- Singleton export ---

let instance: RedisClientManager | null = null;

/**
 * Get the singleton RedisClientManager instance.
 */
export function getRedisClient(): RedisClientManager {
  instance ??= new RedisClientManager();
  return instance;
}
export { RedisClientManager, buildRedisOptions };
