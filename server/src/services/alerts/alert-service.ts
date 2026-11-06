/**
 * Runs alert rules over one persisted scrape run. Each product in the run is
 * compared with its previous run; an alert is created when a product enters a
 * rule's condition, and `alert_state` remembers that it is in it, so the rule
 * stays quiet until the product leaves the condition and enters it again.
 */
import { DatabaseService } from '../database';
import { createLogger } from '../../utils/logger';
import { checkImages } from './image-check';
import {
  alertDetails, inCondition, ruleMatchesTarget,
  type AlertRule, type ProductObservation, type ProductState,
} from './evaluate';

const logger = createLogger('alert-service');

export interface EvaluateDeps {
  /** URL → loads as an image. Called only for new or changed image URLs. */
  checkImages?: (urls: string[]) => Promise<Map<string, boolean>>;
  /** Told the new alert ids once they are committed (webhook delivery). */
  notify?: (alertIds: number[]) => Promise<void>;
}

interface StateRow {
  product_id: number;
  min_price: string | null;
  any_in_stock: boolean;
  image_url: string | null;
}

const IN_STOCK_SQL = `COALESCE(inventory_in_stock(s.inventory), FALSE)`;
const SUMMARY_SQL = `
  s.product_id,
  MIN(s.selling_price) AS min_price,
  BOOL_OR(${IN_STOCK_SQL}) AS any_in_stock,
  (ARRAY_AGG(s.image_url ORDER BY s.id) FILTER (WHERE COALESCE(s.image_url, '') <> ''))[1] AS image_url`;

function toState(row: StateRow | undefined): ProductState | null {
  if (!row) return null;
  return {
    min_price: row.min_price === null ? null : Number(row.min_price),
    any_in_stock: row.any_in_stock,
    image_url: row.image_url ?? '',
    image_ok: null,
  };
}

async function loadRules(db: DatabaseService): Promise<AlertRule[]> {
  const rows = await db.all<AlertRule & { threshold: string | null; percent: string | null }>(
    `SELECT id, name, kind, target_type, target_site, target_brand, target_style_id, threshold, percent
     FROM alert_rules WHERE enabled ORDER BY id`,
  );
  return rows.map((r) => ({
    ...r,
    threshold: r.threshold === null ? null : Number(r.threshold),
    percent: r.percent === null ? null : Number(r.percent),
  }));
}

/** The run's products, each with its summary for this run and for its previous run. */
async function loadObservations(db: DatabaseService, scrapeRunId: number): Promise<ProductObservation[]> {
  const run = await db.get<{ site: string; brand: string }>('SELECT site, brand FROM scrape_runs WHERE id = $1', scrapeRunId);
  if (!run) return [];

  const current = await db.all<StateRow & { style_id: string }>(
    `SELECT ${SUMMARY_SQL}, p.style_id
     FROM product_snapshots s JOIN products p ON p.id = s.product_id
     WHERE s.scrape_run_id = $1
     GROUP BY s.product_id, p.style_id`,
    scrapeRunId,
  );
  if (current.length === 0) return [];

  const previous = await db.all<StateRow>(
    `WITH prev AS (
       SELECT product_id, MAX(scrape_run_id) AS run_id
       FROM product_snapshots
       WHERE product_id = ANY($1) AND scrape_run_id < $2
       GROUP BY product_id
     )
     SELECT ${SUMMARY_SQL}
     FROM product_snapshots s JOIN prev ON prev.product_id = s.product_id AND s.scrape_run_id = prev.run_id
     GROUP BY s.product_id`,
    current.map((c) => c.product_id), scrapeRunId,
  );
  const previousById = new Map(previous.map((p) => [p.product_id, p]));

  return current.map((c) => ({
    product_id: c.product_id,
    retailer: run.site,
    brand: run.brand,
    style_id: c.style_id,
    current: toState(c)!,
    previous: toState(previousById.get(c.product_id)),
  }));
}

