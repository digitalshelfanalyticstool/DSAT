/**
 * Alert rule evaluation. Pure, with no project imports: whether a rule targets
 * a product, whether the product is in the rule's condition, and the details an
 * alert records. Firing on the transition (out → in) is the caller's job.
 */

export type AlertKind = 'price_below' | 'price_drop' | 'out_of_stock' | 'broken_image';
export type AlertTarget = 'all' | 'brand' | 'site' | 'product';

export interface AlertRule {
  id: number;
  name: string;
  kind: AlertKind;
  target_type: AlertTarget;
  target_site: string | null;
  target_brand: string | null;
  target_style_id: string | null;
  threshold: number | null;
  percent: number | null;
}

/** One product as seen by one scrape run, summarised across its variants. */
export interface ProductState {
  /** Lowest variant selling price; null when no variant has one. */
  min_price: number | null;
  any_in_stock: boolean;
  /** First non-empty variant image URL; '' when none. */
  image_url: string;
  /** Result of the image check; null when not checked. */
  image_ok: boolean | null;
}

export interface ProductObservation {
  product_id: number;
  retailer: string;
  brand: string;
  style_id: string;
  current: ProductState;
  /** The product's previous run; null on its first scrape. */
  previous: ProductState | null;
}

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

export function ruleMatchesTarget(rule: AlertRule, o: ProductObservation): boolean {
  switch (rule.target_type) {
    case 'all': return true;
    case 'brand': return same(rule.target_brand, o.brand);
    case 'site': return same(rule.target_site, o.retailer);
    case 'product': return same(rule.target_site, o.retailer) && rule.target_style_id === o.style_id;
  }
}

export function inCondition(rule: AlertRule, o: ProductObservation): boolean {
  const { current, previous } = o;
  switch (rule.kind) {
    case 'price_below':
      return current.min_price !== null && rule.threshold !== null && current.min_price < rule.threshold;
    case 'price_drop': {
      const prev = previous?.min_price ?? null;
      if (prev === null || current.min_price === null || current.min_price >= prev) return false;
      return rule.percent === null || ((prev - current.min_price) / prev) * 100 >= rule.percent;
    }
    case 'out_of_stock':
      return previous !== null && previous.any_in_stock && !current.any_in_stock;
    case 'broken_image':
      return current.image_url === '' || current.image_ok === false;
  }
}

export function alertDetails(rule: AlertRule, o: ProductObservation): Record<string, unknown> {
  switch (rule.kind) {
    case 'price_below':
      return { old_price: o.previous?.min_price ?? null, new_price: o.current.min_price, threshold: rule.threshold };
    case 'price_drop':
      return {
        old_price: o.previous?.min_price ?? null, new_price: o.current.min_price,
        ...(rule.percent !== null && { percent: rule.percent }),
      };
    case 'out_of_stock':
      return {};
    case 'broken_image':
      return { image_url: o.current.image_url, reason: o.current.image_url === '' ? 'missing' : 'broken' };
  }
}
