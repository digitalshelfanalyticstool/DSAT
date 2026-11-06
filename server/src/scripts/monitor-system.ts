/**
 * System Monitoring Script — real-time metrics collection during load testing
 *
 * Collects:
 *   - BullMQ queue depth (waiting, active, completed, failed)
 *   - PostgreSQL connections and query performance
 *   - Redis memory, connections, ops/sec
 *   - Worker process health and throughput
 *   - System CPU, memory, disk I/O
 *   - Rate limiter token availability
 *
 * Usage:
 *   npx tsx server/src/scripts/monitor-system.ts
 *   npx tsx server/src/scripts/monitor-system.ts --interval 2 --duration 600 --output metrics.csv
 *
 * Flags:
 *   --interval <seconds>  Metrics collection interval (default: 5)
 *   --duration <seconds>  How long to monitor (default: 300 = 5min)
 *   --output <file>       Save metrics to CSV file (default: none)
 *   --watch              Live dashboard mode (clears screen each update)
 */

import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import { DatabaseService } from '../services/database';
import { getQueueService } from '../services/queue-service';
import { buildConfigFromEnv as buildRateLimitConfig } from '../services/rate-limiter';
import { knownRetailers } from '../services/retailers';
import { scrapeSlotSettingsKey } from '../services/rate-limit-keys';
import { getRedisClient, readWorkerHeartbeats } from '../services/redis-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('monitor');

interface MonitorConfig {
  intervalSeconds: number;
  durationSeconds: number;
  outputFile: string | null;
  watchMode: boolean;
}

interface SystemMetrics {
  timestamp: string;

  // BullMQ metrics
  queue_waiting: number;
  queue_active: number;
  queue_completed: number;
  queue_failed: number;
  queue_delayed: number;

  // PostgreSQL metrics
  pg_total_connections: number;
  pg_active_connections: number;
  pg_idle_connections: number;
  pg_query_latency_ms: number;
  pg_slow_queries: number;

  // Redis metrics
  redis_memory_mb: number;
  redis_connected_clients: number;
  redis_ops_per_sec: number;
  redis_keyspace_hits: number;
  redis_keyspace_misses: number;
  redis_hit_rate_percent: number;

  // Worker metrics
  active_workers: number;
  worker_concurrency: number;
  jobs_per_minute: number;

  // Rate limiter metrics
  /** Rate-limit tokens available, by site name. */
  rate_limit_available: Record<string, number>;

  // System metrics
  system_cpu_percent: number;
  system_memory_used_mb: number;
  system_memory_total_mb: number;
  system_memory_percent: number;
  system_load_avg_1min: number;
  system_load_avg_5min: number;
  system_load_avg_15min: number;

  // Process metrics
  process_cpu_percent: number;
  process_memory_mb: number;
  process_uptime_hours: number;
}

class SystemMonitor {
  private db: DatabaseService | null = null;
  private redis: ReturnType<typeof getRedisClient> | null = null;
  private queue: ReturnType<typeof getQueueService> | null = null;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = performance.now();
  private lastCompletedJobs = 0;
  private lastMetricTime = Date.now();

  async initialize() {
    this.db = await DatabaseService.getInstance();
    this.redis = getRedisClient();
    this.queue = getQueueService();
  }

  async collect(): Promise<SystemMetrics> {
    const metrics: SystemMetrics = {
      timestamp: new Date().toISOString(),
      queue_waiting: 0,
      queue_active: 0,
      queue_completed: 0,
      queue_failed: 0,
      queue_delayed: 0,
      pg_total_connections: 0,
      pg_active_connections: 0,
      pg_idle_connections: 0,
      pg_query_latency_ms: 0,
      pg_slow_queries: 0,
      redis_memory_mb: 0,
      redis_connected_clients: 0,
      redis_ops_per_sec: 0,
      redis_keyspace_hits: 0,
      redis_keyspace_misses: 0,
      redis_hit_rate_percent: 0,
      active_workers: 0,
      worker_concurrency: 0,
      jobs_per_minute: 0,
      rate_limit_available: {},
      system_cpu_percent: 0,
      system_memory_used_mb: 0,
      system_memory_total_mb: 0,
      system_memory_percent: 0,
      system_load_avg_1min: 0,
      system_load_avg_5min: 0,
      system_load_avg_15min: 0,
      process_cpu_percent: 0,
      process_memory_mb: 0,
      process_uptime_hours: 0,
    };

    await Promise.all([
      this.collectQueueMetrics(metrics),
      this.collectPostgreSQLMetrics(metrics),
      this.collectRedisMetrics(metrics),
      this.collectWorkerMetrics(metrics),
      this.collectRateLimitMetrics(metrics),
      this.collectSystemMetrics(metrics),
      this.collectProcessMetrics(metrics),
    ]);

    return metrics;
  }

