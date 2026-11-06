/**
 * Bottleneck-backed Rate Limiter — per-retailer concurrency control via Redis clustering.
 *
 * Shared across all worker processes to prevent overwhelming retailer APIs
 * or exceeding Bright Data session limits. Uses Bottleneck's Redis Cluster
 * for atomic reservoir management, eliminating custom Lua scripts.
 *
 * A slot is a Bottleneck job that stays running until release() (or until its
 * lease expires, which frees the slot of a worker that crashed while holding
 * it). Key names: rate-limit-keys.ts.
 *
 * Default limits:
 * - 15 concurrent sessions per retailer
 * - lease: config.rateLimits.leaseTtlMs
 */

import Bottleneck from 'bottleneck';
import { v4 as uuidv4 } from 'uuid';
import { buildRedisOptions } from './redis-client';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { scrapeSlotLimiterId } from './rate-limit-keys';

const logger = createLogger('rate-limiter');

export interface RateLimitConfig {
  /** Max concurrent requests per retailer across all workers. */
  maxConcurrent: Record<string, number>;
  /** Global default when no per-retailer override is set. */
  defaultMaxConcurrent: number;
  /**
   * RATE_LIMIT_TIMEOUT_MS. Bottleneck uses it as the Redis key TTL after the
   * last acquire (not an acquire timeout); it is raised to at least the lease.
   */
  timeout?: number;
  /** A held slot frees itself this long after acquire if never released. */
  leaseTtlMs?: number;
}

/** Default: 15 concurrent sessions per retailer. */
const DEFAULT_MAX_CONCURRENT = 15;

/** Default timeout for acquiring a rate limit slot (ms). */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Parse a setting as an integer within a valid range.
 * Returns the default if unset, non-numeric, or out of range.
 */
export function parseEnvInt(envKey: string, raw: string | undefined, defaultValue: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    logger.warn(`Invalid ${envKey}, using default ${defaultValue}`, { raw, min, max });
    return defaultValue;
  }
  return parsed;
}

/**
 * Build a RateLimitConfig from environment variables.
 *
 * Reads `RATE_LIMIT_MAX_CONCURRENT` for the global default (default: 15, range [1, 200]).
 * Reads `RATE_LIMIT_{SITE}_MAX_CONCURRENT` for per-site overrides (site name upper-cased).
 * Reads `RATE_LIMIT_TIMEOUT_MS` for the acquire timeout (default: 300000).
 */
export function buildConfigFromEnv(): RateLimitConfig {
  const env = config.rateLimits.scrapeEnv;
  const globalMax = parseEnvInt('RATE_LIMIT_MAX_CONCURRENT', env.RATE_LIMIT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1, 200);
  const timeout = parseEnvInt('RATE_LIMIT_TIMEOUT_MS', env.RATE_LIMIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 600_000);
  const perRetailer: Record<string, number> = {};

  for (const [envKey, val] of Object.entries(env)) {
    const match = /^RATE_LIMIT_([A-Z0-9_]+)_MAX_CONCURRENT$/.exec(envKey);
    if (!match) continue;
    const retailer = match[1].toLowerCase();
    if (val !== undefined && val !== '') {
      const parsed = Number.parseInt(val, 10);
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 200) {
        perRetailer[retailer] = parsed;
      } else {
        logger.warn(`Invalid ${envKey}, ignoring override`, { raw: val });
      }
    }
  }

  return { maxConcurrent: perRetailer, defaultMaxConcurrent: globalMax, timeout, leaseTtlMs: config.rateLimits.leaseTtlMs };
}

/**
 * Bottleneck-backed distributed rate limiter using Redis clustering for
 * per-retailer concurrency control across multiple worker processes.
 */
export class BottleneckRateLimiter {
  private readonly config: Required<RateLimitConfig>;

  /**
   * Map of Bottleneck limiter init promises per retailer. We store the promise
   * (not the resolved instance) so concurrent acquires de-duplicate to a single
   * `ready()` await — the Bottleneck Redis-cluster datastore emits
   * `ERR SETTINGS_KEY_NOT_FOUND` every 5s when operations are scheduled before
   * the cluster init finishes seeding its settings hash, so we must await
   * `ready()` before exposing the limiter.
   */
  private readonly limiters: Map<string, Promise<Bottleneck>> = new Map();

