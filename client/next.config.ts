import type { NextConfig } from 'next';
import bundleAnalyzer from '@next/bundle-analyzer';
import { withSentryConfig } from '@sentry/nextjs';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  // The Docker image runs Next's self-contained server; `next start` can't, so
  // only the image build sets NEXT_OUTPUT.
  ...(process.env.NEXT_OUTPUT === 'standalone' && { output: 'standalone' as const }),
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

// Sentry wraps the Next config to wire up automatic error capture and (when
// SENTRY_AUTH_TOKEN is set at build time) source-map upload. Without the
// auth token the build still succeeds — stack traces in Sentry will just be
// minified until source maps are wired up later.
export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  silent: true,
  disableLogger: true,
  // Tunnel route avoids ad blockers eating Sentry events, but adds proxy
  // load on the Next.js server. Skip for now — re-enable if we see drops.
  // tunnelRoute: '/monitoring',
});