  private async collectQueueMetrics(metrics: SystemMetrics) {
    try {
      const queueMetrics = await this.queue!.getQueueMetrics();
      metrics.queue_waiting = queueMetrics.waiting;
      metrics.queue_active = queueMetrics.active;
      metrics.queue_completed = queueMetrics.completed;
      metrics.queue_failed = queueMetrics.failed;
      metrics.queue_delayed = queueMetrics.delayed || 0;

      // Calculate jobs/minute throughput
      const now = Date.now();
      const elapsed = (now - this.lastMetricTime) / 1000 / 60; // minutes
      const newJobs = queueMetrics.completed - this.lastCompletedJobs;
      metrics.jobs_per_minute = elapsed > 0 ? newJobs / elapsed : 0;
      this.lastCompletedJobs = queueMetrics.completed;
      this.lastMetricTime = now;
    } catch (err) {
      logger.warn('Failed to collect queue metrics', { error: (err as Error).message });
    }
  }

  private async collectPostgreSQLMetrics(metrics: SystemMetrics) {
    try {
      // Connection counts by state
      const connStats = await this.db!.all<{ state: string; count: string }>(
        `SELECT state, COUNT(*) as count FROM pg_stat_activity
         WHERE datname = current_database()
         GROUP BY state`
      );

      for (const row of connStats) {
        const count = Number.parseInt(row.count, 10);
        if (row.state === 'active') metrics.pg_active_connections = count;
        if (row.state === 'idle') metrics.pg_idle_connections = count;
        metrics.pg_total_connections += count;
      }

      // Query latency test
      const queryStart = performance.now();
      await this.db!.get('SELECT 1');
      metrics.pg_query_latency_ms = performance.now() - queryStart;

      // Slow queries (> 100ms)
      const slowQueries = await this.db!.get<{ count: string }>(
        `SELECT COUNT(*) as count FROM pg_stat_activity
         WHERE datname = current_database()
         AND state = 'active'
         AND now() - query_start > interval '100 milliseconds'`
      );
      metrics.pg_slow_queries = slowQueries ? Number.parseInt(slowQueries.count, 10) : 0;
    } catch (err) {
      logger.warn('Failed to collect PostgreSQL metrics', { error: (err as Error).message });
    }
  }

  private async collectRedisMetrics(metrics: SystemMetrics) {
    try {
      const conn = this.redis!.getPublisherConnection();
      const [memInfo, clientInfo, statsInfo] = await Promise.all([
        conn.info('memory'),
        conn.info('clients'),
        conn.info('stats'),
      ]);

      // Memory usage
      const memMatch = /used_memory:(\d+)/.exec(memInfo);
      if (memMatch) {
        metrics.redis_memory_mb = Number.parseInt(memMatch[1], 10) / 1024 / 1024;
      }

      // Connected clients
      const clientMatch = /connected_clients:(\d+)/.exec(clientInfo);
      if (clientMatch) {
        metrics.redis_connected_clients = Number.parseInt(clientMatch[1], 10);
      }

      // Operations per second
      const opsMatch = /instantaneous_ops_per_sec:(\d+)/.exec(statsInfo);
      if (opsMatch) {
        metrics.redis_ops_per_sec = Number.parseInt(opsMatch[1], 10);
      }

      // Cache hit rate
      const hitsMatch = /keyspace_hits:(\d+)/.exec(statsInfo);
      const missesMatch = /keyspace_misses:(\d+)/.exec(statsInfo);
      if (hitsMatch && missesMatch) {
        metrics.redis_keyspace_hits = Number.parseInt(hitsMatch[1], 10);
        metrics.redis_keyspace_misses = Number.parseInt(missesMatch[1], 10);
        const total = metrics.redis_keyspace_hits + metrics.redis_keyspace_misses;
        metrics.redis_hit_rate_percent = total > 0
          ? (metrics.redis_keyspace_hits / total) * 100
          : 0;
      }
    } catch (err) {
      logger.warn('Failed to collect Redis metrics', { error: (err as Error).message });
    }
  }