  /**
   * Slots this process holds, per retailer: token id -> the function that ends
   * the Bottleneck job holding the slot, and that job's promise.
   */
  private readonly held: Map<string, Map<string, { finish: () => void; done: Promise<unknown> }>> = new Map();

  constructor(options: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxConcurrent: { ...options.maxConcurrent },
      defaultMaxConcurrent: options.defaultMaxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      leaseTtlMs: options.leaseTtlMs ?? config.rateLimits.leaseTtlMs,
    };
  }

  private heldFor(retailer: string) {
    let tokens = this.held.get(retailer);
    if (!tokens) {
      tokens = new Map();
      this.held.set(retailer, tokens);
    }
    return tokens;
  }

  /**
   * Get the max concurrent limit for a retailer.
   * Falls back to the env-driven defaultMaxConcurrent if no per-retailer override is set.
   */
  private getMaxConcurrent(retailer: string): number {
    return this.config.maxConcurrent[retailer] ?? this.config.defaultMaxConcurrent;
  }

  /**
   * Get or create a Bottleneck instance for the retailer with Redis Cluster.
   *
   * Returns a promise that resolves once the Redis settings hash is seeded
   * (via `limiter.ready()`); operations scheduled before init complete would
   * otherwise emit `ERR SETTINGS_KEY_NOT_FOUND` every 5s.
   */
  private getLimiter(retailer: string): Promise<Bottleneck> {
    const existing = this.limiters.get(retailer);
    if (existing) return existing;

    const maxConcurrent = this.getMaxConcurrent(retailer);
    const redisOptions = buildRedisOptions('bottleneck', false);

    // Build Bottleneck config — use Redis cluster when available, local otherwise
    const limiter = new Bottleneck({
      id: scrapeSlotLimiterId(retailer),
      maxConcurrent,
      // Redis key TTL: keep the state at least as long as a lease can be held.
      timeout: Math.max(this.config.timeout, this.config.leaseTtlMs),
      ...(redisOptions ? {
        datastore: 'ioredis' as const,
        clientOptions: redisOptions,
        clearDatastore: false, // Preserve state across restarts
      } : {}),
    });

    // Attach error handler for fail-open behavior
    limiter.on('error', (err: Error) => {
      logger.error('Bottleneck error', {
        operation: 'bottleneck-error',
        retailer,
        error: err.message,
      });
    });

    const initPromise = limiter.ready().then(() => {
      logger.debug('Created Bottleneck limiter', {
        operation: 'getLimiter',
        retailer,
        maxConcurrent,
        timeout: this.config.timeout,
      });
      return limiter;
    });

    // If init fails (Redis down at startup), evict the rejected promise so the
    // next caller retries instead of inheriting a permanently-broken entry.
    initPromise.catch(() => {
      if (this.limiters.get(retailer) === initPromise) {
        this.limiters.delete(retailer);
      }
    });

    this.limiters.set(retailer, initPromise);
    return initPromise;
  }

  /**
   * Acquire a concurrency token for the given retailer.
   *
   * Uses Bottleneck's `schedule()` to queue the request and wait for a slot.
   * Implements fail-open: if Redis is unavailable, logs a warning and returns
   * a synthetic token ID to allow the request to proceed.
   *
   * @returns The token ID (needed for release)
   * @throws Error if the acquire times out
   */
  async acquire(retailer: string): Promise<string> {
    const tokenId = uuidv4();

    logger.debug('Acquiring rate limit token', {
      operation: 'acquire',
      retailer,
      tokenId,
    });

    try {
      const limiter = await this.getLimiter(retailer);
      // The job runs (holding a slot) until release() calls finish, or until
      // the lease expires and Bottleneck frees the slot itself.
      await new Promise<void>((acquired, failed) => {
        let isHeld = false;
        const done = limiter.schedule({ id: tokenId, expiration: this.config.leaseTtlMs }, () => new Promise<void>((finish) => {
          this.heldFor(retailer).set(tokenId, { finish, done });
          isHeld = true;
          acquired();
        }));
        done.catch((err: Error) => {
          this.held.get(retailer)?.delete(tokenId);
          if (isHeld) {
            logger.warn('Rate limit lease expired before release; slot freed', {
              operation: 'acquire', retailer, tokenId, leaseTtlMs: this.config.leaseTtlMs, error: err.message,
            });
          }
          failed(err); // no-op once acquired
        });
      });

      logger.info('Rate limit token acquired', { operation: 'acquire', retailer, tokenId });
      return tokenId;
    } catch (err) {
      // Fail-open: if Redis is unavailable or timeout occurs, allow request to proceed
      logger.warn('Rate limit acquire failed, allowing request (fail-open)', {
        operation: 'acquire',
        retailer,
        tokenId,
        error: (err as Error).message,
      });

      // Return synthetic token ID to allow caller to proceed
      return `synthetic-${tokenId}`;
    }
  }

  /**
   * Release a concurrency token back to the pool.
   *
   * Increments the Bottleneck reservoir to restore the slot. If no tokenId is provided,
   * releases the most recently acquired token for the retailer from this process.
   */
  async release(retailer: string, tokenId?: string): Promise<void> {
    const tokens = this.held.get(retailer);
    const idToRelease = tokenId ?? tokens?.keys().next().value;

    if (!idToRelease) {
      logger.warn('No token to release', { operation: 'release', retailer });
      return;
    }
    if (idToRelease.startsWith('synthetic-')) return; // fail-open token: no slot was taken

    const slot = tokens?.get(idToRelease);
    if (!slot) {
      logger.debug('Token not held (already released or lease expired)', { operation: 'release', retailer, tokenId: idToRelease });
      return;
    }
    tokens!.delete(idToRelease);
    if (tokens!.size === 0) this.held.delete(retailer);

    slot.finish();
    // Resolves once Bottleneck has freed the slot.
    await slot.done.catch(() => {});
    logger.debug('Rate limit token released', { operation: 'release', retailer, tokenId: idToRelease });
  }

  /**
   * Get the number of available tokens for a retailer.
   *
   * Queries the Bottleneck reservoir. Note: This is an approximation
   * in a distributed system with concurrent acquisitions.
   */
  async getAvailableTokens(retailer: string): Promise<number> {
    try {
      const limiter = await this.getLimiter(retailer);
      // running() is cluster-wide in Redis mode.
      return Math.max(0, this.getMaxConcurrent(retailer) - (await limiter.running()));
    } catch (err) {
      logger.error('Failed to get available tokens', {
        operation: 'getAvailableTokens',
        retailer,
        error: (err as Error).message,
      });
      return 0;
    }
  }

  /**
   * Disconnect all Bottleneck instances and release all held tokens.
   * Called during graceful shutdown.
   */
  async disconnect(): Promise<void> {
    logger.info('Disconnecting all Bottleneck limiters', { operation: 'disconnect' });

    // Give back every slot this process holds before dropping the connections.
    await Promise.all(Array.from(this.held.entries()).flatMap(([retailer, tokens]) =>
      Array.from(tokens.keys()).map((id) => this.release(retailer, id))));

    // Disconnect all limiters — await each init promise first so we don't
    // race with a limiter that hasn't finished its `ready()` initialization.
    const disconnectPromises = Array.from(this.limiters.entries()).map(async ([retailer, limiterPromise]) => {
      try {
        const limiter = await limiterPromise;
        await limiter.disconnect();
        logger.debug('Bottleneck limiter disconnected', {
          operation: 'disconnect',
          retailer,
        });
      } catch (err) {
        logger.error('Failed to disconnect Bottleneck limiter', {
          operation: 'disconnect',
          retailer,
          error: (err as Error).message,
        });
      }
    });

    await Promise.allSettled(disconnectPromises);

    this.limiters.clear();
    this.held.clear();

    logger.info('All Bottleneck limiters disconnected', { operation: 'disconnect' });
  }
}

// --- Singleton export ---

let instance: BottleneckRateLimiter | null = null;

/**
 * Get the singleton BottleneckRateLimiter instance.
 * When no explicit config is passed, reads from environment variables.
 */
export function getRateLimiter(config?: Partial<RateLimitConfig>): BottleneckRateLimiter {
  instance ??= new BottleneckRateLimiter(config ?? buildConfigFromEnv());
  return instance;
}
