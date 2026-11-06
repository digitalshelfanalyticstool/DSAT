'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useToast } from '@/components/ui/Toast';

export interface UseAsyncResourceOptions {
  /**
   * Fetch automatically on mount, whenever `deps` change, and whenever
   * `auto` itself flips from false to true (auth-gate pattern:
   * `auto: authChecked`). Default true.
   */
  auto?: boolean;
  /**
   * Error handling: `'toast'` shows `error.message` via the shared toast;
   * a function receives the normalized `Error`. When omitted, the error is
   * only exposed via the returned `error` field.
   */
  onError?: 'toast' | ((error: Error) => void);
  /**
   * Values that retrigger the automatic fetch (e.g. the current page
   * number). Only consulted while `auto` is true.
   */
  deps?: unknown[];
}

export interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Re-runs the fetcher. Stable identity — safe to use in effect deps. */
  refetch: () => Promise<void>;
  /** Local (optimistic) updates without a round-trip. */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Shared fetch/loading/error/toast state for a single async resource.
 *
 * - Stale results are ignored: a fetch superseded by a newer refetch, or
 *   resolving after unmount, never calls setState.
 * - `data` is retained across refetches and on error (no flash of the
 *   empty state while refreshing; failed refresh keeps the last good view).
 * - `loading` is derived to be true from the very render in which an
 *   auto-fetch becomes pending (before the effect runs), so gated pages
 *   never flash their empty state between the gate opening and the fetch.
 */
export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  options: UseAsyncResourceOptions = {},
): AsyncResource<T> {
  const { auto = true, onError, deps = [] } = options;
  const { showToast } = useToast();

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [settled, setSettled] = useState(false);

  // Latest-value refs so `refetch` stays referentially stable and callers
  // can pass inline closures without retriggering the auto effect.
  // Declared BEFORE the auto effect: effects run in declaration order, so
  // the auto effect always sees the fetcher from the current render.
  const fetcherRef = useRef(fetcher);
  const onErrorRef = useRef(onError);
  const showToastRef = useRef(showToast);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onErrorRef.current = onError;
    showToastRef.current = showToast;
  });

  // Monotonic request id: bumped on every fetch and on unmount, so a
  // resolution from a superseded request (or after unmount) is dropped
  // instead of calling setState.
  const requestIdRef = useRef(0);
  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const refetch = useCallback(async () => {
    requestIdRef.current += 1;
    const id = requestIdRef.current;
    setInFlight(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      if (id !== requestIdRef.current) return;
      setData(result);
    } catch (err) {
      if (id !== requestIdRef.current) return;
      const normalized = err instanceof Error ? err : new Error(String(err));
      setError(normalized);
      const handler = onErrorRef.current;
      if (handler === 'toast') {
        showToastRef.current(normalized.message, 'error');
      } else if (handler) {
        handler(normalized);
      }
    } finally {
      if (id === requestIdRef.current) {
        setInFlight(false);
        setSettled(true);
      }
    }
  }, []);

  useEffect(() => {
    if (auto) void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller-declared retrigger list; fetcher/onError flow through latest-value refs by design.
  }, [auto, refetch, ...deps]);

  return {
    data,
    error,
    // Derived: also true while an auto-fetch is pending but its effect has
    // not run yet (the render where `auto` flips true or `deps` change).
    loading: inFlight || (auto && !settled),
    refetch,
    setData,
  };
}
