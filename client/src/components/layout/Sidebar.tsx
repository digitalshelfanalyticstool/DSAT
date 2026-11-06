'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { signOut } from '@/lib/sign-out';
import { ROUTES, type AppRoute } from '@/lib/routes';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { usePolling } from '@/hooks/usePolling';

const STORAGE_KEY = 'sidebar-collapsed';
const UNREAD_POLL_MS = 60_000;
/** Dispatched on window by the Alerts page after marking alerts read, so the badge updates at once. */
export const ALERTS_READ_EVENT = 'alerts-read';

interface SidebarProps {
  user?: {
    username: string;
    role: string;
  } | null;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const mainRoutes = ROUTES.filter((r) => r.nav && r.section === 'main');
const adminRoutes = ROUTES.filter((r) => r.nav && r.section === 'admin');

function NavIcon({ paths }: Readonly<{ paths: string[] }>) {
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d} />
      ))}
    </svg>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({ user, onCollapsedChange }) => {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Refs for the imperative <dialog> focus trap.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  // Initial value is set synchronously from the <html data-sidebar-collapsed>
  // attribute that layout.tsx's inline script paints before hydration — this
  // eliminates the post-hydration collapse flash.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.dataset.sidebarCollapsed === 'true';
  });

  // Sync parent on initial mount (MainLayout needs to know the value).
  useEffect(() => {
    onCollapsedChange?.(collapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      document.documentElement.dataset.sidebarCollapsed = String(next);
      onCollapsedChange?.(next);
      return next;
    });
  }, [onCollapsedChange]);

  // Unread-alert badge: polled while the tab is visible, refreshed when it becomes visible again.
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const signedIn = Boolean(user);
  const refreshUnread = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    apiClient.getUnreadAlertCount().then((r) => setUnreadAlerts(r.count), () => {});
  }, []);
  usePolling(refreshUnread, signedIn ? UNREAD_POLL_MS : null);
  useEffect(() => {
    if (!signedIn) return;
    refreshUnread();
    document.addEventListener('visibilitychange', refreshUnread);
    globalThis.addEventListener(ALERTS_READ_EVENT, refreshUnread);
    return () => {
      document.removeEventListener('visibilitychange', refreshUnread);
      globalThis.removeEventListener(ALERTS_READ_EVENT, refreshUnread);
    };
  }, [signedIn, pathname, refreshUnread]);

  const badgeCount = (r: AppRoute) => (r.badge === 'unreadAlerts' ? unreadAlerts : 0);

  const isActive = (path: string) => pathname === path;
  const startsWith = (prefix: string) => pathname.startsWith(prefix);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Close on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll on mobile open — via the shared ref-counted hook so the
  // Modal primitive and this drawer cooperate instead of clobbering each other.
  useBodyScrollLock(mobileOpen);

  // Drive the <dialog> imperatively so the browser provides focus-trap,
  // backdrop, and Esc-to-close natively. Restore focus to the hamburger
  // button on close so keyboard users don't lose their place.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (mobileOpen && !d.open) {
      d.showModal();
    } else if (!mobileOpen && d.open) {
      d.close();
      hamburgerRef.current?.focus();
    }
  }, [mobileOpen]);


  const navLinkClass = (active: boolean) =>
    `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
      collapsed ? 'justify-center' : ''
    } ${
      active
        ? 'text-white bg-white/10'
        // eslint-disable-next-line no-restricted-syntax -- contrast OK on dark surface (gray-400 on slate-900 = 5.78:1)
        : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
    }`;

  const renderNavLink = (
    href: string,
    icon: React.ReactNode,
    label: string,
    active: boolean,
    onClick?: () => void,
    badge = 0,
  ) => (
    <Link
      key={href}
      href={href}
      className={navLinkClass(active)}
      onClick={onClick ?? closeMobile}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[60%] rounded-r-full bg-accent" />
      )}
      {icon}
      {!collapsed && <span>{label}</span>}
      {badge > 0 && (
        <span
          aria-label={`${badge} unread alerts`}
          className={`${collapsed ? 'absolute top-1 right-1' : 'ml-auto'} min-w-5 h-5 px-1.5 rounded-full bg-accent text-white text-[11px] font-semibold flex items-center justify-center`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );

  // Full sidebar content (used for both expanded desktop and mobile)
  const sidebarContent = (isCollapsed: boolean) => (
    <>
      {/* Logo */}
      <div className={`shrink-0 ${isCollapsed ? 'px-0 pt-6 pb-4 flex justify-center' : 'px-5 pt-6 pb-4'}`}>
        <Link href="/" className="flex items-center" onClick={closeMobile}>
          {isCollapsed ? (
            <div className="w-8 h-8 rounded bg-gradient-to-br from-accent to-violet flex items-center justify-center">
              <span className="text-xs font-display font-bold text-white">P</span>
            </div>
          ) : (
            <div>
              <p className="text-sm font-display font-semibold text-white tracking-wide">Product Scraper</p>
            </div>
          )}
        </Link>
      </div>

      {/* Nav sections */}
      <nav className={`flex-1 ${isCollapsed ? 'px-2' : 'px-3'} py-2 space-y-6 overflow-y-auto`} aria-label="Main navigation">
        <div>
          {isCollapsed ? (
            <div className="mx-auto w-6 h-px bg-white/10 mb-2" />
          ) : (
            <p className="px-3 mb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
              Main
            </p>
          )}
          <div className="space-y-0.5">
            {mainRoutes.map((r) =>
              renderNavLink(r.href, <NavIcon paths={r.icon ?? []} />, r.label, isActive(r.href), undefined, badgeCount(r))
            )}
          </div>
        </div>

        {user?.role === 'admin' && (
          <div>
            {isCollapsed ? (
              <div className="mx-auto w-6 h-px bg-white/10 mb-2" />
            ) : (
              <p className="px-3 mb-2 text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
                Admin
              </p>
            )}
            <div className="space-y-0.5">
              {adminRoutes.map((r) =>
                renderNavLink(r.href, <NavIcon paths={r.icon ?? []} />, r.label, startsWith(r.href))
              )}
            </div>
          </div>
        )}
      </nav>

      {/* User section */}
      {user && (
        <div className={`shrink-0 border-t border-white/10 ${isCollapsed ? 'px-2' : 'px-3'} py-4`}>
          {isCollapsed ? (
            <div className="flex justify-center mb-3">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center" title={user.username}>
                <span className="text-sm font-medium text-gray-300">
                  {user.username.charAt(0).toUpperCase()}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                <span className="text-sm font-medium text-gray-300">
                  {user.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-200 truncate">{user.username}</p>
                <p className="text-xs text-gray-400 capitalize">{user.role}</p>
              </div>
            </div>
          )}
          <div className="space-y-0.5">
            <Link
              href="/account"
              className={navLinkClass(isActive('/account'))}
              onClick={closeMobile}
              title={isCollapsed ? 'Account' : undefined}
            >
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              {!isCollapsed && <span>Account</span>}
            </Link>
            <button
              onClick={() => { closeMobile(); void signOut(); }}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-rose-400 hover:text-rose-300 hover:bg-white/[0.06] transition-all duration-150 ${isCollapsed ? 'justify-center' : ''}`}
              title={isCollapsed ? 'Sign out' : undefined}
            >
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              {!isCollapsed && <span>Sign out</span>}
            </button>
          </div>
        </div>
      )}

      {/* Collapse/Expand toggle — desktop only */}
      <div className={`hidden lg:block shrink-0 border-t border-white/10 ${isCollapsed ? 'px-2' : 'px-3'} py-3`}>
        <button
          onClick={toggleCollapsed}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-300 hover:bg-white/[0.06] transition-all duration-150 ${isCollapsed ? 'justify-center' : ''}`}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? (
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          ) : (
            <>
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 lg:z-40 transition-[width] duration-200 ease-in-out ${
          collapsed ? 'lg:w-[72px]' : 'lg:w-[260px]'
        }`}
        style={{ backgroundColor: 'var(--color-sidebar)' }}
        aria-label="Sidebar navigation"
      >
        {sidebarContent(collapsed)}
      </aside>

      {/* Mobile hamburger button */}
      <button
        ref={hamburgerRef}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-surface shadow-premium border border-hairline text-ink-muted hover:text-ink hover:bg-surface-secondary transition-all duration-150"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={mobileOpen}
        aria-controls="mobile-nav-dialog"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile slide-in sidebar — <dialog> is opened imperatively via showModal()
          so the browser provides a real focus trap, ::backdrop, and Esc-to-close
          per the native Dialog Element spec. `open` attribute deliberately
          omitted — showModal controls visibility. Click-outside-cancel
          intentionally dropped — Sonar's a11y rules treat onClick on a non-
          interactive element as a violation. Dismissal: Esc, Close button. */}
      <dialog
        ref={dialogRef}
        id="mobile-nav-dialog"
        className={`lg:hidden fixed top-0 left-0 z-50 h-full w-[280px] flex flex-col shadow-premium-xl transition-transform duration-300 p-0 m-0 border-none bg-transparent backdrop:bg-gray-900/40 backdrop:backdrop-blur-sm ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          backgroundColor: 'var(--color-sidebar)',
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
          // Respect iPhone notch + home-indicator. `env()` returns 0 on
          // non-notched devices so these are a safe no-op elsewhere.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        aria-label="Navigation menu"
        aria-modal="true"
        onClose={closeMobile}
      >
        {/* Close button */}
        <button
          // eslint-disable-next-line no-restricted-syntax -- contrast OK on dark surface (gray-400 on slate-900 = 5.78:1)
          className="absolute top-4 right-4 p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          onClick={closeMobile}
          aria-label="Close navigation menu"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {sidebarContent(false)}
      </dialog>
    </>
  );
};
