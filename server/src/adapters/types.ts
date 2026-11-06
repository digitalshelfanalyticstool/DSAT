/**
 * The retailer adapter API. One adapter turns a retailer's listing pages into
 * product URLs (discover) and a product page into variant rows (extract).
 *
 * Zero runtime imports, so anything can import this file. See docs/ADAPTERS.md.
 */
import type { ProductVariant } from '../scrapers/site-adapter';
import type { SiteConfig } from '../services/config-manager';

export type { ProductVariant, SiteConfig };

export interface DiscoverContext {
  brand: string;
  /** Per-brand listing URL from the site's brand_urls, if configured. */
  brandUrl?: string;
  site: SiteConfig;
  /** Fetch a page through the active scraping provider. Throws on failure. */
  fetchPage: FetchPage;
  maxPages: number;
  signal?: AbortSignal;
}

/** A row as an adapter returns it. The registry stamps `source` with the adapter id. */
export type AdapterRow = Omit<ProductVariant, 'source'> & { source?: string };

/** Fetch a page through the active scraping provider. Throws on failure. */
export type FetchPage = (url: string, opts?: { render?: boolean }) => Promise<string>;

export interface ExtractContext {
  url: string;
  html: string;
  site: SiteConfig;
}

export interface RetailerAdapter {
  /** Stable id stored in site config (`adapter` field), e.g. "schema-org". */
  readonly id: string;
  /** Product page URLs for a brand. */
  discover(ctx: DiscoverContext): Promise<string[]>;
  /** One product page → variant rows. Throw ExtractionError with a reason when it can't. */
  extract(ctx: ExtractContext): AdapterRow[];
  /** Stable product id for a URL (catalog key). Default: `defaultProductId`. */
  productId?(url: string): string;
  /** Rebuild a product URL from its id when discovery is empty. Optional. */
  productUrl?(id: string, site: SiteConfig): string | null;
  /**
   * URL to fetch for a product page, when it differs from the product URL (e.g. a
   * JSON endpoint). `extract` still gets the product URL as `ctx.url`. Optional.
   */
  fetchUrl?(productUrl: string): string;
  /** Positive marker of a discontinued page. Optional. */
  isDiscontinued?(html: string): boolean;
  /** Whether product pages need browser rendering. Default false. */
  readonly needsRender?: boolean;
  /** Whether discovery needs the site's `product_link_pattern`. The "Add a retailer" wizard suggests one. */
  readonly needsLinkPattern?: boolean;
  /**
   * Whether the store at `origin` runs on this adapter's platform, from one or
   * two cheap probes. The wizard asks each adapter in registration order. A
   * thrown fetch counts as "no". Optional.
   */
  detect?(origin: string, fetchPage: FetchPage): Promise<boolean>;
}

/** An adapter as the registry hands it out: `productId` always set, rows stamped and canonicalized. */
export interface Adapter extends RetailerAdapter {
  extract(ctx: ExtractContext): ProductVariant[];
  productId(url: string): string;
}

/** The default catalog key: the last all-digit path segment, else the last path segment. */
export function defaultProductId(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return url;
  }
  return [...segments].reverse().find((s) => /^\d+$/.test(s)) ?? segments.at(-1) ?? url;
}

/** Thrown by `extract` when a page can't be turned into rows; the message is the reason. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}
