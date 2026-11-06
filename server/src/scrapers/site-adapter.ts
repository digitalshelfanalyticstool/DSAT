/**
 * The variant row every adapter produces. The adapter API itself lives in
 * ../adapters/types.ts.
 */

/**
 * Represents a single product variant — one row in the final Excel output.
 * Each variant is a unique size/color combination of a base product.
 */
export interface ProductVariant {
  retailer: string;
  style_id: string;
  sku: string;
  upc: string;
  title: string;
  color: string;
  size: string;
  description: string;
  list_price: string;   // decimal with 2 decimal places as string
  selling_price: string; // decimal with 2 decimal places as string
  url: string;
  source: string;
  item_number: string;
  inventory: string;     // stock availability: a quantity, 'In Stock'/'Out of Stock', or empty
  image_url: string;     // empty string when scraper couldn't extract one
  /** Product type classified from title at persist time; optional — only the Excel read path sets it. */
  product_type?: string;
}
