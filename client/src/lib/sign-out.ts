import { apiClient } from '@/lib/api-client';

/** Signed-in users are signed out after this long without input (NEXT_PUBLIC_IDLE_SIGN_OUT_MINUTES, default 30). */
export const IDLE_SIGN_OUT_MS = (Number(process.env.NEXT_PUBLIC_IDLE_SIGN_OUT_MINUTES) || 30) * 60 * 1000;

/**
 * The only way the client signs out: revoke the server session, then reload
 * onto /login.
 *
 * - The server call must happen. Dropping only the in-memory token leaves the
 *   httpOnly refresh cookie valid, so /login mints a new token and bounces
 *   the user straight back in.
 * - The navigation must be a hard one, not router.push(). SessionProvider
 *   caches /auth/session for 60s and nothing in the app tree unmounts on a
 *   soft navigation, so /login's `if (session) router.replace('/')` would
 *   bounce the user back too. Reloading the document drops that state.
 * - A failed logout call (network blip, 5xx, a 401 on /auth/logout itself)
 *   is logged and swallowed: the navigation runs regardless, and callers are
 *   fire-and-forget onClick handlers that must not see a rejection.
 */
export async function signOut(opts: { expired?: boolean } = {}): Promise<void> {
  try {
    await apiClient.logout();
  } catch (err) {
    console.error('[signOut] logout call failed; continuing to the sign-in page.', err);
  }
  globalThis.window.location.href = opts.expired ? '/login?session_expired=true' : '/login';
}
