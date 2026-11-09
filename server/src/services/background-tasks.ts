/**
 * The API process's periodic work, started once and stopped on shutdown.
 *
 * Each task runs `firstRunMs` after start, then `intervalMs` after the previous
 * run finished (so a slow run never overlaps the next). A run that throws is
 * logged and the task carries on. The stopper clears every pending timer and
 * keeps an in-flight run from scheduling another.
 */

import { config } from '../config';
import { createLogger } from '../utils/logger';
import { DatabaseService } from './database';
import { cleanupOldFiles } from './download-service';
import { runRetentionCleanup } from './db-retention';
import { ensureWebVitalsPartitions } from './partition-manager';
import { runTokenCleanup } from './auth-token-cleanup';
import { runEmailDigest } from './email-digest-scheduler';
import { recordAndPruneHealthSnapshots } from './health-monitor';
import { createMonitorScheduleCheck, MONITOR_CHECK_INTERVAL_MS } from './site-monitor-runner';
import { checkAndFireDueSchedules, SCHEDULE_CHECK_INTERVAL_MS } from './scheduler';

const logger = createLogger('background-tasks');

export interface BackgroundTask {
  name: string;
  firstRunMs: number;
  intervalMs: number;
  run: () => Promise<unknown>;
}

const HOUR_MS = 60 * 60 * 1000;

/** Everything the API process runs in the background. */
export function apiBackgroundTasks(): BackgroundTask[] {
  const maintenanceMs = config.scheduling.maintenanceIntervalMs;
  return [
    { name: 'job-schedules', firstRunMs: SCHEDULE_CHECK_INTERVAL_MS, intervalMs: SCHEDULE_CHECK_INTERVAL_MS, run: checkAndFireDueSchedules },
    { name: 'site-monitor-schedule', firstRunMs: MONITOR_CHECK_INTERVAL_MS, intervalMs: MONITOR_CHECK_INTERVAL_MS, run: createMonitorScheduleCheck() },
    { name: 'health-snapshots', firstRunMs: 0, intervalMs: 5 * 60 * 1000, run: recordAndPruneHealthSnapshots },
    { name: 'token-cleanup', firstRunMs: HOUR_MS, intervalMs: 24 * HOUR_MS, run: async () => runTokenCleanup(await DatabaseService.getInstance()) },
    { name: 'email-digest', firstRunMs: HOUR_MS, intervalMs: config.email.digestIntervalMs, run: runEmailDigest },
    {
      name: 'report-cleanup', firstRunMs: 0, intervalMs: maintenanceMs,
      run: async () => {
        const days = config.scraping.reportRetentionDays;
        const deletedCount = await cleanupOldFiles(days);
        logger.info(`Report cleanup: removed ${deletedCount} Excel file(s) older than ${days} days`, { operation: 'excelCleanup', deletedCount });
      },
    },
    {
      name: 'db-retention', firstRunMs: 0, intervalMs: maintenanceMs,
      run: async () => {
        // web_vitals is weekly-partitioned and written on every page load, so it
        // needs partitions provisioned ahead of time, not by the scrape pipeline.
        await ensureWebVitalsPartitions().catch((err: unknown) => {
          logger.warn('web_vitals partition provisioning failed', { operation: 'ensureWebVitalsPartitions', error: (err as Error).message });
        });
        const r = await runRetentionCleanup(
          config.scraping.snapshotRetentionDays,
          config.scraping.bandwidthRetentionDays,
          config.email.emailLogRetentionDays,
          config.observability.webVitalsRetentionDays,
          config.auth.auditLogRetentionDays,
        );
        logger.info(`DB retention: removed ${r.snapshots} snapshot(s), ${r.bandwidth} bandwidth record(s), ${r.emailLog} email_log row(s), ${r.auditLogs} audit_log row(s), ${r.webVitals} web_vitals partition(s)`, {
          operation: 'dbRetention', ...r,
        });
      },
    },
  ];
}

/** Start `tasks`; the returned function stops all of them. */
export function startBackgroundTasks(tasks: BackgroundTask[] = apiBackgroundTasks()): () => void {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();

  for (const task of tasks) {
    const schedule = (delayMs: number): void => {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void tick();
      }, delayMs);
      timers.add(timer);
    };
    const tick = async (): Promise<void> => {
      try {
        await task.run();
      } catch (err) {
        logger.error('Background task failed; it runs again next interval', {
          operation: 'backgroundTask', task: task.name, error: (err as Error).message,
        });
      }
      schedule(task.intervalMs);
    };
    schedule(task.firstRunMs);
  }

  logger.info('Background tasks started', { operation: 'startBackgroundTasks', tasks: tasks.map((t) => t.name) });

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
