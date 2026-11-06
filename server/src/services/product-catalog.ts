/**
 * Product Catalog — persistent, cumulative store of known product IDs and
 * cached variant data per site+brand.
 *
 * Each run adds newly discovered product IDs to the catalog. Products are never
 * removed automatically — they accumulate over time to compensate for inconsistent
 * CDN responses from retailers. Products that fail to fetch on consecutive runs
 * get a failure counter incremented; after MAX_CONSECUTIVE_FAILURES they're marked
 * stale but still retained for reference.
 *
 * Variant caching: successful fetches store the variant rows in a separate cache
 * file. When a product fails to fetch, the orchestrator falls back to the cached
 * variants from the last successful fetch, ensuring consistent output every run.
 *
 * Storage:
 *   server/data/catalogs/{site}_{brand}.json         — product ID catalog
 *   server/data/catalogs/{site}_{brand}_variants.json — cached variant data
 *
 * Both are keyed by the adapter's product id (`adapter.productId`), and both are
 * stamped with CATALOG_SCHEMA_VERSION and the adapter that wrote them. A file
 * with another stamp is ignored (read as empty) and overwritten on the next
 * write, so a shape change or a site switching adapters invalidates it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { readJSON, writeJSON, invalidateCache } from '../utils/json-storage';
import { createLogger } from '../utils/logger';
import type { ProductVariant } from '../scrapers/site-adapter';

const logger = createLogger('product-catalog');

/** Max consecutive fetch failures before a product is marked stale. Configurable via MAX_CONSECUTIVE_FAILURES (default 3). */
const MAX_CONSECUTIVE_FAILURES = config.scraping.maxConsecutiveFailures;

/**
 * Bump when the shape or the keying of either file changes.
 * 2: variant cache keyed by product id instead of style_id; adapter stamp added.
 */
export const CATALOG_SCHEMA_VERSION = 2;

interface Stamp {
  schema_version: number;
  /** Id of the adapter whose product ids key this file. */
  adapter: string;
}

function hasStamp(data: { schema_version?: unknown; adapter?: unknown }, adapter: string): boolean {
  return data.schema_version === CATALOG_SCHEMA_VERSION && data.adapter === adapter;
}

interface CatalogEntry {
  product_id: string;
  first_seen: string;
  last_seen: string;
  consecutive_failures: number;
  stale: boolean;
  /** Product page URL from discovery, so later runs can re-fetch without the adapter rebuilding it. */
  url?: string;
}

export interface ProductCatalog extends Stamp {
  site: string;
  brand: string;
  updated_at: string;
  /** ISO timestamp of the last successful discovery run (used for discovery cache TTL). */
  discovery_completed_at?: string;
  entries: CatalogEntry[];
}

function getCatalogPath(site: string, brand: string): string {
  return path.join(config.scraping.dataDir, 'catalogs', `${site.toLowerCase()}_${brand.toLowerCase()}.json`);
}

function getVariantCachePath(site: string, brand: string): string {
  return path.join(config.scraping.dataDir, 'catalogs', `${site.toLowerCase()}_${brand.toLowerCase()}_variants.json`);
}

// ─── Cache inventory & purge (admin) ─────────────────────────────────────────

function catalogsDir(): string {
  return path.join(config.scraping.dataDir, 'catalogs');
}

