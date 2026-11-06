/**
 * Database migrations module.
 *
 * Contains initializeSchema, runMigrations, runSingleMigration, and getSchemaVersion
 * extracted from DatabaseService. Functions take a DatabaseService instance as their
 * first parameter so that DatabaseService.ts delegates to this module without
 * incurring a circular-dependency at runtime (DatabaseService is imported as a type only).
 */

import { PoolClient } from 'pg';
import { createLogger } from '../utils/logger';
import { assertSafePartitionDdl } from './partition-ddl-guard';
import { partitionDdl, weeklyPartition } from './partition-bounds';

// Import DatabaseService as TYPE only to avoid circular dependency at runtime.
// The actual instance is passed as a function parameter.
import type { DatabaseService } from './database';

const logger = createLogger('database-migrations');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the complete database schema.
 * Creates all tables, indexes, and records the initial schema version when
 * this is a fresh database. For existing databases, runs any pending migrations.
 *
 * NOTE: ensureOpen() is not called here — it is the responsibility of the
 * DatabaseService wrapper method that delegates to this function.
 */
export async function initializeSchema(db: DatabaseService): Promise<void> {
  // Check if schema already exists
  const existing = await db.get<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users'`
  );

  if (existing) {
    logger.info('Database schema already exists, checking for migrations', {
      operation: 'initializeSchema',
    });
    await runMigrations(db);
    return;
  }

  logger.info('Creating database schema', { operation: 'initializeSchema' });

  await db.transaction(async (client) => {
    // Schema version tracking
    await client.query(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);

    // Users table
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        is_active SMALLINT NOT NULL DEFAULT 1,
        last_login BIGINT,
        locked_until BIGINT,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0
      )
    `);

    await client.query('CREATE INDEX idx_users_username ON users(username)');
    await client.query('CREATE INDEX idx_users_email ON users(email)');
    await client.query('CREATE INDEX idx_users_role ON users(role)');
    await client.query('CREATE INDEX idx_users_is_active ON users(is_active)');

    // Refresh tokens table
    await client.query(`
      CREATE TABLE refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        token_prefix TEXT
      )
    `);

    await client.query('CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)');
    await client.query('CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id)');
    await client.query('CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at)');
    await client.query('CREATE INDEX idx_refresh_tokens_prefix ON refresh_tokens(token_prefix)');

    // Audit logs table
    await client.query(`
      CREATE TABLE audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at BIGINT NOT NULL
      )
    `);

    await client.query('CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id)');
    await client.query('CREATE INDEX idx_audit_logs_action ON audit_logs(action)');
    await client.query('CREATE INDEX idx_audit_logs_resource_type ON audit_logs(resource_type)');
    await client.query('CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at)');
    await client.query('CREATE INDEX idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC)');

    // App settings table
    await client.query(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Scheduled jobs table
    await client.query(`
      CREATE TABLE scheduled_jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        site TEXT NOT NULL,
        brand TEXT NOT NULL,
        schedule_time TEXT NOT NULL,
        schedule_days TEXT NOT NULL,
        enabled SMALLINT NOT NULL DEFAULT 1,
        last_run_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);

    await client.query('CREATE INDEX idx_scheduled_jobs_user_id ON scheduled_jobs(user_id)');
    await client.query('CREATE INDEX idx_scheduled_jobs_enabled ON scheduled_jobs(enabled)');

    // Rate limit attempts table
    await client.query(`
      CREATE TABLE rate_limit_attempts (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('ip', 'username')),
        attempted_at BIGINT NOT NULL
      )
    `);

    await client.query('CREATE INDEX idx_rate_limit_key_type ON rate_limit_attempts(key, type)');
    await client.query('CREATE INDEX idx_rate_limit_attempted_at ON rate_limit_attempts(attempted_at)');

    // Credential rotation tracking table
    await client.query(`
      CREATE TABLE credential_rotation_tracking (
        id SERIAL PRIMARY KEY,
        credential_key TEXT UNIQUE NOT NULL,
        last_rotated_at BIGINT NOT NULL,
        rotation_warning_days INTEGER NOT NULL DEFAULT 90
      )
    `);

    // Record schema version — all tables created at version 8
    await client.run(
      'INSERT INTO schema_version (version, applied_at) VALUES ($1, $2)',
      8,
      Math.floor(Date.now() / 1000)
    );

    logger.info('Database schema created successfully (version 8)', {
      operation: 'initializeSchema',
    });
  });

  // Run any migrations beyond the initial schema version (future-proofing)
  await runMigrations(db);
}

/**
 * Get the current schema version.
 * Returns 0 if the schema_version table doesn't exist.
 *
 * NOTE: ensureOpen() is not called here — it is the responsibility of the
 * DatabaseService wrapper method that delegates to this function.
 */
