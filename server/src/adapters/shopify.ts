/**
 * Shopify stores, read through their public storefront JSON. Needs no config
 * beyond the brand page URL: a collection page, or any page (then products are
 * filtered by vendor = brand). See docs/ADAPTERS.md.
 */
import { cleanDescription } from '../scrapers/html-utils';
import { ExtractionError, type DiscoverContext, type AdapterRow, type RetailerAdapter } from './types';

interface ShopifyListing { products: { handle: string; vendor?: string }[] }

interface ShopifyVariant {
  option1?: string | null;
  option2?: string | null;
  sku?: string | null;
  barcode?: string | null;
  available?: boolean;
  price?: number | string | null;
  compare_at_price?: number | string | null;
  featured_image?: { src?: string } | string | null;
}

interface ShopifyProduct {
  id: number | string;
  title?: string;
  description?: string;
  body_html?: string;
  options?: ({ name?: string } | string)[];
  images?: (string | { src?: string })[];
  variants: ShopifyVariant[];
}

/** The collection handle in a `/collections/<handle>[/...]` URL; null for the vendors page or other URLs. */
export function collectionHandle(url: string): string | null {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  if (segments[0] !== 'collections' || !segments[1] || segments[1] === 'vendors' || segments[1] === 'all') return null;
  return segments[1];
}

/** True when a body is Shopify's products.json listing. */
export function isShopifyProductsJson(body: string): boolean {
  try {
    return Array.isArray((JSON.parse(body) as Partial<ShopifyListing>).products);
  } catch {
    return false;
  }
}

/** `.js` prices are integer cents; `.json` prices are decimal strings. */
function price(value: ShopifyVariant['price']): string {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'number' ? (value / 100).toFixed(2) : Number.parseFloat(value).toFixed(2);
}

function httpsUrl(src: string | undefined): string {
  if (!src) return '';
  if (src.startsWith('//')) return `https:${src}`;
  return src.replace(/^http:/, 'https:');
}

function imageSrc(image: string | { src?: string } | null | undefined): string {
  return httpsUrl(typeof image === 'string' ? image : image?.src);
}

async function discover(ctx: DiscoverContext): Promise<string[]> {
  const pageUrl = ctx.brandUrl ?? ctx.site.base_url;
  const { origin } = new URL(pageUrl);
  const handle = collectionHandle(pageUrl);
  const listing = handle ? `${origin}/collections/${handle}/products.json` : `${origin}/products.json`;
  const brand = ctx.brand.toLowerCase();

  const urls: string[] = [];
  for (let page = 1; page <= ctx.maxPages; page++) {
    const body = await ctx.fetchPage(`${listing}?limit=250&page=${page}`);
    if (!isShopifyProductsJson(body)) {
      throw new Error(`not a Shopify store: ${listing} is not product JSON`);
    }
    const { products } = JSON.parse(body) as ShopifyListing;
    if (products.length === 0) break;
    for (const p of products) {
      if (handle || p.vendor?.toLowerCase() === brand) urls.push(`${origin}/products/${p.handle}`);
    }
  }
  return urls;
}

function extract({ url, html, site }: { url: string; html: string; site: { name: string } }): AdapterRow[] {
  let product: ShopifyProduct;
  try {
    product = JSON.parse(html) as ShopifyProduct;
  } catch {
    throw new ExtractionError('product response is not JSON');
  }
  if (!Array.isArray(product?.variants) || product.variants.length === 0) {
    throw new ExtractionError('product JSON has no variants');
  }

  const names = (product.options ?? []).map((o) => (typeof o === 'string' ? o : o.name ?? ''));
  const colorIdx = names.findIndex((n) => /colou?r/i.test(n));
  const sizeIdx = names.findIndex((n) => /size/i.test(n));
  const option = (v: ShopifyVariant, idx: number, fallback: number) => {
    const i = colorIdx === -1 && sizeIdx === -1 ? fallback : idx;
    return (i === 0 ? v.option1 : i === 1 ? v.option2 : '') ?? '';
  };
  const firstImage = imageSrc(product.images?.[0]);
  const description = cleanDescription(product.description ?? product.body_html ?? '');

  return product.variants.map((v) => {
    const selling = price(v.price);
    return {
      retailer: site.name,
      style_id: String(product.id),
      sku: v.sku ?? '',
      upc: v.barcode ?? '',
      title: product.title ?? '',
      color: option(v, colorIdx, 0),
      size: option(v, sizeIdx, 1),
      description,
      list_price: price(v.compare_at_price) || selling,
      selling_price: selling,
      url,
      item_number: '',
      inventory: v.available ? 'In Stock' : 'Out of Stock',
      image_url: imageSrc(v.featured_image) || firstImage,
    };
  });
}

export const shopifyAdapter: RetailerAdapter = {
  id: 'shopify',
  discover,
  extract,
  detect: async (origin, fetchPage) => isShopifyProductsJson(await fetchPage(`${origin}/products.json?limit=1`)),
  productId: (url) => new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url,
  fetchUrl: (productUrl) => {
    const u = new URL(productUrl);
    u.pathname = `${u.pathname.replace(/\/$/, '')}.js`;
    return u.toString();
  },
  needsRender: false,
};