/** Read JSON without readJSON()'s file-creating side effect; null on any error. */
async function readJsonNoCreate(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

/** Inventory entry for one site+brand catalog-cache pair. */
export interface CatalogCacheInfo {
  site: string;
  brand: string;
  discoveryBytes: number;
  /** Hours since the last successful discovery, or null if never recorded. */
  discoveryAgeHours: number | null;
  variantBytes: number;
  variantProductCount: number;
  /** Empty variant cache next to a non-empty discovery catalog — the poisoned-run signature. */
  suspectedPoisoned: boolean;
}

/**
 * List active catalog caches (discovery + variant pairs) under the catalogs dir.
 * Only files ending exactly in `.json` count as active — move-aside copies
 * (`.json.purged-*` / `.poisoned` / `.reset-*`) and temp files are ignored.
 */
export async function listCatalogCaches(): Promise<CatalogCacheInfo[]> {
  const dir = catalogsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const discoveryFiles = files.filter(
    (f) => f.endsWith('.json') && !f.endsWith('_variants.json') && !f.startsWith('.'),
  );

  const infos = await Promise.all(
    discoveryFiles.map(async (file): Promise<CatalogCacheInfo | null> => {
      const base = file.slice(0, -'.json'.length); // "<site>_<brand>"
      const sep = base.indexOf('_');
      if (sep <= 0) return null;
      const site = base.slice(0, sep);
      const brand = base.slice(sep + 1);

      const discoveryPath = path.join(dir, file);
      const variantPath = path.join(dir, `${base}_variants.json`);

      const [discoveryBytes, variantBytes, discoveryJson, variantJson] = await Promise.all([
        fileSize(discoveryPath),
        fileSize(variantPath),
        readJsonNoCreate(discoveryPath),
        readJsonNoCreate(variantPath),
      ]);

      const completedAt = (discoveryJson as ProductCatalog | null)?.discovery_completed_at;
      const discoveryAgeHours = completedAt
        ? (Date.now() - new Date(completedAt).getTime()) / 3_600_000
        : null;

      const products = (variantJson as VariantCache | null)?.products;
      const variantProductCount =
        products && typeof products === 'object' ? Object.keys(products).length : 0;

      return {
        site,
        brand,
        discoveryBytes,
        discoveryAgeHours,
        variantBytes,
        variantProductCount,
        suspectedPoisoned: variantProductCount === 0 && discoveryBytes > 0,
      };
    }),
  );

  return infos
    .filter((i): i is CatalogCacheInfo => i !== null)
    .sort((a, b) => a.site.localeCompare(b.site) || a.brand.localeCompare(b.brand));
}

/**
 * Move aside (not delete) the discovery + variant cache files for a site+brand so
 * the next run re-discovers fresh. Renames each to `<file>.purged-<ISO>` and drops
 * the in-memory read cache. No-op-safe when a file is absent. Returns moved basenames.
 */
export async function purgeCatalogCache(site: string, brand: string): Promise<string[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targets = [getCatalogPath(site, brand), getVariantCachePath(site, brand)];
  const moved: string[] = [];
  for (const filePath of targets) {
    try {
      await fs.rename(filePath, `${filePath}.purged-${stamp}`);
      invalidateCache(filePath);
      moved.push(path.basename(filePath));
    } catch {
      // absent — nothing to move
    }
  }
  if (moved.length > 0) {
    logger.info('Catalog cache purged', { operation: 'purgeCatalogCache', site, brand, moved });
  }
  return moved;
}

/** A single cached product's variant data with a fetch timestamp for TTL checks. */
export interface CachedProductEntry {
  variants: ProductVariant[];
  fetched_at: string;
}

/** Variant cache: maps product_id → variant data with fetch timestamp */
export interface VariantCache extends Partial<Stamp> {
  updated_at: string;
  products: Record<string, CachedProductEntry | ProductVariant[]>;
}

function emptyC(site: string, brand: string, adapter: string): ProductCatalog {
  return { schema_version: CATALOG_SCHEMA_VERSION, adapter, site, brand, updated_at: new Date().toISOString(), entries: [] };
}

/**
 * Load the catalog for a site+brand. Returns an empty catalog if none exists,
 * the data is invalid, or it was written by another schema version or adapter.
 */
async function loadCatalog(site: string, brand: string, adapter: string): Promise<ProductCatalog> {
  const filePath = getCatalogPath(site, brand);
  try {
    const data = await readJSON<any>(filePath);
    // Validate shape — readJSON defaults to [] for new files, we need an object with entries
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.entries)) {
      if (hasStamp(data, adapter)) return data as ProductCatalog;
      logger.info('Ignoring catalog from another schema version or adapter', {
        operation: 'loadCatalog', site, brand, adapter, fileVersion: data.schema_version, fileAdapter: data.adapter,
      });
    }
    return emptyC(site, brand, adapter);
  } catch {
    return emptyC(site, brand, adapter);
  }
}

/**
 * Merge newly discovered product IDs into the catalog.
 * - New IDs get added with consecutive_failures = 0
 * - Existing IDs get their last_seen updated and consecutive_failures reset to 0
 * Returns the full list of active (non-stale) product IDs to fetch.
 */
