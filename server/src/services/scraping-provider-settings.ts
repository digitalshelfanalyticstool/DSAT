/**
 * Resolves which scraping provider this process should use right now.
 *
 * The API process and the workers are separate PM2 processes, so a change
 * saved through the admin UI reaches a worker only when its cache expires
 * (`SCRAPING_PROVIDER_CACHE_TTL_MS`). Consumers that hold provider-bound
 * resources (the CDP pool) subscribe with `onProviderChange` to drop them.
 */

import { config } from '../config';
import { fingerprint, type ProviderSettings } from '../scrapers/scraping-provider';
import { createLogger, registerLogSecret } from '../utils/logger';
import { decrypt, encrypt } from './secrets';
import type { EncryptedEnvelope } from './secrets';
import type { DatabaseService } from './database';
import { SettingsStore } from './settings-store';
import { providerFor } from '../providers';

const logger = createLogger('scraping-provider-settings');

/** Settings implied by environment variables alone — used until an admin saves some. */
export function envProviderSettings(): ProviderSettings {
  const bd = config.brightdata;
  if (bd.apiKey) return { kind: 'brightdata', apiKey: bd.apiKey, zone: bd.zone };
  const proxyUrl = config.scrapingProvider.proxyUrl;
  return proxyUrl ? { kind: 'direct', proxyUrl } : { kind: 'direct' };
}

type Row = { provider: string; encrypted_credentials: EncryptedEnvelope };

let decryptFailureLogged = false;

/** Stored settings, or the env fallback when none are saved or they cannot be decrypted. */
function parseRow(row: Row | undefined): { settings: ProviderSettings; source: 'db' | 'env' } {
  if (!row) return { settings: envProviderSettings(), source: 'env' };
  try {
    const settings = decrypt<ProviderSettings>(row.encrypted_credentials);
    decryptFailureLogged = false;
    return { settings, source: 'db' };
  } catch (err) {
    // A rotated or missing EMAIL_CONFIG_ENCRYPTION_KEY must not stop scraping.
    // Every reload hits this, so say it once per failure streak.
    if (!decryptFailureLogged) {
      decryptFailureLogged = true;
      logger.error('Saved scraping provider settings could not be decrypted; using environment settings. ' +
        'Check that EMAIL_CONFIG_ENCRYPTION_KEY matches on the API and every worker.', {
        operation: 'loadStoredProvider',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { settings: envProviderSettings(), source: 'env' };
  }
}

const providerStore = new SettingsStore<Row, ReturnType<typeof parseRow>>(
  'scraping_provider_settings',
  ['provider', 'encrypted_credentials'],
  {
    ttlMs: () => config.scrapingProvider.cacheTtlMs,
    parse: parseRow,
    // A database blip must not fail every fetch: keep the last known provider.
    serveStaleOnError: true,
    onReadError: (err) => logger.warn('Could not reload scraping provider settings; keeping the last known provider', {
      operation: 'getActiveProvider',
      error: err instanceof Error ? err.message : String(err),
    }),
  },
);
const uncachedStore = new SettingsStore<Row, ReturnType<typeof parseRow>>(
  'scraping_provider_settings', ['provider', 'encrypted_credentials'], { parse: parseRow },
);

let lastSeen: ProviderSettings | null = null;
let lastFingerprint: string | null = null;
const listeners: Array<() => void | Promise<void>> = [];

// Injected at process startup (index.ts, worker.ts) rather than imported, so the
// scraper modules that read settings never pull in the database layer.
let store: DatabaseService | null = null;

export function useProviderStore(db: DatabaseService | null): void {
  store = db;
  providerStore.reset();
  decryptFailureLogged = false;
}

/** The saved settings, read now (not cached), or the env fallback when none are saved or they cannot be read. */
export async function loadStoredProvider(
  db: DatabaseService,
): Promise<{ settings: ProviderSettings; source: 'db' | 'env' }> {
  return uncachedStore.read(db);
}

export async function saveProviderSettings(db: DatabaseService, s: ProviderSettings, userId: number): Promise<void> {
  await providerStore.write(db, { provider: s.kind, encrypted_credentials: JSON.stringify(encrypt(s)) }, userId);
}

function registerSecrets(s: ProviderSettings): void {
  for (const secret of providerFor(s).secrets(s)) if (secret) registerLogSecret(secret);
}

export async function getActiveProvider(): Promise<ProviderSettings> {
  let settings: ProviderSettings;
  if (!store) {
    settings = envProviderSettings();
  } else {
    settings = await providerStore.read(store).then((r) => r.settings, () => envProviderSettings());
  }
  if (settings === lastSeen) return settings;

  // New value (first read, or a reload): register its secrets and tell listeners if it changed.
  lastSeen = settings;
  registerSecrets(settings);
  const fp = fingerprint(settings);
  const changed = lastFingerprint !== null && lastFingerprint !== fp;
  lastFingerprint = fp;
  if (changed) {
    for (const cb of listeners) await cb();
  }
  return settings;
}
export function onProviderChange(cb: () => void | Promise<void>): void {
  listeners.push(cb);
}
