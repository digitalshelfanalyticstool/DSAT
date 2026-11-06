/**
 * Database Service — singleton PostgreSQL wrapper with connection pooling and retry logic.
 *
 * All database access goes through this service. Uses pg.Pool for async,
 * connection-pooled PostgreSQL operations. Implements retry logic with
 * exponential backoff for transient PostgreSQL errors.
 *
 * Connection is configured via DATABASE_URL or individual PG* env vars.
 */

import { Pool, PoolConfig, QueryResult, types as pgTypes } from 'pg';
import fs from 'node:fs';
import { config, DATABASE_DEFAULTS, validateDatabaseEnv } from '../config';
import { createLogger } from '../utils/logger';
import {
  initializeSchema as _initializeSchema,
  getSchemaVersion as _getSchemaVersion,
} from './database-migrations';

const logger = createLogger('database');

// Coerce PostgreSQL BIGINT (OID 20) results to JavaScript numbers globally.
// Without this, `COUNT(*)`, `BIGSERIAL` ids, and any `int8` column arrive as
// strings — causing `expect(row.count).toBe(10)` to fail with "expected '10'
// to be 10". Individual call sites were compensating ad-hoc (e.g. rate-limit-
// store's Number() wrap); registering once here eliminates the class of bug.
// Safe for our data: all COUNT and id values comfortably fit in 2^53.
pgTypes.setTypeParser(pgTypes.builtins.INT8, (val: string | null) =>
  val === null ? null : Number(val),
);

/**
 * Transient PostgreSQL error codes that warrant a retry.
 */
const TRANSIENT_PG_ERROR_CODES = new Set([
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '40001', // serialization_failure
]);

/**
 * Upper bound (ms) on the health-check probe. Applied via a transaction-scoped
 * `SET LOCAL statement_timeout` so it never leaks onto a reused pooled
 * connection. A fixed probe budget, not a deployment-topology value.
 */
const HEALTH_CHECK_TIMEOUT_MS = 5000;

// --- Configuration ---

