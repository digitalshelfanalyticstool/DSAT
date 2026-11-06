/**
 * image-url-canonicalizer
 *
 * Single chokepoint every variant's image_url passes through before it is
 * persisted. Retailer-agnostic: it asserts only what holds for any site —
 * an absolute https URL with no whitespace. Retailer-specific CDN repair
 * belongs in that retailer's adapter.
 *
 * - Zero imports from any project module (see partition-ddl-guard.ts), so
 *   the persistence layer can import it without a cycle.
 * - Empty-string-on-rejection, not throw. The persistence layer stores ''
 *   as NULL, which renders the client's fallback tile; a broken URL would
 *   render a blank one instead.
 */

export type RejectReason = 'parse_error' | 'not_https' | 'whitespace';

export interface CanonicalizeResult {
  /** The URL, or empty string if it was rejected. */
  url: string;
  /** Why the input was rejected; null for clean (or empty) inputs. */
  rejected: RejectReason | null;
}

export function canonicalizeImageUrl(raw: string | null | undefined): CanonicalizeResult {
  if (!raw) return { url: '', rejected: null };
  if (/\s/.test(raw)) return { url: '', rejected: 'whitespace' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: '', rejected: 'parse_error' };
  }
  if (parsed.protocol !== 'https:') return { url: '', rejected: 'not_https' };

  return { url: raw, rejected: null };
}
