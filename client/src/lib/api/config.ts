import { http } from './http';
import type { PaletteId } from '../palettes';

export interface Site {
  site_id: string;
  name: string;
  display_name?: string;
  base_url: string;
  enabled: boolean;
  /** Per-brand discovery URLs (key = brand name lowercase). */
  brand_urls?: Record<string, string>;
  /** Adapter id; unset means the server default (`default_adapter` from GET /config/adapters). */
  adapter?: string;
  /** Listing URL for brands with no brand_urls entry; `{brand}` and `{page}` are substituted. */
  listing_url_template?: string;
  /** Regex matched against link paths to pick product pages. */
  product_link_pattern?: string;
}

/** Fields an admin sets when adding or editing a site. */
export type SiteInput = Pick<Site, 'name' | 'base_url' | 'brand_urls' | 'adapter' | 'listing_url_template' | 'product_link_pattern'>;

export interface Brand {
  brand_id: string;
  name: string;
  display_name?: string;
  filter_criteria: Record<string, unknown>;
  enabled: boolean;
  /** Retailers (lowercase site names) this brand may run on. Absent/empty ⇒ all retailers. */
  allowed_retailers?: string[];
}

/** "Add a retailer" wizard — POST /config/sites/preview. */
export interface SitePreviewInput { url: string; brand: string; adapter?: string; product_link_pattern?: string }

export interface SitePreviewSample { url: string; rows: Record<string, string>[]; error?: string }

export interface SitePreview {
  adapter: string;
  suggested_pattern: string | null;
  link_count: number;
  links: string[];
  samples: SitePreviewSample[];
  fields: { filled: string[]; empty: string[] };
  problem: 'blocked' | 'no_links' | 'no_data' | 'timeout' | null;
  message: string | null;
}

/** POST /config/sites/onboard. */
export interface OnboardSiteInput {
  url: string;
  brand: string;
  adapter: string;
  product_link_pattern?: string;
  name?: string;
  display_name?: string;
}

/** One provider as the Config form draws it; served by the API. */
export interface ScrapingProviderCatalogEntry {
  /** Provider id. The server owns the list. */
  kind: string;
  label: string;
  description: string;
  /** A warning to show under the form. */
  hint?: string;
  fields: { key: string; label: string; secret?: boolean; placeholder?: string; default?: string }[];
  billsBandwidth: boolean;
}

/** Field values as the form edits them. Secrets arrive masked; sending a mask back keeps the stored value. */
export interface ScrapingProviderInput {
  provider: string;
  fields: Record<string, string>;
}

export interface ScrapingProviderResponse extends ScrapingProviderInput {
  success: boolean;
  /** 'env' until an admin saves settings here. */
  source: 'db' | 'env';
  /** Whether the active provider bills by the byte, so bandwidth and cost views apply. */
  bills_bandwidth: boolean;
  /** Every provider the server supports. */
  catalog: ScrapingProviderCatalogEntry[];
}

/** OIDC single sign-on settings as the admin form edits them. The client secret arrives masked. */
export interface SsoFields {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowedEmailDomains: string[];
  buttonLabel: string;
}

export interface SsoSettingsResponse {
  success: boolean;
  configured: boolean;
  /** Register this with the identity provider. */
  redirectUri: string;
  fields: SsoFields;
}

export const configApi = {
  async getSites() {
    return http.request<{
      success: true;
      sites: Site[];
    }>('/config/sites');
  },

  async getBrands() {
    return http.request<{
      success: true;
      brands: Brand[];
    }>('/config/brands');
  },

  async getAdapters() {
    return http.request<{ success: true; adapters: string[]; default_adapter?: string; needs_link_pattern?: string[] }>('/config/adapters');
  },

  async previewSite(input: SitePreviewInput) {
    return http.request<{ success: true; preview: SitePreview; site: { name: string; display_name: string; existing: boolean } }>('/config/sites/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async onboardSite(input: OnboardSiteInput) {
    return http.request<{ success: true; site: Site; brand: Brand; job_id: string; reused_site: boolean }>(
      '/config/sites/onboard',
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  async addSite(site: SiteInput) {
    return http.request<{
      success: true;
      site: Site;
    }>('/config/sites', {
      method: 'POST',
      body: JSON.stringify(site),
    });
  },

  async updateSite(
    siteId: string,
    updates: Partial<SiteInput> & { enabled?: boolean }
  ) {
    return http.request<{
      success: true;
      site: Site;
    }>(`/config/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async addBrand(brand: { name: string; filter_criteria: Record<string, unknown>; allowed_retailers?: string[] }) {
    return http.request<{
      success: true;
      brand: Brand;
    }>('/config/brands', {
      method: 'POST',
      body: JSON.stringify(brand),
    });
  },

  async updateBrand(
    brandId: string,
    updates: { name?: string; filter_criteria?: Record<string, unknown>; enabled?: boolean; allowed_retailers?: string[] }
  ) {
    return http.request<{
      success: true;
      brand: Brand;
    }>(`/config/brands/${brandId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async getScrapingProvider() {
    return http.request<ScrapingProviderResponse>('/admin/scraping-provider');
  },

  async saveScrapingProvider(body: ScrapingProviderInput) {
    return http.request<ScrapingProviderResponse>('/admin/scraping-provider', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  async testScrapingProvider(body: ScrapingProviderInput) {
    return http.request<{ success: boolean; message: string; egressIp?: string }>('/admin/scraping-provider/test', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async getSsoSettings() {
    return http.request<SsoSettingsResponse>('/admin/sso');
  },

  async saveSsoSettings(body: { fields: SsoFields }) {
    return http.request<SsoSettingsResponse>('/admin/sso', { method: 'PUT', body: JSON.stringify(body) });
  },

  async testSsoSettings(body: { fields: SsoFields }) {
    return http.request<{ success: boolean; message: string }>('/admin/sso/test', { method: 'POST', body: JSON.stringify(body) });
  },

  /** The site palette. Public: the login and setup pages read it before sign-in. */
  async getAppearance() {
    return http.request<{ success: true; palette: PaletteId }>('/settings/appearance');
  },

  async setAppearance(palette: PaletteId) {
    return http.request<{ success: true; palette: PaletteId }>('/admin/appearance', { method: 'PUT', body: JSON.stringify({ palette }) });
  },
};
