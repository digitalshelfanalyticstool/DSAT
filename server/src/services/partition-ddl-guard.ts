/**
 * Guard for dynamically-built partition DDL.
 *
 * Several places build a partition table name and date-range literals from
 * `Date` getters and interpolate them into `CREATE TABLE ... PARTITION OF ...`.
 * Those values carry no external input today; this assertion keeps the
 * templated SQL provably safe against future refactors. Kept in a dependency-
 * free leaf module so it can be imported by both `partition-manager.ts` and
 * `database-migrations.ts` without risking an import cycle.
 */

/** A monthly or weekly partition identifier, e.g. `product_snapshots_2026_05` or `web_vitals_2026_05_11`. */
export const PARTITION_NAME_RE = /^[a-z][a-z0-9_]*_\d{4}_\d{2}(_\d{2})?$/;

/** A date literal in `YYYY-MM-DD` form (the only shape `Date.toISOString().slice(0, 10)` produces). */
export const PARTITION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Throw unless `name`, `fromIso` and `toIso` are safe to interpolate into
 * partition DDL. Returns void; callers proceed only if no error is thrown.
 */
export function assertSafePartitionDdl(name: string, fromIso: string, toIso: string): void {
  if (!PARTITION_NAME_RE.test(name)) {
    throw new Error(`Refusing to create partition with unexpected name: ${name}`);
  }
  if (!PARTITION_DATE_RE.test(fromIso) || !PARTITION_DATE_RE.test(toIso)) {
    throw new Error(`Refusing to create partition with unexpected date range: ${fromIso}..${toIso}`);
  }
}
