/**
 * Centralized environment configuration: the only module that reads process.env.
 *
 * Each entry point calls `validateConfig(role)` at startup and exits when it
 * fails. `config.auth.jwtSecret` and `config.server.trustProxy` are populated
 * only by a successful `validateConfig('api')`; workers never sign tokens.
 */

import fs from 'node:fs';
import path from 'node:path';

// --- Types ---

export interface EnvValidationResult {
  valid: boolean;
  errors: string[];
}

export interface DatabaseEnvConfig {
  connectionString?: string;
  poolSize: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  ssl: boolean;
  caCertPath?: string;
}

/** Pool defaults when DATABASE_* tuning variables are unset. The only copy. */
export const DATABASE_DEFAULTS = {
  poolSize: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
} as const;

/** Which entry point is validating: they need different environment variables. */
export type ProcessRole = 'api' | 'worker';

// --- Config object ---

let _jwtSecret: string | null = null;
let _trustProxy: string | number | boolean = false;

export const config = {
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },

  get isTest(): boolean {
    return process.env.NODE_ENV === 'test';
  },

  server: {
    get port(): number {
      return Number.parseInt(process.env.PORT || '3001', 10);
    },
    get corsOrigins(): string | undefined {
      return process.env.CORS_ORIGINS || undefined;
    },
    get trustProxy(): string | number | boolean {
      return _trustProxy;
    },
  },

  redis: {
    get url(): string {
      return process.env.REDIS_URL || 'redis://localhost:6379';
    },
  },

  auth: {
    get jwtSecret(): string {
      if (_jwtSecret === null) {
        throw new Error(
          "JWT secret accessed before validateConfig('api'). Worker processes have no JWT secret.",
        );
      }
      return _jwtSecret;
    },
    get cookieSecure(): boolean {
      const raw = process.env.COOKIE_SECURE;
      if (raw !== undefined) return raw === 'true';
      return process.env.NODE_ENV === 'production';
    },
    /** Retention window (days) for audit_logs rows. Default 365. */
    get auditLogRetentionDays(): number {
      const days = Number.parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '', 10);
      // A typo must not shrink the audit trail: anything below 1 day falls back to the default.
      return days >= 1 ? days : 365;
    },
    /**
     * Max rows written per batched UPSERT/INSERT during a bulk user import.
     * Bounds the unnest() array size against PostgreSQL's 65,535 bind limit.
     */
    get userImportBatchSize(): number {
      const raw = process.env.USER_IMPORT_BATCH_SIZE;
      if (!raw) return 2000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 2000;
      return parsed;
    },
    /**
     * Bounded parallelism for per-new-user bcrypt hashing during bulk import.
     * bcrypt is CPU-bound and runs on libuv's threadpool (UV_THREADPOOL_SIZE,
     * default 4), so hashing this many passwords at once matches the pool.
     */
    get userImportHashConcurrency(): number {
      const raw = process.env.USER_IMPORT_HASH_CONCURRENCY;
      if (!raw) return 4;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 4;
      return parsed;
    },

    /**
     * bcrypt cost factor for NEWLY WRITTEN password and refresh-token hashes.
     *
     * 12 is the production value and the default. A constrained environment
     * can lower it; the code paths are identical, only the work factor differs.
     *
     * This is the WRITE cost only. The threshold below which a STORED hash is
     * considered legacy and gets opportunistically rehashed is a separate
     * constant in auth-service.ts, deliberately not this value: lowering the
     * write cost in a test or a constrained environment must never change
     * which stored hashes are classified as weak.
     *
     * Clamped to 4..15. Below 4 bcrypt itself rejects the input; above 15 a
     * single hash takes seconds and would look like a hung request.
     *
     * IGNORED IN PRODUCTION when it would lower the cost. The opportunistic
     * rehash in auth-service treats any stored hash below cost 12 as legacy and
     * rewrites it at THIS cost — so a lowered value in production would not
     * just weaken new hashes, it would actively downgrade existing cost-10 and
     * cost-11 hashes on the owner's next login. A performance knob must not be
     * able to do that to real credentials, so production floors at 12 and only
     * an explicitly non-production NODE_ENV can go below.
     */
    get bcryptCost(): number {
      const raw = process.env.BCRYPT_COST?.trim();
      if (!raw) return 12;
      // Whole-string integer match rather than a bare parseInt: parseInt('9.5.1')
      // returns 9, so a typo would silently select a WEAKER cost than the
      // default and nothing would report it. Everything unparseable falls back
      // to 12.
      if (!/^\d+$/.test(raw)) return 12;
      const parsed = Number.parseInt(raw, 10);
      if (parsed < 4 || parsed > 15) return 12;
      if (process.env.NODE_ENV === 'production' && parsed < 12) return 12;
      return parsed;
    },
  },

  sso: {
    /** Public origin of the API; the OIDC redirect URI is built from it. */
    get apiPublicUrl(): string {
      let url = process.env.API_PUBLIC_URL || 'http://localhost:3001';
      while (url.endsWith('/')) url = url.slice(0, -1);
      return url;
    },
  },

  brightdata: {
    get apiKey(): string | undefined {
      return process.env.BRIGHTDATA_API_KEY || undefined;
    },
    get zone(): string | undefined {
      return process.env.BRIGHTDATA_ZONE || undefined;
    },
  },

  scrapingProvider: {
    /** Direct-mode proxy used when no provider has been saved in the admin UI. */
    get proxyUrl(): string | undefined {
      return process.env.SCRAPER_PROXY_URL || undefined;
    },
    /** How long each process trusts its cached provider settings before re-reading them. */
    get cacheTtlMs(): number {
      const parsed = Number.parseInt(process.env.SCRAPING_PROVIDER_CACHE_TTL_MS ?? '', 10);
      return Number.isNaN(parsed) || parsed < 0 ? 30_000 : parsed;
    },
    /** URL fetched by "Test connection" for Direct and Apify; should echo the egress IP. */
    get testUrl(): string {
      return process.env.SCRAPING_PROVIDER_TEST_URL || 'https://api.ipify.org?format=json';
    },
  },

  secrets: {
    /**
     * AES-256-GCM key for credentials stored in the database (SMTP, scraping
     * provider, SSO client secret, webhook secrets). Not validated at boot:
     * secrets.ts validates on first use, so the app starts without it until a
     * feature that stores a credential is configured.
     */
    get encryptionKey(): string | undefined {
      return process.env.EMAIL_CONFIG_ENCRYPTION_KEY || undefined;
    },
  },

  email: {
    /** Public URL of the Next.js dashboard — used to build email links. */
    get appPublicUrl(): string {
      return process.env.APP_PUBLIC_URL || 'http://localhost:3000';
    },
    /** Retention window (days) for email_log rows. Default 90. */
    get emailLogRetentionDays(): number {
      return Math.max(1, Number.parseInt(process.env.EMAIL_LOG_RETENTION_DAYS || '90', 10));
    },
    /** Daily-digest scheduler interval (ms). Default 24h, min 1 minute. */
    get digestIntervalMs(): number {
      const raw = process.env.EMAIL_DIGEST_INTERVAL_MS;
      if (!raw) return 24 * 60 * 60 * 1000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 60_000) return 24 * 60 * 60 * 1000;
      return parsed;
    },
  },

  worker: {
    /** PM2 instance id (`pm_id`, set by PM2), used for the worker's name. */
    get pm2InstanceId(): string | undefined {
      return process.env.pm_id || undefined;
    },
    get concurrency(): number {
      return Number.parseInt(process.env.WORKER_CONCURRENCY || '13', 10);
    },
    get unlockerConcurrency(): number {
      const raw = process.env.UNLOCKER_CONCURRENCY;
      if (!raw) return 12;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) return 12;
      return parsed;
    },
    /**
     * How often each process logs its rolling Web Unlocker latency summary.
     * 0 disables the summary entirely. Default 60s — frequent enough to see a
     * regression develop within a job, sparse enough not to flood pm2 logs.
     */
    get unlockerLatencyLogIntervalMs(): number {
      const raw = process.env.UNLOCKER_LATENCY_LOG_INTERVAL_MS;
      if (raw === undefined) return 60_000;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 0) return 60_000;
      return parsed;
    },
    get pdpRenderTimeoutMs(): number {
      // Fetch timeout for product pages of an adapter with `needsRender`.
      // Browser rendering a client-side page is slow — well over the 30s
      // default for a plain fetch. Configurable per environment.
      const raw = process.env.PDP_RENDER_TIMEOUT_MS;
      if (!raw) return 90_000;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 10_000 || parsed > 300_000) return 90_000;
      return parsed;
    },
    get extractionFailureAlertThreshold(): number {
      // Fraction of a PDP batch that must be *extraction errors* (thrown parse
      // failures, i.e. a likely retailer schema break — NOT legitimately-empty
      // products) before the live scrape logs a schema-drift alert and the
      // Prometheus counter's rate spikes. Default 0.5 (half the batch). Range
      // (0, 1]; anything else falls back to the default.
      const raw = process.env.SCRAPER_EXTRACTION_FAILURE_ALERT_THRESHOLD;
      if (!raw) return 0.5;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return 0.5;
      return parsed;
    },
    get excelConcurrency(): number {
      // Per-process concurrency for the excel-jobs queue. Default 1 — across N
      // worker processes only N excel generations run at once. Capping serialises
      // the disk-write burst (Netdata 149 MiB/s peak) into a longer plateau.
      return Number.parseInt(process.env.EXCEL_WORKER_CONCURRENCY || '1', 10);
    },
    get persistConcurrency(): number {
      // Per-process concurrency for the persist-jobs queue. Default 1 —
      // serialises concurrent INSERT bursts and reduces PG row-lock contention
      // when many scrapes finish close together.
      return Number.parseInt(process.env.PERSIST_WORKER_CONCURRENCY || '1', 10);
    },
    get processRole(): string {
      return process.env.PROCESS_ROLE || 'api';
    },
    get shutdownTimeoutMs(): number {
      // Worker graceful-shutdown ceiling. Must exceed JOB_TIMEOUT_MS (60min
      // default in queue-service.ts) so an in-flight scrape can finish
      // before the worker process exits. Override in dev with a smaller
      // value if you want fast Ctrl-C cycles.
      return Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || String(65 * 60 * 1000), 10);
    },
    get expectedWorkers(): number {
      return Number.parseInt(process.env.EXPECTED_WORKERS || '2', 10);
    },
  },

  observability: {
    get lokiUrl(): string | undefined {
      return process.env.LOKI_URL || undefined;
    },
    get logLevel(): string {
      return process.env.LOG_LEVEL || 'info';
    },
    get metricsSampleIntervalMs(): number {
      // How often the API process samples runtime gauges (BullMQ queue
      // depth, pg pool counts) into the Prometheus registry. Default 15s,
      // matching a typical Prometheus scrape interval. Clamp to a sane band.
      const raw = process.env.OBSERVABILITY_METRICS_SAMPLE_INTERVAL_MS;
      if (!raw) return 15_000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 600_000) return 15_000;
      return parsed;
    },
    /** Bearer token for /metrics/prometheus; unset hides the endpoint (404). */
    get metricsBearerToken(): string | undefined {
      return process.env.METRICS_BEARER_TOKEN || undefined;
    },
    /** Retention window (days) for web_vitals partitions. Default 90. */
    get webVitalsRetentionDays(): number {
      return Math.max(1, Number.parseInt(process.env.WEB_VITALS_RETENTION_DAYS || '90', 10));
    },
    /** Waiting scrape jobs above which /api/health reports degraded. */
    get queueDepthDegradedThreshold(): number {
      return Number.parseInt(process.env.HEALTH_QUEUE_DEPTH_THRESHOLD || '100', 10);
    },
  },

  scheduling: {
    /** IANA zone that schedule times ("HH:MM", weekdays) are written in. The web client has its own copy. */
    get timezone(): string {
      return process.env.SCHEDULE_TIMEZONE || 'America/New_York';
    },
    /** How often report-file cleanup, DB retention and web_vitals partitioning run. Default 7 days. */
    get maintenanceIntervalMs(): number {
      return Number.parseInt(process.env.MAINTENANCE_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
    },
  },

  scraping: {
    get discoveryCacheTtlHours(): number {
      return Number.parseInt(process.env.DISCOVERY_CACHE_TTL_HOURS || '24', 10);
    },
    get variantCacheTtlHours(): number {
      return Number.parseInt(process.env.VARIANT_CACHE_TTL_HOURS || '24', 10);
    },
    get snapshotRetentionDays(): number {
      return Math.max(1, Number.parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '90', 10));
    },
    get bandwidthRetentionDays(): number {
      return Math.max(1, Number.parseInt(process.env.BANDWIDTH_RETENTION_DAYS || '90', 10));
    },
    /** Retention window (days) for generated Excel report files on disk. Default 7. */
    get reportRetentionDays(): number {
      return Math.max(1, Number.parseInt(process.env.REPORT_RETENTION_DAYS || '7', 10));
    },
    /**
     * Min times a product must appear in jobs.failed_products within the reporting
     * window to surface on the admin "stale products" report. Default 5.
     */
    get staleProductFailureThreshold(): number {
      return Math.max(1, Number.parseInt(process.env.STALE_PRODUCT_FAILURE_THRESHOLD || '5', 10));
    },
    get discoveryRuns(): number {
      return Math.max(1, Number.parseInt(process.env.DISCOVERY_RUNS || '2', 10));
    },
    get maxConsecutiveFailures(): number {
      const raw = process.env.MAX_CONSECUTIVE_FAILURES;
      if (!raw) return 3;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) return 3;
      return parsed;
    },
    get storageDir(): string {
      return process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage', 'excel');
    },
    get diskSpaceCheckPath(): string {
      return process.env.STORAGE_PATH || process.cwd();
    },
    get persistBatchSize(): number {
      const raw = process.env.PERSIST_BATCH_SIZE;
      if (!raw) return 2000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 2000;
      return parsed;
    },
    get browserPoolSize(): number {
      const raw = process.env.BROWSER_POOL_SIZE;
      if (!raw) return 3;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 20) return 3;
      return parsed;
    },
    get cdpAcquireTimeoutMs(): number {
      const raw = process.env.CDP_ACQUIRE_TIMEOUT_MS;
      if (!raw) return 30_000;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1_000 || parsed > 600_000) return 30_000;
      return parsed;
    },
    get dataDir(): string {
      return process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
    },
    get retailerApiMinDelayMs(): number {
      const raw = process.env.RETAILER_API_MIN_DELAY_MS;
      if (!raw) return 100;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 0) return 100;
      return parsed;
    },
    get retryConcurrencyMultiplier(): number {
      const raw = process.env.RETRY_CONCURRENCY_MULTIPLIER;
      if (!raw) return 2;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 10) return 2;
      return parsed;
    },
    /** $/GB for bandwidth cost estimates until an admin saves a rate. */
    get defaultCostPerGb(): number {
      const parsed = Number.parseFloat(process.env.BANDWIDTH_COST_PER_GB || '3');
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
    },
    get backfillMaxProducts(): number {
      const raw = process.env.BACKFILL_MAX_PRODUCTS;
      if (!raw) return 5000;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) return 5000;
      if (parsed < 100) return 100;
      if (parsed > 50000) return 50000;
      return parsed;
    },
  },

  jobs: {
    get jobTimeoutMs(): number {
      return Number.parseInt(process.env.JOB_TIMEOUT_MS || String(60 * 60 * 1000), 10);
    },
    get excelJobTimeoutMs(): number {
      return Number.parseInt(process.env.EXCEL_JOB_TIMEOUT_MS || String(5 * 60 * 1000), 10);
    },
    get persistJobTimeoutMs(): number {
      return Number.parseInt(process.env.PERSIST_JOB_TIMEOUT_MS || String(5 * 60 * 1000), 10);
    },
    /**
     * BullMQ lock on a scrape job — how long it may run before BullMQ calls it
     * stalled. Scrapes take 10-30 minutes; BullMQ's 30s default would re-run them.
     */
    get scrapeLockDurationMs(): number {
      return Number.parseInt(process.env.SCRAPE_JOB_LOCK_DURATION_MS || String(45 * 60 * 1000), 10);
    },
    /** How often BullMQ workers check for stalled jobs. */
    get stalledIntervalMs(): number {
      return Number.parseInt(process.env.QUEUE_STALLED_INTERVAL_MS || String(5 * 60 * 1000), 10);
    },
    /** How long a queue worker gets to drain on stop before it is force-closed. */
    get queueStopTimeoutMs(): number {
      return Number.parseInt(process.env.QUEUE_STOP_TIMEOUT_MS || '30000', 10);
    },
    /** Alert-webhook deliveries in flight per worker process. */
    get webhookConcurrency(): number {
      return Number.parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || '2', 10);
    },
    /** Delivery attempts per webhook (first try included), with exponential backoff. */
    get webhookAttempts(): number {
      return Number.parseInt(process.env.WEBHOOK_DELIVERY_ATTEMPTS || '3', 10);
    },
  },

  alerts: {
    /** Per-image timeout for broken-image checks. */
    get imageCheckTimeoutMs(): number {
      return Number.parseInt(process.env.ALERT_IMAGE_CHECK_TIMEOUT_MS || '8000', 10);
    },
    /** Images checked at once after a run. */
    get imageCheckConcurrency(): number {
      return Number.parseInt(process.env.ALERT_IMAGE_CHECK_CONCURRENCY || '8', 10);
    },
  },

  siteMonitor: {
    /**
     * A monitor run still 'running' after this long is treated as crashed and
     * marked failed when the next run starts, so one orphan can't block
     * monitoring forever. Default 2h.
     */
    get staleRunMs(): number {
      const raw = Number.parseInt(process.env.SITE_MONITOR_STALE_RUN_MS || '', 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60 * 1000;
    },
  },

  rateLimits: {
    get apiMax(): number {
      return Number.parseInt(process.env.RATE_LIMIT_API_MAX || '500', 10);
    },
    get authMax(): number {
      return Number.parseInt(process.env.RATE_LIMIT_AUTH_MAX || '20', 10);
    },
    get adminMax(): number {
      return Number.parseInt(process.env.RATE_LIMIT_ADMIN_MAX || '300', 10);
    },
    get metricsMax(): number {
      return Number.parseInt(process.env.RATE_LIMIT_METRICS_MAX || '120', 10);
    },
    /**
     * How long a scrape slot stays held without a release before it frees
     * itself (a crashed worker's slot). Must outlast a job: default
     * JOB_TIMEOUT_MS + 5 minutes.
     */
    get leaseTtlMs(): number {
      const raw = Number.parseInt(process.env.RATE_LIMIT_LEASE_TTL_MS || '', 10);
      return Number.isFinite(raw) && raw > 0 ? raw : config.jobs.jobTimeoutMs + 5 * 60 * 1000;
    },
    /** Failed token refreshes per IP per 15 minutes. */
    get refreshMax(): number {
      return Number.parseInt(process.env.RATE_LIMIT_REFRESH_MAX || '30', 10);
    },
    /**
     * Raw scrape-limiter settings: RATE_LIMIT_MAX_CONCURRENT, RATE_LIMIT_TIMEOUT_MS
     * and RATE_LIMIT_{SITE}_MAX_CONCURRENT. rate-limiter.ts validates them.
     */
    get scrapeEnv(): Record<string, string | undefined> {
      return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('RATE_LIMIT_')));
    },
  },
};

