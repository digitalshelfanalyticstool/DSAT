/**
 * Tight CSP for the Bull Board dashboard.
 *
 * Bull Board's bundled HTML (`@bull-board/ui` `dist/index.ejs`) contains:
 *   - no executable inline `<script>` — the only inline `<script>` is
 *     `type="application/json"` (the UI config blob), which browsers never
 *     execute, so `script-src` doesn't need `'unsafe-inline'`;
 *   - one inline `<style>` block plus a handful of inline `style="…"` attributes
 *     (a static loading placeholder shown for ~200 ms before the React bundle
 *     hydrates), and a `<link>` to Google Fonts.
 *
 * So `script-src 'self'` is sufficient, and `style-src` can use SHA-256 hashes
 * (plus `'unsafe-hashes'` so the hashes apply to the `style="…"` attributes)
 * instead of `'unsafe-inline'`. The hashes are derived from the *installed*
 * template at process start, so a `@bull-board/ui` bump that changes the
 * loading markup is picked up automatically. If the template can't be read
 * (e.g. the path moves in a future major), `style-src` falls back to
 * `'unsafe-inline'` — degraded but functional — and a warning is logged.
 * (`script-src` stays `'self'` regardless: if a future version introduced an
 * executable inline script, that would surface as a console CSP violation /
 * test failure rather than a silent loosening.)
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger';

const logger = createLogger('bull-board-csp');

function sha256Source(value: string): string {
  return `'sha256-${crypto.createHash('sha256').update(value, 'utf8').digest('base64')}'`;
}

/**
 * SHA-256 source hashes for every inline `<style>` block and `style="…"`
 * attribute in the Bull Board UI template, or `null` if the template can't
 * be located/read.
 */
export function bullBoardInlineStyleHashes(): string[] | null {
  try {
    const templatePath = require.resolve('@bull-board/ui/dist/index.ejs');
    const src = fs.readFileSync(templatePath, 'utf8');
    const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    const attrs = [...src.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]);
    const all = [...blocks, ...attrs];
    if (all.length === 0) return null;
    return [...new Set(all.map(sha256Source))];
  } catch (err) {
    logger.warn('Could not read @bull-board/ui template — Bull Board CSP falls back to style-src \'unsafe-inline\'', {
      operation: 'bullBoardInlineStyleHashes',
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Helmet CSP directives for the `/admin/queues` Bull Board routes.
 */
export function buildBullBoardCspDirectives(isProduction: boolean): Record<string, Iterable<string> | null> {
  const hashes = bullBoardInlineStyleHashes();
  const styleSrc = hashes
    ? ["'self'", "'unsafe-hashes'", ...hashes, 'https://fonts.googleapis.com']
    : ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'];

  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc,
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: isProduction ? [] : null,
  };
}
