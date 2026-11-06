'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/providers/SessionProvider';
import { apiClient } from '@/lib/api-client';
import { PasswordSignInForm } from './PasswordSignInForm';

function SessionExpiredBanner() {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-warning-light bg-warning-light/30 p-4">
      {/* eslint-disable-next-line no-restricted-syntax -- decorative icon, aria-hidden */}
      <svg className="mt-0.5 h-5 w-5 shrink-0 text-warning-dark" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <p className="text-sm text-warning-dark">
        Your session has expired. Please login again.
      </p>
    </div>
  );
}

// Fixed codes from server/src/routes/auth-sso.ts. Anything else in the URL is
// ignored, so a crafted link cannot put its own words on this page.
const SSO_FAILED = 'We could not sign you in with single sign-on. Please try again.';
const SSO_ERRORS: Record<string, string> = {
  disabled: 'Single sign-on is turned off. Sign in with your password.',
  not_allowed: 'Access not set up yet — ask your admin.',
  admin_link_required: 'Admin accounts connect SSO from their account page after signing in with a password.',
  inactive: 'This account is deactivated. Ask your admin.',
  failed: SSO_FAILED,
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session } = useSession();

  // Already signed in: leave the login page rather than show it behind a live session.
  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  // A fresh install has no users yet: the first visitor creates the admin.
  useEffect(() => {
    apiClient.getSetupStatus()
      .then(({ needsSetup }) => { if (needsSetup) router.replace('/setup'); })
      .catch(() => { /* the login form still works; nothing to show */ });
  }, [router]);

  const [sso, setSso] = useState<{ enabled: boolean; label: string } | null>(null);
  const [ssoError, setSsoError] = useState('');
  useEffect(() => {
    apiClient.getSsoConfig()
      .then(setSso)
      .catch(() => { /* no SSO button; the password form still works */ });
  }, []);

  // Back from the identity provider: the session is in the refresh cookie.
  useEffect(() => {
    const code = searchParams.get('sso_error');
    if (code) setSsoError(SSO_ERRORS[code] ?? SSO_FAILED);
    if (searchParams.get('sso') !== '1') return;
    void apiClient.refreshSession().then((ok) => {
      if (ok) globalThis.location.href = '/';
      else setSsoError(SSO_FAILED);
    });
  }, [searchParams]);

  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (searchParams.get('session_expired') === 'true') setSessionExpired(true);
  }, [searchParams]);

  return (
    <main className="min-h-dvh flex flex-col lg:flex-row">
      {/* ── Left decorative panel (desktop only) ── */}
      <div className="hidden lg:flex lg:w-[38%] relative overflow-hidden bg-[var(--color-sidebar)] flex-col items-center justify-center px-12">
        {/* Gradient mesh background */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 20% 50%, rgba(99,102,241,0.15) 0%, transparent 60%), ' +
              'radial-gradient(ellipse at 80% 20%, rgba(139,92,246,0.12) 0%, transparent 50%), ' +
              'radial-gradient(ellipse at 60% 80%, rgba(99,102,241,0.08) 0%, transparent 50%)',
          }}
        />

        {/* Subtle dot grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'radial-gradient(circle, #ffffff 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        {/* Floating geometric shapes */}
        <div className="absolute top-[15%] left-[10%] w-64 h-64 rounded-full border border-accent/10 animate-[pulse-dot_6s_ease-in-out_infinite]" />
        <div className="absolute bottom-[20%] right-[8%] w-48 h-48 rounded-full border border-violet/10 animate-[pulse-dot_8s_ease-in-out_infinite]" />
        <div className="absolute top-[60%] left-[60%] w-32 h-32 rounded-2xl border border-accent/[0.07] rotate-45 animate-[pulse-dot_7s_ease-in-out_infinite]" />

        {/* Accent glow orb */}
        <div className="absolute top-1/3 left-1/4 w-96 h-96 bg-accent/[0.06] rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-violet/[0.05] rounded-full blur-3xl" />

        {/* Content */}
        <div className="relative z-10 text-center max-w-md">
          {/* Logo mark */}
          <div className="mx-auto mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-violet shadow-glow-accent">
            <svg
              className="h-8 w-8 text-white"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"
              />
            </svg>
          </div>

          <h1 className="font-display text-3xl font-bold text-white tracking-tight">
            Product Scraper
          </h1>
          {/* eslint-disable-next-line no-restricted-syntax -- contrast OK on dark surface (gray-900 panel; gray-400 → 5.78:1 PASS). */}
          <p className="mt-3 text-ink-muted text-base leading-relaxed">
            Enterprise-grade product data extraction
          </p>

          {/* Feature highlights */}
          <div className="mt-12 space-y-4 text-left">
            {[
              { label: 'Multi-retailer scraping', desc: 'Any retailer, through a pluggable adapter' },
              { label: 'Real-time progress', desc: 'Live job tracking with SSE streaming' },
              { label: 'Excel reports', desc: 'Automated variant data export' },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <div className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20">
                  <svg className="h-3 w-3 text-accent-light" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{item.label}</p>
                  <p className="text-xs text-ink-muted">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-6 py-12 lg:px-16 lg:pr-[12%]">
        {/* Mobile logo (shown only on small screens) */}
        <div className="mb-10 flex flex-col items-center lg:hidden">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-violet shadow-glow-accent">
            <svg
              className="h-6 w-6 text-white"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"
              />
            </svg>
          </div>
          <h1 className="font-display text-xl font-bold text-ink tracking-tight">Product Scraper</h1>
        </div>

        <div className="w-full max-w-md animate-in">
          <div className="mb-8">
            <h2 className="font-display text-2xl font-bold text-ink">Welcome back</h2>
            <p className="mt-1 text-sm text-ink-muted">Sign in to continue</p>
          </div>

          {sessionExpired && <SessionExpiredBanner />}

          {ssoError && (
            <div role="alert" className="mb-6 rounded-xl border border-error-light bg-error-light/30 p-4">
              <p className="text-sm text-error-dark">{ssoError}</p>
            </div>
          )}

          <PasswordSignInForm />

          {sso?.enabled && (
            <div className="mt-6">
              <a
                href={`${apiClient.getBaseUrl()}/auth/sso/start`}
                className="flex w-full items-center justify-center rounded-lg border border-hairline px-4 py-2 text-sm font-medium text-ink hover:bg-surface-secondary"
              >
                Sign in with {sso.label}
              </a>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh bg-surface flex items-center justify-center px-4">
        <div className="text-center text-ink-muted">Loading...</div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
