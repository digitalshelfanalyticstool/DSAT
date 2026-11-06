/**
 * Browser-side Sentry init. Next.js auto-loads this file for the client
 * runtime. Errors-only mode: tracesSampleRate / replaysSampleRate are 0
 * so the SDK adds minimal payload weight to the bundle and zero perf
 * cost on the page. The DSN must be exposed to the browser, so it's read
 * from NEXT_PUBLIC_SENTRY_DSN and baked in at build time.
 *
 * Set NEXT_PUBLIC_SENTRY_DSN to enable; leaving it unset is a clean no-op.
 */

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NODE_ENV ??
      'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
