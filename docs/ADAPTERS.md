# Retailer adapters

An adapter teaches the scraper one retailer. It does two jobs:

- **discover**: turn a brand's listing pages into product page URLs;
- **extract**: turn one product page into variant rows (one per size and color).

Everything else is shared by every adapter: fetching through your configured scraping provider (Direct, Bright Data, Apify or Firecrawl), the job queue, caching, the database and the Excel export.

You are responsible for complying with each site's terms of use and robots.txt.

## Start with the generic adapter

Many retailers publish schema.org `Product` data (JSON-LD) on product pages for search engines. The built-in `schema-org` adapter reads that data, so for those sites you configure fields and write no code.

On the **Config → Sites** page, add the site and set:

| Field | What it is | Example |
|---|---|---|
| Adapter | `schema-org` (the default) | |
| Product link pattern | A regex matched against each link's path on a listing page. Only matching links count as product pages. | `/p/[^/?#]+/\d+` |
| Listing URL template | Optional. Used for brands with no `brand_urls` entry. `{brand}` and `{page}` are substituted. | `https://shop.example.com/brand/{brand}?page={page}` |
| Brand URLs | Optional JSON map of a lowercased brand name to its listing page. Wins over the template. | `{"red maple": "https://shop.example.com/b/red-maple"}` |

**How pages are walked.** Without `{page}` in the URL, page 2 onward appends `page=N`. Discovery stops at the first page that adds no new products, or at 8 pages.

**Check before you trust it.** A wrong pattern finds 0 products rather than raising an error.
1. Open a product page.
2. View its source and search for `application/ld+json`.
3. Look for `"@type": "Product"` or `"ProductGroup"`.

If it isn't there, write an adapter.

**Fields read from the JSON-LD:**

| Row field | Read from |
|---|---|
| Title, SKU, color, size, description, image | `name`, `sku`, `color`, `size`, `description` and `image` |
| UPC | `gtin13`, `gtin12`, `gtin14`, `gtin` or `gtin8` |
| Selling price | `offers.price`, or `lowPrice` |
| List price | a `ListPrice` price specification, or `highPrice`, else the selling price |
| Inventory | `availability`, as In Stock or Out of Stock |

A `ProductGroup` gives one row per `hasVariant`.

## Shopify stores

Set the site's adapter to `shopify`. It needs no link pattern or listing template, only the brand's page on the store as the brand URL:

- **A collection page** (`https://store.example/collections/red-maple`, or a page under it): every product in that collection, read from `/collections/<handle>/products.json`.
- **Any other page**, such as the vendors page (`/collections/vendors?q=Red%20Maple`): every product in the store whose vendor matches the brand name, ignoring case, read from `/products.json`.

Each product is read from its `/products/<handle>.js` JSON, one row per variant. Options named like "Color"/"Colour" and "Size" become color and size; otherwise the first option is the color and the second the size. `compare_at_price` is the list price when set.

A store must leave `products.json` public. A password-protected store answers with its storefront page instead, and discovery fails with "not a Shopify store".

## WooCommerce stores

Set the site's adapter to `woocommerce`. Like `shopify`, it needs only the brand's page on the store as the brand URL. Everything is read from the public Store API (`/wp-json/wc/store/v1/products`), which needs no key:

- **A product category page** (`/product-category/red-maple/`): every product in that category.
- **A brand page** (`/brand/red-maple/` or `/product-brand/red-maple/`): every product of that brand.
- **Any other page**: every product in the store whose brand (WooCommerce Brands) matches the brand name, ignoring case.

A variable product gives one row per variation, each with its own SKU, price, stock and image, read from `/products?parent=<id>&type=variation`. Attributes named like "Color"/"Colour" and "Size" become color and size; otherwise the first attribute is the color and the second the size. A simple product gives one row. Prices are converted from the store's minor currency unit, and the regular price is the list price.

Product URLs are WordPress shortlinks (`/?p=<id>`, plus `&post_type=product` for simple products), because the variations can only be fetched by the parent's id. They redirect to the product page, and each row's URL is the product's real permalink.

A store that disables or blocks the Store API answers with something other than product JSON, and discovery fails with "not a WooCommerce store".

## Write your own adapter

1. Copy `server/src/adapters/_template.ts` to `server/src/adapters/my-retailer.ts`, and give it a unique `id`.
2. Fill in `discover` and `extract`. The template is a working example; its comments mark what to change. Fetch only through `ctx.fetchPage`, so the configured provider and its proxies are used.
3. Register it in `server/src/adapters/index.ts`: one import, one list entry.
4. Try it against a product page from your site. **Don't commit pages captured from a retailer.**
5. Set the site's **Adapter** to your id on the Config page.

When a page can't be read, throw `ExtractionError` with a short reason rather than returning rows full of empty strings. The reason is recorded against that product.

Optional hooks:

| Hook | Use it for |
|---|---|
| `productId(url)` | A stable catalog key for a URL. The default is the last all-digit path segment, else the last path segment. |
| `productUrl(id, site)` | Rebuilds a product URL from its id when discovery comes back empty. |
| `fetchUrl(productUrl)` | The URL to fetch for a product, when it differs from the page URL (e.g. a JSON endpoint). `extract` still receives the product URL. |
| `isDiscontinued(html)` | Positively recognises a "product not found" page, so it is skipped rather than counted as a failure. |
| `needsRender` | Set it when product pages only work with browser rendering (slower and costlier). |
| `needsLinkPattern` | Set it when `discover` needs the site's product link pattern. The "Add a retailer" wizard then suggests one from the listing page and shows the field. |
| `detect(origin, fetchPage)` | Recognises a store on your platform from one cheap request, e.g. a JSON endpoint only that platform serves. The wizard asks each adapter in registration order and falls back to `schema-org`; a fetch that throws counts as "no". |

The registry (`getAdapter`) fills in what every adapter shares, so don't do these yourself:
- `productId` falls back to the default rule above;
- each row's `source` is set to your adapter id;
- each row's `image_url` goes through `scrapers/image-url-canonicalizer.ts` right after `extract`: anything but an absolute https URL with no whitespace becomes `''`. Repair a retailer's own CDN quirks (protocol-relative `//` URLs, `http:`) in your adapter before returning.

## The `ProductVariant` row

Every field is a string. Use `''` when a value is unknown, never `undefined`. Adapters return these rows without `source` (the `AdapterRow` type).

| Field | Meaning |
|---|---|
| `retailer` | `site.name` |
| `style_id` | The product (style) id, shared by all its variants |
| `sku`, `upc`, `item_number` | Per-variant identifiers |
| `title`, `description` | The description is plain text; use `cleanDescription` |
| `color`, `size` | |
| `list_price`, `selling_price` | Two decimals, e.g. `"49.50"`; use `formatPrice` |
| `inventory` | `In Stock`, `Out of Stock`, a quantity, or `''` |
| `image_url` | An absolute https URL, or `''`. Anything else is replaced with `''`. |
| `url` | The product page URL |
| `source` | Leave it out: the registry sets it to your adapter id |

## Upgrading from the built-in retailers

Releases before the adapter API shipped four hard-wired retailers. Their sites stay in your config and now run on `schema-org`.

They fail with "Set a product link pattern…" until you either:
- set the fields above, or
- disable the site.

You don't need to clear `data/catalogs/`. Each catalog and variant-cache file records the adapter and cache version that wrote it, and a file from another adapter or version is ignored and rewritten on the next run. That run re-discovers and re-fetches every product.
