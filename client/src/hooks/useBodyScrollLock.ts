'use client';

import { useEffect } from 'react';

/**
 * Ref-counted body scroll lock.
 *
 * Multiple components (Modal, mobile Sidebar drawer, future popovers)
 * want to lock `document.body` scroll while they're open. If each one
 * mutates `body.style.overflow` independently, the first to unmount
 * clears the lock even though the second is still open. This module
 * tracks a shared counter so the lock is released only when the last
 * locker unlocks.
 *
 * The `active` argument drives engage/release so callers can flip state
 * without unmounting (e.g. a Modal that opens/closes via a boolean prop).
 */

let lockCount = 0;
let originalOverflow: string | null = null;

function engage(): void {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function release(): void {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) return; // unbalanced release — no-op
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = originalOverflow ?? '';
    originalOverflow = null;
  }
}

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    engage();
    return () => release();
  }, [active]);
}
