/**
 * Helpers for the "Add a retailer" wizard: suggest a product link pattern from a
 * listing page and derive site names from a URL. Pure. Adapter detection is the
 * registry's (`detectAdapter` in ../adapters).
 */
import { productLinks } from '../adapters/schema-org';
import { FetchError, failureStatus } from '../scrapers/fetch-failure';

const MIN_LINKS_PER_SHAPE = 3;

/** A path's shape: all-digit segments → {digits}, slug-like ones → {slug}. */
export function pathShape(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (/^\d+$/.test(seg)) return '{digits}';
      if (/^[a-z0-9-]+$/i.test(seg) && (seg.includes('-') || seg.length > 12)) return '{slug}';
      return seg;
    })
    .join('/');
}

function shapeToRegex(shape: string): string {
  const parts = shape.split('/').map((seg) => {
    if (seg === '{digits}') return String.raw`\d+`;
    if (seg === '{slug}') return '[a-z0-9-]+';
    return seg.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return `^${parts.join('/')}$`;
}

/**
 * The most common same-origin link shape with at least 3 distinct links and a
 * digits or slug segment, as an anchored regex source. Null when none qualifies.
 */
export function suggestLinkPattern(html: string, pageUrl: string): string | null {
  const byShape = new Map<string, Set<string>>();
  for (const link of productLinks(html, pageUrl, /^/)) {
    const shape = pathShape(new URL(link).pathname);
    if (!shape.includes('{digits}') && !shape.includes('{slug}')) continue;
    byShape.set(shape, (byShape.get(shape) ?? new Set()).add(link));
  }
  let best: [string, number] | null = null;
  for (const [shape, links] of byShape) {
    if (links.size >= MIN_LINKS_PER_SHAPE && (!best || links.size > best[1])) best = [shape, links.size];
  }
  return best ? shapeToRegex(best[0]) : null;
}

/** Host words, without `www.` and the TLD: `www.red-boutique.example` → ['red', 'boutique']. */
function hostWords(url: string): string[] {
  const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, '').split('.');
  const name = labels.length > 1 ? labels.slice(0, -1).join('-') : labels[0];
  return name.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Site name from the host: lowercase, letters and digits only, unique among `existing`. */
export function deriveSiteName(url: string, existing: string[]): string {
  const base = hostWords(url).join('') || 'site';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function deriveDisplayName(url: string): string {
  return hostWords(url).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** 'blocked' for a fetch that got a 403, or a tiny "Access Denied" page; null otherwise. */
export function classifyFetchError(err: unknown, body?: string): 'blocked' | null {
  if (err instanceof FetchError && failureStatus(err.failure) === 403) return 'blocked';
  if (body !== undefined && body.length < 1024 && /access denied/i.test(body)) return 'blocked';
  return null;
}
