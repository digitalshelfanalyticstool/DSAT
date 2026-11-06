'use client';

import React, { useEffect, useState } from 'react';

/**
 * Dismissible Cmd+K discoverability chip.
 *
 * Surfaces the command palette keyboard shortcut for new users.
 * Persists dismissal in localStorage under `cmd-k-hint-dismissed` so it never
 * comes back after the user closes it.
 *
 * SSR-safe: localStorage is only read inside `useEffect`, so the server render
 * and the first client render both produce `null`. After hydration we read the
 * persisted state and decide whether to show the chip.
 */

const STORAGE_KEY = 'cmd-k-hint-dismissed';

export const CmdKHint: React.FC = () => {
  // Tri-state: undefined = pre-hydration (render nothing), true = visible,
  // false = dismissed. Booleans alone can't distinguish "not yet read" from
  // "read and is false", which would flash the chip after hydration.
  const [visible, setVisible] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    try {
      const dismissed = globalThis.window.localStorage.getItem(STORAGE_KEY) === 'true';
      setVisible(!dismissed);
    } catch {
      // localStorage may be unavailable (private mode, blocked storage). Show
      // the hint anyway — it's harmless and the close button still works in
      // memory for the session.
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      globalThis.window.localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // Storage quota / blocked — already-hidden in memory, fine.
    }
  };

  if (!visible) return null;

  // Detect platform for the modifier glyph (purely cosmetic — both shortcuts
  // are wired in CommandPalette host). `navigator.platform` is deprecated,
  // but its documented replacement `navigator.userAgentData.platform` is
  // Chromium-only (no Safari/Firefox support). Use here is cosmetic (Mac
  // glyph vs Ctrl+ label) and degrades safely to "Ctrl+" on browsers that
  // report falsy platform strings. Re-evaluate when userAgentData ships in
  // Safari.
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform); // NOSONAR(typescript:S1874): no cross-browser replacement; cosmetic use only.
  const modifier = isMac ? '⌘' : 'Ctrl+';

  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-tertiary border border-hairline text-xs text-ink"
      data-testid="cmd-k-hint"
    >
      <span>
        Press <kbd className="font-mono font-semibold">{modifier}K</kbd> to search
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss Cmd+K hint"
        className="text-ink-muted hover:text-ink transition-colors"
      >
        <svg
          className="w-3 h-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
