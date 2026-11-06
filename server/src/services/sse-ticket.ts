/**
 * Short-lived, single-use tickets for credentials that have to ride in a URL,
 * where Nginx logs them. A ticket limits the blast radius of that log line to
 * 60 seconds and one use.
 *
 * - `sse`: EventSource connections, which cannot set an Authorization header.
 * - `sso_link`: the top-level navigation that connects SSO to a signed-in account.
 */

import crypto from 'crypto';
import { config } from '../config';
import { getRedisClient } from './redis-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('sse-ticket');

/** Exported so callers (the issuing route) never duplicate this literal. */
export const TICKET_TTL_SECONDS = 60;

/** Guard against an ioredis command hanging when the connection drops mid-flight. */
const REDIS_OP_TIMEOUT_MS = 250;

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.auth.jwtSecret).update(payload).digest('base64url');
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis op timed out')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export type TicketPurpose = 'sse' | 'sso_link';

// The `sse_` prefix is what authMiddleware routes on; a link ticket must never match it.
const PREFIX: Record<TicketPurpose, string> = { sse: 'sse_', sso_link: 'ssolink_' };

export function issueTicket(userId: number, purpose: TicketPurpose): string {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${PREFIX[purpose]}${userId}.${exp}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export async function consumeTicket(ticket: string, purpose: TicketPurpose): Promise<{ userId: number } | null> {
  const parts = ticket.split('.');
  if (parts.length !== 4) return null;
  const [prefixed, expRaw, nonce, mac] = parts;

  const expected = sign(`${prefixed}.${expRaw}.${nonce}`);
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;

  const prefix = PREFIX[purpose];
  if (!prefixed.startsWith(prefix)) return null;
  const userId = Number.parseInt(prefixed.slice(prefix.length), 10);
  if (!Number.isFinite(userId)) return null;

  // A replayed link ticket would bind someone else's IdP identity to this account,
  // so it is refused when single use cannot be enforced. SSE fails open instead:
  // a Redis outage must not take live job streaming down.
  const failClosed = purpose === 'sso_link';
  const keyspace = purpose === 'sse' ? 'sse_ticket' : `${purpose}_ticket`;

  // Single use. SET NX returns null when the key already exists.
  //
  // getRedisClient() returns the RedisClientManager singleton, which does
  // not expose command methods directly — commands go through one of its
  // named connections. getPublisherConnection() is the same connection
  // access-token-denylist.ts uses for its own SET/GET calls; reusing it here
  // avoids opening a fourth Redis connection for a single command.
  try {
    const redis = getRedisClient().getPublisherConnection();
    if (redis.status !== 'ready') {
      // Same guard as access-token-denylist.ts: a connection that is merely
      // *connecting* (not down) would otherwise let ioredis queue the SET
      // command indefinitely. Decide immediately rather than waiting on it.
      logger.warn('Redis not ready — ticket replay check skipped', {
        operation: 'consumeTicket',
        purpose,
        failClosed,
        redisStatus: redis.status,
      });
      return failClosed ? null : { userId };
    }
    const claimed = await withTimeout(
      redis.set(`${keyspace}:${nonce}`, '1', 'EX', TICKET_TTL_SECONDS, 'NX'),
      REDIS_OP_TIMEOUT_MS,
    );
    if (claimed === null) return null;
  } catch (err) {
    logger.warn('Redis unavailable for ticket replay check', {
      operation: 'consumeTicket',
      purpose,
      failClosed,
      error: (err as Error).message,
    });
    if (failClosed) return null;
  }

  return { userId };
}

export function issueSseTicket(userId: number): string {
  return issueTicket(userId, 'sse');
}

export function consumeSseTicket(ticket: string): Promise<{ userId: number } | null> {
  return consumeTicket(ticket, 'sse');
}
