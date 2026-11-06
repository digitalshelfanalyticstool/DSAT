// Loads .env and initializes Sentry; must come before any module that loads http/express.
import './instrument';

import fs from 'node:fs';

import type { Server } from 'node:http';
import { createApp } from './app';
import { needsSetup } from './services/first-run-setup';
import { issueSetupCode } from './services/setup-code';
import { DatabaseService } from './services/database';
import { reactivateExpiredLockouts, checkLegacyBcryptHashes } from './services/auth-service';
import { startBackgroundTasks } from './services/background-tasks';
import { getQueueService } from './services/queue-service';
import { ALL_QUEUES } from './services/queues';
import { getProgressBus } from './services/progress-bus';
import { createLogger } from './utils/logger';
import { config, validateConfigOrExit } from './config';
import { startObservabilitySampler, stopObservabilitySampler } from './services/observability-sampler';
import { useProviderStore } from './services/scraping-provider-settings';

const PROCESS_ROLE = config.worker.processRole;

// Validate environment variables before anything else touches them.
validateConfigOrExit(PROCESS_ROLE === 'worker' ? 'worker' : 'api');

const logger = createLogger('server');
const PORT = config.server.port;

/** Reference to the HTTP server for graceful shutdown. */
let server: Server | null = null;

/** Whether a shutdown is already in progress. */
let isShuttingDown = false;

/** Stops the background tasks; set once they start. */
let stopBackgroundTasks: (() => void) | null = null;

/**
 * Ensure required data and storage directories exist.
 */
async function initDirectories(): Promise<void> {
  const dirs = [
    config.scraping.dataDir,
    config.scraping.storageDir,
  ];

  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

/**
 * Initialize the database and seed default data on first startup.
 */
async function seedData(): Promise<void> {
  const db = await DatabaseService.getInstance();
  await db.initializeSchema();
  useProviderStore(db);

  if (await needsSetup(db)) {
    const code = issueSetupCode();
    logger.warn(`No users yet. Open /setup and enter this one-time setup code: ${code}`, { operation: 'firstRunSetup' });
  }
}

/**
 * Graceful shutdown handler.
 *
 * 1. Stops accepting new connections
 * 2. Stops the scheduler
 * 3. Shuts down queue service and Redis connections
 * 4. Exits cleanly
 *
 * Note: Job processing and SSE are handled by worker processes (worker.ts),
 * not the API server. The API process is a BullMQ producer only.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, starting graceful shutdown`, {
    operation: 'shutdown',
    signal,
  });

  // 1. Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed — no longer accepting connections', {
        operation: 'shutdown',
      });
    });
  }

  // 2. Stop background tasks and the metrics sampler
  stopBackgroundTasks?.();
  stopObservabilitySampler();

  // 3. Shut down queue service and Redis connections
  try {
    const queueService = getQueueService();
    await queueService.shutdown();
    await getProgressBus().shutdown();
  } catch {
    // Queue service may not have been initialized (e.g. no Redis)
  }

  try {
    const { getRedisClient } = await import('./services/redis-client');
    const redis = getRedisClient();
    await redis.shutdown();
  } catch {
    // Redis may not have been initialized
  }

  logger.info('Graceful shutdown complete', { operation: 'shutdown' });
  process.exit(0);
}

async function main(): Promise<void> {
  try {
    // If PROCESS_ROLE is 'worker', delegate to the standalone worker entry point
    if (PROCESS_ROLE === 'worker') {
      logger.info('Starting in worker mode', { operation: 'startup', role: PROCESS_ROLE });
      const { start: startWorker } = await import('./worker');
      await startWorker();
      return;
    }

    // --- API server mode (default) ---
    logger.info('Starting in API server mode', { operation: 'startup', role: PROCESS_ROLE });

    await initDirectories();
    await seedData();

    // Reactivate any accounts whose lockout expired during downtime
    await reactivateExpiredLockouts(await DatabaseService.getInstance());

    // Scan for legacy bcrypt cost-factors and log a single
    // warning at startup so operators can track rotation progress.
    // Non-blocking — failure does not abort startup.
    await checkLegacyBcryptHashes(await DatabaseService.getInstance()).catch((err: Error) => {
      logger.warn('checkLegacyBcryptHashes failed (non-fatal)', {
        operation: 'startup',
        error: err.message,
      });
    });

    const app = createApp();

    server = app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`, {
        operation: 'startup',
        port: PORT,
        role: PROCESS_ROLE,
      });
    });

    // Schedules, site monitor, health snapshots, token cleanup, email digest,
    // report cleanup and DB retention.
    stopBackgroundTasks = startBackgroundTasks();

    // Periodically sample BullMQ queue depth + pg pool counts into Prometheus.
    const queueService = getQueueService();
    startObservabilitySampler(ALL_QUEUES.map((name) => ({ name, queue: queueService.queue(name) })));

    // Register graceful shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (err) {
    logger.error('Failed to start server', {
      operation: 'startup',
      error: (err as Error).message,
    });
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    operation: 'unhandledRejection',
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', {
    operation: 'uncaughtException',
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

main();
