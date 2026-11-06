/**
 * Broken-image checks for the `broken_image` alert. An image is broken when a
 * GET fails, isn't 2xx, or isn't an image content type. There is deliberately
 * no byte-size rule: image CDNs serve one asset at very different sizes, and a
 * size heuristic once flagged most real images as placeholders.
 */
import { isIP } from 'node:net';
import type { DatabaseService } from '../database';
import { config } from '../../config';

const CACHE_HOURS = 24;

const MAX_REDIRECTS = 3;

/**
 * Image URLs come from scraped pages, so don't let one aim the server at itself
 * or its network. Checked on every redirect hop. Literal addresses only: a
 * hostname that resolves inward is not caught (the check only learns whether
 * the image loaded, and the worker already fetches retailer URLs anyway).
 */
function isInternalHost(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // "localhost." is localhost
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 6) {
    return host === '::' || host === '::1' || host.startsWith('::ffff:')
      || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function checkImage(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; reason: string | null }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'not an http(s) URL' };
  if (!URL.canParse(url)) return { ok: false, reason: 'invalid URL' };

  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(current.protocol)) return { ok: false, reason: 'not an http(s) URL' };
    if (isInternalHost(current.hostname)) return { ok: false, reason: 'internal address' };

    let res: Response;
    try {
      res = await fetchFn(current.toString(), { redirect: 'manual', signal: AbortSignal.timeout(config.alerts.imageCheckTimeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { ok: false, reason: timedOut ? 'timed out' : `request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Only the headers matter; don't download the image.
    await res.body?.cancel().catch(() => {});

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return { ok: false, reason: 'too many redirects' };
      if (!URL.canParse(location, current.toString())) return { ok: false, reason: 'invalid URL' };
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('image/')) return { ok: false, reason: `not an image (${type || 'no content type'})` };
    return { ok: true, reason: null };
  }
}

/**
 * URL → loads as an image. Results under 24h old come from `image_checks`; the
 * rest are checked (a few at a time) and stored.
 */
export async function checkImages(
  db: DatabaseService,
  urls: string[],
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  if (urls.length === 0) return results;

  const cached = await db.all<{ url: string; ok: boolean }>(
    `SELECT url, ok FROM image_checks WHERE url = ANY($1) AND checked_at > NOW() - make_interval(hours => $2)`,
    urls, CACHE_HOURS,
  );
  for (const row of cached) results.set(row.url, row.ok);

  const queue = urls.filter((u) => !results.has(u));
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const { ok, reason } = await checkImage(url, fetchFn);
      results.set(url, ok);
      await db.run(
        `INSERT INTO image_checks (url, ok, reason, checked_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, reason = EXCLUDED.reason, checked_at = NOW()`,
        url, ok, reason,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, config.alerts.imageCheckConcurrency) }, worker));
  return results;
}
