/**
 * Scraping provider registry. To add a provider: add its settings shape to
 * `ProviderSettings` and its transport branch to `scrapers/scraping-provider.ts`,
 * write a module like ./apify.ts, and add one entry below. The Config page
 * reads the list from the server.
 */
import type { ProviderSettings } from '../scrapers/scraping-provider';
import { apifyProvider } from './apify';
import { brightdataProvider } from './brightdata';
import { directProvider } from './direct';
import { firecrawlProvider } from './firecrawl';
import type { ProviderField, ProviderKind, ScrapingProviderModule } from './types';

// The mapped type makes a new ProviderSettings kind without a module a compile error.
const registry: { [K in ProviderKind]: ScrapingProviderModule<K> } = {
  direct: directProvider,
  brightdata: brightdataProvider,
  apify: apifyProvider,
  firecrawl: firecrawlProvider,
};

/** In Config-page order. */
export const providerModules = Object.values(registry) as ScrapingProviderModule[];

/** The module for these settings (or this kind). */
export function providerFor(s: ProviderSettings | ProviderKind): ScrapingProviderModule {
  return registry[typeof s === 'string' ? s : s.kind] as ScrapingProviderModule;
}

export interface ProviderCatalogEntry {
  kind: ProviderKind;
  label: string;
  description: string;
  hint?: string;
  fields: readonly ProviderField[];
  billsBandwidth: boolean;
}

/** What the Config page needs to draw the provider form. */
export function providerCatalog(): ProviderCatalogEntry[] {
  return providerModules.map(({ kind, label, description, hint, fields, billsBandwidth }) => ({
    kind, label, description, ...(hint ? { hint } : {}), fields, billsBandwidth,
  }));
}

export type { ProviderKind, ScrapingProviderModule, SettingsOf } from './types';
