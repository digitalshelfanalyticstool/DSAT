/**
 * Every BullMQ queue the app runs: its name, the payload it carries, and the
 * one list everything that iterates queues (Bull Board, health, metrics,
 * shutdown) reads. A leaf module — no project imports except config and
 * types — so any file can depend on it without creating a cycle.
 */
import type { ProductVariant } from '../scrapers/site-adapter';

export const SCRAPE_QUEUE = 'scrape-jobs';
export const EXCEL_QUEUE = 'excel-jobs';
export const PERSIST_QUEUE = 'persist-jobs';
export const WEBHOOK_QUEUE = 'alert-webhooks';

export const ALL_QUEUES = [SCRAPE_QUEUE, EXCEL_QUEUE, PERSIST_QUEUE, WEBHOOK_QUEUE] as const;
export type QueueName = (typeof ALL_QUEUES)[number];

export interface ScrapeJobPayload {
  jobId: string;
  site: string;
  brand: string;
  userId: string;
  /** Resume from the job's checkpoint, which the worker loads by jobId (set by continue). */
  resume?: boolean;
  scheduleId?: number;
}

export interface ExcelJobPayload {
  jobId: string;
  siteName: string;
  brand: string;
  scrapeRunId: number;
  outputPath: string;
}

export interface ExcelJobResult {
  filePath: string;
  variantCount: number;
  durationMs: number;
}

export interface PersistJobPayload {
  jobId: string;
  siteName: string;
  brand: string;
  variants: ProductVariant[];
}

export interface PersistJobResult {
  scrape_run_id: number;
  products_upserted: number;
  snapshots_inserted: number;
  new_products: number;
  duration_ms: number;
}

export interface WebhookJobPayload { webhookId: number; alertIds: number[] }

export interface QueuePayloads {
  [SCRAPE_QUEUE]: ScrapeJobPayload;
  [EXCEL_QUEUE]: ExcelJobPayload;
  [PERSIST_QUEUE]: PersistJobPayload;
  [WEBHOOK_QUEUE]: WebhookJobPayload;
}

/**
 * BullMQ job id for one attempt of a scrape job. Each attempt (first run,
 * /continue) needs its own id: BullMQ silently ignores an add whose id matches
 * a job it still retains, completed ones included. BullMQ rejects ':' in ids.
 */
export function scrapeAttemptId(jobId: string, attempt: number): string {
  return `${jobId}_${attempt}`;
}

/**
 * A lazily created async resource whose init PROMISE is cached, so concurrent
 * callers share one init, and evicted if it rejects, so the next call retries.
 * Same pattern as getLimiter() in rate-limiter.ts.
 */
export function lazyAsync<T>(init: () => Promise<T>): { get(): Promise<T>; current(): Promise<T> | null; reset(): void } {
  let pending: Promise<T> | null = null;
  return {
    get() {
      if (!pending) {
        const p = init();
        pending = p;
        p.catch(() => { if (pending === p) pending = null; });
      }
      return pending;
    },
    current: () => pending,
    reset() { pending = null; },
  };
}