export interface DatabaseConfig {
  /** Full connection string (DATABASE_URL). When present, individual PG* vars are ignored. */
  connectionString?: string;
  /** PostgreSQL host (PGHOST) */
  host?: string;
  /** PostgreSQL port (PGPORT) */
  port?: number;
  /** PostgreSQL database name (PGDATABASE) */
  database?: string;
  /** PostgreSQL user (PGUSER) */
  user?: string;
  /** PostgreSQL password (PGPASSWORD) */
  password?: string;
  /** Pool tuning; defaults in DATABASE_DEFAULTS (config.ts). */
  poolSize?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Kills queries exceeding this duration. */
  statementTimeoutMs?: number;
  /** Enable SSL (DATABASE_SSL) */
  ssl?: boolean;
  /** Path to custom CA certificate (DATABASE_CA_CERT) */
  caCertPath?: string;
  /** Max retries for transient errors (default 3) */
  maxRetries?: number;
  /** Initial retry delay in ms, doubles each retry (default 50) */
  initialRetryDelayMs?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Helper object passed to transaction callbacks */
export interface TransactionClient {
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

// --- Singleton ---

let instance: DatabaseService | null = null;

/**
 * Resolve DatabaseConfig from environment variables via the central
 * `validateDatabaseEnv()` parser in config.ts.
 *
 * Errors from the parser are intentionally swallowed — callers can pass a
 * `Partial<DatabaseConfig>` override to `getInstance()` (e.g. tests that don't
 * set DATABASE_URL); a downstream `pool.query('SELECT 1')` will surface a
 * clearer connection error than rejecting at config time.
 */
function resolveConfigFromEnv(): Partial<DatabaseConfig> {
  const { config: parsed } = validateDatabaseEnv();
  if (!parsed) return {};

  const { caCertPath, ...rest } = parsed;
  return caCertPath === undefined ? rest : { ...rest, caCertPath };
}

/**
 * Build a pg PoolConfig from our DatabaseConfig.
 */
function buildPoolConfig(dbConfig: DatabaseConfig): PoolConfig {
  const poolConfig: PoolConfig = {
    max: dbConfig.poolSize ?? DATABASE_DEFAULTS.poolSize,
    idleTimeoutMillis: dbConfig.idleTimeoutMs ?? DATABASE_DEFAULTS.idleTimeoutMs,
    connectionTimeoutMillis: dbConfig.connectionTimeoutMs ?? DATABASE_DEFAULTS.connectionTimeoutMs,
    statement_timeout: dbConfig.statementTimeoutMs ?? DATABASE_DEFAULTS.statementTimeoutMs,
  };

  if (dbConfig.connectionString) {
    poolConfig.connectionString = dbConfig.connectionString;
  } else {
    poolConfig.host = dbConfig.host;
    poolConfig.port = dbConfig.port;
    poolConfig.database = dbConfig.database;
    poolConfig.user = dbConfig.user;
    poolConfig.password = dbConfig.password;
  }

  if (dbConfig.ssl) {
    const sslConfig: { rejectUnauthorized: boolean; ca?: string } = {
      rejectUnauthorized: true,
    };
    if (dbConfig.caCertPath) {
      sslConfig.ca = fs.readFileSync(dbConfig.caCertPath, 'utf-8');
    }
    poolConfig.ssl = sslConfig;
  }

  return poolConfig;
}

/**
 * Execute a SQL statement using a PoolClient and return a RunResult.
 * For INSERT statements, appends RETURNING id to get the auto-generated ID.
 */
/**
 * Tables known to have a SERIAL `id` column.
 * INSERT into these tables will use `RETURNING id` to populate lastInsertRowid.
 * Tables without an `id` column (e.g. schema_version, app_settings) skip RETURNING.
 */
const TABLES_WITH_SERIAL_ID = new Set([
  'users', 'refresh_tokens', 'audit_logs', 'scheduled_jobs',
  'rate_limit_attempts', 'credential_rotation_tracking', 'global_messages',
  'products', 'scrape_runs', 'product_snapshots',
  'site_monitor_baselines', 'site_monitor_runs', 'site_monitor_changes',
]);

async function executeRun(client: { query(sql: string, params?: unknown[]): Promise<QueryResult> }, sql: string, params: unknown[]): Promise<RunResult> {
  const trimmed = sql.trimStart();
  const isInsert = /^INSERT\b/i.test(trimmed);

  let finalSql = sql;
  if (isInsert && !/RETURNING\b/i.test(trimmed)) {
    // Extract table name from INSERT INTO <table> and validate against whitelist.
    // Only whitelisted table names trigger the RETURNING id append — no user input
    // reaches this code path; all SQL strings are hardcoded in the codebase.
    const tableMatch = /^INSERT\s+INTO\s+["']?(\w+)["']?/i.exec(trimmed);
    const tableName = tableMatch?.[1]?.toLowerCase() ?? '';
    if (TABLES_WITH_SERIAL_ID.has(tableName)) {
      // Safe: tableName is validated against a static whitelist
      const stripped = sql.trimEnd().replace(/;$/, '');
      finalSql = `${stripped} RETURNING id`;
    }
  }

  const result = await client.query(finalSql, params); // CodeQL: sql is always from hardcoded internal callers, never user input

  if (isInsert) {
    const insertedId = result.rows[0]?.id ?? 0;
    return { changes: result.rowCount ?? 1, lastInsertRowid: insertedId };
  }

  return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
}

/**
 * DatabaseService wraps a pg.Pool with connection pooling, retry logic,
 * transaction support, schema management, and health checks.
 *
 * All methods are async. The singleton is obtained via `getInstance()`.
 */
export class DatabaseService {
  private readonly pool: Pool;
  private readonly config: DatabaseConfig;
  private closed = false;

  private constructor(pool: Pool, config: DatabaseConfig) {
    this.pool = pool;
    this.config = config;
  }

  /**
   * Get or create the singleton DatabaseService instance.
   * Resolves config from env vars if not provided.
   * Verifies connectivity by running SELECT 1.
   */
  public static async getInstance(overrides?: Partial<DatabaseConfig>): Promise<DatabaseService> {
    if (instance) {
      return instance;
    }

    const envConfig = resolveConfigFromEnv();
    const mergedConfig: DatabaseConfig = {
      ...DATABASE_DEFAULTS,
      maxRetries: 3,
      initialRetryDelayMs: 50,
      ...envConfig,
      ...overrides,
    };

    const poolConfig = buildPoolConfig(mergedConfig);

    logger.info('Creating PostgreSQL connection pool', {
      operation: 'getInstance',
      host: mergedConfig.connectionString ? '(connection string)' : mergedConfig.host,
      port: mergedConfig.connectionString ? undefined : mergedConfig.port,
      database: mergedConfig.connectionString ? undefined : mergedConfig.database,
      poolSize: mergedConfig.poolSize,
      ssl: mergedConfig.ssl ?? false,
    });

    const pool = new Pool(poolConfig);

    // Verify connectivity
    try {
      const result = await pool.query('SELECT 1 AS ok');
      if (result.rows[0]?.ok !== 1) {
        throw new Error('Connectivity check returned unexpected result');
      }
    } catch (err) {
      const error = err as Error;
      logger.error('Failed to connect to PostgreSQL', {
        operation: 'getInstance',
        error: error.message,
        host: mergedConfig.connectionString ? '(connection string)' : mergedConfig.host,
        port: mergedConfig.connectionString ? undefined : mergedConfig.port,
      });
      await pool.end().catch(() => { /* ignore cleanup errors */ });
      throw new Error(`Failed to connect to PostgreSQL: ${error.message}`);
    }

    instance = new DatabaseService(pool, mergedConfig);

    // Pre-warm pool connections in production to avoid cold-start latency
    if (config.isProduction) {
      await instance.warmPool();
    }

    return instance;
  }

  /**
   * Pre-warm the connection pool by opening connections up to half the max pool size.
   * Connections are acquired in parallel and immediately released back to the pool.
   */
  private async warmPool(): Promise<void> {
    const target = Math.min(Math.ceil((this.pool.options.max ?? 10) / 2), 3);
    logger.info('Warming connection pool', { operation: 'warmPool', target });

    const clients: import('pg').PoolClient[] = [];
    try {
      const acquirePromises = Array.from({ length: target }, () => this.pool.connect());
      const settled = await Promise.allSettled(acquirePromises);
      for (const result of settled) {
        if (result.status === 'fulfilled') clients.push(result.value);
      }
      logger.info('Connection pool warmed', { operation: 'warmPool', warmed: clients.length });
    } finally {
      for (const client of clients) client.release();
    }
  }

  /**
   * Get the underlying pg.Pool. Useful for advanced operations.
   */
  public getPool(): Pool {
    this.ensureOpen();
    return this.pool;
  }

  // --- Retry Logic ---

  /**
   * Execute an async function with retry logic for transient PostgreSQL errors.
   * Uses exponential backoff: 50ms, 100ms, 200ms by default.
   * Transient error codes: 08006, 08001, 40P01, 57P01, 40001
   */
  public async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.maxRetries ?? 3;
    const initialDelay = this.config.initialRetryDelayMs ?? 50;
    let lastError: Error | null = null;
    let delay = initialDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const error = err as Error & { code?: string };
        if (error.code && TRANSIENT_PG_ERROR_CODES.has(error.code)) {
          lastError = error;
          logger.warn('Transient PostgreSQL error, retrying', {
            operation: 'withRetry',
            errorCode: error.code,
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
          });

          if (attempt < maxRetries) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            delay *= 2;
          }
        } else {
          throw err;
        }
      }
    }

