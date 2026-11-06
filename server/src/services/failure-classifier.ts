/**
 * Classifies a thrown error into a coarse failure category for operational
 * dashboards. The categories are intentionally coarse and biased toward
 * operator-actionability rather than precise root-cause analysis: a human
 * looking at a failure-mode breakdown should be able to act on each category
 * without reading the underlying error message.
 *
 * - `bd_quota`: Bright Data plan ceiling hit. Action: lower per-retailer
 *   concurrency or upgrade the BD plan.
 * - `network`: transport-layer failure (timeout, TLS, socket reset). Action:
 *   usually transient; check whether retries succeeded.
 * - `db_error`: PostgreSQL rejected the query. Action: check DB health,
 *   pool exhaustion, statement timeout, schema mismatch.
 * - `retailer_changed`: parser failed because the retailer's HTML or JSON
 *   shape no longer matches what the adapter expects. Action: inspect the
 *   adapter, update selectors or schema, re-run.
 * - `config`: missing or disabled site/brand config, missing credentials.
 *   Action: fix the config in admin or env vars.
 * - `other`: nothing matched. Action: read the raw error message; consider
 *   adding a new pattern to the classifier if this category is recurring.
 *
 * Classification is by case-insensitive substring match on `error.message`.
 * Order matters because a single error can mention multiple keywords; the
 * first matching branch wins.
 */

export type FailureCategory =
  | 'bd_quota'
  | 'network'
  | 'db_error'
  | 'retailer_changed'
  | 'config'
  | 'other';
export function classifyFailure(err: unknown): FailureCategory {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (msg.includes('429') || msg.includes('rate limit')
      || msg.includes('quota exceeded') || msg.includes('plan exceeded')
      || msg.includes('billing')) {
    return 'bd_quota';
  }

  // db_error must precede network because some PG errors mention "timeout" or
  // "connection terminated" but should classify as db, not transport.
  const isPgRelationError = msg.includes('relation') && msg.includes('does not exist');
  if (msg.includes('statement timeout') || msg.includes('connection terminated')
      || isPgRelationError || msg.includes('duplicate key')
      || msg.includes('deadlock') || msg.includes('postgres')
      || msg.includes('postgresql')) {
    return 'db_error';
  }

  if (msg.includes('timeout') || msg.includes('econnreset')
      || msg.includes('econnrefused') || msg.includes('etimedout')
      || msg.includes('fetch failed') || msg.includes('cdp connection')
      || msg.includes('socket hang up') || msg.includes('tls handshake')
      || msg.includes('network')) {
    return 'network';
  }

  if (msg.includes('failed to extract') || msg.includes('no product json')
      || msg.includes('no valid product json') || msg.includes('__initial_config__')
      || msg.includes('not found or required keys')
      || msg.includes('unexpected token') || msg.includes('json parse')) {
    return 'retailer_changed';
  }

  if (msg.includes('not configured') || msg.includes('site is disabled')
      || msg.includes('configuration not found')
      || msg.includes('discovery not implemented')) {
    return 'config';
  }

  return 'other';
}
