/**
 * Sentry initialization. Imported as the very first thing in index.ts and
 * worker.ts so the SDK can hook into Node's http module before Express loads.
 *
 * Errors-only mode: tracesSampleRate=0 means no transaction sampling, so
 * the OpenTelemetry hooks the SDK registers stay no-ops on the request hot
 * path. SDK-resident memory is ~5MB per process; CPU overhead is
 * negligible unless an exception actually fires.
 *
 * Set SENTRY_DSN to enable; leaving it unset is a clean no-op (useful for
 * local dev and CI).
 */

import dotenv from 'dotenv';
import path from 'node:path';
import * as Sentry from '@sentry/node';

// Load env BEFORE Sentry.init. `override: true` is critical: PM2 caches the
// env captured at first start, so a stale SENTRY_DSN (e.g. an earlier
// placeholder) survives every `pm2 restart` until processes are deleted.
// Forcing override makes `.env` the source of truth on each boot.
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      const headers = event.request?.headers;
      if (headers) {
        delete headers.authorization;
        delete headers.Authorization;
        delete headers.cookie;
        delete headers.Cookie;
        delete headers['x-api-key'];
      }
      return event;
    },
  });
}