// --- Validation helpers (ported from validate-env.ts) ---

/**
 * Check whether a JWT secret meets minimum security requirements:
 *   1. At least 32 characters (256-bit for HS256)
 *   2. Not a dictionary-word pattern (only lowercase letters and hyphens)
 *   3. Sufficient character diversity / entropy — rejects long runs of a
 *      single character or short repeating cycles (e.g. "a".repeat(31) + "B"),
 *      which satisfy 1 and 2 but are trivially guessable.
 */
export function validateJwtSecret(secret: string): boolean {
  if (secret.length < 32) return false;
  if (/^[a-z-]+$/.test(secret)) return false;
  return hasSufficientSecretEntropy(secret);
}

/**
 * Heuristic guard against low-entropy JWT secrets. Returns true if `secret`
 * looks like high-entropy random output (e.g. the result of
 * `openssl rand -base64 32`), false if it looks low-entropy.
 *
 * Two cheap signals, both must hold:
 *   1. Distinct-character count >= 12. Random 32-byte base64 has ~25-32 distinct
 *      chars and 32-char hex has ~14; "a".repeat(31)+"B" has 2; a period-k
 *      repeating cycle has k. 12 admits hex output while rejecting short cycles.
 *   2. Shannon entropy per character >= 3.0 bits. Uniform output approaches
 *      log2(alphabet) (~6 for base64, ~4 for hex); "ab".repeat(20) is 1.0.
 */
