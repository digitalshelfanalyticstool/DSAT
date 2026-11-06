import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { config } from '../config';
import { readJSON, appendToArray, updateItem, removeFromArray } from '../utils/json-storage';
import { getApiToken } from './credential-manager';
import { createLogger } from '../utils/logger';

/**
 * Caller errors from this module carry the status (and, for a conflict, the
 * established `conflict_error` tag) that the config routes answer with. The
 * routes used to recover that by testing the message for "already exists" /
 * "not found" inside a catch-all, which also matched unrelated failures whose
 * text happened to contain those words.
 */
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, errorType: 'conflict_error' });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}


const logger = createLogger('config-manager');

// --- Data Models ---

export interface SiteConfig {
  site_id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Optional display name for UI */
  display_name?: string;
  /** Per-brand URLs for discovery pages (key = brand name lowercase) */
  brand_urls?: Record<string, string>;
  /** Adapter id from server/src/adapters (default "schema-org"). */
  adapter?: string;
  /** Listing URL used when brand_urls has no entry; `{brand}` and `{page}` are substituted. */
  listing_url_template?: string;
  /** Regex source matched against link pathnames to pick product pages. */
  product_link_pattern?: string;
}

/** Site fields that configure its retailer adapter. */
export type AdapterField = 'adapter' | 'listing_url_template' | 'product_link_pattern';

export interface BrandConfig {
  brand_id: string;
  name: string;
  filter_criteria: Record<string, string>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Retailers (lowercase site names) this brand may run on. Absent/empty ⇒ all retailers. */
  allowed_retailers?: string[];
}

// --- File Paths ---

function getDataDir(): string {
  return config.scraping.dataDir;
}

function getSitesFile(): string {
  return path.join(getDataDir(), 'sites.json');
}

function getBrandsFile(): string {
  return path.join(getDataDir(), 'brands.json');
}

// --- Site CRUD ---

