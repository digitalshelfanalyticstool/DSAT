'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/lib/sign-out';
import { pageTitle } from '@/lib/routes';

interface HeaderProps {
  user?: {
    username: string;
    role: string;
  } | null;
}

export const Header: React.FC<HeaderProps> = ({ user }) => {
  const pathname = usePathname();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);


  const closeUserMenu = useCallback(() => {
    setUserMenuOpen(false);
    userMenuTriggerRef.current?.focus();
  }, []);

  // Close user dropdown when clicking outside or pressing Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeUserMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeUserMenu]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-hairline glass">
        <div className="px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Page title — left side with space for sidebar */}
            <div className="flex items-center gap-4">
              {/* Spacer for mobile hamburger button */}
              <div className="lg:hidden w-10" />
              <h1 className="text-lg font-display font-semibold text-ink">
                {pageTitle(pathname)}
              </h1>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-3">
              {/* User dropdown */}
              {user ? (
                <div className="relative" ref={userMenuRef}>
                  <button
                    ref={userMenuTriggerRef}
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-ink-muted hover:text-ink hover:bg-surface-secondary transition-all duration-150"
                    aria-label="User menu"
                    aria-expanded={userMenuOpen}
                    aria-haspopup="menu"
                    aria-controls="user-menu-dropdown"
                  >
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-violet flex items-center justify-center">
                      <span className="text-xs font-medium text-white">
                        {user.username.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="hidden sm:inline font-medium">{user.username}</span>
                    {/* eslint-disable-next-line no-restricted-syntax -- decorative icon, aria-hidden */}
                    <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {userMenuOpen && (
                    <div
                      id="user-menu-dropdown"
                      role="menu"
                      className="absolute right-0 mt-2 w-56 rounded-xl shadow-premium-lg bg-surface border border-hairline z-50 animate-scale-in overflow-hidden"
                    >
                      <div className="px-4 py-3 border-b border-hairline">
                        <p className="text-sm font-medium text-ink">{user.username}</p>
                        <p className="text-xs text-ink-muted capitalize">{user.role}</p>
                      </div>
                      <div className="py-1">
                        <Link
                          href="/account"
                          role="menuitem"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink hover:bg-surface-secondary transition-colors"
                          onClick={() => setUserMenuOpen(false)}
                        >
                          {/* eslint-disable-next-line no-restricted-syntax -- decorative icon, aria-hidden */}
                          <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          Account Settings
                        </Link>
                      </div>
                      <div className="border-t border-hairline py-1">
                        <button
                          role="menuitem"
                          onClick={() => void signOut()}
                          className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-rose-600 hover:bg-rose-50 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                          </svg>
                          Sign out
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link href="/login" className="text-sm font-medium text-ink-muted hover:text-ink transition-colors">
                  Login
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
