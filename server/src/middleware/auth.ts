/**
 * Authentication and authorization middleware for Express.
 *
 * Provides:
 *   - authMiddleware: Validates JWT Bearer tokens, checks user is_active, attaches user to req
 *   - requireRole: Checks req.user.role matches a required role
 */

import type { Response, NextFunction } from 'express';
import { validateAccessToken, AuthError } from '../services/auth-service';
import { isAccessTokenDenylisted } from '../services/access-token-denylist';
import { DatabaseService } from '../services/database';
import { createLogger } from '../utils/logger';
import { getCachedUser } from '../services/user-cache';
import { toUserResponse } from '../services/user-records';
import { consumeSseTicket } from '../services/sse-ticket';
export type { AuthenticatedRequest } from '../types/auth';
import type { AuthenticatedRequest } from '../types/auth';

const logger = createLogger('auth-middleware');

// --- Helpers ---

/**
 * `extra` carries a machine-readable discriminator (e.g. `{ code: 'not_provisioned' }`)
 * for callers that need the client to distinguish between 401 causes it would
 * otherwise have to guess at from `message` text. Omitted by every pre-existing
 * call site, so their response shape is unchanged.
 */
function errorResponse(message: string, errorType: string, extra?: Record<string, unknown>) {
  return {
    success: false,
    error_type: errorType,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}



// --- Middleware: authMiddleware ---

/**
 * Express middleware that validates JWT Bearer tokens.
 * Extracts the token from the Authorization header (or query param for SSE),
 * validates signature and expiration, checks user is_active in the database,
 * and attaches the user to req.user.
 *
 * Returns 401 for:
 *   - Missing or malformed Authorization header
 *   - Invalid token signature
 *   - Expired token (with message "Token expired")
 *   - User not found or is_active === 0
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- security-sensitive auth middleware: token extraction, signature verification, user-active check, error-class taxonomy. Hard-excluded in CLAUDE.md (no AI refactors on auth). NOSONAR(typescript:S3776).
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;

  // Support token from Authorization header, or an sse_-prefixed ticket from
  // a query parameter. A real access token must never travel as a query
  // parameter (it would land in access logs, proxy logs, and browser
  // history) — only the Authorization header is a valid channel for those.
  // SSE tickets are the one credential designed to ride in a URL (60s,
  // single-use), and even they don't authenticate through this function:
  // the check below rejects them outright. They authenticate only through
  // sseAuthMiddleware, mounted on the three stream routes.
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof queryToken === 'string' && queryToken.startsWith('sse_')) {
    token = queryToken;
  }

  if (!token) {
    logger.warn('Missing or malformed Authorization header', {
      operation: 'authMiddleware',
      path: req.path,
    });
    res.status(401).json(errorResponse('Authentication required', 'authentication_error'));
    return;
  }

  // SSE tickets are a narrow, single-purpose credential: they must
  // authenticate exactly the three stream routes (via sseAuthMiddleware) and
  // nothing else. Resolving them here — the middleware guarding the entire
  // API, including POST /auth/sse-ticket itself — would let a captured
  // ticket mint itself a fresh ticket forever, collapsing the 60s/single-use
  // bound into unbounded access.
  if (token.startsWith('sse_')) {
    logger.warn('SSE ticket presented to the general auth middleware — rejected', {
      operation: 'authMiddleware',
      path: req.path,
    });
    res.status(401).json(errorResponse('Invalid or expired stream ticket', 'authentication_error'));
    return;
  }

  try {
    // Local HS256 access token. validateAccessToken pins the algorithm, so an
    // RS256 or other foreign token is rejected here without any key fetch.
    const payload = validateAccessToken(token);

    // Reject tokens revoked via logout. Fails open if Redis is
    // unavailable — see access-token-denylist.ts.
    if (await isAccessTokenDenylisted(payload.jti)) {
      res.status(401).json(errorResponse('Token revoked', 'authentication_error'));
      return;
    }

    // Check user exists and is active in the database (with 30s TTL cache)
    const db = await DatabaseService.getInstance();
    const user = await getCachedUser(db, String(payload.user_id));

    if (!user) {
      res.status(401).json(errorResponse('User not found', 'authentication_error'));
      return;
    }

    if (user.is_active !== 1) {
      res.status(401).json(errorResponse('Account is disabled', 'authentication_error'));
      return;
    }

    req.user = toUserResponse(user);
    req.accessTokenPayload = { jti: payload.jti, exp: payload.exp };

    next();
  } catch (err) {
    const error = err as Error;
    const statusCode = err instanceof AuthError ? err.statusCode : 401;
    const message = error.name === 'TokenExpiredError' ? 'Token expired' : error.message;

    logger.warn('Token validation failed', {
      operation: 'authMiddleware',
      path: req.path,
      error: error.message,
    });
    res.status(statusCode).json(errorResponse(message, 'authentication_error'));
  }
}


// --- Middleware: sseAuthMiddleware ---

/**
 * Express middleware that authenticates SSE (EventSource) connections using
 * a short-lived, single-use ticket minted by POST /api/auth/sse-ticket
 * (see services/sse-ticket.ts). EventSource cannot send an Authorization
 * header, so the ticket travels as a query parameter — that is the only
 * reason this middleware exists separately from authMiddleware.
 *
 * Deliberately narrow: accepts ONLY sse_-prefixed tickets, and is mounted
 * only on the three stream routes (job stream, admin health stream,
 * site-monitor run stream) instead of authMiddleware. A real JWT
 * token presented here is rejected, not resolved — this middleware must
 * never become a second general-purpose auth path. Mounting a ticket-only
 * middleware (rather than an sse_ branch inside authMiddleware) is what stops a captured ticket
 * from being replayed to mint itself a fresh ticket: minting still requires
 * a real session, since POST /auth/sse-ticket stays on authMiddleware.
 */
export async function sseAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;

  let token: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof queryToken === 'string' && queryToken.length > 0) {
    token = queryToken;
  }

  if (!token || !token.startsWith('sse_')) {
    res.status(401).json(errorResponse('Invalid or expired stream ticket', 'authentication_error'));
    return;
  }

  const consumed = await consumeSseTicket(token);
  if (!consumed) {
    res.status(401).json(errorResponse('Invalid or expired stream ticket', 'authentication_error'));
    return;
  }

  const db = await DatabaseService.getInstance();
  const user = await getCachedUser(db, String(consumed.userId));
  if (user?.is_active !== 1) {
    res.status(401).json(errorResponse('User not found or disabled', 'authentication_error'));
    return;
  }

  req.user = toUserResponse(user);
  next();
}

/**
 * Re-check for long-lived admin streams: authorization was decided once at
 * connect, so they call this on each push and close when it turns false.
 * Staleness is bounded by the user cache TTL, or none after invalidateUserCache.
 */
export async function isActiveAdmin(userId: number): Promise<boolean> {
  const user = await getCachedUser(await DatabaseService.getInstance(), String(userId));
  return user?.is_active === 1 && user.role === 'admin';
}

// --- Middleware: requireRole ---

/**
 * Express middleware factory that checks if the authenticated user has the required role.
 * Must be used after authMiddleware.
 * Returns 403 Forbidden if the user's role does not match.
 */
export function requireRole(role: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json(errorResponse('Authentication required', 'authentication_error'));
      return;
    }

    if (req.user.role !== role) {
      logger.warn('Insufficient permissions', {
        operation: 'requireRole',
        requiredRole: role,
        userRole: req.user.role,
        username: req.user.username,
        path: req.path,
      });
      res.status(403).json(errorResponse('Insufficient permissions', 'authorization_error'));
      return;
    }

    next();
  };
}
