/**
 * Load (or remove) the fictional demo data: three `.example` retailers, three
 * brands, ~60 products with six weeks of daily snapshots, two alert rules and
 * the alerts they raise. Nothing calls the network.
 *
 * Usage: npm run demo -w server [-- --remove]
 * Docker: docker compose run --rm api npm run demo [-- --remove]
 *
 * Refuses to load into a database that already has real products, so demo
 * rows never mix with real ones. Demo rows are the ones whose retailer is a
 * demo site name, which is what `--remove` deletes.
 */

import { parseArgs } from 'node:util';
import { DatabaseService } from '../services/database';
import * as configManager from '../services/config-manager';
import { ensurePartitions } from '../services/partition-manager';
import { evaluateRun } from '../services/alerts/alert-service';
import { classifyProductType } from '../scrapers/product-type-classifier';
import { DEMO_BRANDS, DEMO_RULE_PREFIX, DEMO_SITES, generateDemoData, type DemoRun } from './demo-data';

const DAYS = 42;
const SITE_NAMES = DEMO_SITES.map((s) => s.name);
const RUNS_PER_DAY = DEMO_SITES.length * DEMO_BRANDS.length;

/** The config calls the seed makes; injected so tests don't write the real data dir. */
export type DemoConfig = Pick<typeof configManager, 'getSites' | 'addSite' | 'getBrands' | 'addBrand' | 'removeSitesByName' | 'removeBrandsByName'>;

export type DemoOutcome =
  | { status: 'seeded'; products: number; snapshots: number; runs: number; alerts: number }
  | { status: 'already_loaded' }
  | { status: 'refused'; reason: string };

const isOut = (inventory: string) => inventory === '0';

/** A run's time: `daysAgo` days back, an hour before now, staggered a minute per run within the day so runs keep their order. */
function runTime(now: Date, daysAgo: number, indexInDay: number): Date {
  return new Date(now.getTime() - daysAgo * 86_400_000 - 3_600_000 + indexInDay * 60_000);
}

async function addConfig(cfg: DemoConfig): Promise<void> {
  const sites = new Set((await cfg.getSites()).map((s) => s.name.toLowerCase()));
  for (const site of DEMO_SITES) {
    if (sites.has(site.name)) continue;
    const brandUrls = Object.fromEntries(DEMO_BRANDS.map((b) => [b.toLowerCase(), `${site.base_url}/brands/${b.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`]));
    await cfg.addSite({ ...site, brand_urls: brandUrls });
  }
  const brands = new Set((await cfg.getBrands()).map((b) => b.name.toLowerCase()));
  for (const name of DEMO_BRANDS) {
    if (!brands.has(name.toLowerCase())) await cfg.addBrand({ name, filter_criteria: {} });
  }
}

