import type { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { REFRESH_TOKEN_TTL_SECONDS } from '../services/session-lifetimes';

const REFRESH_COOKIE = 'refresh_token';

/**
 * Every cookie the API sets is httpOnly and scoped to the routes that read it.
 * SameSite defaults to strict when cookies are Secure; over plain-HTTP local dev
 * it relaxes to lax so Next.js on :3000 can reach the API on :3001.
 */
export function cookieOptions(path: string, opts: { sameSite?: 'strict' | 'lax'; maxAgeSeconds?: number } = {}): CookieOptions {
  const secure = config.auth.cookieSecure;
  return {
    httpOnly: true,
    secure,
    sameSite: opts.sameSite ?? (secure ? 'strict' : 'lax'),
    path,
    ...(opts.maxAgeSeconds === undefined ? {} : { maxAge: opts.maxAgeSeconds * 1000 }),
  };
}

const refreshCookieOptions = (): CookieOptions => cookieOptions('/api/auth');

/** The refresh token rides in an httpOnly cookie, never the response body. */
export function setSessionCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...refreshCookieOptions(), maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.clearCookie('bull_board_token', cookieOptions('/admin/queues'));
}

export function readSessionCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
