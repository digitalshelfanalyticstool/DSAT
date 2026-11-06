import { Router } from 'express';
import { z } from 'zod';
import { AuthError, issueSession, login, logout, logoutAll, refreshAccessToken } from '../services/auth-service';
import { createFirstAdmin, needsSetup } from '../services/first-run-setup';
import { checkSetupCode, clearSetupCode } from '../services/setup-code';
import { PALETTE_IDS, setPalette } from '../services/appearance';
import { authMiddleware } from '../middleware/auth';
import { validate, type ValidatedRequest } from '../middleware/validate';
import { denylistAccessToken } from '../services/access-token-denylist';
import { issueSseTicket, TICKET_TTL_SECONDS } from '../services/sse-ticket';
import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import { changePassword, getProfile, setUserFields, UserManagerError } from '../services/user-manager';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie';
import ssoRouter from './auth-sso';
import type { AuthenticatedRequest } from '../middleware/auth';
import { auditRequestContext } from './audit-context';

const logger = createLogger('auth-routes');
const router = Router();

router.use('/sso', ssoRouter);

// --- Validation Schemas ---
// Bodies stay passthrough (handlers ignore unknown keys). Credential fields
// are required-and-truthy in the handlers, so `.min(1)` mirrors that.

const loginSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .passthrough();
const loginSchemas = { body: loginSchema };

const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) })
  .passthrough();
const passwordChangeSchemas = { body: passwordChangeSchema };

const setupSchema = z.object({
  username: z.string().min(1),
  email: z.string().min(1),
  password: z.string().min(1),
  setupCode: z.string().min(1),
  palette: z.enum(PALETTE_IDS).optional(),
});
const setupSchemas = { body: setupSchema };

/**
 * GET /api/auth/setup-status — unauthenticated. True only on a fresh install
 * with no users, when the client shows the "Create admin account" screen.
 */
router.get('/setup-status', asyncHandler(async (_req, res) => {
  res.json({ success: true, needsSetup: await needsSetup(await DatabaseService.getInstance()) });
}, { operation: 'setupStatus' }));

/**
 * POST /api/auth/setup — creates the first admin and signs them in. Requires the
 * one-time setup code from the server log (403 otherwise), and returns 409 once
 * any user exists, so this cannot be used to add accounts later.
 */
router.post('/setup', validate(setupSchemas), asyncHandler(async (req: ValidatedRequest<typeof setupSchemas>, res) => {
  const { setupCode, palette, ...account } = req.body;
  if (!checkSetupCode(setupCode)) {
    res.status(403).json(errorResponse('The setup code is wrong. Find the current one in the API server log.', 'invalid_setup_code'));
    return;
  }
  const db = await DatabaseService.getInstance();
  let user;
  try {
    user = await createFirstAdmin(db, account);
  } catch (err) {
    if (err instanceof UserManagerError) {
      res.status(err.statusCode).json(errorResponse(err.message, 'validation_error'));
      return;
    }
    throw err;
  }
  if (!user) {
    res.status(409).json(errorResponse('Setup is already complete', 'setup_complete'));
    return;
  }
  clearSetupCode();
  if (palette) await setPalette(db, palette, user.id);
  await new AuditService(db).log({
    userId: user.id,
    action: 'first_run_setup',
    resourceType: 'user',
    resourceId: String(user.id),
    ...auditRequestContext(req),
  });
  const result = await issueSession(db, user);
  setSessionCookie(res, result.refreshToken);
  res.json({
    success: true,
    token: result.accessToken,
    user: result.user,
    expires_at: result.expiresAt,
    must_change_password: result.user.must_change_password,
  });
}, { operation: 'firstRunSetup' }));

/**
 * POST /api/auth/login
 * Authenticate user, return access token, set refresh token cookie.
 */
