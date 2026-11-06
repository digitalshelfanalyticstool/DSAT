/**
 * Periodically samples runtime state into the Prometheus registry:
 *   - BullMQ queue depths (waiting / active / delayed / failed / completed / paused)
 *   - this process's pg.Pool connection counts (total / idle / waiting)
 *
 * These are gauges — cheap to read, safe to miss a tick. The sampler runs in
 * the API process (the one that exposes /api/metrics/prometheus). Worker
 * processes have no scrape endpoint yet, so their pools / phase counters are
 * out of scope here.
 */

import type { Queue } from 'bullmq';
import { config } from '../config';
import { bullmqJobs, pgPoolConnections } from './prom-metrics';
import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';

const logger = createLogger('observability-sampler');

/** BullMQ job states we surface as gauge series. */
const TRACKED_QUEUE_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
] as const;

export interface NamedQueue {
  name: string;
  queue: Queue;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Take one sample. Production callers go through
 * {@link startObservabilitySampler}. Never throws — a Redis blip or an
 * uninitialized pool downgrades to a warning and an unchanged gauge.
 */
export async function sampleObservabilityMetrics(queues: NamedQueue[]): Promise<void> {
  for (const { name, queue } of queues) {
    try {
      const counts = await queue.getJobCounts(...TRACKED_QUEUE_STATES);
      for (const state of TRACKED_QUEUE_STATES) {
        bullmqJobs.set({ queue: name, state }, Number(counts[state] ?? 0));
      }
    } catch (err) {
      logger.warn('Failed to sample BullMQ queue depth', {
        operation: 'sampleObservabilityMetrics',
        queue: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const pool = (await DatabaseService.getInstance()).getPool();
    pgPoolConnections.set({ state: 'total' }, pool.totalCount);
    pgPoolConnections.set({ state: 'idle' }, pool.idleCount);
    pgPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
  } catch (err) {
    logger.warn('Failed to sample pg pool counts', {
      operation: 'sampleObservabilityMetrics',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the periodic sampler. Idempotent; no-op under NODE_ENV=test so unit
 * suites don't leak a background timer. The timer is unref'd so it never
 * keeps the process alive on its own.
 */
export function startObservabilitySampler(queues: NamedQueue[]): void {
  if (timer || config.isTest) return;

  const intervalMs = config.observability.metricsSampleIntervalMs;
  // Prime the gauges immediately so the first scrape isn't empty.
  void sampleObservabilityMetrics(queues);
  timer = setInterval(() => {
    void sampleObservabilityMetrics(queues);
  }, intervalMs);
  timer.unref();

  logger.info('Observability sampler started', {
    operation: 'startObservabilitySampler',
    intervalMs,
    queues: queues.map((q) => q.name),
  });
}

/** Stop the periodic sampler (used on graceful shutdown). */
export function stopObservabilitySampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
