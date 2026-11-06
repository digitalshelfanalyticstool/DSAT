'use client';

import { useEffect, useRef, useCallback } from 'react';

const IDLE_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click',
];

/**
 * Hook that tracks user activity and calls onIdle after timeoutMs of inactivity.
 * Listens for mouse, keyboard, touch, and scroll events to reset the timer.
 */
export function useIdleTimeout(onIdle: () => void, timeoutMs: number) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  const resetTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      onIdleRef.current();
    }, timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    // Start the timer on mount
    resetTimer();

    const handler = () => resetTimer();
    for (const event of IDLE_EVENTS) {
      globalThis.window.addEventListener(event, handler, { passive: true });
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      for (const event of IDLE_EVENTS) {
        globalThis.window.removeEventListener(event, handler);
      }
    };
  }, [resetTimer]);
}