  private async collectWorkerMetrics(metrics: SystemMetrics) {
    try {
      const workerConn = this.redis!.getPublisherConnection();
      const heartbeats = await readWorkerHeartbeats(workerConn);
      metrics.active_workers = heartbeats.length;
      metrics.worker_concurrency = heartbeats.reduce((sum, hb) => sum + hb.concurrency, 0);
    } catch (err) {
      logger.warn('Failed to collect worker metrics', { error: (err as Error).message });
    }
  }

  private async collectRateLimitMetrics(metrics: SystemMetrics) {
    try {
      const rlConfig = buildRateLimitConfig();
      const rlConn = this.redis!.getPublisherConnection();

      for (const retailer of await knownRetailers()) {
        const inUse = Number(await rlConn.hget(scrapeSlotSettingsKey(retailer), 'running')) || 0;
        const max = rlConfig.maxConcurrent[retailer] ?? rlConfig.defaultMaxConcurrent;
        metrics.rate_limit_available[retailer] = max - inUse;
      }
    } catch (err) {
      logger.warn('Failed to collect rate limit metrics', { error: (err as Error).message });
    }
  }

  private collectSystemMetrics(metrics: SystemMetrics) {
    try {
      // System memory
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      metrics.system_memory_total_mb = totalMem / 1024 / 1024;
      metrics.system_memory_used_mb = usedMem / 1024 / 1024;
      metrics.system_memory_percent = (usedMem / totalMem) * 100;

      // Load averages (Unix-like systems only)
      const loadAvg = os.loadavg();
      metrics.system_load_avg_1min = loadAvg[0];
      metrics.system_load_avg_5min = loadAvg[1];
      metrics.system_load_avg_15min = loadAvg[2];

      // CPU usage (approximation based on load average / CPU count)
      const cpuCount = os.cpus().length;
      metrics.system_cpu_percent = (loadAvg[0] / cpuCount) * 100;
    } catch (err) {
      logger.warn('Failed to collect system metrics', { error: (err as Error).message });
    }
  }

  private collectProcessMetrics(metrics: SystemMetrics) {
    try {
      // Process CPU usage
      const now = performance.now();
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      const elapsed = (now - this.lastCpuTime) * 1000; // microseconds
      metrics.process_cpu_percent = elapsed > 0 ? ((cpuUsage.user + cpuUsage.system) / elapsed) * 100 : 0;

      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTime = now;

      // Process memory
      const memUsage = process.memoryUsage();
      metrics.process_memory_mb = memUsage.heapUsed / 1024 / 1024;

      // Process uptime
      metrics.process_uptime_hours = process.uptime() / 3600;
    } catch (err) {
      logger.warn('Failed to collect process metrics', { error: (err as Error).message });
    }
  }
}

