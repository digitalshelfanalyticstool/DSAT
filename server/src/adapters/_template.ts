/**
 * TEMPLATE — copy this file to `my-retailer.ts` to support a site the generic
 * schema-org adapter can't read. Then:
 *   1. rename `templateAdapter` and set a unique `id`;
 *   2. register it in ./index.ts (one import, one map entry);
 *   3. set the site's `adapter` field to that id on the Config page;
 *   4. check it against a product page from your site.
 *
 * This file is NOT registered. It reads a made-up page shape: product data in
 * an inline JSON script tag.
 * See docs/ADAPTERS.md for the ProductVariant field contract.
 */
import { cleanDescription, findProductJsonInScripts, formatPrice } from '../scrapers/html-utils';
import { ExtractionError, type AdapterRow, type RetailerAdapter } from './types';

/** Change this to match your site's product page paths. */
const PRODUCT_PATH = /^\/products\/[^/]+$/;

/** The JSON shape your site embeds. Describe only the fields you read. */
interface SiteProduct {
  id?: string | number;
  name?: string;
  description?: string;
  price?: number | string;
  listPrice?: number | string;
  image?: string;
  variants?: { sku?: string; upc?: string; color?: string; size?: string; inStock?: boolean }[];
}

export const templateAdapter: RetailerAdapter = {
  id: 'template',

  /**
   * Return product page URLs for one brand. `ctx.brandUrl` is the brand's
   * listing page from the site's brand_urls. Fetch only through
   * `ctx.fetchPage`, so the configured scraping provider is used.
   */
  async discover({ brandUrl, site, fetchPage, maxPages }) {
    if (!brandUrl) throw new Error(`Add a brand_urls entry for this brand on site '${site.name}'`);
    const urls = new Set<string>();
    for (let page = 1; page <= maxPages; page++) {
      const pageUrl = page === 1 ? brandUrl : `${brandUrl}?page=${page}`;
      const html = await fetchPage(pageUrl);
      const before = urls.size;
      for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/g)) {
        const u = new URL(m[1], pageUrl);
        // Same origin only: a listing page must not steer the fetcher at another host.
        if (u.origin === new URL(pageUrl).origin && PRODUCT_PATH.test(u.pathname)) urls.add(u.origin + u.pathname);
      }
      if (urls.size === before) break; // no new products: end of the listing
    }
    return [...urls];
  },

  /**
   * Turn one product page into rows, one per variant (size × color).
   * Throw ExtractionError with a short reason when the page isn't usable;
   * it is recorded against the product instead of producing empty rows.
   */
  extract({ url, html, site }) {
    // Other helpers in ../scrapers/html-utils: findJsonLdProducts (schema.org),
    // forEachScriptTag (custom script scanning).
    const data = findProductJsonInScripts(html) as SiteProduct | undefined;
    if (!data?.variants?.length) throw new ExtractionError('no product data on page');

    const selling = formatPrice(data.price);
    return data.variants.map((v): AdapterRow => ({
      retailer: site.name,
      style_id: String(data.id ?? ''),
      sku: v.sku ?? '',
      upc: v.upc ?? '',
      title: data.name ?? '',
      color: v.color ?? '',
      size: v.size ?? '',
      description: cleanDescription(data.description),
      list_price: formatPrice(data.listPrice) || selling,
      selling_price: selling,
      url,
      item_number: '',
      inventory: v.inStock ? 'In Stock' : 'Out of Stock',
      image_url: data.image ?? '',
    }));
  },

  // Optional hooks: productId(url), productUrl(id, site), fetchUrl(url), isDiscontinued(html),
  // needsRender, needsLinkPattern, detect(origin, fetchPage). See docs/ADAPTERS.md.
};
