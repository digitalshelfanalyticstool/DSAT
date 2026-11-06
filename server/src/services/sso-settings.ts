/**
 * Admin-configured OIDC single sign-on settings (one identity provider per
 * install). Read by the API process only, once per sign-in, so not cached.
 */

import * as oidc from 'openid-client';
import { config } from '../config';
import { createLogger, registerLogSecret } from '../utils/logger';
import { decrypt, encrypt } from './secrets';
import type { EncryptedEnvelope } from './secrets';
import type { DatabaseService } from './database';
import { SettingsStore } from './settings-store';

const logger = createLogger('sso-settings');

export type SsoSettings = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowedEmailDomains: string[];
  buttonLabel?: string;
};

type Row = {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  encrypted_client_secret: EncryptedEnvelope;
  allowed_email_domains: string[];
  button_label: string | null;
};

const store = new SettingsStore<Row, Row | undefined>(
  'sso_settings',
  ['enabled', 'issuer_url', 'client_id', 'encrypted_client_secret', 'allowed_email_domains', 'button_label'],
  { parse: (row) => row },
);

/** The saved settings, or null when none are saved or the secret cannot be decrypted. */
export async function loadSsoSettings(db: DatabaseService): Promise<SsoSettings | null> {
  const row = await store.read(db);
  if (!row) return null;
  let clientSecret: string;
  try {
    clientSecret = decrypt<string>(row.encrypted_client_secret);
  } catch (err) {
    logger.error('Saved SSO client secret could not be decrypted; SSO is off until it is saved again. ' +
      'Check EMAIL_CONFIG_ENCRYPTION_KEY.', {
      operation: 'loadSsoSettings',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  registerLogSecret(clientSecret);
  return {
    enabled: row.enabled,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecret,
    allowedEmailDomains: row.allowed_email_domains,
    ...(row.button_label ? { buttonLabel: row.button_label } : {}),
  };
}

export async function saveSsoSettings(db: DatabaseService, s: SsoSettings, userId: number | null): Promise<void> {
  await store.write(db, {
    enabled: s.enabled,
    issuer_url: s.issuerUrl,
    client_id: s.clientId,
    encrypted_client_secret: JSON.stringify(encrypt(s.clientSecret)),
    allowed_email_domains: s.allowedEmailDomains,
    button_label: s.buttonLabel ?? null,
  }, userId);
}

export function ssoRedirectUri(): string {
  return `${config.sso.apiPublicUrl}/api/auth/sso/callback`;
}

/** http:// is allowed for a local development identity provider only. */
export function isLocalIssuer(issuerUrl: string): boolean {
  return /^http:\/\/localhost(:\d+)?(\/|$)/.test(issuerUrl);
}

/** Discovers the issuer's OIDC configuration. Shared by the admin Test button and sign-in. */
export async function discover(s: Pick<SsoSettings, 'issuerUrl' | 'clientId'> & { clientSecret?: string }): Promise<oidc.Configuration> {
  return oidc.discovery(new URL(s.issuerUrl), s.clientId, s.clientSecret, undefined, {
    timeout: 10,
    ...(isLocalIssuer(s.issuerUrl) ? { execute: [oidc.allowInsecureRequests] } : {}),
  });
}

/** What the admin Test button reports: does the issuer publish a usable configuration? */
export async function discoverIssuer(issuerUrl: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const meta = (await discover({ issuerUrl, clientId: 'connection-test' })).serverMetadata();
    if (meta.response_types_supported && !meta.response_types_supported.includes('code')) {
      return { ok: false, message: 'The issuer does not support the authorization-code flow.' };
    }
    return { ok: true };
  } catch (err) {
    // The detail stays in the server log: echoing it would turn Test into a probe of whatever the URL reaches.
    logger.warn('SSO issuer discovery failed', { issuerUrl, error: err instanceof Error ? err.message : String(err) });
    if (err instanceof TypeError) return { ok: false, message: 'Could not reach the issuer. Check the URL; the server log has details.' };
    return { ok: false, message: "The issuer's discovery document was rejected. The server log has details." };
  }
}
