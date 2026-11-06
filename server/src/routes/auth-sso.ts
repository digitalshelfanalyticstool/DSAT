/**
 * Sign-in through the admin-configured OIDC provider (authorization code + PKCE).
 * The browser only ever sees redirects: the session arrives as the same
 * refresh-token cookie a password login sets, and no token is put in a URL.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';
import { config } from '../config';
import { AuditService } from '../services/audit-service';
import { issueSession } from '../services/auth-service';
import { DatabaseService } from '../services/database';
import { HANDSHAKE_COOKIE, HANDSHAKE_TTL_SECONDS, openHandshake, sealHandshake } from '../services/sso-handshake';
import { discover, loadSsoSettings, ssoRedirectUri } from '../services/sso-settings';
import { resolveSsoUser } from '../services/sso-user-resolver';
import type { UserRow } from '../types/auth';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth';
import { consumeTicket, issueTicket, TICKET_TTL_SECONDS } from '../services/sse-ticket';
import { asyncHandler } from '../utils/async-handler';
import { createLogger } from '../utils/logger';
import { cookieOptions, setSessionCookie } from './session-cookie';
import { setUserFields } from '../services/user-manager';
import { auditRequestContext } from './audit-context';

const logger = createLogger('auth-sso');
const router = Router();

// Lax, not strict: the callback is a top-level navigation coming back from the IdP's site.
const handshakeCookie = () => cookieOptions('/api/auth/sso', { sameSite: 'lax' });
const linkCookie = () => cookieOptions('/api/auth/sso', { sameSite: 'strict' });

/** Only these fixed codes reach the URL; the login page maps each to a message. */
type SsoErrorCode = 'disabled' | 'failed' | 'not_allowed' | 'admin_link_required' | 'inactive' | 'already_linked';

/** Sign-in flows return to /login; connecting SSO from the account page returns there. */
const toApp = (res: Response, page: 'login' | 'account', query: string) =>
  res.redirect(302, `${config.email.appPublicUrl}/${page}?${query}`);

router.get('/config', asyncHandler(async (_req, res) => {
  const s = await loadSsoSettings(await DatabaseService.getInstance());
  res.json({ success: true, enabled: s?.enabled ?? false, label: s?.buttonLabel || 'SSO' });
}, { operation: 'ssoConfig' }));

const LINK_COOKIE = 'sso_link';

/**
 * POST /link-ticket — a 60s single-use ticket for the /start?link= navigation,
 * which cannot carry a header. The same ticket is set in a SameSite=Strict cookie
 * that /start requires, so a link handed to someone else (to bind their IdP
 * identity to the issuer's account) does nothing in their browser.
 */
router.post('/link-ticket', authMiddleware, (req: AuthenticatedRequest, res) => {
  const ticket = issueTicket(req.user!.id, 'sso_link');
  res.cookie(LINK_COOKIE, ticket, { ...linkCookie(), maxAge: TICKET_TTL_SECONDS * 1000 });
  res.json({ success: true, ticket });
});

/** DELETE /link — disconnects SSO from the caller's account. */
router.delete('/link', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  await setUserFields(db, req.user!.id, { sso_issuer: null, sso_subject: null });
  await new AuditService(db).log({
    userId: req.user!.id, action: 'unlink_sso', resourceType: 'user', resourceId: String(req.user!.id),
    ...auditRequestContext(req),
  });
  res.json({ success: true });
}, { operation: 'ssoUnlink' }));

