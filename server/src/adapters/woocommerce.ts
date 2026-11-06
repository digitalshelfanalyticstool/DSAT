/**
 * WooCommerce stores, read through the public Store API (`/wp-json/wc/store/v1`),
 * which needs no key. Needs no config beyond the brand page URL: a product
 * category or brand page narrows the listing; any other page (or none) lists
 * the whole store and keeps products whose brand matches. See docs/ADAPTERS.md.
 *
 * Variations can only be fetched by their parent's numeric id, which a
 * permalink doesn't carry, so the product URL is the WordPress shortlink
 * `/?p=<id>` (it redirects to the product page). Simple products add
 * `post_type=product`, still a valid WordPress URL, so `fetchUrl` knows there
 * are no variations to ask for. Rows show the real permalink.
 */
import { cleanDescription, formatPrice } from '../scrapers/html-utils';
import { ExtractionError, type DiscoverContext, type AdapterRow, type RetailerAdapter, type SiteConfig } from './types';

const API_PATH = '/wp-json/wc/store/v1/products';
const PER_PAGE = 100; // the Store API maximum

interface WooListed { id: number; type?: string; brands?: { name?: string; slug?: string }[] }

interface WooProduct {
  id: number;
  parent?: number;
  name?: string;
  variation?: string;
  permalink?: string;
  sku?: string;
  description?: string;
  short_description?: string;
  prices?: { price?: string; regular_price?: string; currency_minor_unit?: number };
  images?: { src?: string }[];
  is_in_stock?: boolean;
}

/** Store API filter for a category or brand page URL; empty for any other page. */
export function listingQuery(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  if (segments[0] === 'product-category' && segments.length > 1) return `&category=${encodeURIComponent(segments.at(-1)!)}`;
  if ((segments[0] === 'brand' || segments[0] === 'product-brand') && segments[1]) return `&brand=${encodeURIComponent(segments[1])}`;
  return '';
}

/** True when a body is the Store API's product list (a JSON array of products with numeric ids). */
export function isWooProductsJson(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) && parsed.every((p) => typeof (p as WooListed)?.id === 'number');
  } catch {
    return false;
  }
}

function shortlink(origin: string, p: WooListed): string {
  return p.type === 'variable' ? `${origin}/?p=${p.id}` : `${origin}/?p=${p.id}&post_type=product`;
}

async function discover(ctx: DiscoverContext): Promise<string[]> {
  const pageUrl = ctx.brandUrl ?? ctx.site.base_url;
  const { origin } = new URL(pageUrl);
  const filter = listingQuery(pageUrl);
  const brand = ctx.brand.toLowerCase();

  const urls: string[] = [];
  for (let page = 1; page <= ctx.maxPages; page++) {
    const listing = `${origin}${API_PATH}?per_page=${PER_PAGE}&page=${page}${filter}`;
    const body = await ctx.fetchPage(listing);
    if (!isWooProductsJson(body)) throw new Error(`not a WooCommerce store: ${listing} is not Store API product JSON`);
    const products = JSON.parse(body) as WooListed[];
    for (const p of products) {
      if (filter || p.brands?.some((b) => b.name?.toLowerCase() === brand)) urls.push(shortlink(origin, p));
    }
    if (products.length < PER_PAGE) break;
  }
  return urls;
}

function postId(productUrl: string): string {
  return new URL(productUrl).searchParams.get('p') ?? '';
}

function fetchUrl(productUrl: string): string {
  const u = new URL(productUrl);
  const id = postId(productUrl);
  return u.searchParams.get('post_type') === 'product'
    ? `${u.origin}${API_PATH}/${id}`
    : `${u.origin}${API_PATH}?parent=${id}&type=variation&per_page=${PER_PAGE}`;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Store API names are HTML-escaped (`&#8211;`, `&amp;`). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? m;
    const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}

/** Store API prices are integer strings in the currency's minor unit ("3599" with 2 → 35.99). */
function price(value: string | undefined, minorUnit = 2): string {
  if (!value) return '';
  return formatPrice(Number(value) / 10 ** minorUnit);
}

/** "Color: Oat, Size: S" → named attribute values. */
function attributes(variation: string): { name: string; value: string }[] {
  return decodeEntities(cleanDescription(variation)).split(', ').map((pair) => {
    const i = pair.indexOf(': ');
    return i === -1 ? { name: '', value: pair.trim() } : { name: pair.slice(0, i).trim(), value: pair.slice(i + 2).trim() };
  }).filter((a) => a.value);
}

function colorAndSize(variation: string): { color: string; size: string } {
  const attrs = attributes(variation);
  const color = attrs.find((a) => /colou?r/i.test(a.name));
  const size = attrs.find((a) => /size/i.test(a.name));
  if (!color && !size) return { color: attrs[0]?.value ?? '', size: attrs[1]?.value ?? '' };
  return { color: color?.value ?? '', size: size?.value ?? '' };
}

function permalink(p: WooProduct): string {
  if (!p.permalink) return '';
  const u = new URL(p.permalink);
  u.search = ''; // a variation's permalink pre-selects its attributes; the row names the product
  return u.toString();
}

function row(p: WooProduct, productUrl: string, site: SiteConfig): AdapterRow {
  const minor = p.prices?.currency_minor_unit ?? 2;
  const selling = price(p.prices?.price, minor);
  return {
    retailer: site.name,
    style_id: String(p.parent || p.id),
    sku: p.sku ?? '',
    upc: '',
    title: decodeEntities(p.name ?? ''),
    ...colorAndSize(p.variation ?? ''),
    description: decodeEntities(cleanDescription(p.description || p.short_description || '')),
    list_price: price(p.prices?.regular_price, minor) || selling,
    selling_price: selling,
    url: permalink(p) || productUrl,
    item_number: '',
    inventory: p.is_in_stock ? 'In Stock' : 'Out of Stock',
    image_url: p.images?.[0]?.src ?? '',
  };
}

function extract({ url, html, site }: { url: string; html: string; site: SiteConfig }): AdapterRow[] {
  let body: unknown;
  try {
    body = JSON.parse(html);
  } catch {
    throw new ExtractionError('product response is not JSON');
  }
  const products = Array.isArray(body) ? (body as WooProduct[]) : [body as WooProduct];
  if (products.length === 0) throw new ExtractionError('product has no variations');
  if (!products.every((p) => typeof p?.id === 'number')) throw new ExtractionError('response is not Store API product JSON');
  return products.map((p) => row(p, url, site));
}

export const woocommerceAdapter: RetailerAdapter = {
  id: 'woocommerce',
  discover,
  extract,
  detect: async (origin, fetchPage) => isWooProductsJson(await fetchPage(`${origin}${API_PATH}?per_page=1`)),
  productId: postId,
  productUrl: (id, site) => `${new URL(site.base_url).origin}/?p=${id}`,
  fetchUrl,
  needsRender: false,
};
