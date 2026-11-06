/**
 * Health Monitor — aggregates health signals from PostgreSQL, Redis, BullMQ,
 * and worker heartbeats into a single HealthReport.
 *
 * Exposed via the /api/health endpoint. Status logic:
 * - "unhealthy" if PostgreSQL or Redis is unreachable
 * - "degraded" if queue depth > 100 or any expected worker is missing
 * - "healthy" otherwise
 */

import { DatabaseService } from './database';
import { getRedisClient, readWorkerHeartbeats } from './redis-client';
import { getQueueService } from './queue-service';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const logger = createLogger('health-monitor');

/** Queue depth threshold above which status degrades. */

// --- Public Types ---

interface PostgresHealthCheck {
  ok: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
}

interface RedisHealthCheck {
  ok: boolean;
  memoryUsageMb: number;
  connectedClients: number;
}

interface QueueHealthCheck {
  ok: boolean;
  waiting: number;
  active: number;
  stalled: number;
}

interface WorkerHealthCheck {
  ok: boolean;
  activeWorkers: number;
  expectedWorkers: number;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  checks: {
    postgresql: PostgresHealthCheck;
    redis: RedisHealthCheck;
    queue: QueueHealthCheck;
    workers: WorkerHealthCheck;
  };
}

// --- Health Check Implementations ---

/**
 * Check PostgreSQL connectivity and pool stats.
 */
async function checkPostgres(): Promise<PostgresHealthCheck> {
  try {
    const db = await DatabaseService.getInstance();
    const pool = db.getPool();
    const isAlive = await db.healthCheck();

    return {
      ok: isAlive,
      poolSize: pool.totalCount,
      activeConnections: pool.totalCount - pool.idleCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
    };
  } catch (err) {
    logger.error('PostgreSQL health check failed', {
      operation: 'checkPostgres',
      error: (err as Error).message,
    });
    return { ok: false, poolSize: 0, activeConnections: 0, idleConnections: 0, waitingRequests: 0 };
  }
}

/**
 * Check Redis connectivity, memory usage, and connected client count.
 * Uses the INFO command on the queue connection to gather stats.
 */
async function checkRedis(): Promise<RedisHealthCheck> {
  try {
    const redis = getRedisClient();
    const isAlive = await redis.healthCheck();

    if (!isAlive) {
      return { ok: false, memoryUsageMb: 0, connectedClients: 0 };
    }

    // Parse INFO output for memory and client stats
    const conn = redis.getQueueConnection();
    const info = await conn.info('memory');
    const clientInfo = await conn.info('clients');

    const memoryMatch = /used_memory:(\d+)/m.exec(info);
    const memoryBytes = memoryMatch ? Number.parseInt(memoryMatch[1], 10) : 0;
    const memoryUsageMb = Math.round((memoryBytes / (1024 * 1024)) * 100) / 100;

    const clientsMatch = /connected_clients:(\d+)/m.exec(clientInfo);
    const connectedClients = clientsMatch ? Number.parseInt(clientsMatch[1], 10) : 0;

    return { ok: true, memoryUsageMb, connectedClients };
  } catch (err) {
    logger.error('Redis health check failed', {
      operation: 'checkRedis',
      error: (err as Error).message,
    });
    return { ok: false, memoryUsageMb: 0, connectedClients: 0 };
  }
}

/**
 * Check BullMQ queue depth: waiting, active, and stalled job counts.
 */
async function checkQueue(): Promise<QueueHealthCheck> {
  try {
    const queueService = getQueueService();
    const metrics = await queueService.getQueueMetrics();

    return {
      ok: true,
      waiting: metrics.waiting,
      active: metrics.active,
      stalled: metrics.stalled,
    };
  } catch (err) {
    logger.error('Queue health check failed', {
      operation: 'checkQueue',
      error: (err as Error).message,
    });
    return { ok: false, waiting: 0, active: 0, stalled: 0 };
  }
}