function formatMetricsForDisplay(metrics: SystemMetrics): string {
  const lines = [
    '',
    '═'.repeat(100),
    '                            SYSTEM METRICS — ' + new Date(metrics.timestamp).toLocaleTimeString(),
    '═'.repeat(100),
    '',
    '┌─ QUEUE (BullMQ) ─────────────────────────────────────────────────────────────────────────┐',
    `│  Waiting: ${metrics.queue_waiting.toString().padStart(6)}  │  Active: ${metrics.queue_active.toString().padStart(6)}  │  Completed: ${metrics.queue_completed.toString().padStart(8)}  │  Failed: ${metrics.queue_failed.toString().padStart(6)}  │`,
    `│  Throughput: ${metrics.jobs_per_minute.toFixed(2).padStart(6)} jobs/min                                        │`,
    '└──────────────────────────────────────────────────────────────────────────────────────────┘',
    '',
    '┌─ DATABASE (PostgreSQL) ──────────────────────────────────────────────────────────────────┐',
    `│  Connections: ${metrics.pg_active_connections.toString().padStart(3)} active / ${metrics.pg_idle_connections.toString().padStart(3)} idle / ${metrics.pg_total_connections.toString().padStart(3)} total                      │`,
    `│  Query Latency: ${metrics.pg_query_latency_ms.toFixed(2).padStart(6)} ms  │  Slow Queries (>100ms): ${metrics.pg_slow_queries.toString().padStart(3)}                │`,
    '└──────────────────────────────────────────────────────────────────────────────────────────┘',
    '',
    '┌─ REDIS ──────────────────────────────────────────────────────────────────────────────────┐',
    `│  Memory: ${metrics.redis_memory_mb.toFixed(1).padStart(8)} MB  │  Clients: ${metrics.redis_connected_clients.toString().padStart(4)}  │  Ops/sec: ${metrics.redis_ops_per_sec.toString().padStart(6)}            │`,
    `│  Cache Hit Rate: ${metrics.redis_hit_rate_percent.toFixed(1).padStart(5)}%  (${metrics.redis_keyspace_hits} hits / ${metrics.redis_keyspace_misses} misses)                         │`,
    '└──────────────────────────────────────────────────────────────────────────────────────────┘',
    '',
    '┌─ WORKERS & RATE LIMITS ──────────────────────────────────────────────────────────────────┐',
    `│  Active Workers: ${metrics.active_workers.toString().padStart(2)}  │  Total Concurrency: ${metrics.worker_concurrency.toString().padStart(3)}                              │`,
    `│  Rate Limit Tokens Available:                                                            │`,
    `│    ${Object.entries(metrics.rate_limit_available).map(([site, n]) => `${site}: ${n}`).join('  │  ') || 'no sites configured'}`,
    '└──────────────────────────────────────────────────────────────────────────────────────────┘',
    '',
    '┌─ SYSTEM (host) ──────────────────────────────────────────────────────────────────────────┐',
    `│  CPU: ${metrics.system_cpu_percent.toFixed(1).padStart(5)}%  │  Load Avg: ${metrics.system_load_avg_1min.toFixed(2).padStart(5)} / ${metrics.system_load_avg_5min.toFixed(2).padStart(5)} / ${metrics.system_load_avg_15min.toFixed(2).padStart(5)}  (1m/5m/15m)    │`,
    `│  Memory: ${metrics.system_memory_used_mb.toFixed(0).padStart(6)} / ${metrics.system_memory_total_mb.toFixed(0).padStart(6)} MB  (${metrics.system_memory_percent.toFixed(1).padStart(5)}% used)                         │`,
    `│  Process: ${metrics.process_cpu_percent.toFixed(1).padStart(5)}% CPU, ${metrics.process_memory_mb.toFixed(1).padStart(6)} MB heap, ${metrics.process_uptime_hours.toFixed(1).padStart(5)}h uptime        │`,
    '└──────────────────────────────────────────────────────────────────────────────────────────┘',
    '',
  ];

  // Add warnings
  const warnings: string[] = [];

  if (metrics.queue_waiting > 50) warnings.push('⚠️  HIGH QUEUE DEPTH — Workers may be overloaded');
  if (metrics.pg_total_connections > 80) warnings.push('⚠️  HIGH PG CONNECTIONS — Near max_connections limit');
  if (metrics.pg_query_latency_ms > 50) warnings.push('⚠️  SLOW DATABASE QUERIES — Check pg_stat_statements');
  if (metrics.pg_slow_queries > 5) warnings.push(`⚠️  ${metrics.pg_slow_queries} SLOW QUERIES DETECTED`);
  if (metrics.redis_memory_mb > 1000) warnings.push('⚠️  HIGH REDIS MEMORY — Consider Redis cluster');
  if (metrics.system_cpu_percent > 80) warnings.push('⚠️  HIGH CPU USAGE — Consider scaling horizontally');
  if (metrics.system_memory_percent > 85) warnings.push('⚠️  HIGH MEMORY USAGE — Risk of OOM');
  if (metrics.active_workers < 4) warnings.push(`⚠️  ONLY ${metrics.active_workers} WORKERS ACTIVE — Expected 4+`);
  for (const [site, n] of Object.entries(metrics.rate_limit_available)) {
    if (n <= 0) warnings.push(`⚠️  ${site.toUpperCase()} RATE LIMIT SATURATED`);
  }

  if (warnings.length > 0) {
    lines.push('⚠️  WARNINGS ⚠️');
    warnings.forEach(w => lines.push(w));
    lines.push('');
  }

  return lines.join('\n');
}

function metricsToCSV(metrics: SystemMetrics): string {
  return Object.values(metrics).map(v =>
    typeof v === 'number' ? v.toFixed(2) : `"${String(v)}"`
  ).join(',');
}

