/**
 * Partition names and bounds for the RANGE-partitioned tables
 * (product_snapshots monthly, web_vitals weekly), all in UTC.
 *
 * Bounds are written as timestamptz literals with an explicit +00 offset, so
 * neither the Node process's TZ nor the Postgres session's TimeZone can move
 * them. A leaf module (it imports only the DDL guard) so the migrations and
 * partition-manager.ts can both use it without an import cycle.
 */

import { PARTITION_NAME_RE } from './partition-ddl-guard';

export interface PartitionSpec {
  name: string;
  /** `FOR VALUES FROM` literal. */
  from: string;
  /** `FOR VALUES TO` literal (exclusive). */
  to: string;
}

/** A bound literal: a date, optionally a time and offset (digits, `:`, `.`, `+`, `-`). Never a quote. */
const BOUND_RE = /^\d{4}-\d{2}-\d{2}( [\d:.+-]{8,20})?$/;
const PARENT_RE = /^[a-z_]+$/;

const pad = (n: number) => String(n).padStart(2, '0');
const utcMidnight = (d: Date) => `${d.toISOString().slice(0, 10)} 00:00:00+00`;

/** The UTC calendar month `offset` months from `now`: `<parent>_YYYY_MM`. */
export function monthlyPartition(parent: string, now: Date, offset: number): PartitionSpec {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return {
    name: `${parent}_${start.getUTCFullYear()}_${pad(start.getUTCMonth() + 1)}`,
    from: utcMidnight(start),
    to: utcMidnight(end),
  };
}

/** The UTC Monday-to-Monday week `offset` weeks from `now`'s week: `<parent>_YYYY_MM_DD`. */
export function weeklyPartition(parent: string, now: Date, offset: number): PartitionSpec {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday + offset * 7));
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return {
    name: `${parent}_${start.getUTCFullYear()}_${pad(start.getUTCMonth() + 1)}_${pad(start.getUTCDate())}`,
    from: utcMidnight(start),
    to: utcMidnight(end),
  };
}

/** `CREATE TABLE IF NOT EXISTS ... PARTITION OF ...`, after checking every interpolated value. */
export function partitionDdl(parent: string, spec: PartitionSpec): string {
  if (!PARENT_RE.test(parent) || !PARTITION_NAME_RE.test(spec.name) || !spec.name.startsWith(`${parent}_`)) {
    throw new Error(`Refusing to create partition with unexpected name: ${parent}/${spec.name}`);
  }
  if (!BOUND_RE.test(spec.from) || !BOUND_RE.test(spec.to)) {
    throw new Error(`Refusing to create partition with unexpected range: ${spec.from}..${spec.to}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${spec.name} PARTITION OF ${parent} FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`;
}

/** `{ from, to }` of a `pg_get_expr(relpartbound)` range, or null for anything else (DEFAULT, MINVALUE). */
export function parseRangeBound(expr: string): { from: string; to: string } | null {
  const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(expr);
  return m ? { from: m[1], to: m[2] } : null;
}
