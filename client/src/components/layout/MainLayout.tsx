'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { GlobalBanner } from './GlobalBanner';
import { CmdKHint } from '@/components/CmdKHint';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';
import { useSession } from '@/providers/SessionProvider';
import { signOut, IDLE_SIGN_OUT_MS } from '@/lib/sign-out';

interface MainLayoutProps {
  children: React.ReactNode;
}

/**
 * App chrome for signed-in pages. Identity always comes from the session, so
 * the must_change_password redirect applies on every page that uses it.
 */
export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const router = useRouter();
  const { session } = useSession();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    typeof document !== 'undefined' && document.documentElement.dataset.sidebarCollapsed === 'true'
  );

  const username = session?.user.username;
  const role = session?.user.role;
  const user = useMemo(() => (username && role ? { username, role } : null), [username, role]);

  const handleIdle = useCallback(() => {
    void signOut({ expired: true });
  }, []);

  useIdleTimeout(handleIdle, IDLE_SIGN_OUT_MS);

  const mustChangePassword = session?.user.must_change_password === true;
  useEffect(() => {
    if (mustChangePassword) {
      router.push('/change-password');
    }
  }, [mustChangePassword, router]);

  return (
    <div className="min-h-dvh bg-surface-secondary/50">
      {/* Sidebar */}
      <Sidebar user={user} onCollapsedChange={setSidebarCollapsed} />

      {/* Main content area — offset by sidebar width on desktop */}
      <div className={`min-h-dvh flex flex-col transition-[padding-left] duration-200 ease-in-out ${
        sidebarCollapsed ? 'lg:pl-[72px]' : 'lg:pl-[260px]'
      }`}>
        <Header user={user} />
        <GlobalBanner />

        {user && (
          <div className="px-4 sm:px-6 lg:px-8 pt-4 max-w-[1400px] w-full mx-auto">
            <CmdKHint />
          </div>
        )}

        <main
          id="main-content"
          tabIndex={-1}
          // pt-20 on mobile reserves space for the fixed hamburger (top-4 + h-~10)
          // so page h1 / breadcrumbs don't sit underneath. Restored to pt-8
          // on lg+ where the sidebar replaces the hamburger.
          className="flex-1 px-4 sm:px-6 lg:px-8 pt-20 pb-8 lg:pt-8 max-w-[1400px] w-full mx-auto focus:outline-none"
        >
          {children}
        </main>

        <footer className="mt-auto border-t border-hairline">
          <div className="px-4 sm:px-6 lg:px-8 max-w-[1400px] mx-auto">
            {/* Footer copy uses text-ink-muted (>= 4.5:1 on bg-surface-secondary/50) per WCAG 1.4.3. */}
            <div className="py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-muted">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 rounded bg-gradient-to-br from-accent to-violet flex items-center justify-center">
                  <span className="text-[9px] font-display font-bold text-white">P</span>
                </div>
                <span className="font-medium text-ink">Product Scraper</span>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};
