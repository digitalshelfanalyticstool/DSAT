'use client';

import React, { useCallback, useMemo } from 'react';
import { apiClient } from '@/lib/api-client';
import { createTTLProvider } from './createTTLProvider';
import type { SessionUser } from '@/lib/api-client';

export interface SessionData {
  user: SessionUser;
}

interface SessionContextValue {
  session: SessionData | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<SessionData | null>;
}

const SESSION_TTL_MS = 60_000;

async function fetchSession(): Promise<SessionData | null> {
  const res = await apiClient.getSession();
  return { user: res.user };
}

const { Provider: InnerProvider, useValue: useInner } = createTTLProvider<SessionData | null>({
  fetchFn: fetchSession,
  initialValue: null,
  ttlMs: SESSION_TTL_MS,
  displayName: 'Session',
});

export function SessionProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  return <InnerProvider>{children}</InnerProvider>;
}

/**
 * Consume the cached session. Callers should tolerate `session === null` during
 * the initial fetch and on auth errors.
 */
export function useSession(): SessionContextValue {
  const { data, loading, error, refresh: innerRefresh } = useInner();
  const refresh = useCallback(() => innerRefresh(), [innerRefresh]);
  return useMemo<SessionContextValue>(
    () => ({ session: data, loading, error, refresh }),
    [data, loading, error, refresh],
  );
}
