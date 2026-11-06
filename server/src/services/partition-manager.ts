/**
 * Partition Manager — creates and identifies droppable partitions of the
 * RANGE-partitioned tables: product_snapshots (monthly) and web_vitals
 * (weekly). Bounds are UTC; see partition-bounds.ts.
 */

import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import { monthlyPartition, weeklyPartition, partitionDdl, parseRangeBound, type PartitionSpec } from './partition-bounds';

const logger = createLogger('partition-manager');

/** Only drops tables matching product_snapshots_YYYY_MM */
const PARTITION_NAME_RE = /^product_snapshots_\d{4}_\d{2}$/;

/** Only drops tables matching web_vitals_YYYY_MM_DD (weekly partitions) */
const WEB_VITALS_PARTITION_NAME_RE = /^web_vitals_\d{4}_\d{2}_\d{2}$/;

type SpecAt = (parent: string, now: Date, offset: number) => PartitionSpec;

/**
 * Create the partitions of `parent` at `offsets` (UTC months or weeks from
 * now). A partition whose neighbour already exists takes that neighbour's
 * bound instead of its own, so it meets partitions written before bounds were
 * UTC (date-only literals, read in the session TimeZone) with no gap and no
 * overlap. Safe to call repeatedly.
 */
async function ensureRangePartitions(parent: string, specAt: SpecAt, offsets: number[]): Promise<void> {
  const db = await DatabaseService.getInstance();
  const now = new Date();
  const rows = await db.all<{ name: string; bound: string }>(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = $1::regclass`,
    parent,
  );
  const existing = new Map(rows.map(r => [r.name, parseRangeBound(r.bound)]));

  for (const offset of offsets) {
    const spec = specAt(parent, now, offset);
    if (existing.has(spec.name)) continue;
    const from = existing.get(specAt(parent, now, offset - 1).name)?.to ?? spec.from;
    const to = existing.get(specAt(parent, now, offset + 1).name)?.from ?? spec.to;
    // IF NOT EXISTS: the API and the workers may race to create the same one.
    await db.run(partitionDdl(parent, { name: spec.name, from, to }));
    existing.set(spec.name, { from, to });
    logger.info('Ensured partition exists', { operation: 'ensureRangePartitions', partition: spec.name, from, to });
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Ensure monthly product_snapshots partitions exist from `monthsBack` months
 * before the current UTC month to `monthsAhead` months after it.
 */
export async function ensurePartitions(monthsAhead: number = 2, monthsBack: number = 0): Promise<void> {
  await ensureRangePartitions('product_snapshots', monthlyPartition, range(-monthsBack, monthsAhead));
}

/**
 * Ensure weekly web_vitals partitions exist for the current UTC week +
 * `weeksAhead` weeks (the layout migration 35 creates).
 *
 * web_vitals is written on every client page load, independent of the scrape
 * pipeline, so this MUST be driven by a timer (see index.ts) — not by
 * ensurePartitions, which only fires during a scrape.
 */
export async function ensureWebVitalsPartitions(weeksAhead: number = 4): Promise<void> {
  await ensureRangePartitions('web_vitals', weeklyPartition, range(0, weeksAhead));
}

/**
 * Find partitions older than the retention cutoff: every month before the
 * UTC month the cutoff falls in.
 */
export async function getDroppablePartitions(retentionDays: number): Promise<string[]> {
  const db = await DatabaseService.getInstance();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffName = monthlyPartition('product_snapshots', cutoff, 0).name;

  const rows = await db.all<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename LIKE 'product_snapshots_%'
       AND tablename < $1`,
    cutoffName,
  );

  return rows.map(r => r.tablename).filter(name => PARTITION_NAME_RE.test(name));
}

/**
 * Drop a single partition by name. Validates against allowlist pattern.
 */
export async function dropPartition(partitionName: string): Promise<void> {
  if (!PARTITION_NAME_RE.test(partitionName)) {
    throw new Error(`Invalid partition name: ${partitionName}`);
  }
  const db = await DatabaseService.getInstance();
  await db.run(`DROP TABLE IF EXISTS ${partitionName}`);
  logger.info('Dropped partition', { operation: 'dropPartition', partition: partitionName });
}

/**
 * Find weekly web_vitals partitions older than the retention cutoff.
 * Lexicographic comparison is valid because web_vitals_YYYY_MM_DD names sort
 * in the same order as the dates they encode.
 */
export async function getDroppableWebVitalsPartitions(retentionDays: number): Promise<string[]> {
  const db = await DatabaseService.getInstance();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffName = `web_vitals_${cutoff.toISOString().slice(0, 10).replace(/-/g, '_')}`;

  const rows = await db.all<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename LIKE 'web_vitals_%'
       AND tablename < $1`,
    cutoffName,
  );

  return rows.map(r => r.tablename).filter(name => WEB_VITALS_PARTITION_NAME_RE.test(name));
}

/**
 * Drop a single web_vitals partition by name. Validates against allowlist pattern.
 */
export async function dropWebVitalsPartition(partitionName: string): Promise<void> {
  if (!WEB_VITALS_PARTITION_NAME_RE.test(partitionName)) {
    throw new Error(`Invalid web_vitals partition name: ${partitionName}`);
  }
  const db = await DatabaseService.getInstance();
  await db.run(`DROP TABLE IF EXISTS ${partitionName}`);
  logger.info('Dropped web_vitals partition', { operation: 'dropWebVitalsPartition', partition: partitionName });
}
