/**
 * QueueService — the app's BullMQ queues, producers and consumers.
 *
 * One Queue / QueueEvents / Worker per entry of ALL_QUEUES (queues.ts), created
 * lazily on first use. Per-queue behaviour (retries, lock duration, retention)
 * lives in QUEUE_OPTIONS below. Job progress pub/sub is in progress-bus.ts; job
 * status in Postgres is job-lifecycle.ts's business, not this module's.
 */

import { Queue, Worker, QueueEvents, type Job as BullMQJob, type JobsOptions } from 'bullmq';
import { config } from '../config';
import { getRedisClient, buildRedisOptions } from './redis-client';
import { createLogger } from '../utils/logger';
import {
  ALL_QUEUES, SCRAPE_QUEUE, EXCEL_QUEUE, PERSIST_QUEUE, WEBHOOK_QUEUE, lazyAsync,
  type QueueName, type QueuePayloads, type ScrapeJobPayload,
  type ExcelJobPayload, type ExcelJobResult, type PersistJobPayload, type PersistJobResult,
  type WebhookJobPayload,
} from './queues';

const logger = createLogger('queue-service');

/** Lock margin over a job's own timeout, so BullMQ never calls a live job stalled. */
const LOCK_MARGIN_MS = 60_000;

interface QueueOptions {
  add: JobsOptions;
  /** BullMQ lock duration for this queue's worker; BullMQ's default when unset. */
  lockDurationMs?: number;
}

/**
 * Scrape jobs run once (`attempts: 1`): the worker records every outcome in
 * Postgres itself and never rethrows, so BullMQ retries could never fire, and
 * a retry at this layer would run a job whose row is already terminal. Retries
 * of a scrape are user actions (/continue, /restart) or schedule retries.
 * Excel, persist and webhook handlers do throw, so their BullMQ retries are real.
 */
function queueOptions(name: QueueName): QueueOptions {
  switch (name) {
    case SCRAPE_QUEUE:
      return {
        add: { attempts: 1, removeOnComplete: { count: 500 }, removeOnFail: { count: 200 } },
        lockDurationMs: config.jobs.scrapeLockDurationMs,
      };
    case EXCEL_QUEUE:
      return {
        add: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
        lockDurationMs: config.jobs.excelJobTimeoutMs + LOCK_MARGIN_MS,
      };
    case PERSIST_QUEUE:
      return {
        add: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
        lockDurationMs: config.jobs.persistJobTimeoutMs + LOCK_MARGIN_MS,
      };
    case WEBHOOK_QUEUE:
      return {
        add: { attempts: config.jobs.webhookAttempts, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
      };
  }
}

interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  stalled: number;
}

export interface FailedJob {
  /** `<queue>:<BullMQ id>` — the id the DLQ routes take. */
  id: string;
  queue: QueueName;
  site: string;
  brand: string;
  jobId: string;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
}

type StaleJobStore = {
  getByIds(ids: string[]): Promise<Map<string, { worker_id: string | null; status: string }>>;
};

class QueueService {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly events = new Map<QueueName, ReturnType<typeof lazyAsync<QueueEvents>>>();
  private readonly workers = new Map<QueueName, Worker>();
  private shutdownInProgress = false;

