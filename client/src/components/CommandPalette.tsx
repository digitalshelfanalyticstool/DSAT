'use client';

import React, { useState, useEffect, useId, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import type { Job } from '@/lib/api-client';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { ROUTES } from '@/lib/routes';
import { timeAgo } from '@/lib/format';

interface NavItem {
  label: string;
  description: string;
  href: string;
  category: 'Navigation' | 'Admin' | 'Recent Jobs';
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = ROUTES.map((r) => ({
  label: r.title ?? r.label,
  description: r.description,
  href: r.href,
  category: r.section === 'admin' ? 'Admin' : 'Navigation',
  adminOnly: r.section === 'admin',
}));

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  userRole?: string;
}

export function CommandPalette({ open, onClose, userRole }: Readonly<CommandPaletteProps>) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // ARIA ids for the combobox/listbox relationship.
  const listboxId = useId();
  const inputId = useId();

  // Ref-counted body scroll lock while the palette is open.
  useBodyScrollLock(open);

  // Lazy-fetch recent jobs when the palette opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.getJobs({ page: 1, page_size: 10 });
        if (!cancelled) setRecentJobs(res.jobs ?? []);
      } catch {
        // Silently skip if jobs cannot be loaded
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const jobItems: NavItem[] = recentJobs.map((j) => ({
    label: `${j.site} · ${j.brand}`,
    description: `${j.status} · ${timeAgo(j.created_at)}`,
    href: `/jobs/${j.job_id}`,
    category: 'Recent Jobs',
  }));

  const allItems: NavItem[] = [...NAV_ITEMS, ...jobItems];

  const filteredItems = allItems.filter((item) => {
    if (item.adminOnly && userRole !== 'admin') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
  });

  const selectItem = useCallback((item: NavItem) => {
    onClose();
    router.push(item.href);
  }, [onClose, router]);

  // Capture previously-focused element + restore on close. Also
  // toggles `inert` + `aria-hidden` on the underlying <main> so SR/keyboard
  // users don't escape the palette.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const mainEl = document.querySelector<HTMLElement>('main');
    if (mainEl) {
      mainEl.setAttribute('inert', '');
      mainEl.setAttribute('aria-hidden', 'true');
    }
    return () => {
      if (mainEl) {
        mainEl.removeAttribute('inert');
        mainEl.removeAttribute('aria-hidden');
      }
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          selectItem(filteredItems[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => globalThis.window.removeEventListener('keydown', handleKeyDown);
  }, [open, filteredItems, selectedIndex, selectItem, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    // jsdom (and some older browsers) don't implement scrollIntoView — guard.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Trap Tab inside the palette. Only the search input + the visible
  // list options participate in the focus order.
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  // Group items by category
  const grouped: Record<string, NavItem[]> = {};
  for (const item of filteredItems) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  let globalIndex = 0;
  const activeOptionId = filteredItems.length > 0 ? `${listboxId}-${selectedIndex}` : undefined;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={handleDialogKeyDown}
      className="fixed inset-0 z-[var(--z-toast)] flex items-start justify-center pt-[20vh]"
    >
      {/* Backdrop — purely presentational; the click-to-close handler stays on a button below for keyboard parity */}
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm cursor-default"
      />
      <div className="relative w-full max-w-lg bg-surface rounded-xl shadow-2xl border border-hairline overflow-hidden">
        <div className="p-3 border-b border-hairline">
          <label htmlFor={inputId} className="sr-only">
            Search commands
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-controls={listboxId}
            aria-expanded={true}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            className="w-full px-3 py-2 text-sm bg-surface-secondary border border-hairline rounded-lg outline-none focus:border-accent-400 focus:ring-1 focus:ring-accent-400"
          />
        </div>

        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Command results"
          className="max-h-72 overflow-y-auto py-2 m-0 list-none"
        >
          {filteredItems.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-ink-muted">No results found</li>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <li key={category} role="presentation">
                <div
                  className="px-4 py-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wider"
                  aria-hidden="true"
                >
                  {category}
                </div>
                {/* NOSONAR(typescript:S6819): WAI-ARIA listbox-with-grouping
                    pattern requires <ul role="group"> nested inside the
                    parent <ul role="listbox">. <optgroup> is only valid as
                    a child of <select>; <fieldset>/<details>/<address>
                    would all break the listbox/option semantic relationship
                    and the aria-activedescendant wiring on the input. */}
                <ul // NOSONAR(typescript:S6819): see WAI-ARIA listbox-with-grouping rationale block above.
                  role="group"
                  aria-label={category}
                  className="m-0 p-0 list-none"
                >
                  {items.map((item) => {
                    const idx = globalIndex++;
                    const isSelected = idx === selectedIndex;
                    return (
                      // NOSONAR(typescript:S6847,typescript:S6848): textbook
                      // WAI-ARIA listbox/option pattern — <li role="option">
                      // is the spec-prescribed child of the <ul role="listbox">
                      // above. Converting to <button> would break the
                      // listbox/option semantic relationship and the parent's
                      // aria-activedescendant wiring. Full keyboard contract
                      // is present (onKeyDown for Enter/Space, plus the
                      // input's ArrowUp/Down handler driving aria-activedescendant).
                      <li
                        key={item.href}
                        id={`${listboxId}-${idx}`}
                        role="option"
                        aria-selected={isSelected}
                        data-index={idx}
                        onClick={() => selectItem(item)}
                        onKeyDown={(e) => {
                          // Listbox selection is driven by the input's keydown
                          // handler (ArrowUp/Down + Enter). Local keydown is
                          // here to satisfy jsx-a11y's keyboard pairing rule
                          // for elements with click handlers.
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            selectItem(item);
                          }
                        }}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors cursor-pointer ${
                          isSelected ? 'bg-accent-50 text-accent' : 'text-ink hover:bg-surface-secondary'
                        }`}
                      >
                        <div>
                          <div className="text-sm font-medium">{item.label}</div>
                          <div className="text-xs text-ink-muted">{item.description}</div>
                        </div>
                        {isSelected && (
                          <span className="text-xs text-ink-muted" aria-hidden="true">
                            Enter
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>

        <div
          className="px-4 py-2 border-t border-hairline bg-surface-secondary flex items-center gap-4 text-xs text-ink-muted"
          aria-hidden="true"
        >
          <span>{'↑↓ navigate'}</span>
          <span>{'↵ select'}</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
