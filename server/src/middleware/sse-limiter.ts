/**
 * SSE Connection Limiter Middleware
 *
 * Tracks active SSE connections per authenticated user and rejects
 * new connections with 429 when the per-user limit is exceeded.
 * Connections are automatically cleaned up on close.
 *
 * Requires auth middleware to have run first (req.user must be set).
 */

import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth';
import { createLogger } from '../utils/logger';

const logger = createLogger('sse-limiter');

export interface SSELimiterOptions {
  /** Maximum concurrent SSE connections per user. Default: 5 */
  maxConnectionsPerUser: number;
}

const DEFAULT_OPTIONS: SSELimiterOptions = {
  maxConnectionsPerUser: 5,
};

/** In-memory map: userId → Set of active Response objects */
const userSSEConnections = new Map<number, Set<Response>>();

/**
 * Express middleware that limits concurrent SSE connections per user.
 *
 * Returns 429 when the user already has `maxConnectionsPerUser` active
 * connections. Automatically removes the connection from tracking when
 * the response closes.
 */
export function sseLimiter(options?: Partial<SSELimiterOptions>) {
  const { maxConnectionsPerUser } = { ...DEFAULT_OPTIONS, ...options };

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error_type: 'authentication_error',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const userId = req.user.id;

    if (!userSSEConnections.has(userId)) {
      userSSEConnections.set(userId, new Set());
    }

    const connections = userSSEConnections.get(userId)!;

    if (connections.size >= maxConnectionsPerUser) {
      logger.warn('SSE connection limit exceeded', {
        operation: 'sseLimiter',
        userId,
        activeConnections: connections.size,
        maxConnectionsPerUser,
      });

      res.status(429).json({
        success: false,
        error_type: 'rate_limit_error',
        message: `Maximum ${maxConnectionsPerUser} concurrent SSE connections per user`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    connections.add(res);

    res.on('close', () => {
      connections.delete(res);
      if (connections.size === 0) {
        userSSEConnections.delete(userId);
      }
    });

    next();
  };
}