export function hasSufficientSecretEntropy(secret: string): boolean {
  const counts = new Map<string, number>();
  for (const ch of secret) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  if (counts.size < 12) return false;

  const len = secret.length;
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / len;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3;
}

// --- Database validation helpers ---

function isNonEmpty(val: string | undefined): val is string {
  return val !== undefined && val !== '';
}

function parseOptionalInt(
  envName: string, defaultVal: number, min: number, max: number, errors: string[],
): number {
  const raw = process.env[envName];
  if (!isNonEmpty(raw)) return defaultVal;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${envName} must be an integer between ${min} and ${max}. Received: "${raw}"`);
    return defaultVal;
  }
  return parsed;
}

function parseOptionalTimeout(envName: string, defaultVal: number, errors: string[]): number {
  const raw = process.env[envName];
  if (!isNonEmpty(raw)) return defaultVal;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`${envName} must be a non-negative number. Received: "${raw}"`);
    return defaultVal;
  }
  return parsed;
}

function parseSslConfig(databaseUrl: string, errors: string[]): boolean {
  const rawSsl = process.env.DATABASE_SSL;
  if (isNonEmpty(rawSsl)) {
    if (rawSsl !== 'true' && rawSsl !== 'false') {
      errors.push(`DATABASE_SSL must be "true" or "false". Received: "${rawSsl}"`);
      return true;
    }
    return rawSsl === 'true';
  }
  // Default: true for non-localhost, false for localhost
  const isLocalhost = /^postgres(ql)?:\/\/(.*@)?localhost[:/]/.test(databaseUrl);
  return !isLocalhost;
}

function parseCaCertPath(errors: string[]): string | undefined {
  const rawCaCert = process.env.DATABASE_CA_CERT;
  if (!isNonEmpty(rawCaCert)) return undefined;
  if (fs.existsSync(rawCaCert)) return rawCaCert;
  errors.push(`DATABASE_CA_CERT file not found at path: "${rawCaCert}"`);
  return undefined;
}

/**
 * Validate PostgreSQL-specific environment variables.
 * Requires DATABASE_URL (a `postgresql://` / `postgres://` connection string).
 * Also validates optional pool, timeout, SSL, and CA cert settings.
 */
export function validateDatabaseEnv(): { errors: string[]; config: DatabaseEnvConfig | null } {
  const errors: string[] = [];
  const databaseUrl = process.env.DATABASE_URL ?? '';

  if (!isNonEmpty(databaseUrl)) {
    errors.push(
      'Missing required environment variable: DATABASE_URL (must start with "postgresql://" or "postgres://")',
    );
    return { errors, config: null };
  }

  if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) {
    // Never echo the value: it carries the database credentials.
    errors.push('DATABASE_URL must start with "postgresql://" or "postgres://".');
  }

  const d = DATABASE_DEFAULTS;
  const poolSize = parseOptionalInt('DATABASE_POOL_SIZE', d.poolSize, 1, 100, errors);
  const idleTimeoutMs = parseOptionalTimeout('DATABASE_IDLE_TIMEOUT_MS', d.idleTimeoutMs, errors);
  const connectionTimeoutMs = parseOptionalTimeout('DATABASE_CONNECTION_TIMEOUT_MS', d.connectionTimeoutMs, errors);
  const statementTimeoutMs = parseOptionalTimeout('DATABASE_STATEMENT_TIMEOUT_MS', d.statementTimeoutMs, errors);
  const ssl = parseSslConfig(databaseUrl, errors);
  const caCertPath = parseCaCertPath(errors);

  if (errors.length > 0) {
    return { errors, config: null };
  }

  return {
    errors: [],
    config: { connectionString: databaseUrl, poolSize, idleTimeoutMs, connectionTimeoutMs, statementTimeoutMs, ssl, caCertPath },
  };
}

