/**
 * The generic adapter: reads schema.org Product / ProductGroup JSON-LD, which
 * many retailers publish for search engines. Configured only by site settings
 * (`product_link_pattern`, and `brand_urls` or `listing_url_template`).
 */
import { cleanDescription, findJsonLdProducts, formatPrice } from '../scrapers/html-utils';
import { defaultProductId as productId, ExtractionError, type AdapterRow, type RetailerAdapter } from './types';
import { createLogger } from '../utils/logger';

const logger = createLogger('schema-org-adapter');

type Node = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/**
 * "$1,299.00" / "1.299,00" → "1299.00"; 1299 → "1299.00"; a range takes its
 * first number. Anything ambiguous → "" (a blank beats a wrong price).
 */
function price(v: unknown): string {
  if (typeof v === 'number') return formatPrice(v);
  const token = /\d[\d.,]*/.exec(str(v))?.[0].replace(/[.,]$/, '');
  if (!token) return '';
  const hasDot = token.includes('.');
  const hasComma = token.includes(',');
  let normal: string;
  if (hasDot && hasComma) {
    // The separator that comes last is the decimal one.
    const decimal = token.lastIndexOf(',') > token.lastIndexOf('.') ? ',' : '.';
    normal = token.replaceAll(decimal === ',' ? '.' : ',', '').replace(',', '.');
  } else if (hasComma) {
    if (/^\d{1,3}(,\d{3})+$/.test(token)) normal = token.replaceAll(',', '');
    else if (/^\d+,\d{1,2}$/.test(token)) normal = token.replace(',', '.');
    else return '';
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(token)) {
    normal = token.replaceAll('.', '');
  } else if ((token.match(/\./g) ?? []).length > 1) {
    return '';
  } else {
    normal = token;
  }
  return formatPrice(normal);
}

function firstImage(v: unknown): string {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first === 'string') return first;
  return str((first as Node | undefined)?.url);
}

/** Selling price, list price and stock from an `offers` value of any shape. */
function readOffers(offers: unknown): { selling: string; list: string; inventory: string } {
  const offer = (Array.isArray(offers) ? offers[0] : offers) as Node | undefined;
  if (!offer || typeof offer !== 'object') return { selling: '', list: '', inventory: '' };
  const selling = price(offer.price) || price(offer.lowPrice);
  const specs = Array.isArray(offer.priceSpecification) ? offer.priceSpecification : [offer.priceSpecification];
  const listSpec = specs.find((s) => str((s as Node | undefined)?.priceType).endsWith('ListPrice')) as Node | undefined;
  const list = price(listSpec?.price) || price(offer.highPrice) || selling;
  const availability = str(offer.availability);
  let inventory = '';
  if (availability) inventory = /InStock|LimitedAvailability|InStoreOnly|OnlineOnly/.test(availability) ? 'In Stock' : 'Out of Stock';
  return { selling, list, inventory };
}

function gtin(node: Node): string {
  return str(node.gtin13) || str(node.gtin12) || str(node.gtin14) || str(node.gtin) || str(node.gtin8);
}

/** Listing URL for a page: substitutes `{brand}`/`{page}`, else appends `page=N` after page 1. */
export function listingPageUrl(base: string, brand: string, page: number): string {
  const url = base.replaceAll('{brand}', encodeURIComponent(brand));
  if (url.includes('{page}')) return url.replaceAll('{page}', String(page));
  if (page === 1) return url;
  return `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
}

/**
 * Absolute product URLs (no query or fragment) of links whose pathname matches.
 * Only links on the listing page's own origin are kept, so a page can't steer
 * the fetcher at another host (e.g. an internal address).
 */
export function productLinks(html: string, pageUrl: string, pattern: RegExp): string[] {
  const { origin } = new URL(pageUrl);
  const links: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/g)) {
    let u: URL;
    try {
      u = new URL(m[1], pageUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin || !pattern.test(u.pathname)) continue;
    links.push(u.origin + u.pathname);
  }
  return links;
}

export const schemaOrgAdapter: RetailerAdapter = {
  id: 'schema-org',

  async discover({ brand, brandUrl, site, fetchPage, maxPages, signal }) {
    if (!site.product_link_pattern) {
      throw new Error(`Set a product link pattern for site '${site.name}' so the schema-org adapter can find product pages`);
    }
    const base = brandUrl || site.listing_url_template;
    if (!base) {
      throw new Error(`No listing URL for brand '${brand}' on site '${site.name}': add it to brand_urls or set a listing URL template`);
    }
    const pattern = new RegExp(site.product_link_pattern);
    const found = new Map<string, string>();

    for (let page = 1; page <= maxPages; page++) {
      signal?.throwIfAborted();
      const pageUrl = listingPageUrl(base, brand, page);
      const before = found.size;
      let html: string;
      try {
        html = await fetchPage(pageUrl);
      } catch (err) {
        // Page 1 failing means nothing was found; a later page failing keeps what was.
        if (page === 1) throw err;
        logger.warn('Listing page fetch failed; keeping earlier pages', {
          operation: 'schemaOrgDiscover', site: site.name, brand, page, error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      for (const link of productLinks(html, pageUrl, pattern)) {
        const id = productId(link);
        if (!found.has(id)) found.set(id, link);
      }
      // An empty page, or one past the end that repeats earlier products, ends the listing.
      if (found.size === before) break;
    }
    return [...found.values()];
  },

  extract({ url, html, site }) {
    const product = findJsonLdProducts(html)[0];
    if (!product) throw new ExtractionError('no schema.org Product on page');

    // A hasVariant entry with only an @id is a reference to a node elsewhere; it has no data of its own.
    const variants = Array.isArray(product.hasVariant)
      ? (product.hasVariant as Node[]).filter((v) => v && typeof v === 'object' && Object.keys(v).some((k) => k !== '@id'))
      : [product];
    const styleId = str(product.productGroupID) || str(product.sku) || productId(url);

    return variants.map((v): AdapterRow => {
      const offers = readOffers(v.offers ?? product.offers);
      return {
        retailer: site.name,
        style_id: styleId,
        sku: str(v.sku),
        upc: gtin(v),
        title: str(v.name) || str(product.name),
        color: str(v.color),
        size: str(v.size),
        description: cleanDescription(v.description ?? product.description),
        list_price: offers.list,
        selling_price: offers.selling,
        url,
        item_number: str(v.mpn),
        inventory: offers.inventory,
        image_url: firstImage(v.image ?? product.image),
      };
    });
  },

  needsLinkPattern: true,
};
