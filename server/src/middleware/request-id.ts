/**
 * Request ID Middleware
 *
 * Generates a UUID v4 per incoming request using Node.js built-in crypto,
 * attaches it to `req.requestId`, and sets the `X-Request-Id` response header.
 * This enables correlation of log entries and security incident tracing.
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { requestIdStorage } from '../utils/request-context';

// The AsyncLocalStorage instance lives in utils/request-context.ts (a leaf
// module) so the logger can read it without a utils -> middleware back-edge.

/**
 * Augment Express Request to include `requestId`.
 * Using module augmentation so downstream code can access `req.requestId`
 * without casting.
 */
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Express middleware that assigns a unique UUID v4 to every request.
 *
 * - Attaches the ID to `req.requestId`
 * - Sets the `X-Request-Id` response header
 * - Stores the ID in AsyncLocalStorage so the Winston logger can
 *   include it automatically without explicit parameter passing
 */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    // Run the rest of the middleware chain inside AsyncLocalStorage
    // so any code (including the logger) can retrieve the request ID
    requestIdStorage.run(requestId, () => {
      next();
    });
  };
}
