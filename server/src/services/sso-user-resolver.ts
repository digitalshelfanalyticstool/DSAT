/**
 * Maps an identity the configured OIDC provider vouched for to a users row.
 * Authorization is not decided here: the caller reads users.role, exactly as
 * for a password login.
 */

import crypto from 'crypto';
import { hashPassword, isErasedUsername } from './user-records';
import { setUserFields } from './user-manager';
import { createLogger } from '../utils/logger';
import type { DatabaseService } from './database';
import type { SsoSettings } from './sso-settings';

const logger = createLogger('sso-user-resolver');

export type SsoIdentity = { issuer: string; subject: string; email?: string; emailVerified?: boolean; name?: string };
export type SsoResolution = { userId: number } | { error: 'not_allowed' | 'admin_link_required' | 'inactive' };

type Candidate = { id: number; role: string; is_active: number; sso_issuer: string | null; sso_subject: string | null };

/**
 * A bcrypt hash of 48 random bytes. Nobody knows the plaintext, so the account
 * cannot be signed into with a password until an admin resets it. A sentinel
 * string would be worse: bcrypt.compare throws on a malformed hash.
 */
export async function unusablePasswordHash(): Promise<string> {
  return hashPassword(crypto.randomBytes(48).toString('base64url'));
}

function domainAllowed(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && domains.includes(email.slice(at + 1));
}

async function freeUsername(db: DatabaseService, email: string): Promise<string> {
  const local = email.slice(0, email.lastIndexOf('@')) || 'user';
  // erased- names are reserved for erased accounts.
  const base = isErasedUsername(local) ? `user-${local}` : local;
  const taken = new Set((await db.all<{ u: string }>(
    // LIKE wildcards in a local part only widen this read; the loop below decides.
    'SELECT LOWER(username) AS u FROM users WHERE LOWER(username) LIKE $1',
    `${base}%`,
  )).map((r) => r.u));
  let name = base;
  let n = 1;
  while (taken.has(name)) name = `${base}${++n}`;
  return name;
}

export async function resolveSsoUser(db: DatabaseService, id: SsoIdentity, s: SsoSettings): Promise<SsoResolution> {
  const linked = await db.get<Candidate>(
    'SELECT id, role, is_active, sso_issuer, sso_subject FROM users WHERE sso_issuer = $1 AND sso_subject = $2',
    id.issuer, id.subject,
  );
  if (linked) return linked.is_active ? { userId: linked.id } : { error: 'inactive' };

  const email = id.email?.trim().toLowerCase();
  if (!email || id.emailVerified === false || !domainAllowed(email, s.allowedEmailDomains)) return { error: 'not_allowed' };

  const byEmail = await db.get<Candidate>(
    'SELECT id, role, is_active, sso_issuer, sso_subject FROM users WHERE LOWER(email) = $1',
    email,
  );
  if (byEmail) {
    // An address can be reassigned to a new person; a row already bound to another
    // subject at this issuer belongs to whoever bound it. A link from an earlier
    // issuer is stale once the admin switches providers, so email may replace it.
    if (byEmail.sso_issuer === id.issuer) return { error: 'not_allowed' };
    if (byEmail.role === 'admin') return { error: 'admin_link_required' };
    if (!byEmail.is_active) return { error: 'inactive' };
    // Linking an existing account by email needs the IdP to vouch for the address;
    // a missing or non-boolean email_verified is not that.
    if (id.emailVerified !== true) return { error: 'not_allowed' };
    await setUserFields(db, byEmail.id, { sso_issuer: id.issuer, sso_subject: id.subject });
    logger.info('Linked existing account to SSO identity', { operation: 'resolveSsoUser', userId: byEmail.id });
    return { userId: byEmail.id };
  }

  const now = Math.floor(Date.now() / 1000);
  const created = await db.get<{ id: number }>(
    `INSERT INTO users (username, email, password_hash, role, created_at, updated_at,
                        is_active, must_change_password, has_completed_onboarding, sso_issuer, sso_subject)
     VALUES ($1, $2, $3, 'user', $4, $4, 1, 0, 0, $5, $6)
     RETURNING id`,
    await freeUsername(db, email), email, await unusablePasswordHash(), now, id.issuer, id.subject,
  );
  logger.info('Created account for SSO identity', { operation: 'resolveSsoUser', userId: created!.id });
  return { userId: created!.id };
}
