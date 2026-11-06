/**
 * Accumulates HTTP bandwidth per scraping job in memory and persists the totals
 * through JobBandwidthStore when the job finishes.
 */

import { createLogger } from '../utils/logger';
import { JobBandwidthStore } from './job-bandwidth-store';

const logger = createLogger('bandwidth-tracker');

interface BandwidthMetrics {
  bytesDownloaded: number;
  bytesUploaded: number;
  requestCount: number;
}

export class BandwidthTracker {
  private readonly jobContexts: Map<string, BandwidthMetrics> = new Map();
  private readonly bandwidthStore: JobBandwidthStore;

  constructor(bandwidthStore: JobBandwidthStore) {
    this.bandwidthStore = bandwidthStore;
  }

  startJob(jobId: string): void {
    this.jobContexts.set(jobId, { bytesDownloaded: 0, bytesUploaded: 0, requestCount: 0 });
    logger.debug('Bandwidth tracking started', { operation: 'startJob', jobId });
  }

  /** Accumulate bytes from a single HTTP request into the job's running totals. */
  recordRequest(jobId: string, bytesDown: number, bytesUp: number): void {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) {
      logger.warn('recordRequest called for unknown job, ignoring', { operation: 'recordRequest', jobId });
      return;
    }
    ctx.bytesDownloaded += bytesDown;
    ctx.bytesUploaded += bytesUp;
    ctx.requestCount += 1;
  }

  /**
   * Persist the job's accumulated bandwidth, then clear the in-memory context.
   * A failed write is logged, not thrown, so the scraping job still completes.
   */
  async finalizeJob(jobId: string, site: string): Promise<void> {
    const ctx = this.jobContexts.get(jobId);
    if (!ctx) {
      logger.warn('finalizeJob called for unknown job, nothing to persist', { operation: 'finalizeJob', jobId });
      return;
    }

    try {
      await this.bandwidthStore.create({
        jobId,
        site,
        bytesDownloaded: ctx.bytesDownloaded,
        bytesUploaded: ctx.bytesUploaded,
        requestCount: ctx.requestCount,
      });
      logger.info('Job bandwidth persisted', {
        operation: 'finalizeJob',
        jobId,
        site,
        bytesDownloaded: ctx.bytesDownloaded,
        bytesUploaded: ctx.bytesUploaded,
        requestCount: ctx.requestCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to persist job bandwidth — data lost for this job', {
        operation: 'finalizeJob',
        jobId,
        site,
        error: message,
      });
    } finally {
      this.jobContexts.delete(jobId);
    }
  }

  /** Clear a job's in-memory context without persisting (for cancelled jobs). */
  clearJob(jobId: string): void {
    this.jobContexts.delete(jobId);
    logger.debug('Bandwidth context cleared without persisting', { operation: 'clearJob', jobId });
  }
}

/** Set by the worker bootstrap; null until then. */
let trackerInstance: BandwidthTracker | null = null;

export function setBandwidthTracker(tracker: BandwidthTracker): void {
  trackerInstance = tracker;
}

export function getBandwidthTracker(): BandwidthTracker | null {
  return trackerInstance;
}
