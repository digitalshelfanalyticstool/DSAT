import type { AlertKind, Brand, Site } from '@/lib/api-client';

export const KIND_OPTIONS: { value: AlertKind; label: string }[] = [
  { value: 'price_below', label: 'Price below' },
  { value: 'price_drop', label: 'Price drop' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'broken_image', label: 'Broken or missing image' },
];

export function money(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

export function alertTitle(kind: AlertKind, details: Record<string, unknown>): string {
  switch (kind) {
    case 'price_below': return money(details.threshold) ? `Price below ${money(details.threshold)}` : 'Price below';
    case 'price_drop': return 'Price drop';
    case 'out_of_stock': return 'Out of stock';
    case 'broken_image': return details.reason === 'missing' ? 'Missing image' : 'Broken image';
  }
}

/** Retailer options: values are the site names alerts and rules store. */
export const siteOptions = (sites: Site[]) => sites.map((s) => ({ value: s.name, label: s.display_name || s.name }));

export const brandOptions = (brands: Brand[]) =>
  brands.map((b) => ({ value: b.display_name || b.name, label: b.display_name || b.name }));

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
