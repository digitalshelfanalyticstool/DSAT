/**
 * The OIDC state, nonce and PKCE verifier between /sso/start and /sso/callback.
 * Kept in a signed cookie, not on the server, so a callback can be checked by
 * any API process without shared storage.
 */

import crypto from 'crypto';
import { config } from '../config';

export type Handshake = { state: string; nonce: string; codeVerifier: string; linkUserId?: number; exp: number };

export const HANDSHAKE_COOKIE = 'sso_handshake';
export const HANDSHAKE_TTL_SECONDS = 600;

function mac(body: string): string {
  // Prefixed so this MAC can never be confused with a value signed elsewhere with the same secret.
  return crypto.createHmac('sha256', config.auth.jwtSecret).update(`sso-handshake:${body}`).digest('base64url');
}

export function sealHandshake(h: Handshake): string {
  const body = Buffer.from(JSON.stringify(h)).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function openHandshake(raw: string | undefined): Handshake | null {
  const parts = (raw ?? '').split('.');
  if (parts.length !== 2) return null;
  const [body, sent] = parts;
  const expected = Buffer.from(mac(body));
  const got = Buffer.from(sent);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(body, 'base64url').toString()) as Handshake;
    if (typeof h.state !== 'string' || typeof h.nonce !== 'string' || typeof h.codeVerifier !== 'string') return null;
    return typeof h.exp === 'number' && h.exp > Math.floor(Date.now() / 1000) ? h : null;
  } catch {
    return null;
  }
}
