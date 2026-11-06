import type { Metadata, Viewport } from 'next';
import { DM_Sans, Outfit, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import WebVitalsReporter from '@/components/WebVitalsReporter';
import { ToastWrapper } from '@/components/layout/ToastWrapper';
import ErrorBoundary from '@/components/ErrorBoundary';
import { SessionProvider } from '@/providers/SessionProvider';
import { ConfigProvider } from '@/providers/ConfigProvider';
import { PaletteSync } from '@/components/PaletteSync';
import { PALETTES, PALETTE_STORAGE_KEY } from '@/lib/palettes';

/** Pre-hydration script: applies the cached sidebar state and a known palette id. Built from constants only. */
const PRE_HYDRATION_SCRIPT = `try{var s=localStorage.getItem('sidebar-collapsed');if(s==='true')document.documentElement.dataset.sidebarCollapsed='true';var p=localStorage.getItem(${JSON.stringify(PALETTE_STORAGE_KEY)});if(${JSON.stringify(PALETTES.map((x) => x.id))}.indexOf(p)>=0)document.documentElement.dataset.palette=p;}catch(e){}`;

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

// Weight 400 only: JetBrains Mono is used in monospaced badges/IDs/code snippets where a single regular weight is enough;
// shipping the full variable-weight axis was ~50% wasted bytes on every cold load.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Product Scraper',
  description: 'Tracks how retailers price and display your products',
  icons: {
    icon: '/favicon.ico',
  },
};

// viewportFit=cover lets content flow into the notch / home-indicator area on
// iPhone; components that need to avoid those regions opt in via
// `env(safe-area-inset-*)` padding.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${dmSans.variable} ${outfit.variable} ${jetbrainsMono.variable} font-sans`}>
        {/* Skip-to-content link (WCAG 2.4.1 Bypass Blocks). Visible only
            when focused so keyboard users can jump straight to <main>
            instead of tabbing through the whole sidebar on every page. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg focus:shadow-premium-lg focus:outline-none focus:ring-2 focus:ring-white"
        >
          Skip to main content
        </a>
        {/* Sync sidebar-collapsed state to <html> before React hydration to avoid
            CLS. Script is built from constants (PRE_HYDRATION_SCRIPT) — NO
            user-controlled input feeds into it. Only reads one localStorage key and sets one `data-`
            attribute (plus the cached site palette, which PaletteSync refreshes
            from the API). Placed in <body> rather than <head> to avoid conflicting
            with Next App Router's managed <head>. Review-mark the SonarCloud
            hotspot as SAFE. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: PRE_HYDRATION_SCRIPT,
          }}
        />
        {/* Real User Monitoring — captures Core Web Vitals (CLS, INP,
            LCP, TTFB, FCP) and ships them to /api/metrics/web-vitals. Mounted
            once at the root so all routes participate. */}
        <WebVitalsReporter />
        <PaletteSync />
        <ErrorBoundary>
          <SessionProvider>
            <ConfigProvider>
              <ToastWrapper>{children}</ToastWrapper>
            </ConfigProvider>
          </SessionProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