export async function getSites(): Promise<SiteConfig[]> {
  const sites = await readJSON<SiteConfig[]>(getSitesFile());
  // Deduplicate by name (case-insensitive), keeping the first occurrence
  const seen = new Set<string>();
  return sites.filter((s) => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function addSite(config: {
  name: string;
  base_url: string;
  display_name?: string;
  brand_urls?: Record<string, string>;
} & Partial<Pick<SiteConfig, AdapterField>>): Promise<SiteConfig> {
  const sites = await getSites();
  const duplicate = sites.find(
    (s) => s.name.toLowerCase() === config.name.toLowerCase(),
  );
  if (duplicate) {
    throw conflict(`Site with name "${config.name}" already exists`);
  }

  const now = new Date().toISOString();
  const site: SiteConfig = {
    site_id: uuidv4(),
    name: config.name,
    base_url: config.base_url,
    enabled: true,
    created_at: now,
    updated_at: now,
    ...(config.display_name && { display_name: config.display_name }),
    ...(config.brand_urls && { brand_urls: config.brand_urls }),
    ...(config.adapter && { adapter: config.adapter }),
    ...(config.listing_url_template && { listing_url_template: config.listing_url_template }),
    ...(config.product_link_pattern && { product_link_pattern: config.product_link_pattern }),
  };

  await appendToArray<SiteConfig>(getSitesFile(), site);
  logger.info('Site added', { operation: 'addSite', siteId: site.site_id, name: site.name });
  return site;
}

export async function updateSite(
  siteId: string,
  updates: Partial<Pick<SiteConfig, 'name' | 'base_url' | 'enabled' | 'brand_urls' | AdapterField>>,
): Promise<SiteConfig> {
  // If renaming, check uniqueness
  if (updates.name !== undefined) {
    const sites = await getSites();
    const duplicate = sites.find(
      (s) => s.name.toLowerCase() === updates.name!.toLowerCase() && s.site_id !== siteId,
    );
    if (duplicate) {
      throw conflict(`Site with name "${updates.name}" already exists`);
    }
  }

  let updated: SiteConfig | null = null;
  await updateItem<SiteConfig>(
    getSitesFile(),
    (s) => s.site_id === siteId,
    (s) => {
      updated = {
        ...s,
        ...updates,
        updated_at: new Date().toISOString(),
      };
      return updated;
    },
  );

  if (!updated) {
    throw notFound(`Site with id "${siteId}" not found`);
  }

  logger.info('Site updated', { operation: 'updateSite', siteId });
  return updated;
}

/** Delete sites by name (case-insensitive). Only the demo seed's `--remove` uses this; the UI disables sites instead. */
export async function removeSitesByName(names: readonly string[]): Promise<number> {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return removeFromArray<SiteConfig>(getSitesFile(), (s) => lower.has(s.name.toLowerCase()));
}

// --- Brand CRUD ---

export async function getBrands(): Promise<BrandConfig[]> {
  return readJSON<BrandConfig[]>(getBrandsFile());
}

export async function addBrand(config: {
  name: string;
  filter_criteria: Record<string, string>;
  allowed_retailers?: string[];
}): Promise<BrandConfig> {
  const brands = await getBrands();
  const duplicate = brands.find(
    (b) => b.name.toLowerCase() === config.name.toLowerCase(),
  );
  if (duplicate) {
    throw conflict(`Brand with name "${config.name}" already exists`);
  }

  const now = new Date().toISOString();
  const brand: BrandConfig = {
    brand_id: uuidv4(),
    name: config.name,
    filter_criteria: config.filter_criteria,
    enabled: true,
    created_at: now,
    updated_at: now,
    ...(config.allowed_retailers && { allowed_retailers: config.allowed_retailers }),
  };

  await appendToArray<BrandConfig>(getBrandsFile(), brand);
  logger.info('Brand added', { operation: 'addBrand', brandId: brand.brand_id, name: brand.name });
  return brand;
}

export async function updateBrand(
  brandId: string,
  updates: Partial<Pick<BrandConfig, 'name' | 'filter_criteria' | 'enabled' | 'allowed_retailers'>>,
): Promise<BrandConfig> {
  if (updates.name !== undefined) {
    const brands = await getBrands();
    const duplicate = brands.find(
      (b) => b.name.toLowerCase() === updates.name!.toLowerCase() && b.brand_id !== brandId,
    );
    if (duplicate) {
      throw conflict(`Brand with name "${updates.name}" already exists`);
    }
  }

  let updated: BrandConfig | null = null;
  await updateItem<BrandConfig>(
    getBrandsFile(),
    (b) => b.brand_id === brandId,
    (b) => {
      updated = {
        ...b,
        ...updates,
        updated_at: new Date().toISOString(),
      };
      return updated;
    },
  );

  if (!updated) {
    throw notFound(`Brand with id "${brandId}" not found`);
  }

  logger.info('Brand updated', { operation: 'updateBrand', brandId });
  return updated;
}

/** Delete brands by name (case-insensitive). Only the demo seed's `--remove` uses this. */
export async function removeBrandsByName(names: readonly string[]): Promise<number> {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return removeFromArray<BrandConfig>(getBrandsFile(), (b) => lower.has(b.name.toLowerCase()));
}

// --- Credential Management ---

/**
 * Test connection to the Bright Data API.
 * Makes a simple request to verify the API key is valid.
 * Uses provided token or falls back to stored value.
 */
export async function testBrightDataConnection(
  token?: string,
): Promise<{ success: boolean; message: string }> {
  const actualToken = token || getApiToken();

  if (!actualToken) {
    return { success: false, message: 'Bright Data API key is not configured' };
  }

  try {
    const url = 'https://api.brightdata.com/zone/route_ips';
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${actualToken}`,
      },
    });

    if (response.ok) {
      return { success: true, message: 'Connection successful' };
    }

    if (response.status === 401 || response.status === 403) {
      return { success: false, message: 'Authentication failed: invalid API key' };
    }

    return {
      success: false,
      message: `Connection failed with status ${response.status}`,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Connection failed: ${msg}` };
  }
}

