/**
 * Redis Pub/Sub relay between worker processes and the API's SSE streams:
 * job progress, site-monitor progress and job cancellation signals.
 *
 * Every subscription goes through one channel registry on the shared
 * subscriber connection: ioredis emits 'message' for EVERY subscribed channel,
 * so each handler filters by channel, any number of viewers can watch the same
 * channel, and the Redis channel is subscribed once and unsubscribed when the
 * last viewer leaves.
 */
import { getRedisClient } from './redis-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('progress-bus');

const PROGRESS_CHANNEL_PREFIX = 'job:progress:';
const MONITOR_PROGRESS_CHANNEL_PREFIX = 'monitor:progress:';
const CANCEL_CHANNEL_PREFIX = 'job:cancel:';

export interface ProgressEvent {
  jobId: string;
  status: string;
  phase?: string;
  products_discovered?: number;
  products_processed?: number;
  variants_extracted?: number;
  error_message?: string;
  file_path?: string;
  phase_duration_ms?: number;
  phase_name?: string;
  phase_timings?: Record<string, number>;
}

export interface MonitorProgressEvent {
  runId: number;
  type: string;
  timestamp: string;
  message: string;
  retailer?: string;
  product_id?: number;
  url?: string;
  changes_found?: number;
  critical_count?: number;
  error?: string;
}

type Dispose = () => Promise<void>;
type RawHandler = (channel: string, message: string) => void;

export class ProgressBus {
  /** channel → handlers of every viewer subscribed to it. */
  private readonly handlers = new Map<string, Set<RawHandler>>();
  /** channel → chained promise serialising subscribe/unsubscribe. */
  private readonly locks = new Map<string, Promise<void>>();

  private async publish(channel: string, payload: unknown): Promise<void> {
    await getRedisClient().getPublisherConnection().publish(channel, JSON.stringify(payload));
  }

  private async withLock(channel: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(channel) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    this.locks.set(channel, chained);
    await previous;
    try {
      await work();
    } finally {
      release();
      if (this.locks.get(channel) === chained) this.locks.delete(channel);
    }
  }

  private async subscribe<T>(channel: string, callback: (event: T) => void): Promise<Dispose> {
    const subscriber = getRedisClient().getSubscriberConnection();
    const handler: RawHandler = (ch, message) => {
      if (ch !== channel) return;
      try {
        callback(JSON.parse(message) as T);
      } catch (err) {
        logger.error('Failed to handle pub/sub message', { operation: 'subscribe', channel, error: (err as Error).message });
      }
    };

    await this.withLock(channel, async () => {
      let set = this.handlers.get(channel);
      if (!set) {
        set = new Set();
        this.handlers.set(channel, set);
      }
      const first = set.size === 0;
      set.add(handler);
      subscriber.on('message', handler);
      if (first) await subscriber.subscribe(channel);
    });

    return () => this.withLock(channel, async () => {
      const set = this.handlers.get(channel);
      if (!set?.has(handler)) return;
      subscriber.removeListener('message', handler);
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await subscriber.unsubscribe(channel);
      }
    });
  }

  publishProgress(jobId: string, progress: ProgressEvent): Promise<void> {
    return this.publish(`${PROGRESS_CHANNEL_PREFIX}${jobId}`, progress);
  }

  /** Subscribe one viewer to a job's progress; the returned disposer removes only that viewer. */
  subscribeProgress(jobId: string, callback: (progress: ProgressEvent) => void): Promise<Dispose> {
    return this.subscribe(`${PROGRESS_CHANNEL_PREFIX}${jobId}`, callback);
  }

  publishMonitorProgress(runId: number, event: MonitorProgressEvent): Promise<void> {
    return this.publish(`${MONITOR_PROGRESS_CHANNEL_PREFIX}${runId}`, event);
  }

  subscribeMonitorProgress(runId: number, callback: (event: MonitorProgressEvent) => void): Promise<Dispose> {
    return this.subscribe(`${MONITOR_PROGRESS_CHANNEL_PREFIX}${runId}`, callback);
  }

  /** Tell whichever worker runs the job to stop it. */
  publishCancel(jobId: string): Promise<void> {
    return this.publish(`${CANCEL_CHANNEL_PREFIX}${jobId}`, { jobId });
  }

  subscribeCancel(jobId: string, onCancel: () => void): Promise<Dispose> {
    return this.subscribe(`${CANCEL_CHANNEL_PREFIX}${jobId}`, () => onCancel());
  }

  /** Drop every subscription (process shutdown). */
  async shutdown(): Promise<void> {
    if (this.handlers.size === 0) return;
    const subscriber = getRedisClient().getSubscriberConnection();
    const channels = [...this.handlers.keys()];
    for (const [, set] of this.handlers) for (const h of set) subscriber.removeListener('message', h);
    this.handlers.clear();
    if (channels.length > 0) await subscriber.unsubscribe(...channels).catch(() => {});
  }
}

let instance: ProgressBus | null = null;

export function getProgressBus(): ProgressBus {
  instance ??= new ProgressBus();
  return instance;
}
