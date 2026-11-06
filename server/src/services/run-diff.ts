/**
 * Run diff — what changed between two scrape runs: new and dropped products,
 * price moves, sellouts and restocks. GET /analytics/changes (latest two runs
 * per site and brand) and GET /admin/analytics/compare (two chosen runs) both
 * read it, so the two views can't disagree on what a change is.
 */

import type { DatabaseService } from './database';

const HOUR_MS = 3_600_000;

/**
 * Bounds on product_snapshots.scraped_at that contain every snapshot of runs
 * scraped between `first` and `last`. Every snapshot carries its run's
 * scraped_at, so the window loses no rows; it exists because the table is
 * RANGE-partitioned on scraped_at and Postgres prunes partitions only when the
 * key is compared with a constant or parameter, never with a joined column.
 * The slack (6h before, 24h after) absorbs long runs and clock drift.
 * Use as `scraped_at >= $from AND scraped_at < $to`.
 */
export function snapshotWindow(first: Date | string, last: Date | string = first): { from: string; to: string } {
  return {
    from: new Date(new Date(first).getTime() - 6 * HOUR_MS).toISOString(),
    to: new Date(new Date(last).getTime() + 24 * HOUR_MS).toISOString(),
  };
}

export interface RunRef { id: number; scraped_at: Date | string }

export interface RunDiff {
  new_products: number;
  dropped_products: number;
  price_increases: number;
  price_decreases: number;
  new_sellouts: number;
  restocked: number;
}

const ZERO: RunDiff = {
  new_products: 0, dropped_products: 0,
  price_increases: 0, price_decreases: 0,
  new_sellouts: 0, restocked: 0,
};

/**
 * Diff each `a` (older) run against its `b` (newer) run. One query per metric
 * however many pairs, and one diff per pair in input order. A product's price
 * is the average selling price of its variants; it is in stock when any
 * variant is (`inventory_in_stock`).
 */
export async function diffRunPairs(
  db: DatabaseService,
  pairs: Array<{ a: RunRef; b: RunRef }>,
): Promise<RunDiff[]> {
  if (pairs.length === 0) return [];

  const runA = pairs.map((p) => Number(p.a.id));
  const runB = pairs.map((p) => Number(p.b.id));
  const times = pairs.flatMap((p) => [p.a.scraped_at, p.b.scraped_at]).map((t) => new Date(t).getTime());
  const { from, to } = snapshotWindow(new Date(Math.min(...times)), new Date(Math.max(...times)));

  const productsOf = (ids: number[]) => db.all<{ scrape_run_id: number; product_id: number }>(
    `SELECT DISTINCT scrape_run_id, product_id
     FROM product_snapshots
     WHERE scrape_run_id = ANY($1::int[])
       AND scraped_at >= $2::timestamptz
       AND scraped_at < $3::timestamptz`,
    ids, from, to,
  );

  // Per-pair aggregate over products present in both runs. `agg` is the
  // per-product expression; `where` filters the snapshots it reads.
  const pairedMetric = <T>(agg: string, where: string, select: string) => db.all<T>(
    `WITH pairs(run_a, run_b) AS (
      SELECT unnest($1::int[]), unnest($2::int[])
    ), a AS (
      SELECT p.run_a, ps.product_id, ${agg} AS v
      FROM product_snapshots ps
      JOIN pairs p ON ps.scrape_run_id = p.run_a
      WHERE ${where} ps.scraped_at >= $3::timestamptz AND ps.scraped_at < $4::timestamptz
      GROUP BY p.run_a, ps.product_id
    ), b AS (
      SELECT p.run_b, ps.product_id, ${agg} AS v
      FROM product_snapshots ps
      JOIN pairs p ON ps.scrape_run_id = p.run_b
      WHERE ${where} ps.scraped_at >= $3::timestamptz AND ps.scraped_at < $4::timestamptz
      GROUP BY p.run_b, ps.product_id
    )
    SELECT a.run_a, ${select}
    FROM a
    JOIN pairs pr ON pr.run_a = a.run_a
    JOIN b ON b.run_b = pr.run_b AND b.product_id = a.product_id
    GROUP BY a.run_a`,
    runA, runB, from, to,
  );

  const [productsA, productsB, prices, stock] = await Promise.all([
    productsOf(runA),
    productsOf(runB),
    pairedMetric<{ run_a: number; increases: string; decreases: string }>(
      'AVG(ps.selling_price)', 'ps.selling_price IS NOT NULL AND',
      `COUNT(*) FILTER (WHERE b.v > a.v)::text AS increases,
       COUNT(*) FILTER (WHERE b.v < a.v)::text AS decreases`,
    ),
    pairedMetric<{ run_a: number; new_sellouts: string; restocked: string }>(
      'BOOL_OR(inventory_in_stock(ps.inventory))', '',
      `COUNT(*) FILTER (WHERE a.v AND b.v IS FALSE)::text AS new_sellouts,
       COUNT(*) FILTER (WHERE a.v IS FALSE AND b.v)::text AS restocked`,
    ),
  ]);

  const byRun = (rows: Array<{ scrape_run_id: number; product_id: number }>) => {
    const m = new Map<number, Set<number>>();
    for (const r of rows) {
      const id = Number(r.scrape_run_id);
      if (!m.has(id)) m.set(id, new Set());
      m.get(id)!.add(Number(r.product_id));
    }
    return m;
  };
  const setsA = byRun(productsA);
  const setsB = byRun(productsB);
  const priceBy = new Map(prices.map((r) => [Number(r.run_a), r]));
  const stockBy = new Map(stock.map((r) => [Number(r.run_a), r]));

  return pairs.map((_, i) => {
    const setA = setsA.get(runA[i]) ?? new Set<number>();
    const setB = setsB.get(runB[i]) ?? new Set<number>();
    const pc = priceBy.get(runA[i]);
    const sc = stockBy.get(runA[i]);
    return {
      new_products: [...setB].filter((id) => !setA.has(id)).length,
      dropped_products: [...setA].filter((id) => !setB.has(id)).length,
      price_increases: Number(pc?.increases || 0),
      price_decreases: Number(pc?.decreases || 0),
      new_sellouts: Number(sc?.new_sellouts || 0),
      restocked: Number(sc?.restocked || 0),
    };
  });
}

export function sumRunDiffs(diffs: RunDiff[]): RunDiff {
  const total = { ...ZERO };
  for (const d of diffs) {
    for (const k of Object.keys(total) as Array<keyof RunDiff>) total[k] += d[k];
  }
  return total;
}
