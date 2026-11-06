/**
 * The "Add a retailer" preview: a small, bounded dry run of discovery and
 * extraction for one brand page. It fetches at most one listing page and three
 * product pages (plus one request to detect a Shopify store), never a full scrape.
 */
import { detectAdapter, getAdapter, type FetchPage, type ProductVariant, type SiteConfig } from '../adapters';
import { classifyFetchError, deriveSiteName, suggestLinkPattern } from './site-onboarding';

export interface PreviewInput { url: string; brand: string; adapter?: string; product_link_pattern?: string }
export interface PreviewSample { url: string; rows: ProductVariant[]; error?: string }
export interface PreviewResult {
  adapter: string;
  suggested_pattern: string | null;
  link_count: number;
  links: string[];
  samples: PreviewSample[];
  fields: { filled: string[]; empty: string[] };
  problem: 'blocked' | 'no_links' | 'no_data' | 'timeout' | null;
  /** The underlying error, in words, when there is one. */
  message: string | null;
}

const MAX_SAMPLES = 3;
const MAX_LINKS_SHOWN = 20;
const PREVIEW_TIMEOUT_MS = 45_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fieldsOf(samples: PreviewSample[]): PreviewResult['fields'] {
  const rows = samples.flatMap((s) => s.rows);
  if (rows.length === 0) return { filled: [], empty: [] };
  const keys = Object.keys(rows[0]) as (keyof ProductVariant)[];
  const filled = keys.filter((k) => rows.some((r) => String(r[k] ?? '').trim() !== ''));
  return { filled, empty: keys.filter((k) => !filled.includes(k)) };
}

async function runPreview(input: PreviewInput, fetchPage: FetchPage): Promise<PreviewResult> {
  const { origin } = new URL(input.url);
  const adapterId = input.adapter ?? (await detectAdapter(origin, fetchPage));
  const adapter = getAdapter(adapterId);
  const result: PreviewResult = {
    adapter: adapterId, suggested_pattern: null, link_count: 0, links: [], samples: [],
    fields: { filled: [], empty: [] }, problem: null, message: null,
  };
  const fail = (problem: PreviewResult['problem'], err?: unknown): PreviewResult =>
    ({ ...result, problem, message: err === undefined ? null : errorMessage(err) });

  // Listing: one fetch, shared by the pattern suggestion and the adapter's discover.
  let listingFetches = 0;
  const listingCache = new Map<string, Promise<string>>();
  const listingFetch: FetchPage = (url, opts) => {
    const cached = listingCache.get(url);
    if (cached) return cached;
    if (++listingFetches > 1) return Promise.reject(new Error('preview reads one listing page only'));
    const p = fetchPage(url, opts);
    listingCache.set(url, p);
    return p;
  };

  let pattern = input.product_link_pattern;
  if (adapter.needsLinkPattern && !pattern) {
    let html: string;
    try {
      html = await listingFetch(input.url);
    } catch (err) {
      return fail(classifyFetchError(err) ?? 'no_links', err);
    }
    result.suggested_pattern = suggestLinkPattern(html, input.url);
    pattern = result.suggested_pattern ?? undefined;
    if (!pattern) return fail('no_links');
  }

  const site = {
    name: deriveSiteName(input.url, []), base_url: origin, enabled: true,
    adapter: adapterId, product_link_pattern: pattern,
    brand_urls: { [input.brand.toLowerCase()]: input.url },
  } as SiteConfig;

  let links: string[];
  try {
    links = await adapter.discover({ brand: input.brand, brandUrl: input.url, site, fetchPage: listingFetch, maxPages: 1 });
  } catch (err) {
    return fail(classifyFetchError(err) ?? 'no_links', err);
  }
  result.link_count = links.length;
  result.links = links.slice(0, MAX_LINKS_SHOWN);
  if (links.length === 0) return fail('no_links');

  let blockedSamples = 0;
  for (const url of links.slice(0, MAX_SAMPLES)) {
    try {
      const body = await fetchPage(adapter.fetchUrl?.(url) ?? url, { render: adapter.needsRender ?? false });
      result.samples.push({ url, rows: adapter.extract({ url, html: body, site }) });
    } catch (err) {
      result.samples.push({ url, rows: [], error: errorMessage(err) });
      if (classifyFetchError(err)) blockedSamples++;
    }
  }
  result.fields = fieldsOf(result.samples);
  if (result.samples.every((s) => s.rows.length === 0)) {
    const blocked = blockedSamples === result.samples.length;
    return fail(blocked ? 'blocked' : 'no_data');
  }
  return result;
}

export async function previewSite(input: PreviewInput, fetchPage: FetchPage): Promise<PreviewResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<PreviewResult>((resolve) => {
    timer = setTimeout(() => resolve({
      adapter: input.adapter ?? '', suggested_pattern: null, link_count: 0, links: [], samples: [],
      fields: { filled: [], empty: [] }, problem: 'timeout', message: `No answer within ${PREVIEW_TIMEOUT_MS / 1000}s`,
    }), PREVIEW_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runPreview(input, fetchPage), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
