/**
 * Alert webhooks: after a run creates alerts, each enabled webhook gets one
 * JSON POST listing them. The body's `text` is a readable summary, so a Slack
 * incoming-webhook URL works as-is. With a secret set, the request carries
 * `X-Signature: sha256=<HMAC-SHA256 of the body>`. Delivery runs on the queue,
 * which retries a failed POST.
 */
import { createHmac } from 'node:crypto';
import { DatabaseService } from '../database';
import { decrypt } from '../secrets';
import type { EncryptedEnvelope } from '../secrets';
import type { AlertKind } from './evaluate';
import { getQueueService } from '../queue-service';
import type { WebhookJobPayload } from '../queues';

const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookAlert {
  id: number;
  kind: AlertKind;
  rule_name: string;
  retailer: string;
  brand: string;
  product: { id: number; title: string; style_id: string; url: string };
  details: Record<string, unknown>;
  created_at: string;
}

export interface WebhookPayload { event: 'alerts'; alerts: WebhookAlert[]; text: string; sent_at: string }

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toFixed(2)}` : null);

/**
 * Scraped values (titles, URLs) are retailer-controlled. Escape them for Slack
 * mrkdwn (`&`, `<`, `>`: no `<!channel>` or `<url|label>` links), defuse plain
 * `@channel`/`@here`/`@everyone`, and keep each alert on one line.
 */
function chatText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/@(?=(?:channel|here|everyone)\b)/gi, '@\u200b');
}

function summaryLine(a: WebhookAlert): string {
  const who = `${chatText(a.product.title || a.product.style_id)} (${chatText(a.retailer)}, ${chatText(a.brand)})`;
  const prices = [money(a.details.old_price), money(a.details.new_price)].filter(Boolean).join(' → ');
  const parts: string[] = (() => {
    switch (a.kind) {
      case 'price_below': return [`Price below ${money(a.details.threshold)}: ${who}`, prices];
      case 'price_drop': return [`Price drop: ${who}`, prices];
      case 'out_of_stock': return [`Out of stock: ${who}`];
      case 'broken_image':
        return a.details.reason === 'missing'
          ? [`Missing image: ${who}`]
          : [`Broken image: ${who}`, chatText(a.details.image_url)];
    }
  })();
  return [...parts, chatText(a.product.url)].filter(Boolean).join(' ');
}

export function buildPayload(alerts: WebhookAlert[], now = new Date()): WebhookPayload {
  const header = `${alerts.length} new alert${alerts.length === 1 ? '' : 's'}`;
  return { event: 'alerts', alerts, text: [header, ...alerts.map(summaryLine)].join('\n'), sent_at: now.toISOString() };
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** The alerts as webhook entries, oldest first. */
export async function loadWebhookAlerts(db: DatabaseService, alertIds: number[]): Promise<WebhookAlert[]> {
  const rows = await db.all<{
    id: string; kind: AlertKind; rule_name: string; retailer: string; brand: string; details: Record<string, unknown>;
    created_at: Date; product_id: number; title: string | null; style_id: string; url: string | null;
  }>(
    `SELECT a.id, a.kind, a.rule_name, a.retailer, a.brand, a.details, a.created_at,
            p.id AS product_id, p.title, p.style_id, p.url
     FROM alerts a JOIN products p ON p.id = a.product_id
     WHERE a.id = ANY($1) ORDER BY a.id`,
    alertIds,
  );
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, rule_name: r.rule_name, retailer: r.retailer, brand: r.brand, details: r.details,
    created_at: new Date(r.created_at).toISOString(),
    product: { id: r.product_id, title: r.title ?? '', style_id: r.style_id, url: r.url ?? '' },
  }));
}

/**
 * POST a body to one webhook and record the result on it. Throws on a failed
 * or non-2xx delivery so the queue retries. Returns the HTTP status.
 */
export async function deliver(
  db: Pick<DatabaseService, 'get' | 'run'>,
  webhookId: number,
  body: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  const hook = await db.get<{ id: number; url: string; secret_encrypted: EncryptedEnvelope | null }>(
    'SELECT id, url, secret_encrypted FROM alert_webhooks WHERE id = $1', webhookId,
  );
  if (!hook) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'DigitalShelfAnalytics-Webhook' };
  if (hook.secret_encrypted) headers['X-Signature'] = signBody(body, decrypt<string>(hook.secret_encrypted));

  let status: number | null = null;
  let error: string | null = null;
  try {
    // Admins choose the URL (a LAN relay is a fair target), but the receiver
    // doesn't get to bounce the signed body somewhere else: a redirect is a failure.
    const res = await fetchFn(hook.url, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await db.run(
    'UPDATE alert_webhooks SET last_status = $1, last_error = $2, last_attempt_at = NOW() WHERE id = $3',
    status, error, webhookId,
  );
  if (error) throw new Error(error);
  return status;
}

/** Queue one delivery per enabled webhook. */
export async function enqueueWebhookDelivery(alertIds: number[]): Promise<void> {
  const db = await DatabaseService.getInstance();
  const hooks = await db.all<{ id: number }>('SELECT id FROM alert_webhooks WHERE enabled ORDER BY id');
  for (const hook of hooks) {
    await getQueueService().enqueueWebhookJob({ webhookId: hook.id, alertIds });
  }
}

/** Queue worker: build the payload from the alerts and deliver it. */
export async function handleWebhookJob(data: WebhookJobPayload): Promise<void> {
  const db = await DatabaseService.getInstance();
  const alerts = await loadWebhookAlerts(db, data.alertIds);
  if (alerts.length === 0) return;
  await deliver(db, data.webhookId, JSON.stringify(buildPayload(alerts)));
}
