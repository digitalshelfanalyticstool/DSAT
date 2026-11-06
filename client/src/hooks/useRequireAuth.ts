'use client';

import { useEffect, useMemo } from 'react';
import { useRouter, notFound } from 'next/navigation';
import { useSession } from '@/providers/SessionProvider';

interface RequireAuthResult {
  user: { username: string; role: string } | null;
  /** True once the session is known and passes the gate. Hold data loads until then. */
  authChecked: boolean;
}

/**
 * The page-level auth gate. A signed-out visitor goes to /login. With
 * `role: 'admin'`, anyone else gets notFound(), so admin pages don't reveal
 * that they exist.
 *
 * @example
 * const { authChecked } = useRequireAuth({ role: 'admin' });
 * useAsyncResource(load, [], { auto: authChecked });
 */
export function useRequireAuth(opts: { role?: 'admin' } = {}): RequireAuthResult {
  const router = useRouter();
  const { session, loading, error } = useSession();
  const required = opts.role;
  const allowed = !!session && (!required || session.user.role === required);

  useEffect(() => {
    if (loading) return;
    if (error || !session) {
      router.push('/login');
      return;
    }
    if (!allowed) notFound();
  }, [loading, error, session, allowed, router]);

  // Memoized so callers can use `user` as an effect dep without a fetch storm:
  // a fresh object per render re-fires every effect that lists it.
  const username = session?.user.username;
  const role = session?.user.role;
  const user = useMemo(() => (username && role ? { username, role } : null), [username, role]);

  return { user, authChecked: !loading && allowed };
}
