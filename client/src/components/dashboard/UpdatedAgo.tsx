'use client';

import { useEffect, useState } from 'react';
import { timeAgo } from '@/lib/format';

/**
 * Self-contained "updated Xs ago" ticker.
 *
 * Previously the dashboard owned a 1s `setInterval` that bumped a `nowTick`
 * state, forcing the entire page to re-render every second. Lifting the
 * timer into this leaf component keeps the dashboard render count flat —
 * only this `<span>` re-renders on each tick.
 *
 * Lives in `components/dashboard/` (not co-located in `app/page.tsx`)
 * because Next.js App Router rejects non-allowlisted named exports from
 * `page.tsx` files at production-build time.
 */
export function UpdatedAgo({ since }: Readonly<{ since: number }>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-xs text-ink-muted" aria-live="polite">
      Updated {timeAgo(since, now)}
    </span>
  );
}
