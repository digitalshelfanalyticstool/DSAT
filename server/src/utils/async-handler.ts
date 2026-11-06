/**
 * Central async-route error plumbing.
 *
 * `asyncHandler` wraps an async Express handler so a rejected promise is
 * forwarded to `next(err)` instead of surfacing as an unhandled rejection.
 * Paired with `errorHandler` — the terminal error middleware — a route handler
 * can simply `throw` on failure. The middleware then:
 *   - logs the *real* error (message + stack) SERVER-SIDE, and
 *   - responds with a SAFE, generic body for 5xx so internal error strings /
 *     SQL fragments never reach the client.
 * 4xx errors keep their exact message so validation / "not found" feedback is
 * preserved unchanged.
 *
 * Zero project imports beyond the logger and the canonical error-type map, so
 * this stays a cycle-free leaf and may be imported by any route/app module
 * (it must NOT import database.ts / database-migrations.ts).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from './logger';
import { errorResponse, errorTypeForStatus } from './error-response';

const logger = createLogger('error-handler');

/**
 * Per-route failure presentation, applied by `errorHandler` when the wrapped
 * handler rejects. Every field is optional; the defaults reproduce a bare
 * `asyncHandler(fn)`.
 *
 * Some routes answer a 5xx with a curated literal such as
 * `'Failed to load products'` under a route-specific `error_type`, and log a
 * route-specific operation name that log queries and dashboards match on.
 * This carries that presentation; collapsing it onto the generic default
 * would change the envelope and break those queries.
 */
export interface RouteFailure {
  /** `operation` recorded in the error log — keep the value the route's own logger used. */
  operation?: string;
  /**
   * Status for a failure that carries none of its own. Defaults to 500; set it
   * where a route answered every failure with something else (admin-brightdata
   * reports an unreachable Bright Data API as 502). An error with its own
   * `statusCode` always wins.
   */
  statusCode?: number;
  /**
   * Public body message for a 5xx from this route. 4xx messages always come
   * from the error itself, so this never widens what a validation failure says.
   * Pass a LITERAL: passing `err.message` here would leak internal error strings to clients.
   */
  message?: string;
  /** `error_type` for a 5xx from this route (e.g. `internal_error`). 4xx are unaffected. */
  errorType?: string;
}

/**
 * Wrap an async route handler so any thrown error / rejected promise is routed
 * to Express's error-middleware chain via `next(err)`.
 *
 *   router.get('/things', asyncHandler(async (req, res) => { ... }));
 *   router.get('/things', asyncHandler(async (req, res) => { ... },
 *     { operation: 'listThings', message: 'Failed to load things' }));
 *
 * Generic over the request type so handlers typed with a narrower request
 * (`ValidatedRequest<…>`, `AuthenticatedRequest`) are accepted — `Req` is
 * inferred from `fn`, and the runtime request (already mutated by upstream
 * middleware such as `validate()`) is passed through.
 *
 * `failure` is attached to the rejected error for `errorHandler` to read, and
 * only ever fills gaps: an error that already carries its own `statusCode` /
 * `errorType` (a 403 thrown by an ownership check, say) keeps them, so a
 * route-level 5xx presentation cannot swallow a deeper 4xx.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown> | unknown,
  failure?: RouteFailure,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch((err: unknown) => {
      if (failure && err !== null && typeof err === 'object') {
        (err as { routeFailure?: RouteFailure }).routeFailure ??= failure;
      }
      next(err);
    });
  };
}

/**
 * Read an HTTP status off an error, defaulting to 500. Supports either a
 * numeric `statusCode` or `status` property (both shapes appear in the code).
 */
function statusOf(err: unknown): number {
  const e = (err ?? {}) as Record<string, unknown>;
  const raw = e.statusCode ?? e.status ?? failureOf(err).statusCode;
  return typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : 500;
}

/**
 * Tag an error with the HTTP status (and optionally the envelope type) it maps
 * to, so a route can hand it to the shared handler instead of writing a
 * response itself. Returns the same error for a one-line `throw httpError(...)`.
 */
export function httpError(err: unknown, statusCode: number, errorType?: string): Error {
  return Object.assign(err as Error, { statusCode, ...(errorType ? { errorType } : {}) });
}

/**
 * Resolve the response `error_type` for an error.
 *
 * An explicit string `errorType` property on the error wins, so a route that
 * must keep an established envelope tag (e.g. jobs.ts's `forbidden` for 403,
 * where the status default is `authorization_error`) can carry it on the
 * thrown error instead of hand-rolling a catch block. Otherwise the canonical
 * status-derived type is used, keeping `errorTypeForStatus` the default source
 * of truth.
 */
function errorTypeOf(err: unknown, statusCode: number): string {
  const explicit = (err as { errorType?: string })?.errorType;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  // A route-level `errorType` applies to 5xx only. A 4xx that bubbled up from
  // a deeper check carries its own meaning and must not be relabelled by the
  // route's server-failure presentation.
  const routeType = failureOf(err).errorType;
  if (statusCode >= 500 && typeof routeType === 'string' && routeType.length > 0) {
    return routeType;
  }
  // 401 is intentionally absent from errorTypeForStatus (which maps the
  // 400/403/404/409 set); preserve the prior global-handler behaviour of
  // tagging authentication failures as `authentication_error`.
  return statusCode === 401 ? 'authentication_error' : errorTypeForStatus(statusCode);
}

/** The `RouteFailure` an `asyncHandler` attached, or an empty object. */
function failureOf(err: unknown): RouteFailure {
  return (err as { routeFailure?: RouteFailure })?.routeFailure ?? {};
}

/**
 * Terminal Express error handler. MUST be registered AFTER all routes.
 *
 * - Logs the real error (message + stack) server-side at error level.
 * - Responds with the canonical `error_type` for the status
 *   (`errorTypeForStatus`), keeping that helper the single source of truth.
 * - For 5xx, returns a GENERIC message — never the raw `err.message` — so
 *   internal details (SQL, stack fragments) can't leak to clients.
 * - For 4xx, preserves the error's message (validation / not-found feedback).
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If the response has already started (e.g. an SSE stream), we can't rewrite
  // the status/body — defer to Express's default handler to close the socket.
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode = statusOf(err);
  const errorType = errorTypeOf(err, statusCode);
  const failure = failureOf(err);

  logger.error('Unhandled route error', {
    operation: failure.operation ?? 'errorHandler',
    error: err?.message,
    stack: err?.stack,
    statusCode,
  });

  // 5xx bodies never echo `err.message` (info disclosure) — either the
  // route's own literal or the generic default. 4xx keep their caller-supplied
  // message so validation / not-found feedback is unchanged.
  const message =
    statusCode >= 500 ? (failure.message ?? 'Internal server error') : err.message;
  res.status(statusCode).json(errorResponse(message, errorType));
}
