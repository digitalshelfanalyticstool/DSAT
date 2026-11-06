'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface TTLProviderState<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<T>;
}

export interface CreateTTLProviderOptions<T> {
  /** Async function that fetches fresh data. */
  fetchFn: () => Promise<T>;
  /** Initial value used before the first fetch resolves (and on error). */
  initialValue: T;
  /** How long fetched data is considered fresh, in milliseconds. */
  ttlMs: number;
  /** Human-friendly name used in the "must be used within" error message. */
  displayName: string;
  /** If true (default), reset the data to `initialValue` on error. */
  resetOnError?: boolean;
}

export interface TTLProviderBundle<T> {
  Provider: React.FC<Readonly<{ children: React.ReactNode }>>;
  useValue: () => TTLProviderState<T>;
  /** Like useValue, but returns null outside the Provider instead of throwing. */
  useOptionalValue: () => TTLProviderState<T> | null;
}

/**
 * Build a React Context provider + hook pair that:
 *   - Fetches `fetchFn()` once on mount
 *   - Shares a single inflight promise across concurrent callers
 *   - Exposes `refresh()` to force re-fetch
 *   - Re-validates on window `focus` when cache is older than `ttlMs`
 *
 * Consumers get `{ data, loading, error, refresh }`. The value is memoized so
 * referential equality only changes when one of those fields changes.
 */
export function createTTLProvider<T>(
  opts: CreateTTLProviderOptions<T>,
): TTLProviderBundle<T> {
  const { fetchFn, initialValue, ttlMs, displayName, resetOnError = true } = opts;
  const Context = createContext<TTLProviderState<T> | null>(null);

  const Provider: React.FC<Readonly<{ children: React.ReactNode }>> = ({ children }) => {
    const [data, setData] = useState<T>(initialValue);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const fetchedAtRef = useRef<number>(0);
    const inflightRef = useRef<Promise<T> | null>(null);

    const refresh = useCallback(async (): Promise<T> => {
      if (inflightRef.current) return inflightRef.current;
      const promise = (async () => {
        try {
          const next = await fetchFn();
          setData(next);
          setError(null);
          fetchedAtRef.current = Date.now();
          return next;
        } catch (err) {
          setError(err as Error);
          if (resetOnError) setData(initialValue);
          return initialValue;
        } finally {
          setLoading(false);
          inflightRef.current = null;
        }
      })();
      inflightRef.current = promise;
      return promise;
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);

    useEffect(() => {
      const onFocus = () => {
        if (Date.now() - fetchedAtRef.current > ttlMs) {
          refresh();
        }
      };
      globalThis.addEventListener?.('focus', onFocus);
      return () => globalThis.removeEventListener?.('focus', onFocus);
    }, [refresh]);

    const value = useMemo<TTLProviderState<T>>(
      () => ({ data, loading, error, refresh }),
      [data, loading, error, refresh],
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
  };
  Provider.displayName = `${displayName}Provider`;

  const useValue = (): TTLProviderState<T> => {
    const ctx = useContext(Context);
    if (!ctx) {
      throw new Error(`use${displayName} must be used within a ${displayName}Provider`);
    }
    return ctx;
  };

  const useOptionalValue = (): TTLProviderState<T> | null => useContext(Context);

  return { Provider, useValue, useOptionalValue };
}