export async function seedDemo(db: DatabaseService, cfg: DemoConfig = configManager, now = new Date()): Promise<DemoOutcome> {
  const real = await db.get('SELECT 1 FROM products WHERE retailer <> ALL($1) LIMIT 1', SITE_NAMES);
  if (real) return { status: 'refused', reason: 'This database already has real products. The demo only loads into an install with no data of its own.' };
  if (await db.get('SELECT 1 FROM products WHERE retailer = ANY($1) LIMIT 1', SITE_NAMES)) return { status: 'already_loaded' };

  const owner = await db.get<{ id: number }>(`SELECT id FROM users ORDER BY (role = 'admin') DESC, id LIMIT 1`);
  if (!owner) return { status: 'refused', reason: 'Finish setup first: the demo jobs need an owner.' };

  await addConfig(cfg);
  await ensurePartitions(1, Math.ceil(DAYS / 28));

  const { products, runs } = generateDemoData(1, DAYS);
  const ordered = [...runs].sort((a, b) => b.daysAgo - a.daysAgo);
  const firstSeen = runTime(now, DAYS - 1, 0);
  const runIds: { id: number; at: Date }[] = [];
  let snapshotCount = 0;

  await db.transaction(async (tx) => {
    const ids = new Map<string, number>();
    for (const p of products) {
      const row = await tx.get<{ id: number }>(
        `INSERT INTO products (retailer, style_id, title, url, source, product_type, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'demo', $5, $6, $7, $6, $7) RETURNING id`,
        p.retailer, p.style_id, `${p.brand} ${p.title}`, p.url, classifyProductType(p.title), firstSeen, now,
      );
      ids.set(`${p.retailer}|${p.style_id}`, row!.id);
    }

    const previous = new Map<string, DemoRun['snapshots']>();
    for (const [index, run] of ordered.entries()) {
      const at = runTime(now, run.daysAgo, index % RUNS_PER_DAY);
      const job = await tx.get<{ job_id: string }>(
        `INSERT INTO jobs (user_id, site, brand, status, phase, created_at, updated_at, started_at, completed_at,
           products_discovered, products_processed, variants_extracted)
         VALUES ($1, $2, $3, 'completed', 'completed', $4, $4, $4, $4, $5, $5, $6) RETURNING job_id`,
        owner.id, run.site, run.brand, at, new Set(run.snapshots.map((s) => s.style_id)).size, run.snapshots.length,
      );

      // The counters the dashboard reads, against this site+brand's previous run.
      const key = `${run.site}|${run.brand}`;
      const before = new Map((previous.get(key) ?? []).map((s) => [s.sku, s]));
      const changed = new Set(run.snapshots.filter((s) => before.has(s.sku) && before.get(s.sku)!.selling_price !== s.selling_price).map((s) => s.style_id));
      const soldOut = new Set(run.snapshots.filter((s) => isOut(s.inventory) && before.has(s.sku) && !isOut(before.get(s.sku)!.inventory)).map((s) => s.sku));
      previous.set(key, run.snapshots);
      const styles = new Set(run.snapshots.map((s) => s.style_id)).size;

      const scrapeRun = await tx.get<{ id: number }>(
        `INSERT INTO scrape_runs (job_id, site, brand, variant_count, products_upserted, new_products, price_changes_detected, new_sellouts_detected, scraped_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        job!.job_id, run.site, run.brand, run.snapshots.length, styles, before.size === 0 ? styles : 0, changed.size, soldOut.size, at,
      );
      runIds.push({ id: scrapeRun!.id, at });

      const s = run.snapshots;
      await tx.query(
        `INSERT INTO product_snapshots (scrape_run_id, product_id, sku, color, size, list_price, selling_price, inventory, scraped_at, image_url)
         SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::text[], $9::timestamptz[], $10::text[])`,
        [
          scrapeRun!.id, s.map((x) => ids.get(`${run.site}|${x.style_id}`)!), s.map((x) => x.sku), s.map((x) => x.color), s.map((x) => x.size),
          s.map((x) => x.list_price), s.map((x) => x.selling_price), s.map((x) => x.inventory), s.map(() => at), s.map((x) => x.image_url),
        ],
      );
      snapshotCount += s.length;
    }

    await tx.query(
      `UPDATE products p SET latest_snapshot_id = sub.id
       FROM (SELECT DISTINCT ON (product_id) id, product_id FROM product_snapshots
             WHERE product_id = ANY($1) ORDER BY product_id, id DESC) sub
       WHERE sub.product_id = p.id`,
      [[...ids.values()]],
    );

    await tx.query(
      `INSERT INTO alert_rules (name, kind, target_type, target_brand, threshold) VALUES
         ($1, 'price_below', 'brand', 'Red Maple', 40), ($2, 'out_of_stock', 'all', NULL, NULL)`,
      [`${DEMO_RULE_PREFIX}Red Maple under $40`, `${DEMO_RULE_PREFIX}out of stock`],
    );
  });

  // Normal persistence refreshes this (debounced) after each run; the products page reads it.
  await db.run('REFRESH MATERIALIZED VIEW mv_latest_snapshots');

  // Replay the runs in order so the alerts are the ones the rules would really have raised.
  // Placeholder images are local files, so every image counts as loading.
  let alerts = 0;
  const imagesLoad = async (urls: string[]) => new Map(urls.map((u) => [u, true]));
  for (const run of runIds) {
    const { created, alertIds } = await evaluateRun(db, run.id, { checkImages: imagesLoad });
    if (alertIds.length > 0) await db.run('UPDATE alerts SET created_at = $1 WHERE id = ANY($2)', run.at, alertIds);
    alerts += created;
  }

  return { status: 'seeded', products: products.length, snapshots: snapshotCount, runs: runIds.length, alerts };
}

/** Delete exactly the demo data. Alerts and alert state go with the products by cascade; snapshots are partitioned and don't. */
export async function removeDemo(db: DatabaseService, cfg: DemoConfig = configManager): Promise<{ products: number; jobs: number; rules: number }> {
  const result = await db.transaction(async (tx) => {
    await tx.run('DELETE FROM product_snapshots WHERE product_id IN (SELECT id FROM products WHERE retailer = ANY($1))', SITE_NAMES);
    const products = await tx.run('DELETE FROM products WHERE retailer = ANY($1)', SITE_NAMES);
    const jobs = await tx.run('DELETE FROM jobs WHERE site = ANY($1)', SITE_NAMES);
    const rules = await tx.run('DELETE FROM alert_rules WHERE name LIKE $1', `${DEMO_RULE_PREFIX}%`);
    return { products: products.changes, jobs: jobs.changes, rules: rules.changes };
  });
  await db.run('REFRESH MATERIALIZED VIEW mv_latest_snapshots');
  await cfg.removeSitesByName(SITE_NAMES);
  await cfg.removeBrandsByName(DEMO_BRANDS);
  return result;
}

const RESTART_HINT = 'Restart the app so it picks up the site changes: docker compose restart api worker';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { remove: { type: 'boolean' } } });
  const db = await DatabaseService.getInstance();
  try {
    if (values.remove) {
      const r = await removeDemo(db);
      console.log(`Removed demo data: ${r.products} products, ${r.jobs} jobs, ${r.rules} alert rules, and the demo sites and brands.`);
      console.log(RESTART_HINT);
      return;
    }
    const outcome = await seedDemo(db);
    if (outcome.status === 'refused') {
      console.error(outcome.reason);
      process.exitCode = 1;
    } else if (outcome.status === 'already_loaded') {
      console.log('Demo data is already loaded. Remove it with: npm run demo -- --remove');
    } else {
      console.log(`Loaded demo data: ${outcome.products} products, ${outcome.runs} runs, ${outcome.snapshots} snapshots, ${outcome.alerts} alerts.`);
      console.log(RESTART_HINT);
    }
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('demo failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
