/**
 * The Redis heartbeat each worker process writes, and everyone else reads:
 * the worker itself (stale-job cleanup), health-monitor, admin analytics and
 * scripts/monitor-system.ts. Zero imports, so any process can use it.
 */

/** What a worker writes under its key, every WORKER_HEARTBEAT_INTERVAL_MS. */
export interface WorkerHeartbeat {
  workerId: string;
  lastSeen: string;
  activeJobs: number;
  pid: number;
  concurrency: number;
}

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
/** The key expires this long after the last write, so a dead worker drops out. */
export const WORKER_HEARTBEAT_TTL_S = 60;

const PREFIX = 'worker:';
const SUFFIX = ':heartbeat';

/** SCAN pattern matching every worker's heartbeat key. */
export const WORKER_HEARTBEAT_PATTERN = `${PREFIX}*${SUFFIX}`;

export function workerHeartbeatKey(workerId: string): string {
  return `${PREFIX}${workerId}${SUFFIX}`;
}

export function workerIdFromHeartbeatKey(key: string): string {
  return key.slice(PREFIX.length, key.length - SUFFIX.length);
}

/** The heartbeat stored under `key`, or null when it is missing or malformed. */
export function parseWorkerHeartbeat(key: string, raw: string | null): WorkerHeartbeat | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<WorkerHeartbeat>;
    return {
      workerId: data.workerId || workerIdFromHeartbeatKey(key),
      lastSeen: data.lastSeen ?? '',
      activeJobs: data.activeJobs ?? 0,
      pid: data.pid ?? 0,
      concurrency: data.concurrency ?? 0,
    };
  } catch {
    return null;
  }
}