function getCSVHeader(): string {
  return Object.keys({
    timestamp: '',
    queue_waiting: 0,
    queue_active: 0,
    queue_completed: 0,
    queue_failed: 0,
    queue_delayed: 0,
    pg_total_connections: 0,
    pg_active_connections: 0,
    pg_idle_connections: 0,
    pg_query_latency_ms: 0,
    pg_slow_queries: 0,
    redis_memory_mb: 0,
    redis_connected_clients: 0,
    redis_ops_per_sec: 0,
    redis_keyspace_hits: 0,
    redis_keyspace_misses: 0,
    redis_hit_rate_percent: 0,
    active_workers: 0,
    worker_concurrency: 0,
    jobs_per_minute: 0,
    rate_limit_available: {},
    system_cpu_percent: 0,
    system_memory_used_mb: 0,
    system_memory_total_mb: 0,
    system_memory_percent: 0,
    system_load_avg_1min: 0,
    system_load_avg_5min: 0,
    system_load_avg_15min: 0,
    process_cpu_percent: 0,
    process_memory_mb: 0,
    process_uptime_hours: 0,
  }).join(',');
}

async function runMonitoring(config: MonitorConfig) {
  const monitor = new SystemMonitor();
  await monitor.initialize();

  logger.info('System monitoring started', { config });

  const startTime = Date.now();
  const endTime = startTime + config.durationSeconds * 1000;
  const metricsHistory: SystemMetrics[] = [];

  // Write CSV header if output file specified
  if (config.outputFile) {
    await fs.writeFile(config.outputFile, getCSVHeader() + '\n');
  }

  while (Date.now() < endTime) {
    const metrics = await monitor.collect();
    metricsHistory.push(metrics);

    // Clear screen in watch mode
    if (config.watchMode) {
      console.clear();
    }

    // Display metrics
    console.log(formatMetricsForDisplay(metrics));

    // Append to CSV
    if (config.outputFile) {
      await fs.appendFile(config.outputFile, metricsToCSV(metrics) + '\n');
    }

    // Wait for next interval
    await new Promise(resolve => setTimeout(resolve, config.intervalSeconds * 1000));
  }

  // Final summary
  console.log('\n' + '═'.repeat(100));
  console.log('MONITORING COMPLETE');
  console.log('═'.repeat(100));
  console.log(`Duration: ${config.durationSeconds}s`);
  console.log(`Samples collected: ${metricsHistory.length}`);
  if (config.outputFile) {
    console.log(`Data saved to: ${config.outputFile}`);
  }
  console.log('═'.repeat(100));
}

async function main() {
  const args = process.argv.slice(2);

  const config: MonitorConfig = {
    intervalSeconds: 5,
    durationSeconds: 300,
    outputFile: null,
    watchMode: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      config.intervalSeconds = Number.parseInt(args[i + 1], 10);
    }
    if (args[i] === '--duration' && args[i + 1]) {
      config.durationSeconds = Number.parseInt(args[i + 1], 10);
    }
    if (args[i] === '--output' && args[i + 1]) {
      config.outputFile = args[i + 1];
    }
    if (args[i] === '--watch') {
      config.watchMode = true;
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
System Monitoring Script for Product Scraper

Usage:
  npx tsx server/src/scripts/monitor-system.ts [options]

Options:
  --interval <seconds>  Metrics collection interval (default: 5)
  --duration <seconds>  How long to monitor (default: 300 = 5min)
  --output <file>       Save metrics to CSV file (default: none)
  --watch              Live dashboard mode (clears screen each update)
  --help, -h           Show this help message

Examples:
  # Monitor for 10 minutes, update every 2 seconds
  npx tsx server/src/scripts/monitor-system.ts --interval 2 --duration 600

  # Save to CSV for analysis
  npx tsx server/src/scripts/monitor-system.ts --output metrics.csv

  # Watch mode with live updates
  npx tsx server/src/scripts/monitor-system.ts --watch --interval 1 --duration 3600

Metrics Collected:
  - BullMQ queue depth and throughput
  - PostgreSQL connections and query latency
  - Redis memory, operations, cache hit rate
  - Worker process health and concurrency
  - Rate limiter token availability per retailer
  - System CPU, memory, load averages
  - Process-level resource usage
    `);
    process.exit(0);
  }

  try {
    await runMonitoring(config);
    process.exit(0);
  } catch (err) {
    logger.error('Monitoring failed', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  }
}

main();