export async function mergeCatalog(
  site: string,
  brand: string,
  adapter: string,
  discoveredIds: string[],
  urls: Record<string, string> = {},
): Promise<{ catalog: ProductCatalog; activeIds: string[]; newIds: string[]; totalKnown: number }> {
  const catalog = await loadCatalog(site, brand, adapter);
  const now = new Date().toISOString();
  const existingMap = new Map<string, CatalogEntry>();

  for (const entry of catalog.entries) {
    existingMap.set(entry.product_id, entry);
  }

  const newIds: string[] = [];

  // Update existing entries that were re-discovered
  for (const id of discoveredIds) {
    const existing = existingMap.get(id);
    if (existing) {
      existing.last_seen = now;
      existing.consecutive_failures = 0;
      existing.stale = false;
      if (urls[id]) existing.url = urls[id];
    } else {
      newIds.push(id);
      existingMap.set(id, {
        product_id: id,
        first_seen: now,
        last_seen: now,
        consecutive_failures: 0,
        stale: false,
        ...(urls[id] ? { url: urls[id] } : {}),
      });
    }
  }

  catalog.entries = Array.from(existingMap.values());
  catalog.updated_at = now;
  // Mark discovery timestamp only when actual product IDs were discovered
  if (discoveredIds.length > 0) {
    catalog.discovery_completed_at = now;
  }

  // Save updated catalog
  await writeJSON(getCatalogPath(site, brand), catalog);

  // Return active (non-stale) IDs for fetching
  const activeIds = catalog.entries
    .filter(e => !e.stale)
    .map(e => e.product_id);

  logger.info('Catalog merged', {
    operation: 'mergeCatalog', site, brand,
    discovered: discoveredIds.length,
    newProducts: newIds.length,
    totalKnown: catalog.entries.length,
    activeForFetch: activeIds.length,
    stale: catalog.entries.filter(e => e.stale).length,
  });

  return { catalog, activeIds, newIds, totalKnown: catalog.entries.length };
}

/** Product id → product page URL for every catalog entry that has one. */
export async function getCatalogUrls(site: string, brand: string, adapter: string): Promise<Map<string, string>> {
  const catalog = await loadCatalog(site, brand, adapter);
  return new Map(catalog.entries.filter((e) => e.url).map((e) => [e.product_id, e.url as string]));
}

/**
 * Record fetch failures for product IDs that couldn't be fetched.
 * Increments consecutive_failures and marks as stale if threshold exceeded.
 */
export async function recordFailures(
  site: string,
  brand: string,
  adapter: string,
  failedIds: string[],
): Promise<void> {
  if (failedIds.length === 0) return;

  const catalog = await loadCatalog(site, brand, adapter);
  const failedSet = new Set(failedIds);

  for (const entry of catalog.entries) {
    if (failedSet.has(entry.product_id)) {
      entry.consecutive_failures += 1;
      if (entry.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
        entry.stale = true;
      }
    }
  }

  catalog.updated_at = new Date().toISOString();
  await writeJSON(getCatalogPath(site, brand), catalog);

  const newlyStale = catalog.entries.filter(
    e => failedSet.has(e.product_id) && e.stale && e.consecutive_failures === MAX_CONSECUTIVE_FAILURES
  ).length;

  logger.info('Failures recorded', {
    operation: 'recordFailures', site, brand,
    failedCount: failedIds.length,
    newlyStale,
  });
}


// ─── Variant Cache ──────────────────────────────────────────────────────────────

/**
 * Load the variant cache for a site+brand. Returns an empty cache if none
 * exists or it was written by another schema version or adapter.
 */
export async function loadVariantCache(site: string, brand: string, adapter: string): Promise<VariantCache> {
  const filePath = getVariantCachePath(site, brand);
  const empty = (): VariantCache => ({
    schema_version: CATALOG_SCHEMA_VERSION, adapter, updated_at: new Date().toISOString(), products: {},
  });
  try {
    const data = await readJSON<any>(filePath);
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.products === 'object') {
      if (hasStamp(data, adapter)) return data as VariantCache;
      logger.info('Ignoring variant cache from another schema version or adapter', {
        operation: 'loadVariantCache', site, brand, adapter, fileVersion: data.schema_version, fileAdapter: data.adapter,
      });
    }
    return empty();
  } catch {
    return empty();
  }
}

/**
 * Normalize a cache entry to the new CachedProductEntry format.
 * Old caches stored ProductVariant[] directly; new format wraps with fetched_at.
 */
