'use client';

import { useEffect, useRef } from 'react';

/**
 * Call `fn` every `ms` milliseconds while mounted. `ms === null` pauses.
 * With `whenVisible`, ticks are skipped while the tab is hidden.
 *
 * `fn` is read through a ref, so an inline closure doesn't re-arm the timer;
 * only a change of `ms` or `whenVisible` does.
 */
export function usePolling(fn: () => unknown, ms: number | null, opts: { whenVisible?: boolean } = {}): void {
  const { whenVisible = false } = opts;
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => {
      if (whenVisible && document.hidden) return;
      void fnRef.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms, whenVisible]);
}
