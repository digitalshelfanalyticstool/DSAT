/**
 * What one scraping provider knows about itself, apart from how it fetches
 * (that is `scrapers/scraping-provider.ts`, a zero-import leaf). One module per
 * provider, registered in ./index.ts.
 */
import type { z } from 'zod';
import type { ProviderSettings } from '../scrapers/scraping-provider';

export type ProviderKind = ProviderSettings['kind'];
export type SettingsOf<K extends ProviderKind> = Extract<ProviderSettings, { kind: K }>;
export type SubmittedFields = Partial<Record<string, string>>;

/** One input on the Config page. `default` fills the form before anything is saved. */
export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  default?: string;
}

export interface ProviderTestResult {
  success: boolean;
  message: string;
  egressIp?: string;
}

export interface ScrapingProviderModule<K extends ProviderKind = ProviderKind> {
  readonly kind: K;
  readonly label: string;
  readonly description: string;
  /** Shown under the form, when there is something to warn about. */
  readonly hint?: string;
  readonly fields: readonly ProviderField[];
  /** Validates the submitted `fields` object. */
  readonly schema: z.ZodType<SubmittedFields>;
  /** Renders pages on the provider's side; otherwise a local pooled browser renders through it. */
  readonly rendersRemotely: boolean;
  /** Billed per byte, so job bandwidth is recorded and the cost views apply. */
  readonly billsBandwidth: boolean;
  /** Values to redact from logs. */
  secrets(s: SettingsOf<K>): (string | undefined)[];
  /** Why these settings cannot fetch at all, or undefined. A fetch then fails as a config error. */
  missingConfig?(s: SettingsOf<K>): string | undefined;
  /** Field values for the Config page, secrets masked. */
  display(s: SettingsOf<K>): Record<string, string>;
  /** Submitted fields (a masked or blank secret means "keep") plus what is stored → settings to use. Throws a 400 on bad input. */
  merge(fields: SubmittedFields, stored: ProviderSettings): SettingsOf<K>;
  /** Try the settings with real requests. Never throws. */
  test(s: SettingsOf<K>): Promise<ProviderTestResult>;
}
