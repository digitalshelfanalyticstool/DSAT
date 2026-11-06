/**
 * Database Retention Service — periodic cleanup of every table that grows
 * without bound. Partitioned tables (product_snapshots, web_vitals) drop whole
 * partitions; the rest delete rows in 1 000-row batches to avoid long-running
 * transactions and lock contention. health_snapshots is pruned separately,
 * every 5 minutes, by health-monitor.ts.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import {
  getDroppablePartitions,
  dropPartition,
  getDroppableWebVitalsPartitions,
  dropWebVitalsPartition,
} from './partition-manager';

const logger = createLogger('db-retention');

const BATCH_SIZE = 1_000;
const IDENTIFIER_RE = /^[a-z_]+$/;

/**
 * Drop product_snapshots partitions older than `retentionDays`.
 * Returns the number of partitions dropped (instant operation, zero dead tuples).
 */
export async function cleanupOldSnapshots(retentionDays: number): Promise<number> {
  const droppable = await getDroppablePartitions(retentionDays);

  for (const name of droppable) {
    await dropPartition(name);
  }

  if (droppable.length > 0) {
    logger.info('Cleaned up old snapshot partitions', {
      operation: 'cleanupOldSnapshots',
      retentionDays,
      droppedPartitions: droppable.length,
      partitionNames: droppable,
    });
  }

  return droppable.length;
}

/**
 * Drop web_vitals weekly partitions older than `retentionDays`.
 * Returns the number of partitions dropped (instant operation, zero dead tuples).
 */
export async function cleanupOldWebVitals(retentionDays: number): Promise<number> {
  const droppable = await getDroppableWebVitalsPartitions(retentionDays);

  for (const name of droppable) {
    await dropWebVitalsPartition(name);
  }

  if (droppable.length > 0) {
    logger.info('Cleaned up old web_vitals partitions', {
      operation: 'cleanupOldWebVitals',
      retentionDays,
      droppedPartitions: droppable.length,
      partitionNames: droppable,
    });
  }

  return droppable.length;
}

/**
 * Delete rows of `table` whose `column` is older than `retentionDays`, in
 * batches (by ctid, so tables without an id column work too). Returns the
 * number of rows deleted.
 */
export async function deleteOlderThan(table: string, column: string, retentionDays: number): Promise<number> {
  if (!IDENTIFIER_RE.test(table) || !IDENTIFIER_RE.test(column)) {
    throw new Error(`Refusing to prune unexpected identifier: ${table}.${column}`);
  }
  const db = await DatabaseService.getInstance();
  let totalDeleted = 0;

  while (true) {
    const result = await db.run(
      `DELETE FROM ${table}
       WHERE ctid = ANY(ARRAY(
         SELECT ctid FROM ${table}
         WHERE ${column} < NOW() - INTERVAL '1 day' * $1
         LIMIT $2
       ))`,
      retentionDays,
      BATCH_SIZE,
    );
    totalDeleted += result.changes;
    if (result.changes < BATCH_SIZE) break;
  }

  if (totalDeleted > 0) {
    logger.info('Pruned old rows', { operation: 'deleteOlderThan', table, retentionDays, deletedRows: totalDeleted });
  }
  return totalDeleted;
}

export interface RetentionResult {
  snapshots: number;
  webVitals: number;
  bandwidth: number;
  emailLog: number;
  alerts: number;
  imageChecks: number;
  siteMonitorRuns: number;
}

/**
 * Run all retention cleanup tasks. Intended to be called on a weekly schedule.
 *
 * alerts, image_checks and site_monitor_runs (site_monitor_changes cascades)
 * follow the snapshot retention: they describe snapshot history, and keep no
 * meaning once it is gone.
 */
export async function runRetentionCleanup(
  snapshotRetentionDays: number,
  bandwidthRetentionDays: number,
  emailLogRetentionDays: number,
  webVitalsRetentionDays: number,
): Promise<RetentionResult> {
  const rowRules: Array<[keyof RetentionResult, string, string, number]> = [
    ['bandwidth', 'job_bandwidth', 'created_at', bandwidthRetentionDays],
    ['emailLog', 'email_log', 'sent_at', emailLogRetentionDays],
    ['alerts', 'alerts', 'created_at', snapshotRetentionDays],
    ['imageChecks', 'image_checks', 'checked_at', snapshotRetentionDays],
    ['siteMonitorRuns', 'site_monitor_runs', 'started_at', snapshotRetentionDays],
  ];
  logger.info('Starting DB retention cleanup', {
    operation: 'runRetentionCleanup',
    snapshotRetentionDays,
    bandwidthRetentionDays,
    emailLogRetentionDays,
    webVitalsRetentionDays,
  });

  const result: RetentionResult = {
    snapshots: await cleanupOldSnapshots(snapshotRetentionDays),
    webVitals: await cleanupOldWebVitals(webVitalsRetentionDays),
    bandwidth: 0, emailLog: 0, alerts: 0, imageChecks: 0, siteMonitorRuns: 0,
  };
  for (const [key, table, column, days] of rowRules) {
    result[key] = await deleteOlderThan(table, column, days);
  }

  logger.info('DB retention cleanup complete', { operation: 'runRetentionCleanup', ...result });
  return result;
}