/**
 * Validate the environment variables `role` needs, at startup.
 *
 * Both roles need a valid PostgreSQL configuration. The API also needs
 * JWT_SECRET, PORT and NODE_ENV, and populates `config.auth.jwtSecret` and
 * `config.server.trustProxy`. The caller exits the process when `valid` is false.
 */
export function validateConfig(role: ProcessRole = 'api'): EnvValidationResult {
  const errors = [...validateDatabaseEnv().errors];
  if (role === 'worker') return { valid: errors.length === 0, errors };

  for (const key of ['JWT_SECRET', 'PORT', 'NODE_ENV']) {
    if (!process.env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  if (process.env.JWT_SECRET && !validateJwtSecret(process.env.JWT_SECRET)) {
    errors.push(
      'JWT_SECRET must be at least 32 characters, not a simple dictionary-word pattern, ' +
        'and have sufficient character diversity (no long single-character runs or short ' +
        'repeating cycles). Generate a strong secret with: openssl rand -base64 32',
    );
  }

  // --- Optional: TRUST_PROXY (defaults to false: X-Forwarded-For is ignored) ---
  const rawTrustProxy = process.env.TRUST_PROXY;
  if (rawTrustProxy !== undefined && rawTrustProxy !== '') {
    const asNumber = Number(rawTrustProxy);
    _trustProxy = Number.isFinite(asNumber) ? asNumber : rawTrustProxy;
  } else {
    _trustProxy = false;
  }

  if (errors.length === 0 && process.env.JWT_SECRET) {
    _jwtSecret = process.env.JWT_SECRET;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate for `role` and exit the process when that fails. Prints only the
 * error count: the messages name variables and some could echo their values.
 */
export function validateConfigOrExit(role: ProcessRole): void {
  const result = validateConfig(role);
  if (!result.valid) {
    console.error(`Environment validation failed with ${result.errors.length} error(s). Check your .env configuration.`);
    process.exit(1);
  }
}