router.post('/login', validate(loginSchemas), async (req: ValidatedRequest<typeof loginSchemas>, res) => {
  try {
    const { username, password } = req.body;

    const result = await login(await DatabaseService.getInstance(), {
      username,
      password,
      ipAddress: req.ip || '0.0.0.0',
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    logger.info('User logged in', { operation: 'login', username });

    // Log successful login to audit trail
    try {
      const db = await DatabaseService.getInstance();
      const audit = new AuditService(db);
      await audit.logLogin(
        result.user.id,
        req.ip || '0.0.0.0',
        req.headers['user-agent'] || 'unknown',
      );
    } catch (auditErr) {
      logger.error('Failed to write audit log for login', {
        operation: 'login',
        error: (auditErr as Error).message,
      });
    }

    setSessionCookie(res, result.refreshToken);

    res.json({
      success: true,
      token: result.accessToken,
      user: result.user,
      expires_at: result.expiresAt,
      must_change_password: result.user.must_change_password,
    });
  } catch (err) {
    const error = err as Error;
    const statusCode = err instanceof AuthError ? err.statusCode : 401;
    const retryAfter = err instanceof AuthError ? err.retryAfter : undefined;

    logger.warn('Login failed', { operation: 'login', error: error.message });

    // Log failed login attempt to audit trail (username + IP)
    try {
      const db = await DatabaseService.getInstance();
      const audit = new AuditService(db);
      await audit.logFailedLogin(
        req.body.username || 'unknown',
        req.ip || '0.0.0.0',
      );
    } catch (auditErr) {
      logger.error('Failed to write audit log for failed login', {
        operation: 'login',
        error: (auditErr as Error).message,
      });
    }

    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
    }

    res.status(statusCode).json(errorResponse(error.message, 'authentication_error'));
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token from httpOnly cookie.
 */
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = readSessionCookie(req);
    if (!refreshToken) {
      res.status(401).json(errorResponse('No refresh token provided', 'authentication_error'));
      return;
    }

    const db = await DatabaseService.getInstance();
    const result = await refreshAccessToken(db, refreshToken);

    setSessionCookie(res, result.refreshToken);

    res.json({
      success: true,
      token: result.accessToken,
      expires_at: result.expiresAt,
    });
  } catch (err) {
    const error = err as Error;
    const statusCode = err instanceof AuthError ? err.statusCode : 401;
    logger.warn('Token refresh failed', { operation: 'refresh', error: error.message });

    clearSessionCookie(res);

    res.status(statusCode).json(errorResponse(error.message, 'authentication_error'));
  }
});

/**
 * POST /api/auth/logout
 * Revoke refresh token and clear cookie.
 */
router.post('/logout', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const refreshToken = readSessionCookie(req);

  if (refreshToken) {
    const db = await DatabaseService.getInstance();
    await logout(db, refreshToken);
  }

  // Revoke the access token for the remainder of its lifetime,
  // so it can't be replayed before it expires.
  if (req.accessTokenPayload) {
    await denylistAccessToken(req.accessTokenPayload);
  }

  clearSessionCookie(res);

  logger.info('User logged out', { operation: 'logout', username: req.user!.username });

  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

/**
 * POST /api/auth/logout-all
 * Revoke all refresh tokens for the authenticated user.
 */
router.post('/logout-all', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  await logoutAll(db, req.user!.id);

  // Revoke the access token used for this request. Note: this
  // does not revoke the user's *other* outstanding access tokens — there's no
  // per-user jti index yet; those still expire on their own ≤15 min later.
  if (req.accessTokenPayload) {
    await denylistAccessToken(req.accessTokenPayload);
  }

  clearSessionCookie(res);

  logger.info('User logged out from all sessions', {
    operation: 'logoutAll',
    username: req.user!.username,
  });

  res.json({
    success: true,
    message: 'Logged out from all sessions',
  });
});

/**
 * GET /api/auth/session
 * Get current session and user info.
 */
router.get('/session', authMiddleware, (req: AuthenticatedRequest, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

/**
 * POST /api/auth/sse-ticket
 * Mint a 60-second single-use ticket for EventSource connections, which
 * cannot send an Authorization header.
 */
router.post('/sse-ticket', authMiddleware, (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    res.status(401).json(errorResponse('Authentication required', 'authentication_error'));
    return;
  }
  res.json({ success: true, ticket: issueSseTicket(Number(req.user.id)), expires_in: TICKET_TTL_SECONDS });
});

/**
 * GET /api/auth/account
 * Get the authenticated user's full profile (email, created_at, etc.).
 */
// `login` and `refresh` below keep their own catch blocks on purpose: both do
// security-relevant work on the error path (writing the failed-login audit
// record, clearing the refresh cookie) and both default a non-AuthError to 401
// rather than 500. That is behaviour, not error-plumbing duplication.
router.get('/account', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const db = await DatabaseService.getInstance();
  const profile = await getProfile(db, req.user!.id);
  const sso = await db.get<{ sso_subject: string | null }>('SELECT sso_subject FROM users WHERE id = $1', req.user!.id);
  res.json({ success: true, user: profile, ssoLinked: Boolean(sso?.sso_subject) });
  // `UserManagerError` carries its own status; the catch this replaces used it
  // but hardcoded `server_error` as the type, so a 404 answered with a
  // server-error tag. Both now come from the same status.
}, { operation: 'getAccount' }));

/**
 * POST /api/auth/account/password
 * Change the caller's own password, verifying the current one. Also serves the
 * forced first-sign-in change: changePassword clears must_change_password.
 * changePassword revokes every refresh token, so the cookie is cleared too.
 */
router.post(
  '/account/password',
  authMiddleware,
  validate(passwordChangeSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof passwordChangeSchemas, AuthenticatedRequest>, res) => {
    const { currentPassword, newPassword } = req.body;
    const db = await DatabaseService.getInstance();
    try {
      await changePassword(db, req.user!.id, { currentPassword, newPassword }, new AuditService(db), auditRequestContext(req));
    } catch (err) {
      if (err instanceof UserManagerError) {
        res.status(err.statusCode).json(errorResponse(err.message, 'validation_error'));
        return;
      }
      throw err;
    }
    logger.info('User changed own password', { operation: 'changePassword', userId: req.user!.id });
    // Refresh tokens are revoked by changePassword; retire this access token too.
    if (req.accessTokenPayload) await denylistAccessToken(req.accessTokenPayload);
    clearSessionCookie(res);
    res.json({ success: true, message: 'Password changed. Please sign in again.' });
  }, { operation: 'changePassword' }),
);

/**
 * PATCH /api/auth/onboarding-complete
 * Mark the authenticated user's onboarding as completed.
 */
router.patch('/onboarding-complete', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res) => {
  await setUserFields(await DatabaseService.getInstance(), req.user!.id, { has_completed_onboarding: 1 });
  res.json({ success: true });
}, { operation: 'onboardingComplete' }));

export default router;