  /** The producer for a queue (also used by Bull Board, metrics and admin pause/resume). */
  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: buildRedisOptions(`bullmq-${name}-queue`, false) });
      this.queues.set(name, q);
      logger.info('BullMQ queue initialized', { operation: 'queue', queueName: name });
    }
    return q;
  }

  /** Shared QueueEvents subscriber for waitUntilFinished; init promise cached, evicted on failure. */
  private queueEvents(name: QueueName): Promise<QueueEvents> {
    let lazy = this.events.get(name);
    if (!lazy) {
      lazy = lazyAsync(async () => {
        const events = new QueueEvents(name, { connection: buildRedisOptions(`bullmq-${name}-events`, false) });
        try {
          await events.waitUntilReady();
          return events;
        } catch (err) {
          await events.close().catch(() => {});
          throw err;
        }
      });
      this.events.set(name, lazy);
    }
    return lazy.get();
  }

  /**
   * Enqueue and await the worker's result. Throws when the job fails permanently.
   * BullMQ assigns the id: every call is a new piece of work (a /continue of a
   * scrape persists again), so a reused id would hand back the old result.
   */
  private async addAndWait<N extends QueueName, R>(name: N, payload: QueuePayloads[N] & { jobId: string }, timeoutMs: number): Promise<R> {
    const job = await this.queue(name).add(payload.jobId, payload, queueOptions(name).add);
    logger.info('Job enqueued', { operation: 'addAndWait', queueName: name, jobId: payload.jobId, bullJobId: job.id });
    const events = await this.queueEvents(name);
    return (await job.waitUntilFinished(events, timeoutMs)) as R;
  }

  /** Generate the Excel file for a persisted run on the low-concurrency excel queue. */
  runExcelJob(payload: ExcelJobPayload): Promise<ExcelJobResult> {
    return this.addAndWait(EXCEL_QUEUE, payload, config.jobs.excelJobTimeoutMs + 30_000);
  }

  /** Persist a run's variants on the low-concurrency persist queue; resolves with scrape_run_id. */
  runPersistJob(payload: PersistJobPayload): Promise<PersistJobResult> {
    return this.addAndWait(PERSIST_QUEUE, payload, config.jobs.persistJobTimeoutMs + 30_000);
  }

  /** Queue one webhook delivery; a failed POST is retried with backoff. */
  async enqueueWebhookJob(payload: WebhookJobPayload): Promise<void> {
    await this.queue(WEBHOOK_QUEUE).add(`webhook-${payload.webhookId}`, payload, queueOptions(WEBHOOK_QUEUE).add);
  }

  /** Enqueue one attempt of a scrape job under its attempt id (see scrapeAttemptId). */
  async enqueueScrapeJob(bullJobId: string, payload: ScrapeJobPayload): Promise<void> {
    await this.queue(SCRAPE_QUEUE).add(payload.jobId, payload, { ...queueOptions(SCRAPE_QUEUE).add, jobId: bullJobId });
    logger.info('Scrape job enqueued', {
      operation: 'enqueueScrapeJob', jobId: payload.jobId, bullJobId, site: payload.site, brand: payload.brand,
    });
  }

  /**
   * Remove a waiting scrape attempt so no worker picks it up. An active job is
   * locked and can't be removed — the caller signals the worker instead.
   */
  async removeScrapeJob(bullJobId: string): Promise<void> {
    try {
      const job = await this.queue(SCRAPE_QUEUE).getJob(bullJobId);
      if (job) await job.remove();
    } catch (err) {
      logger.debug('Scrape job not removable', { operation: 'removeScrapeJob', bullJobId, reason: (err as Error).message });
    }
  }

  /** Jobs-table ids that BullMQ still holds as work to do (waiting, delayed, active…). */
  async pendingScrapeJobIds(): Promise<Set<string>> {
    const jobs = await this.queue(SCRAPE_QUEUE).getJobs(['active', 'waiting', 'delayed', 'prioritized', 'paused', 'waiting-children']);
    return new Set(jobs.map((j) => j.data?.jobId).filter((id): id is string => !!id));
  }

  /**
   * After a force-kill, BullMQ jobs can stay "active" with a lock from the dead
   * process. Move those whose owning worker is dead to failed in BullMQ; the
   * jobs row is the lifecycle's to fix (it fails rows of dead workers itself).
   */
  async cleanupStaleBullMQJobs(liveWorkerIds: Set<string>, jobStore: StaleJobStore): Promise<number> {
    let cleaned = 0;
    try {
      const activeJobs = await this.queue(SCRAPE_QUEUE).getJobs(['active']);
      const rows = await jobStore.getByIds(activeJobs.map((j) => j.data?.jobId).filter(Boolean));
      const redis = getRedisClient().getPublisherConnection();
      for (const job of activeJobs) {
        const row = job.id ? rows.get(job.data?.jobId) : undefined;
        if (!row || (row.worker_id && liveWorkerIds.has(row.worker_id))) continue;
        try {
          await redis.del(`bull:${SCRAPE_QUEUE}:${job.id}:lock`);
          await job.moveToFailed(new Error('Worker died during processing — cleaned up on restart'), job.id!, false);
          cleaned++;
        } catch (err) {
          logger.warn('Failed to clean up stale BullMQ job', { operation: 'cleanupStaleBullMQJobs', bullJobId: job.id, error: (err as Error).message });
        }
      }
    } catch (err) {
      logger.warn('Failed to scan for stale BullMQ jobs', { operation: 'cleanupStaleBullMQJobs', error: (err as Error).message });
    }
    return cleaned;
  }

  /** Start consuming a queue. Called by worker processes, never the API. */
  startWorker<N extends QueueName>(
    name: N,
    concurrency: number,
    handler: (payload: QueuePayloads[N]) => Promise<unknown>,
  ): void {
    if (this.workers.has(name)) {
      logger.warn('Worker already started', { operation: 'startWorker', queueName: name });
      return;
    }
    const { lockDurationMs } = queueOptions(name);
    const worker = new Worker(
      name,
      async (job: BullMQJob<QueuePayloads[N]>) => handler(job.data),
      {
        connection: buildRedisOptions(`bullmq-${name}-worker`, false),
        concurrency,
        stalledInterval: config.jobs.stalledIntervalMs,
        ...(lockDurationMs !== undefined && { lockDuration: lockDurationMs }),
      },
    );
    worker.on('failed', (job, err) => {
      logger.error('Job failed in BullMQ', {
        operation: 'workerEvent', queueName: name, bullJobId: job?.id ?? 'unknown', error: err.message, attemptsMade: job?.attemptsMade ?? 0,
      });
    });
    worker.on('error', (err) => logger.error('BullMQ worker error', { operation: 'workerEvent', queueName: name, error: err.message }));
    worker.on('stalled', (bullJobId) => logger.warn('Job stalled', { operation: 'workerEvent', queueName: name, bullJobId }));
    this.workers.set(name, worker);
    logger.info('BullMQ worker started', { operation: 'startWorker', queueName: name, concurrency });
  }

  /** Stop consuming: let active jobs finish within the timeout, then force-close. */
  async stopWorker(name: QueueName, timeoutMs: number = config.jobs.queueStopTimeoutMs): Promise<void> {
    const worker = this.workers.get(name);
    if (!worker) return;
    this.workers.delete(name);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        worker.close(),
        new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Worker stop timed out')), timeoutMs); }),
      ]);
    } catch (err) {
      logger.warn('BullMQ worker stop timed out, forcing close', { operation: 'stopWorker', queueName: name, error: (err as Error).message });
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Job counts summed over every queue. BullMQ exposes no stalled count; reported as 0. */
  async getQueueMetrics(): Promise<QueueMetrics> {
    const all = await Promise.all(ALL_QUEUES.map((name) => this.queue(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')));
    const sum = (k: string) => all.reduce((n, c) => n + Number(c[k] ?? 0), 0);
    return { waiting: sum('waiting'), active: sum('active'), completed: sum('completed'), failed: sum('failed'), delayed: sum('delayed'), stalled: 0 };
  }

  // ── Dead letter queue: permanently failed jobs across every queue ────────

  async getFailedJobs(start = 0, end = 19): Promise<{ jobs: FailedJob[]; total: number }> {
    const perQueue = await Promise.all(ALL_QUEUES.map(async (name) => {
      const q = this.queue(name);
      const [count, jobs] = await Promise.all([q.getFailedCount(), q.getJobs(['failed'], 0, end)]);
      return { name, count, jobs };
    }));
    const all = perQueue
      .flatMap(({ name, jobs }) => jobs.map((j) => toFailedJob(name, j)))
      .sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp));
    return { jobs: all.slice(start, end + 1), total: perQueue.reduce((n, q) => n + q.count, 0) };
  }

  private async failedJob(id: string): Promise<BullMQJob> {
    const sep = id.indexOf(':');
    const name = id.slice(0, sep) as QueueName;
    const job = sep > 0 && ALL_QUEUES.includes(name) ? await this.queue(name).getJob(id.slice(sep + 1)) : undefined;
    if (!job) throw new Error(`Job "${id}" not found`);
    return job;
  }

  async retryFailedJob(id: string): Promise<void> {
    const job = await this.failedJob(id);
    const state = await job.getState();
    if (state !== 'failed') throw new Error(`Job "${id}" is not in failed state (current: ${state})`);
    await job.retry();
    logger.info('Failed job retried', { operation: 'retryFailedJob', id });
  }

  async removeFailedJob(id: string): Promise<void> {
    await (await this.failedJob(id)).remove();
    logger.info('Failed job discarded', { operation: 'removeFailedJob', id });
  }

  /** Close every worker, QueueEvents and producer. */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;
    try {
      for (const name of [...this.workers.keys()]) await this.stopWorker(name);
      const closing = [
        ...[...this.events.values()].map((lazy) => lazy.current()?.then((e) => e.close())),
        ...[...this.queues.values()].map((q) => q.close()),
      ];
      const results = await Promise.allSettled(closing);
      for (const r of results) {
        if (r.status === 'rejected') logger.warn('Error closing BullMQ resource', { operation: 'shutdown', error: String(r.reason) });
      }
      this.events.clear();
      this.queues.clear();
      logger.info('Queue service shut down', { operation: 'shutdown' });
    } finally {
      this.shutdownInProgress = false;
    }
  }
}

function toFailedJob(queue: QueueName, j: BullMQJob): FailedJob {
  const data = (j.data ?? {}) as { jobId?: string; site?: string; siteName?: string; brand?: string };
  return {
    id: `${queue}:${j.id ?? ''}`,
    queue,
    site: data.site ?? data.siteName ?? '',
    brand: data.brand ?? '',
    jobId: data.jobId ?? j.id ?? '',
    failedReason: j.failedReason ?? 'Unknown error',
    stacktrace: j.stacktrace ?? [],
    attemptsMade: j.attemptsMade,
    timestamp: j.timestamp,
    processedOn: j.processedOn ?? null,
    finishedOn: j.finishedOn ?? null,
  };
}

let instance: QueueService | null = null;

export function getQueueService(): QueueService {
  instance ??= new QueueService();
  return instance;
}

export { QueueService };