export async function getSchemaVersion(db: DatabaseService): Promise<number> {
  try {
    const row = await db.getPool().query(
      'SELECT MAX(version) AS version FROM schema_version'
    );
    return row.rows[0]?.version ?? 0;
  } catch {
    // schema_version table does not exist yet — return 0 for fresh databases
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Run pending database migrations for existing schemas.
 * Uses advisory lock to prevent concurrent migration runs.
 */
async function runMigrations(db: DatabaseService): Promise<void> {
  const pool = db.getPool();

  // Acquire advisory lock to prevent concurrent migrations
  await pool.query(`SELECT pg_advisory_lock(hashtext('scraper_migration'))`);

  try {
    const version = await getSchemaVersion(db);

    // Data-driven migration definitions — each entry is [version, description, callback].
    // Looping over an array instead of sequential if-blocks keeps cognitive complexity low.
    const migrations: Array<[number, string, (client: PoolClient) => Promise<void>]> = [
      [2, 'add locked_until column', async (client) => {
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'locked_until'`
        );
        if (col.rows.length === 0) {
          await client.query('ALTER TABLE users ADD COLUMN locked_until BIGINT');
        }
      }],
      [3, 'add app_settings table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at BIGINT NOT NULL,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
          )
        `);
      }],
      [4, 'add scheduled_jobs table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS scheduled_jobs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            brand TEXT NOT NULL,
            schedule_time TEXT NOT NULL,
            schedule_days TEXT NOT NULL,
            enabled SMALLINT NOT NULL DEFAULT 1,
            last_run_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user_id ON scheduled_jobs(user_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled ON scheduled_jobs(enabled)');
      }],
      [5, 'add token_prefix column to refresh_tokens', async (client) => {
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'token_prefix'`
        );
        if (col.rows.length === 0) {
          await client.query('ALTER TABLE refresh_tokens ADD COLUMN token_prefix TEXT');
          await client.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_prefix ON refresh_tokens(token_prefix)');
        }
      }],
      [6, 'add rate_limit_attempts table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS rate_limit_attempts (
            id SERIAL PRIMARY KEY,
            key TEXT NOT NULL,
            type TEXT NOT NULL CHECK (type IN ('ip', 'username')),
            attempted_at BIGINT NOT NULL
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_rate_limit_key_type ON rate_limit_attempts(key, type)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_rate_limit_attempted_at ON rate_limit_attempts(attempted_at)');
      }],
      [7, 'add credential_rotation_tracking table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS credential_rotation_tracking (
            id SERIAL PRIMARY KEY,
            credential_key TEXT UNIQUE NOT NULL,
            last_rotated_at BIGINT NOT NULL,
            rotation_warning_days INTEGER NOT NULL DEFAULT 90
          )
        `);
      }],
      [8, 'add composite index on audit_logs(user_id, created_at DESC)', async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC)');
      }],
      [9, 'add mcp_tokens table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS mcp_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at BIGINT NOT NULL,
            created_at BIGINT NOT NULL
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mcp_tokens_expires ON mcp_tokens(expires_at)');
      }],
      [10, 'add global_messages table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS global_messages (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            title TEXT,
            message TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'warning', 'error')),
            active SMALLINT NOT NULL DEFAULT 1,
            expires_at BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_global_messages_active ON global_messages(active)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_global_messages_expires ON global_messages(expires_at)');
      }],
      [11, 'add must_change_password column to users', async (client) => {
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'must_change_password'`
        );
        if (col.rows.length === 0) {
          await client.query('ALTER TABLE users ADD COLUMN must_change_password SMALLINT NOT NULL DEFAULT 0');
        }
      }],
      [12, 'create jobs table for persistent job storage', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS jobs (
            job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            brand TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            phase TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            products_discovered INTEGER NOT NULL DEFAULT 0,
            products_processed INTEGER NOT NULL DEFAULT 0,
            variants_extracted INTEGER NOT NULL DEFAULT 0,
            failed_products JSONB NOT NULL DEFAULT '[]',
            file_path TEXT,
            error_message TEXT,
            restart_count INTEGER NOT NULL DEFAULT 0,
            restart_parent_id UUID REFERENCES jobs(job_id) ON DELETE SET NULL,
            worker_id TEXT
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_site_brand ON jobs(site, brand)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_worker_id ON jobs(worker_id) WHERE worker_id IS NOT NULL');
      }],
      [13, 'create job_bandwidth table for bandwidth tracking', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS job_bandwidth (
            id SERIAL PRIMARY KEY,
            job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            bytes_downloaded BIGINT NOT NULL DEFAULT 0,
            bytes_uploaded BIGINT NOT NULL DEFAULT 0,
            request_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_job_bandwidth_job_id ON job_bandwidth(job_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_job_bandwidth_site ON job_bandwidth(site)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_job_bandwidth_created_at ON job_bandwidth(created_at)');
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_job_bandwidth_job_id_unique ON job_bandwidth(job_id)');
      }],
      [14, 'create products, scrape_runs, product_snapshots tables for scrape data persistence', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            retailer TEXT NOT NULL,
            style_id TEXT NOT NULL,
            title TEXT,
            description TEXT,
            url TEXT,
            source TEXT,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (retailer, style_id)
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_retailer_brand ON products(retailer)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS scrape_runs (
            id SERIAL PRIMARY KEY,
            job_id UUID NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            brand TEXT NOT NULL,
            variant_count INTEGER NOT NULL DEFAULT 0,
            products_upserted INTEGER NOT NULL DEFAULT 0,
            new_products INTEGER NOT NULL DEFAULT 0,
            price_changes_detected INTEGER NOT NULL DEFAULT 0,
            new_sellouts_detected INTEGER NOT NULL DEFAULT 0,
            scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_scrape_runs_job_id ON scrape_runs(job_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_scrape_runs_site_brand ON scrape_runs(site, brand)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS product_snapshots (
            id BIGSERIAL PRIMARY KEY,
            scrape_run_id INTEGER NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            sku TEXT NOT NULL DEFAULT '',
            upc TEXT DEFAULT '',
            color TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            list_price NUMERIC(10,2),
            selling_price NUMERIC(10,2),
            inventory TEXT DEFAULT '',
            item_number TEXT DEFAULT '',
            scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_scrape_run_id ON product_snapshots(scrape_run_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_product_id_scraped ON product_snapshots(product_id, scraped_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_scraped_at ON product_snapshots(scraped_at)');
      }],
      [15, 'site change monitor tables', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS site_monitor_baselines (
            id SERIAL PRIMARY KEY,
            retailer TEXT NOT NULL,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            html_hash TEXT NOT NULL,
            structural_fingerprint JSONB NOT NULL,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (retailer, product_id)
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_site_monitor_baselines_retailer ON site_monitor_baselines(retailer)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS site_monitor_runs (
            id SERIAL PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
            retailers_checked INTEGER NOT NULL DEFAULT 0,
            total_changes_detected INTEGER NOT NULL DEFAULT 0,
            critical_changes INTEGER NOT NULL DEFAULT 0,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_site_monitor_runs_started_at ON site_monitor_runs(started_at DESC)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS site_monitor_changes (
            id SERIAL PRIMARY KEY,
            run_id INTEGER NOT NULL REFERENCES site_monitor_runs(id) ON DELETE CASCADE,
            retailer TEXT NOT NULL,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            change_type TEXT NOT NULL,
            selector_or_field TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
            description TEXT NOT NULL,
            before_value TEXT,
            after_value TEXT,
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_site_monitor_changes_run_id ON site_monitor_changes(run_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_site_monitor_changes_retailer_severity ON site_monitor_changes(retailer, severity)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_site_monitor_changes_detected_at ON site_monitor_changes(detected_at DESC)');
      }],
      [16, 'Add retry policy columns to scheduled_jobs and schedule_id to jobs', async (client) => {
        await client.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS max_retries SMALLINT NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS retry_delay_minutes SMALLINT NOT NULL DEFAULT 15`);
        await client.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS current_retry_count SMALLINT NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS next_retry_at BIGINT`);
        await client.query(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS last_failure_reason TEXT`);
        await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES scheduled_jobs(id) ON DELETE SET NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_schedule_id ON jobs(schedule_id) WHERE schedule_id IS NOT NULL`);
      }],
      [17, 'add missing indexes on audit_logs and refresh_tokens', async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_action ON audit_logs(user_id, action)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, created_at)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)');
      }],
      [18, 'add phase_timings to jobs', async (client) => {
        await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS phase_timings JSONB DEFAULT NULL`);
      }],
      [19, 'add impersonation columns to refresh_tokens', async (client) => {
        await client.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS impersonator_id INTEGER`);
        await client.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS impersonator_username TEXT`);
      }],
      [20, 'add has_completed_onboarding to users', async (client) => {
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS has_completed_onboarding SMALLINT NOT NULL DEFAULT 0');
      }],
      [21, 'add composite indexes for change detection and snapshot lookups', async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_run_prod_color_size ON product_snapshots(scrape_run_id, product_id, color, size)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_prod_color_size_scraped ON product_snapshots(product_id, color, size, scraped_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_scrape_runs_site_brand_id ON scrape_runs(site, brand, id DESC)');
      }],
      [22, 'add failed_login_attempts to users for account lockout tracking', async (client) => {
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0');
      }],
      [23, 'add performance indexes for products and scrape_runs', async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_retailer_style_id ON products(retailer, style_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_last_seen_at ON products(last_seen_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_scrape_runs_site ON scrape_runs(site)');
      }],
      // Migration 24 handled separately below (requires post-transaction pg_trgm logic)
      [25, 'add composite indexes for jobs, audit_logs, scrape_runs, and product listings', async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_scrape_runs_site_brand_scraped ON scrape_runs(site, brand, scraped_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_retailer_last_seen ON products(retailer, last_seen_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_snapshots_run_color_scraped ON product_snapshots(scrape_run_id, color, scraped_at DESC)');
      }],
      [26, 'create health_snapshots table for admin health dashboard', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS health_snapshots (
            id SERIAL PRIMARY KEY,
            status TEXT NOT NULL,
            uptime INTEGER NOT NULL,
            pg_ok BOOLEAN NOT NULL,
            pg_pool_size INTEGER,
            pg_active_connections INTEGER,
            redis_ok BOOLEAN NOT NULL,
            redis_memory_mb REAL,
            redis_clients INTEGER,
            queue_waiting INTEGER,
            queue_active INTEGER,
            queue_stalled INTEGER,
            workers_active INTEGER,
            workers_expected INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_created ON health_snapshots(created_at)');
      }],
      [27, 'add partial index for active jobs and covering index for job stats', async (client) => {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_jobs_active
          ON jobs(status, created_at DESC)
          WHERE status IN ('running', 'queued')
        `);
      }],
      [28, 'add covering indexes for product detail and change detection queries', async (client) => {
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_snapshots_product_detail
          ON product_snapshots (product_id, scraped_at DESC)
          INCLUDE (scrape_run_id, sku, upc, color, size, list_price, selling_price, inventory, item_number)
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_snapshots_change_detect
          ON product_snapshots (scrape_run_id, product_id, color, size)
          INCLUDE (list_price, selling_price, inventory)
        `);
      }],
      [29, 'convert product_snapshots to range-partitioned table by scraped_at', async (client) => {
        // Check if already partitioned (idempotent)
        const isPartitioned = await client.query(
          `SELECT 1 FROM pg_partitioned_table pt
           JOIN pg_class c ON pt.partrelid = c.oid
           WHERE c.relname = 'product_snapshots'`
        );
        if (isPartitioned.rows.length > 0) return;

        // 1. Create partitioned replacement table
        await client.query(`
          CREATE TABLE product_snapshots_partitioned (
            id BIGSERIAL,
            scrape_run_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            sku TEXT NOT NULL DEFAULT '',
            upc TEXT DEFAULT '',
            color TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            list_price NUMERIC(10,2),
            selling_price NUMERIC(10,2),
            inventory TEXT DEFAULT '',
            item_number TEXT DEFAULT '',
            scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (id, scraped_at)
          ) PARTITION BY RANGE (scraped_at)
        `);

        // 2. Determine date range of existing data
        const range = await client.query(
          `SELECT MIN(scraped_at) AS min_at, MAX(scraped_at) AS max_at FROM product_snapshots`
        );
        const minDate = range.rows[0]?.min_at ? new Date(range.rows[0].min_at) : new Date();
        const maxDate = range.rows[0]?.max_at ? new Date(range.rows[0].max_at) : new Date();

        // 3. Create monthly partitions covering existing data + 3 months ahead
        const startMonth = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
        const endMonth = new Date(maxDate.getFullYear(), maxDate.getMonth() + 4, 1);

        for (let d = new Date(startMonth); d < endMonth; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
          const name = `product_snapshots_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
          const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
          const fromIso = d.toISOString().slice(0, 10);
          const toIso = next.toISOString().slice(0, 10);
          assertSafePartitionDdl(name, fromIso, toIso);
          await client.query(
            `CREATE TABLE ${name} PARTITION OF product_snapshots_partitioned
             FOR VALUES FROM ('${fromIso}') TO ('${toIso}')`
          );
        }

        // 4. Copy data
        await client.query(
          `INSERT INTO product_snapshots_partitioned (id, scrape_run_id, product_id, sku, upc, color, size, list_price, selling_price, inventory, item_number, scraped_at)
           SELECT id, scrape_run_id, product_id, sku, upc, color, size, list_price, selling_price, inventory, item_number, scraped_at
           FROM product_snapshots`
        );

        // 5. Swap tables
        await client.query('ALTER TABLE product_snapshots RENAME TO product_snapshots_old');
        await client.query('ALTER TABLE product_snapshots_partitioned RENAME TO product_snapshots');

        // 6. Reset sequence to match max id (setval minimum is 1; skip when table is empty).
        // NOTE: step 5 renamed product_snapshots_partitioned -> product_snapshots, and
        // Postgres renames an owned SERIAL sequence along with its table, so the live
        // sequence is now product_snapshots_id_seq — NOT product_snapshots_partitioned_id_seq.
        // Referencing the old name here errored on any populated pre-v29 upgrade.
        const maxId = await client.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM product_snapshots');
        const seqVal: number = maxId.rows[0].max_id;
        if (seqVal > 0) {
          await client.query(`SELECT setval('product_snapshots_id_seq', $1, true)`, [seqVal]);
        }

        // 7. Recreate indexes on the parent (Postgres propagates to partitions)
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_scrape_run_id ON product_snapshots(scrape_run_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_product_id_scraped ON product_snapshots(product_id, scraped_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_scraped_at ON product_snapshots(scraped_at)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_run_prod_color_size ON product_snapshots(scrape_run_id, product_id, color, size)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_snapshots_prod_color_size_scraped ON product_snapshots(product_id, color, size, scraped_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_snapshots_run_color_scraped ON product_snapshots(scrape_run_id, color, scraped_at DESC)');
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_snapshots_product_detail
          ON product_snapshots (product_id, scraped_at DESC)
          INCLUDE (scrape_run_id, sku, upc, color, size, list_price, selling_price, inventory, item_number)
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_snapshots_change_detect
          ON product_snapshots (scrape_run_id, product_id, color, size)
          INCLUDE (list_price, selling_price, inventory)
        `);

        // 8. Drop old table
        await client.query('DROP TABLE IF EXISTS product_snapshots_old CASCADE');
      }],
      [30, 'create materialized view for latest snapshot per product variant', async (client) => {
        await client.query(`
          CREATE MATERIALIZED VIEW IF NOT EXISTS mv_latest_snapshots AS
          SELECT DISTINCT ON (product_id, color, size)
            product_id, scrape_run_id, sku, upc, color, size,
            list_price, selling_price, inventory, item_number, scraped_at
          FROM product_snapshots
          ORDER BY product_id, color, size, scraped_at DESC
        `);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_latest_snap_pk
          ON mv_latest_snapshots(product_id, color, size)
        `);
      }],
      [31, 'tune autovacuum settings for high-write tables', async (client) => {
        // Note: product_snapshots is partitioned — storage params must be set
        // on individual partitions, not the parent. With monthly partitions each
        // partition is small enough that default autovacuum thresholds work well.
        // Only tune the non-partitioned products table.
        await client.query(`
          ALTER TABLE products SET (
            autovacuum_analyze_scale_factor = 0.05
          )
        `);
      }],
      [32, 'add pool idle and waiting columns to health_snapshots', async (client) => {
        await client.query('ALTER TABLE health_snapshots ADD COLUMN IF NOT EXISTS pg_pool_idle INTEGER');
        await client.query('ALTER TABLE health_snapshots ADD COLUMN IF NOT EXISTS pg_pool_waiting INTEGER');
      }],
      [33, 'record auto_explain check (advisory only)', async () => {
        // No-op migration — the auto_explain check runs after migrations
      }],
      [34, 'create tags and product_tags tables for user-applied product tagging', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS tags (
            id SERIAL PRIMARY KEY,
            name VARCHAR(64) NOT NULL,
            color VARCHAR(7),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
          )
        `);
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags(LOWER(name))');

        await client.query(`
          CREATE TABLE IF NOT EXISTS product_tags (
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            PRIMARY KEY (product_id, tag_id)
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_tags_product_id ON product_tags(product_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_product_tags_tag_id ON product_tags(tag_id)');
      }],
      [35, 'create web_vitals partitioned table for RUM ingestion (REQ-0)', async (client) => {
        // Idempotent: skip if the parent table is already partitioned.
        const isPartitioned = await client.query(
          `SELECT 1 FROM pg_partitioned_table pt
           JOIN pg_class c ON pt.partrelid = c.oid
           WHERE c.relname = 'web_vitals'`
        );
        if (isPartitioned.rows.length > 0) return;

        // Drop a non-partitioned predecessor if one exists from a prior
        // half-applied attempt — the table has no production data we care
        // about preserving since RUM ingestion only starts with this PR.
        await client.query('DROP TABLE IF EXISTS web_vitals CASCADE');

        // captured_at must be in the PRIMARY KEY since the table is
        // partitioned by RANGE on it (Postgres requires partition column
        // membership in any unique constraint, including PK).
        await client.query(`
          CREATE TABLE web_vitals (
            id BIGSERIAL,
            name TEXT NOT NULL,
            value NUMERIC NOT NULL,
            rating TEXT NOT NULL,
            metric_id TEXT NOT NULL,
            route TEXT NOT NULL,
            captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (id, captured_at)
          ) PARTITION BY RANGE (captured_at)
        `);

        // Create 12 weekly partitions starting at the current ISO week
        // (UTC Monday-aligned). product_snapshots only creates partitions
        // covering existing data + 3 months ahead and has no autocreate
        // job, so we provision a generous lead-time here too. Operators
        // can extend later via a follow-up migration before week 12 lapses.
        // Same weeks, names and UTC bounds as ensureWebVitalsPartitions().
        const now = new Date();
        for (let i = 0; i < 12; i++) {
          await client.query(partitionDdl('web_vitals', weeklyPartition('web_vitals', now, i)));
        }

        // Hot-path index for the admin chart "p75 INP per route over last
        // N days" query.
        await client.query(
          'CREATE INDEX IF NOT EXISTS idx_web_vitals_route_name ON web_vitals(route, name)'
        );
        // Time-range scans for any percentile/aggregate query window.
        await client.query(
          'CREATE INDEX IF NOT EXISTS idx_web_vitals_captured_at ON web_vitals(captured_at)'
        );
      }],
      [36, 'add scope column to mcp_tokens (audit H-2)', async (client) => {
        // Idempotent: only add the column if it does not yet exist. MCP tokens
        // historically granted full user-scope authority; the audit narrows
        // them to read/write/admin scopes with read as the safe default.
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'mcp_tokens' AND column_name = 'scope'`
        );
        if (col.rows.length === 0) {
          await client.query(
            `ALTER TABLE mcp_tokens
             ADD COLUMN scope TEXT NOT NULL DEFAULT 'read'
             CHECK (scope IN ('read', 'write', 'admin'))`
          );
        }
      }],
      [37, 'add failed_login_attempts column to users if missing (audit L-1)', async (client) => {
        // The fresh-schema baseline at version 8 already includes
        // failed_login_attempts, but databases initialised before that point
        // (or via a partial schema) may be missing it. Idempotent ALTER
        // ensures L-1's column-based counter has somewhere to live.
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'failed_login_attempts'`
        );
        if (col.rows.length === 0) {
          await client.query(
            'ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0'
          );
        }
      }],
      [38, 'add failure_category column to jobs', async (client) => {
        await client.query(`
          ALTER TABLE jobs
          ADD COLUMN IF NOT EXISTS failure_category TEXT
          CHECK (failure_category IS NULL OR failure_category IN
            ('bd_quota', 'network', 'db_error', 'retailer_changed', 'config', 'other'))
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_jobs_failure_category
          ON jobs(failure_category, completed_at DESC)
          WHERE status = 'failed' AND failure_category IS NOT NULL
        `);
      }],
      [39, 'add cache hit/miss metric columns to scrape_runs', async (client) => {
        // Per-job cache observability so operators can tune DISCOVERY_CACHE_TTL_HOURS
        // and VARIANT_CACHE_TTL_HOURS based on real hit rates instead of guessing.
        await client.query(`
          ALTER TABLE scrape_runs
          ADD COLUMN IF NOT EXISTS discovery_cache_hit BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS variant_cache_hits INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS variant_cache_misses INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_fill_hits INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS cache_fill_misses INTEGER NOT NULL DEFAULT 0
        `);
      }],
      [40, 'denormalize latest_snapshot_id onto products for the /products browse list', async (client) => {
        // The /products list query used to compute "latest snapshot per product"
        // with a DISTINCT ON over the whole partitioned product_snapshots table —
        // the planner can't satisfy that from an index (the id-DESC tie-break
        // isn't covered, and a partitioned table has no global index), so it did a
        // full scan + on-disk sort of every snapshot row, twice per request
        // (count + page). This pointer column turns that into a plain indexed
        // join. It's maintained transactionally by VariantPersistenceService on
        // each persist; this migration adds the column, backfills it, and indexes
        // it. (No FK: product_snapshots' PK is composite (id, scraped_at), so
        // there's no unique constraint on id alone to reference. A dangling
        // pointer after retention deletes the row is inert — the inner join in
        // the browse query just drops that product, same as the old behaviour.)
        await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS latest_snapshot_id BIGINT');
        // Backfill can sort the whole snapshots table on disk; lift the per-
        // statement timeout for the duration of this one statement so a large
        // history doesn't trip DATABASE_STATEMENT_TIMEOUT_MS.
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query(`
          UPDATE products p SET latest_snapshot_id = sub.id
          FROM (
            SELECT DISTINCT ON (product_id) id, product_id
            FROM product_snapshots
            ORDER BY product_id, scraped_at DESC, id DESC
          ) sub
          WHERE sub.product_id = p.id
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_latest_snapshot ON products(latest_snapshot_id)');
      }],
      [41, 'add image_url to product_snapshots and rebuild mv_latest_snapshots', async (client) => {
        // a) Add column to the partitioned base table (PG 11+ propagates to all partitions).
        await client.query('ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS image_url TEXT');

        // b) Rebuild mv_latest_snapshots with image_url in the projection.
        //    Dropping the MV automatically drops its indexes — we recreate them below.
        await client.query('DROP MATERIALIZED VIEW IF EXISTS mv_latest_snapshots');

        // Tie-break choice: ORDER BY ..., id DESC (was scraped_at DESC in migration 30).
        // BIGSERIAL ids are monotonic; scraped_at can collide within a single
        // scrape run, making the DISTINCT ON pick nondeterministic. id DESC
        // matches the pattern used by products.latest_snapshot_id.
        await client.query(`
          CREATE MATERIALIZED VIEW mv_latest_snapshots AS
            SELECT DISTINCT ON (product_id, color, size)
              id, scrape_run_id, product_id, sku, upc, color, size,
              list_price, selling_price, inventory, item_number,
              image_url,
              scraped_at
            FROM product_snapshots
            ORDER BY product_id, color, size, id DESC
        `);

        // c) Indexes: unique index required by REFRESH ... CONCURRENTLY, plus
        //    new filter-path indexes for color/size.
        await client.query(`
          CREATE UNIQUE INDEX idx_mv_latest_snapshots_pk
            ON mv_latest_snapshots (product_id, color, size)
        `);
        await client.query('CREATE INDEX idx_mv_latest_snapshots_color ON mv_latest_snapshots (color)');
        await client.query('CREATE INDEX idx_mv_latest_snapshots_size  ON mv_latest_snapshots (size)');

        // d) Initial population from existing snapshots (all image_url will be NULL).
        await client.query('REFRESH MATERIALIZED VIEW mv_latest_snapshots');
      }],
      [42, 'add email_settings, email_templates, email_log for admin-configurable email integration (#454)', async (client) => {
        // Singleton row holding provider choice + (optional) encrypted creds.
        // CHECK(id=1) enforces single-row at the DB layer; INSERT ON CONFLICT
        // DO NOTHING seeds the row idempotently. Provider 'disabled' is the
        // ship-safe default — feature does nothing until an admin enables it.
        // encrypted_credentials is JSONB so the provider-specific {iv,tag,ciphertext}
        // packing in services/secrets.ts can evolve without a schema change.
        // ACS + Managed Identity has no secret to encrypt, so this column stays NULL
        // for the production path.
        await client.query(`
          CREATE TABLE IF NOT EXISTS email_settings (
            id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            provider TEXT NOT NULL DEFAULT 'disabled'
              CHECK (provider IN ('disabled','acs','smtp')),
            from_address TEXT,
            from_name TEXT,
            acs_endpoint TEXT,
            -- Verified ACS sender domain (e.g. mail.example.com). Stored for
            -- display in the admin UI shipped in PR #2 — the send path reads
            -- from_address directly, so this column is write-only by design.
            acs_sender_domain TEXT,
            encrypted_credentials JSONB,
            is_enabled BOOLEAN NOT NULL DEFAULT false,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          INSERT INTO email_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
        `);

        // Admin-editable templates so copy changes don't require a deploy.
        // `variables` is a JSONB array of variable names the template expects;
        // template-renderer.ts uses it to reject unknown vars at "Send test" time
        // so typos fail loud before any user sees a broken email.
        await client.query(`
          CREATE TABLE IF NOT EXISTS email_templates (
            id BIGSERIAL PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            subject TEXT NOT NULL,
            body_html TEXT NOT NULL,
            body_text TEXT NOT NULL,
            variables JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        // Seed two templates so the system is useful the moment an admin enables it.
        // Slugs are stable identifiers callers use (`emailService.send('job-complete', ...)`).
        // Body intentionally minimal — admins customise via the UI shipped in PR #2.
        await client.query(`
          INSERT INTO email_templates (slug, subject, body_html, body_text, variables) VALUES
            (
              'job-complete',
              'Your scrape job {{jobId}} finished',
              '<p>Hi {{userName}},</p><p>Your {{retailer}} scrape job <strong>{{jobId}}</strong> finished with <strong>{{rowCount}}</strong> rows.</p><p><a href="{{resultUrl}}">View results</a></p>',
              E'Hi {{userName}},\\n\\nYour {{retailer}} scrape job {{jobId}} finished with {{rowCount}} rows.\\n\\nResults: {{resultUrl}}\\n',
              '["userName","jobId","retailer","rowCount","resultUrl"]'::jsonb
            ),
            (
              'daily-digest',
              'Daily digest: {{failedCount}} failed jobs in the last 24h',
              '<p>{{failedCount}} jobs failed in the last 24 hours.</p><p><a href="{{dashboardUrl}}">Open the dashboard</a></p>',
              E'{{failedCount}} jobs failed in the last 24 hours.\\n\\nDashboard: {{dashboardUrl}}\\n',
              '["failedCount","dashboardUrl"]'::jsonb
            )
          ON CONFLICT (slug) DO NOTHING
        `);

        // Per-send audit record. Slug is a free-text fingerprint, NOT a FK — templates
        // may be renamed or deleted but logs must survive that (compliance + support
        // tracing). Index sent_at DESC for the log-viewer query in PR #2 and partial
        // index on status='failed' for the "show only errors" filter and the
        // operational alerting query.
        await client.query(`
          CREATE TABLE IF NOT EXISTS email_log (
            id BIGSERIAL PRIMARY KEY,
            to_address TEXT NOT NULL,
            template_slug TEXT,
            subject TEXT,
            provider TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('sent','skipped','failed')),
            message_id TEXT,
            error TEXT,
            latency_ms INTEGER,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log (sent_at DESC)');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_email_log_failed ON email_log (sent_at DESC) WHERE status = 'failed'`);
      }],
      [43, 'create upc_styles UPC→style-code lookup table', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS upc_styles (
            upc        TEXT PRIMARY KEY,
            brand      TEXT NOT NULL,
            style_code TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      }],
      [44, 'add canonical_upc() for EAN-13/11-digit ↔ UPC-A matching', async (client) => {
        // Canonicalize a UPC to 12-digit UPC-A form so scraped barcodes match the
        // lookup file regardless of representation: digits-only, strip the leading 0 of
        // an EAN-13 ('0'+UPC-A), and zero-pad an 11-digit value. Used on both sides
        // of the upc_styles join and when the loader stores rows.
        await client.query(`
          CREATE OR REPLACE FUNCTION canonical_upc(raw text) RETURNS text
          LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $func$
            SELECT CASE
              WHEN d = '' THEN ''
              WHEN length(d) = 13 AND left(d, 1) = '0' THEN substr(d, 2)
              WHEN length(d) = 11 THEN lpad(d, 12, '0')
              ELSE d
            END
            FROM (SELECT regexp_replace(coalesce(raw, ''), '\\D', '', 'g') AS d) s
          $func$
        `);
      }],
      [45, 'add product_type column to products', async (client) => {
        // Populated at persist time by product-type-classifier; backfilled for
        // existing rows by scripts/backfill-product-types.ts. Nullable: rows
        // persisted before the backfill runs simply have no type yet.
        const col = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_type'`
        );
        if (col.rows.length === 0) {
          await client.query('ALTER TABLE products ADD COLUMN product_type TEXT');
        }
      }],
      [46, 'add nrf_color_code column to upc_styles', async (client) => {
        // Populated by the UPC-styles loader when the source export carries the
        // optional fifth NrfColorCode column. Nullable: rows loaded from the
        // legacy four-column file simply have no code.
        await client.query('ALTER TABLE upc_styles ADD COLUMN IF NOT EXISTS nrf_color_code TEXT');
      }],
      [47, 'create ats_uploads table for ATS report matching', async (client) => {
        // One row per uploaded ATS workbook. The original file is kept on disk
        // (stored_path) because the enriched download re-writes the original
        // bytes; parsed rows + the confirmed column mapping are stored as JSONB
        // so a match can run after an intervening scrape / API restart.
        // Rows and files are swept opportunistically after
        // config.atsMatch.uploadRetentionDays.
        await client.query(`
          CREATE TABLE IF NOT EXISTS ats_uploads (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id           TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_path       TEXT NOT NULL,
            sheet_names       JSONB NOT NULL,
            column_mapping    JSONB,
            rows              JSONB,
            site              TEXT,
            brand             TEXT,
            pending_job_id    UUID,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_ats_uploads_created ON ats_uploads (created_at)');
      }],
      [48, 'add durable job link to ats_uploads', async (client) => {
        // Unlike pending_job_id (transient "awaiting scrape", cleared when a
        // fresh run matches immediately), job_id is the durable link set at
        // job creation / run time and never cleared — it drives the ATS
        // download button on the job pages. No FK, matching pending_job_id:
        // a deleted job just means no button. Several uploads may point at
        // one reused job.
        await client.query('ALTER TABLE ats_uploads ADD COLUMN IF NOT EXISTS job_id UUID');
        await client.query('CREATE INDEX IF NOT EXISTS idx_ats_uploads_job_id ON ats_uploads (job_id)');
      }],
      [49, 'add browse/dashboard hot-path indexes on products.first_seen_at + mv_latest_snapshots (PERF-4)', async (client) => {
        // Index names and target relations below are fixed string literals authored
        // here (no interpolation of external input), so no partition-DDL guard is
        // needed. `products` is a regular table and `mv_latest_snapshots` is a
        // materialized view — neither is the partitioned `product_snapshots` base
        // table, so assertSafePartitionDdl() does not apply. IF NOT EXISTS keeps
        // this idempotent against boxes that already carry some of these indexes.
        // (No CONCURRENTLY — migrations run inside a transaction here.)

        // a) catalogGrowthQuery (routes/analytics.ts) filters + groups on
        //    products.first_seen_at on every /analytics/overview load — currently
        //    a full table scan of products.
        await client.query('CREATE INDEX IF NOT EXISTS idx_products_first_seen_at ON products (first_seen_at)');

        // b) browseProducts (services/product-query-service.ts) joins the browse
        //    grid on m.scrape_run_id and sorts by m.selling_price / m.scraped_at;
        //    every cache miss is a full-MV scan + sort. The MV previously carried
        //    only the (product_id,color,size) unique index plus color/size filter
        //    indexes.
        await client.query('CREATE INDEX IF NOT EXISTS idx_mv_latest_snapshots_scrape_run_id ON mv_latest_snapshots (scrape_run_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mv_latest_snapshots_selling_price ON mv_latest_snapshots (selling_price)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mv_latest_snapshots_scraped_at ON mv_latest_snapshots (scraped_at DESC)');
      }],
      [50, 'normalize legacy mixed-case usernames and enforce case-insensitive uniqueness', async (client) => {
        // Every write path lowercases usernames today (user-manager.ts,
        // user-bulk-ops.ts), but rows created before that normalization are
        // still stored mixed-case — prod carried EBoyle, AGrun and
        // testNewUser1. Those accounts could not log in at all: the lookup in
        // auth-service.login() compares a lowercased input against the stored
        // value, which never matches a mixed-case row.
        //
        // Order matters — normalize first, then add the unique index. If two
        // rows ever differed only by case the index creation fails loudly,
        // which is correct: silently merging two accounts would be worse.
        // All identifiers here are fixed literals authored in this file (no
        // interpolation), and `users` is not the partitioned product_snapshots
        // table, so assertSafePartitionDdl() does not apply.
        await client.query('UPDATE users SET username = LOWER(username) WHERE username <> LOWER(username)');

        // Backs the LOWER(username) = LOWER($1) predicate in login(),
        // recordFailedLogin() and checkAccountLockout() so it stays index-backed,
        // and makes case-insensitive uniqueness a database invariant rather than
        // an assumption held only by application code.
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))');
      }],

      [51, 'drop mcp_tokens, add users.entra_oid for Entra ID linkage', async (client) => {
        // MCP is being rebuilt from scratch; the old bearer-token table has no
        // forward path. Issued tokens are destroyed by design.
        await client.query('DROP TABLE IF EXISTS mcp_tokens');

        // Entra's `oid` claim is the stable per-tenant user id. Email is not:
        // a rename changes the UPN, so linking on email alone would orphan the
        // account. All identifiers here are fixed literals authored in this
        // file (no interpolation) and `users` is not a partitioned table, so
        // assertSafePartitionDdl() does not apply.
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS entra_oid TEXT');
        await client.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_oid ON users (entra_oid) WHERE entra_oid IS NOT NULL'
        );

        // Impersonation was removed in this same PR. refreshAccessToken() no longer
        // reads impersonator_id, so any surviving row would silently rotate into a
        // plain 7-day session for the TARGET user, with no banner, no exit control
        // and no audit attribution. Revoke them rather than let them convert.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = EXTRACT(EPOCH FROM now())::bigint
            WHERE impersonator_id IS NOT NULL AND revoked_at IS NULL`
        );
      }],

      [52, 'clear must_change_password now that Entra owns credentials', async (client) => {
        // Additive and idempotent. A forced password change is unsatisfiable once
        // sign-in goes through Entra: the user has no password they know, and
        // /change-password was removed. MainLayout redirected any flagged session
        // on EVERY authenticated page, so a flagged row is a hard trap.
        //
        // Deliberately does NOT drop the column. Rollback for this feature is a
        // git revert, and the reverted code still reads must_change_password from
        // user-cache.ts, types/auth.ts and the login response. Dropping it would
        // make the revert fail to start.
        await client.query('UPDATE users SET must_change_password = 0 WHERE must_change_password <> 0');
      }],

      [53, 'drop the ATS upload and UPC style-code tables', async (client) => {
        // ATS report matching and the UPC→style-code lookup were specific to one
        // brand's internal identifiers and have been removed from the codebase.
        // Fixed literals only, and none of these objects is partitioned, so
        // assertSafePartitionDdl() does not apply. canonical_upc() existed only
        // for the upc_styles join.
        await client.query('DROP TABLE IF EXISTS ats_uploads');
        await client.query('DROP TABLE IF EXISTS upc_styles');
        await client.query('DROP FUNCTION IF EXISTS canonical_upc(text)');
      }],
      [54, 'add scraping_provider_settings for the admin-chosen fetch provider', async (client) => {
        // Singleton row, same shape as email_settings (migration 42). No seed row:
        // until an admin saves a provider, scraping-provider-settings.ts falls back
        // to the BRIGHTDATA_* / SCRAPER_PROXY_URL environment variables.
        // encrypted_credentials holds the whole ProviderSettings object, encrypted
        // with services/secrets.ts.
        await client.query(`
          CREATE TABLE IF NOT EXISTS scraping_provider_settings (
            id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            provider TEXT NOT NULL CHECK (provider IN ('direct','brightdata','apify')),
            encrypted_credentials JSONB NOT NULL,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      }],
      [55, 'add sso_settings and users.sso_issuer/sso_subject for OIDC sign-in', async (client) => {
        // Singleton row like scraping_provider_settings. No seed row: no row means
        // SSO is off. Only the client secret is encrypted (services/secrets.ts).
        await client.query(`
          CREATE TABLE IF NOT EXISTS sso_settings (
            id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            enabled BOOLEAN NOT NULL DEFAULT false,
            issuer_url TEXT NOT NULL,
            client_id TEXT NOT NULL,
            encrypted_client_secret JSONB NOT NULL,
            allowed_email_domains TEXT[] NOT NULL DEFAULT '{}',
            button_label TEXT,
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        // (issuer, subject) is the stable identity an OIDC provider asserts; an
        // email is not (addresses get reassigned).
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_issuer TEXT');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_subject TEXT');
        await client.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity ON users (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL'
        );
      }],
      [56, 'drop users.entra_oid now that generic OIDC replaces Entra sign-in', async (client) => {
        // Entra's oid is not the OIDC subject the new flow matches on, so there is
        // nothing to carry over: those users link again by email or from their account page.
        await client.query('DROP INDEX IF EXISTS idx_users_entra_oid');
        await client.query('ALTER TABLE users DROP COLUMN IF EXISTS entra_oid');
      }],
      [57, 'remove the Azure Communication Services email provider', async (client) => {
        // An install still set to ACS falls back to disabled; the admin picks SMTP if they want email.
        await client.query(`UPDATE email_settings SET provider = 'disabled', is_enabled = false WHERE provider = 'acs'`);
        await client.query('ALTER TABLE email_settings DROP CONSTRAINT IF EXISTS email_settings_provider_check');
        await client.query(`ALTER TABLE email_settings ADD CONSTRAINT email_settings_provider_check CHECK (provider IN ('disabled','smtp'))`);
        await client.query('ALTER TABLE email_settings DROP COLUMN IF EXISTS acs_endpoint');
        await client.query('ALTER TABLE email_settings DROP COLUMN IF EXISTS acs_sender_domain');
      }],
      [58, 'alerts: rules, alerts, per-(rule, product) state, webhooks, image checks', async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS alert_rules (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            kind TEXT NOT NULL CHECK (kind IN ('price_below', 'price_drop', 'out_of_stock', 'broken_image')),
            target_type TEXT NOT NULL CHECK (target_type IN ('all', 'brand', 'site', 'product')),
            target_site TEXT,
            target_brand TEXT,
            target_style_id TEXT,
            threshold NUMERIC(10,2),
            percent NUMERIC(5,2),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS alerts (
            id BIGSERIAL PRIMARY KEY,
            rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
            rule_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            retailer TEXT NOT NULL,
            brand TEXT NOT NULL,
            scrape_run_id INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
            details JSONB NOT NULL DEFAULT '{}',
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts (created_at DESC) WHERE read_at IS NULL');
        // in_condition is what makes alerts fire on a transition rather than on every run.
        await client.query(`
          CREATE TABLE IF NOT EXISTS alert_state (
            rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            in_condition BOOLEAN NOT NULL,
            last_scrape_run_id INTEGER,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (rule_id, product_id)
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS alert_webhooks (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            secret_encrypted JSONB,
            enabled BOOLEAN NOT NULL DEFAULT true,
            last_status INTEGER,
            last_error TEXT,
            last_attempt_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE TABLE IF NOT EXISTS image_checks (
            url TEXT PRIMARY KEY,
            ok BOOLEAN NOT NULL,
            reason TEXT,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      }],
      [59, 'inventory_in_stock(): the one stock rule (mirrors services/inventory.ts)', async (client) => {
        await client.query(`
          CREATE OR REPLACE FUNCTION inventory_in_stock(inv TEXT) RETURNS BOOLEAN
          LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $fn$
            SELECT CASE
              WHEN COALESCE(btrim(inv), '') = '' THEN NULL
              WHEN btrim(inv) = 'In Stock' THEN TRUE
              WHEN btrim(inv) ~ '^-?[0-9]+$' THEN btrim(inv)::NUMERIC > 0
              ELSE FALSE
            END
          $fn$
        `);
      }],
      [60, 'products.retailer holds the site name, not an older display name', async (client) => {
        // Adapters write retailer = site name ('shop-a'); rows from older
        // releases may hold a display name ('Shop A'), which queries used to
        // match with regexp_replace on both sides. Rename each such row to the
        // one site name (from runs and jobs) it normalizes to. Left alone: names
        // matching no site or several, and rows whose (site, style_id) already
        // exists (renaming would collide; the site-name row is the live one).
        // Of two spellings of the same style, the most recently seen is renamed.
        await client.query(`
          WITH sites AS (
            SELECT site FROM scrape_runs UNION SELECT site FROM jobs
          ), keyed AS (
            SELECT lower(regexp_replace(site, '[^a-zA-Z0-9]', '', 'g')) AS k, min(site) AS site
            FROM sites GROUP BY 1 HAVING count(*) = 1
          ), renames AS (
            SELECT DISTINCT ON (keyed.site, p.style_id) p.id, keyed.site
            FROM products p
            JOIN keyed ON keyed.k = lower(regexp_replace(p.retailer, '[^a-zA-Z0-9]', '', 'g'))
            WHERE p.retailer <> keyed.site
              AND NOT EXISTS (SELECT 1 FROM products q WHERE q.retailer = keyed.site AND q.style_id = p.style_id)
            ORDER BY keyed.site, p.style_id, p.last_seen_at DESC NULLS LAST, p.id DESC
          )
          UPDATE products p SET retailer = renames.site FROM renames WHERE p.id = renames.id
        `);
      }],
    ];

    // Run standard migrations
    for (const [migVersion, description, fn] of migrations) {
      if (version < migVersion) {
        await runSingleMigration(db, migVersion, description, fn);
      }
    }

    // Migration 24: pg_trgm extension — requires post-transaction logic
    if (version < 24) {
      await runSingleMigration(db, 24, 'add trigram index on products.title for ILIKE search (optional)', async () => {
        // no-op inside transaction — extension must be created outside
      });
      try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_products_title_trgm ON products USING GIN (title gin_trgm_ops)');
        logger.info('pg_trgm extension and trigram index created', { operation: 'migration' });
      } catch (err) {
        logger.warn('pg_trgm extension not available, skipping trigram index — ILIKE search will work without it', {
          operation: 'migration',
          error: (err as Error).message,
        });
      }
    }

    // Advisory: check for auto_explain (not a migration, just a warning)
    try {
      const autoExplain = await pool.query(
        `SELECT 1 FROM pg_settings WHERE name = 'auto_explain.log_min_duration'`
      );
      if (autoExplain.rows.length === 0) {
        logger.warn('auto_explain is not loaded — slow queries will not be logged. See docs/postgres-tuning.md', {
          operation: 'migration',
        });
      }
    } catch {
      // Ignore — not all setups support this query
    }

  } finally {
    // Release advisory lock
    await pool.query(`SELECT pg_advisory_unlock(hashtext('scraper_migration'))`).catch(() => {
      /* ignore unlock errors */
    });
  }
}

/**
 * Run a single migration wrapped in a transaction.
 * If the migration callback throws, the transaction is rolled back
 * and the schema version remains unchanged.
 */
async function runSingleMigration(
  db: DatabaseService,
  targetVersion: number,
  description: string,
  migrationFn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  logger.info(`Running migration to version ${targetVersion}: ${description}`, {
    operation: 'migration',
  });

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await migrationFn(client);
    await client.query(
      `INSERT INTO schema_version (version, applied_at) VALUES ($1, $2)
       ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at`,
      [targetVersion, Math.floor(Date.now() / 1000)]
    );
    await client.query('COMMIT');
    logger.info(`Migration to version ${targetVersion} complete`, { operation: 'migration' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* ignore rollback errors */ });
    logger.error(`Migration to version ${targetVersion} failed, rolled back`, {
      operation: 'migration',
      error: (err as Error).message,
    });
    throw err;
  } finally {
    client.release();
  }
}