export function normalizeCacheEntry(entry: CachedProductEntry | ProductVariant[]): CachedProductEntry {
  if (Array.isArray(entry)) {
    // Legacy format — treat as stale (no fetched_at)
    return { variants: entry, fetched_at: '' };
  }
  return entry;
}

/**
 * Update the variant cache with the variants fetched this run, keyed by the
 * catalog product id each was fetched for. Products not in `fetched` keep
 * their entry and its fetched_at.
 */
export async function updateVariantCache(
  site: string,
  brand: string,
  adapter: string,
  fetched: Record<string, ProductVariant[]>,
): Promise<void> {
  const cache = await loadVariantCache(site, brand, adapter);
  const now = new Date().toISOString();

  for (const [productId, variants] of Object.entries(fetched)) {
    cache.products[productId] = { variants, fetched_at: now };
  }

  cache.updated_at = now;
  await writeJSON(getVariantCachePath(site, brand), cache);

  logger.info('Variant cache updated', {
    operation: 'updateVariantCache', site, brand,
    freshProducts: Object.keys(fetched).length,
    totalCachedProducts: Object.keys(cache.products).length,
  });
}

/**
 * Get cached variants for products that failed to fetch.
 * Returns the last-known-good variant data for each failed product ID.
 */
export function getCachedVariants(
  cache: VariantCache,
  failedProductIds: string[],
): { cachedVariants: ProductVariant[]; uncachedIds: string[] } {
  const cachedVariants: ProductVariant[] = [];
  const uncachedIds: string[] = [];

  for (const id of failedProductIds) {
    const raw = cache.products[id];
    if (!raw) {
      uncachedIds.push(id);
      continue;
    }
    const entry = normalizeCacheEntry(raw);
    if (entry.variants.length > 0) {
      cachedVariants.push(...entry.variants);
    } else {
      uncachedIds.push(id);
    }
  }

  return { cachedVariants, uncachedIds };
}

// ─── Discovery Cache ────────────────────────────────────────────────────────────

/**
 * Check whether the discovery cache for a site+brand is still fresh.
 * Returns the active (non-stale) product IDs from the catalog if fresh.
 */
export async function isDiscoveryCacheFresh(
  site: string,
  brand: string,
  adapter: string,
  ttlMs: number,
): Promise<{ fresh: boolean; activeIds: string[] }> {
  const catalog = await loadCatalog(site, brand, adapter);
  const active = catalog.entries.filter(e => !e.stale);
  const activeIds = active.map(e => e.product_id);

  // No active products — always force fresh discovery
  if (activeIds.length === 0) {
    return { fresh: false, activeIds: [] };
  }

  // An entry with no URL predates adapters; only discovery can give it one.
  if (!catalog.discovery_completed_at || active.some(e => !e.url)) {
    return { fresh: false, activeIds };
  }

  const age = Date.now() - new Date(catalog.discovery_completed_at).getTime();
  const fresh = age < ttlMs;

  if (fresh) {
    logger.info('Discovery cache hit', {
      operation: 'isDiscoveryCacheFresh', site, brand,
      cacheAge: Math.round(age / 1000 / 60),
      ttlMinutes: Math.round(ttlMs / 1000 / 60),
      activeProducts: activeIds.length,
    });
  }

  return { fresh, activeIds };
}

// ─── Variant Cache TTL ──────────────────────────────────────────────────────────

/**
 * Filter product IDs to only those whose cached variant data is stale (older than TTL)
 * or missing entirely. Returns the IDs that need a fresh fetch.
 */
export function getStaleProductIds(
  cache: VariantCache,
  productIds: string[],
  ttlMs: number,
): { staleIds: string[]; freshIds: string[] } {
  const now = Date.now();
  const staleIds: string[] = [];
  const freshIds: string[] = [];

  for (const id of productIds) {
    const raw = cache.products[id];
    if (!raw) {
      staleIds.push(id);
      continue;
    }
    const entry = normalizeCacheEntry(raw);
    if (!entry.fetched_at) {
      staleIds.push(id);
      continue;
    }
    const age = now - new Date(entry.fetched_at).getTime();
    if (age >= ttlMs) {
      staleIds.push(id);
    } else {
      freshIds.push(id);
    }
  }

  return { staleIds, freshIds };
}