    logger.error('All transient error retries exhausted', {
      operation: 'withRetry',
      maxRetries,
    });
    throw lastError;
  }

  // --- Query Helpers ---

  /**
   * Run a statement that modifies data (INSERT, UPDATE, DELETE).
   * Returns { changes, lastInsertRowid } for API compatibility.
   * For INSERTs, automatically appends RETURNING id.
   */
  public async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    this.ensureOpen();
    return this.withRetry(() => executeRun(this.pool, sql, params));
  }

  /**
   * Get a single row from a SELECT query.
   * Note: sql parameter is always a hardcoded string from internal callers with $N placeholders.
   */
  public async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    this.ensureOpen();
    return this.withRetry(async () => {
      const result = await this.pool.query({ text: sql, values: params });
      return (result.rows[0] as T) ?? undefined;
    });
  }

  /**
   * Get all rows from a SELECT query.
   * Note: sql parameter is always a hardcoded string from internal callers with $N placeholders.
   */
  public async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.ensureOpen();
    return this.withRetry(async () => {
      const result = await this.pool.query({ text: sql, values: params });
      return result.rows as T[];
    });
  }

  // --- Transaction Support ---

  /**
   * Execute an async function inside a database transaction.
   * Checks out a PoolClient, runs BEGIN, executes the callback, then COMMIT.
   * On error, executes ROLLBACK and re-throws.
   * Always releases the client back to the pool.
   */
  public async transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const client = await this.pool.connect();

    const txClient: TransactionClient = {
      async run(sql: string, ...params: unknown[]): Promise<RunResult> {
        return executeRun(client, sql, params);
      },
      async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
        const result = await client.query(sql, params);
        return (result.rows[0] as T) ?? undefined;
      },
      async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
        const result = await client.query(sql, params);
        return result.rows as T[];
      },
      async query(sql: string, params?: unknown[]): Promise<QueryResult> {
        return client.query(sql, params);
      },
    };

    try {
      await client.query('BEGIN');
      const result = await fn(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* ignore rollback errors */ });
      throw err;
    } finally {
      client.release();
    }
  }

  // --- Health Check ---

  /**
   * Verify the database connection is alive and responsive.
   * Bounds the probe with a 5-second statement_timeout.
   *
   * The timeout is applied via `SET LOCAL` inside a transaction, NOT a bare
   * `SET statement_timeout` on a pooled connection. A bare `SET` mutates the
   * backend's session state and — because pooled connections are reused, not
   * torn down — leaks the reduced 5s cap to the next borrower, killing
   * legitimately-slow queries. `SET LOCAL` is scoped to the surrounding
   * transaction and auto-reverts at COMMIT/ROLLBACK, so the connection returns
   * to the pool with the configured statement_timeout intact.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      this.ensureOpen();
      return await this.transaction(async (tx) => {
        // SET LOCAL is transaction-scoped: reverts at COMMIT/ROLLBACK, so the
        // pooled connection is never returned with a reduced statement_timeout.
        // Literal is a hardcoded constant, never user input.
        await tx.query(`SET LOCAL statement_timeout = ${HEALTH_CHECK_TIMEOUT_MS}`);
        const result = await tx.query('SELECT 1 AS ok');
        return result.rows[0]?.ok === 1;
      });
    } catch (err) {
      logger.error('Database health check failed', {
        operation: 'healthCheck',
        error: (err as Error).message,
      });
      return false;
    }
  }

  // --- Schema Management ---

  /**
   * Initialize the complete database schema.
   * Creates all tables, indexes, and records the initial schema version when this is a
   * fresh database. For existing databases, runs pending migrations.
   * Delegates to database-migrations.ts.
   */
  public async initializeSchema(): Promise<void> {
    this.ensureOpen();
    return _initializeSchema(this);
  }

  /**
   * Get the current schema version.
   * Returns 0 if the schema_version table does not exist yet.
   * Delegates to database-migrations.ts.
   */
  public async getSchemaVersion(): Promise<number> {
    this.ensureOpen();
    return _getSchemaVersion(this);
  }

  // --- Lifecycle ---

  /**
   * Close the connection pool and drain all connections.
   */
  public async close(): Promise<void> {
    if (!this.closed) {
      await this.pool.end();
      this.closed = true;
      logger.info('Database connection pool closed', { operation: 'close' });
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Database connection is closed');
    }
  }
}
