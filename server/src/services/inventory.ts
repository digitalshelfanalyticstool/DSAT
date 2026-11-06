/**
 * The one stock rule. ProductVariant.inventory is a quantity, 'In Stock' /
 * 'Out of Stock', or '' when the page didn't say. Any other string is a raw
 * retailer status ('Sold Out', 'Backordered') and counts as not sellable.
 *
 * Migration 59 defines the same rule in SQL as inventory_in_stock(text);
 * keep the two in step.
 */
export function inventoryInStock(inventory: string | null | undefined): boolean | null {
  const v = (inventory ?? '').trim();
  if (v === '') return null;
  if (v === 'In Stock') return true;
  if (/^-?\d+$/.test(v)) return Number(v) > 0;
  return false;
}