router.get('/start', async (req, res) => {
  const link = typeof req.query.link === 'string' ? req.query.link : undefined;
  const page = link === undefined ? 'login' : 'account';
  try {
    const s = await loadSsoSettings(await DatabaseService.getInstance());
    if (!s?.enabled) return toApp(res, page, 'sso_error=disabled');
    let linkUserId: number | undefined;
    if (link !== undefined) {
      const bound = req.cookies?.[LINK_COOKIE];
      res.clearCookie(LINK_COOKIE, linkCookie());
      if (bound !== link) return toApp(res, page, 'sso_error=failed');
      const redeemed = await consumeTicket(link, 'sso_link');
      if (!redeemed) return toApp(res, page, 'sso_error=failed');
      linkUserId = redeemed.userId;
    }
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const url = oidc.buildAuthorizationUrl(await discover(s), {
      redirect_uri: ssoRedirectUri(),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    const exp = Math.floor(Date.now() / 1000) + HANDSHAKE_TTL_SECONDS;
    res.cookie(HANDSHAKE_COOKIE, sealHandshake({ state, nonce, codeVerifier, exp, ...(linkUserId ? { linkUserId } : {}) }), { ...handshakeCookie(), maxAge: HANDSHAKE_TTL_SECONDS * 1000 });
    return res.redirect(302, url.href);
  } catch (err) {
    logger.error('SSO start failed', { operation: 'ssoStart', error: (err as Error).message });
    return toApp(res, page, 'sso_error=failed');
  }
});

router.get('/callback', async (req: Request, res) => {
  const handshake = openHandshake(req.cookies?.[HANDSHAKE_COOKIE]);
  res.clearCookie(HANDSHAKE_COOKIE, handshakeCookie());
  const ip = req.ip || '0.0.0.0';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const page = handshake?.linkUserId ? 'account' : 'login';
  const fail = (code: SsoErrorCode) => toApp(res, page, `sso_error=${code}`);
  // Failures before the resolver have no identity to name, but still count as failed sign-ins.
  const failUnidentified = async () => {
    try {
      await new AuditService(await DatabaseService.getInstance()).logFailedLogin('unknown', ip, { method: 'sso', reason: 'failed' });
    } catch (auditErr) {
      logger.error('Failed to audit an SSO failure', { operation: 'ssoCallback', error: (auditErr as Error).message });
    }
    return fail('failed');
  };

  try {
    if (!handshake) return await failUnidentified();
    const db = await DatabaseService.getInstance();
    const s = await loadSsoSettings(db);
    if (!s?.enabled) return fail('disabled');

    const oidcConfig = await discover(s);
    // The redirect URI sent in the exchange is this URL minus its query, so build it
    // from the configured public URL rather than from whatever Host the proxy passed.
    const q = req.originalUrl.indexOf('?');
    const currentUrl = new URL(ssoRedirectUri() + (q >= 0 ? req.originalUrl.slice(q) : ''));
    const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: handshake.codeVerifier,
      expectedState: handshake.state,
      expectedNonce: handshake.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) return await failUnidentified();
    // Some providers send the claim as the string "true"/"false"; "false" must still refuse.
    const verified = claims.email_verified;

    const identity = {
      issuer: oidcConfig.serverMetadata().issuer,
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      emailVerified: typeof verified === 'boolean' ? verified : ({ true: true, false: false } as Record<string, boolean>)[String(verified)],
    };
    const audit = new AuditService(db);
    if (handshake.linkUserId) return await linkAccount(db, audit, handshake.linkUserId, identity, res, { ip, userAgent });

    const result = await resolveSsoUser(db, identity, s);
    if ('error' in result) {
      await audit.logFailedLogin(identity.email ?? identity.subject, ip, { method: 'sso', reason: result.error });
      return fail(result.error);
    }

    const user = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', result.userId);
    if (!user) return await failUnidentified();
    // The identity provider vouched for this person, so a forced change of an
    // admin-set password they may never have been given would only lock them out.
    if (user.must_change_password) {
      await setUserFields(db, user.id, { must_change_password: 0 });
      user.must_change_password = 0;
    }
    const session = await issueSession(db, user);
    setSessionCookie(res, session.refreshToken);
    await audit.log({
      userId: user.id, action: 'login', resourceType: 'session',
      details: JSON.stringify({ method: 'sso' }), ipAddress: ip, userAgent,
    });
    return toApp(res, 'login', 'sso=1');
  } catch (err) {
    // IdP error text stays in the log; it is attacker-influenced and never reaches the page.
    logger.warn('SSO callback failed', { operation: 'ssoCallback', error: (err as Error).message });
    return failUnidentified();
  }
});

/**
 * The account-page flow: binds the IdP identity to the user who asked for it,
 * whatever email the IdP reports. That user proved who they are with a password
 * session when the ticket was issued; this is the only way an admin gets linked.
 */
async function linkAccount(
  db: DatabaseService,
  audit: AuditService,
  userId: number,
  identity: { issuer: string; subject: string },
  res: Response,
  meta: { ip: string; userAgent: string },
): Promise<void> {
  const owner = await db.get<{ id: number }>(
    'SELECT id FROM users WHERE sso_issuer = $1 AND sso_subject = $2',
    identity.issuer, identity.subject,
  );
  if (owner && owner.id !== userId) return toApp(res, 'account', 'sso_error=already_linked');
  try {
    await setUserFields(db, userId, { sso_issuer: identity.issuer, sso_subject: identity.subject });
  } catch (err) {
    // The unique index on (sso_issuer, sso_subject) catches a concurrent link of the same subject.
    if ((err as { code?: string }).code === '23505') return toApp(res, 'account', 'sso_error=already_linked');
    throw err;
  }
  await audit.log({
    userId, action: 'link_sso', resourceType: 'user', resourceId: String(userId),
    ipAddress: meta.ip, userAgent: meta.userAgent,
  });
  return toApp(res, 'account', 'sso_linked=1');
}

export default router;