/**
 * Count active workers by scanning Redis heartbeat keys.
 * Workers write one with a TTL (worker-heartbeat.ts); an existing one is alive.
 */
async function checkWorkers(): Promise<WorkerHealthCheck> {
  try {
    const redis = getRedisClient();
    const conn = redis.getQueueConnection();

    const activeWorkerCount = (await readWorkerHeartbeats(conn)).length;
    return {
      ok: activeWorkerCount >= config.worker.expectedWorkers,
      activeWorkers: activeWorkerCount,
      expectedWorkers: config.worker.expectedWorkers,
    };
  } catch (err) {
    logger.error('Worker health check failed', {
      operation: 'checkWorkers',
      error: (err as Error).message,
    });
    return { ok: false, activeWorkers: 0, expectedWorkers: config.worker.expectedWorkers };
  }
}

// --- HealthMonitor Class ---

export class HealthMonitor {
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Run all health checks in parallel and return an aggregate HealthReport.
   */
  async check(): Promise<HealthReport> {
    const [postgresql, redis, queue, workers] = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkQueue(),
      checkWorkers(),
    ]);

    // Determine overall status
    let status: HealthReport['status'] = 'healthy';

    // Unhealthy: core infrastructure down
    if (!postgresql.ok || !redis.ok) {
      status = 'unhealthy';
    }
    // Degraded: queue backlog or missing workers
    else if (queue.waiting > config.observability.queueDepthDegradedThreshold || !workers.ok) {
      status = 'degraded';
    }

    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status,
      uptime,
      checks: { postgresql, redis, queue, workers },
    };
  }
}

// --- Snapshot Persistence ---

/**
 * Record the current health report as a snapshot in the database.
 * Called on a 5-minute interval by the scheduler.
 */
async function recordHealthSnapshot(): Promise<void> {
  try {
    const monitor = getHealthMonitor();
    const report = await monitor.check();
    const db = await DatabaseService.getInstance();
    const { postgresql, redis, queue, workers } = report.checks;

    await db.run(
      `INSERT INTO health_snapshots
        (status, uptime, pg_ok, pg_pool_size, pg_active_connections,
         pg_pool_idle, pg_pool_waiting,
         redis_ok, redis_memory_mb, redis_clients,
         queue_waiting, queue_active, queue_stalled,
         workers_active, workers_expected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      report.status,
      report.uptime,
      postgresql.ok,
      postgresql.poolSize,
      postgresql.activeConnections,
      postgresql.idleConnections,
      postgresql.waitingRequests,
      redis.ok,
      redis.memoryUsageMb,
      redis.connectedClients,
      queue.waiting,
      queue.active,
      queue.stalled,
      workers.activeWorkers,
      workers.expectedWorkers,
    );
  } catch (err) {
    logger.error('Failed to record health snapshot', {
      operation: 'recordHealthSnapshot',
      error: (err as Error).message,
    });
  }
}

/**
 * Delete health snapshots older than the retention period.
 */
async function pruneHealthSnapshots(): Promise<number> {
  try {
    const db = await DatabaseService.getInstance();
    const retentionDays = config.scraping.snapshotRetentionDays;
    const result = await db.run(
      `DELETE FROM health_snapshots WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      retentionDays,
    );
    const deleted = result.changes;
    if (deleted > 0) {
      logger.info(`Pruned ${deleted} health snapshots`, { operation: 'pruneHealthSnapshots' });
    }
    return deleted;
  } catch (err) {
    logger.error('Failed to prune health snapshots', {
      operation: 'pruneHealthSnapshots',
      error: (err as Error).message,
    });
    return 0;
  }
}

/** Record a health snapshot and prune old ones. Run every 5 minutes by background-tasks.ts. */
export async function recordAndPruneHealthSnapshots(): Promise<void> {
  await recordHealthSnapshot();
  await pruneHealthSnapshots();
}

// --- Singleton export ---

let instance: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  instance ??= new HealthMonitor();
  return instance;
}