/** Fill image_ok for images that are new or changed since the product's previous run. */
async function checkChangedImages(observations: ProductObservation[], checkImages: EvaluateDeps['checkImages']): Promise<void> {
  if (!checkImages) return;
  const changed = observations.filter((o) => o.current.image_url !== '' && o.current.image_url !== o.previous?.image_url);
  if (changed.length === 0) return;
  const results = await checkImages([...new Set(changed.map((o) => o.current.image_url))]);
  for (const o of changed) o.current.image_ok = results.get(o.current.image_url) ?? null;
}

export async function evaluateRun(
  db: DatabaseService,
  scrapeRunId: number,
  deps: EvaluateDeps = {},
): Promise<{ created: number; alertIds: number[] }> {
  const rules = await loadRules(db);
  if (rules.length === 0) return { created: 0, alertIds: [] };

  const observations = await loadObservations(db, scrapeRunId);
  if (observations.length === 0) return { created: 0, alertIds: [] };
  if (rules.some((r) => r.kind === 'broken_image')) await checkChangedImages(observations, deps.checkImages);

  const alertIds = await db.transaction(async (tx) => {
    const state = await tx.all<{ rule_id: number; product_id: number; in_condition: boolean }>(
      'SELECT rule_id, product_id, in_condition FROM alert_state WHERE rule_id = ANY($1) AND product_id = ANY($2)',
      rules.map((r) => r.id), observations.map((o) => o.product_id),
    );
    const inBefore = new Set(state.filter((s) => s.in_condition).map((s) => `${s.rule_id}:${s.product_id}`));

    const ids: number[] = [];
    // ponytail: one statement per transition; batch with unnest if a run with thousands of transitions is slow.
    for (const rule of rules) {
      for (const o of observations) {
        if (!ruleMatchesTarget(rule, o)) continue;
        // An unchanged image isn't re-checked, so its state stays as it was.
        if (rule.kind === 'broken_image' && o.current.image_url !== '' && o.current.image_ok === null) continue;

        const was = inBefore.has(`${rule.id}:${o.product_id}`);
        const now = inCondition(rule, o);
        if (now === was) continue;

        if (now) {
          const row = await tx.get<{ id: string }>(
            `INSERT INTO alerts (rule_id, rule_name, kind, product_id, retailer, brand, scrape_run_id, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            rule.id, rule.name, rule.kind, o.product_id, o.retailer, o.brand, scrapeRunId,
            JSON.stringify(alertDetails(rule, o)),
          );
          ids.push(Number(row!.id));
        }
        await tx.run(
          `INSERT INTO alert_state (rule_id, product_id, in_condition, last_scrape_run_id, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (rule_id, product_id)
           DO UPDATE SET in_condition = EXCLUDED.in_condition, last_scrape_run_id = EXCLUDED.last_scrape_run_id, updated_at = NOW()`,
          rule.id, o.product_id, now, scrapeRunId,
        );
      }
    }
    return ids;
  });

  logger.info('Alert rules evaluated', {
    operation: 'evaluateRun', scrapeRunId, rules: rules.length, products: observations.length, created: alertIds.length,
  });
  if (alertIds.length > 0 && deps.notify) {
    await deps.notify(alertIds).catch((err: unknown) => logger.warn('Alert notification failed', {
      operation: 'evaluateRun', scrapeRunId, error: err instanceof Error ? err.message : String(err),
    }));
  }
  return { created: alertIds.length, alertIds };
}

/** Evaluate a persisted run with the app's database and image checker; the caller says who is notified. */
export async function runAlerts(
  scrapeRunId: number,
  deps: Pick<EvaluateDeps, 'notify'> = {},
): Promise<{ created: number; alertIds: number[] }> {
  const db = await DatabaseService.getInstance();
  return evaluateRun(db, scrapeRunId, { checkImages: (urls) => checkImages(db, urls), notify: deps.notify });
}
