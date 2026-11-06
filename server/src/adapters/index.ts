/**
 * Adapter registry. To add an adapter: import it and add it to the list below,
 * then set the site's `adapter` field to its id.
 *
 * Every adapter is handed out through `getAdapter`, which fills in what the
 * pipeline owns: the default `productId`, `source` on each row, and the
 * image_url contract (scrapers/image-url-canonicalizer.ts) applied right after
 * `extract`.
 */
import { canonicalizeImageUrl } from '../scrapers/image-url-canonicalizer';
import { defaultProductId, type Adapter, type FetchPage, type RetailerAdapter } from './types';
import { schemaOrgAdapter } from './schema-org';
import { shopifyAdapter } from './shopify';
import { woocommerceAdapter } from './woocommerce';

export const DEFAULT_ADAPTER_ID = 'schema-org';

function resolve(adapter: RetailerAdapter): Adapter {
  return {
    ...adapter,
    productId: adapter.productId ?? defaultProductId,
    extract: (ctx) => adapter.extract(ctx).map((row) => ({
      ...row,
      source: adapter.id,
      image_url: canonicalizeImageUrl(row.image_url).url,
    })),
  };
}

/** In registration order, which is the order `detectAdapter` probes in. */
const registered: Adapter[] = [schemaOrgAdapter, shopifyAdapter, woocommerceAdapter].map(resolve);
const adapters = new Map(registered.map((a) => [a.id, a]));

/** The adapter for a site's `adapter` field; a site that names none gets the default. */
export function getAdapter(id: string | null | undefined): Adapter {
  const key = id ?? DEFAULT_ADAPTER_ID;
  const adapter = adapters.get(key);
  if (!adapter) throw new Error(`No adapter registered for '${key}'`);
  return adapter;
}

export function adapterIds(): string[] {
  return [...adapters.keys()];
}

/** The first adapter whose `detect` recognises the store at `origin`, else the default. */
export async function detectAdapter(origin: string, fetchPage: FetchPage): Promise<string> {
  for (const adapter of registered) {
    if (!adapter.detect) continue;
    const matches = await adapter.detect(origin, fetchPage).catch(() => false);
    if (matches) return adapter.id;
  }
  return DEFAULT_ADAPTER_ID;
}

export * from './types';
