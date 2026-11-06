/**
 * One-time code that proves the first-run admin is whoever runs the server.
 * Issued at API start when no users exist and printed to the server log; a
 * restart issues a new one. Held in memory only (single API process).
 */

import crypto from 'node:crypto';

let current: string | null = null;

export function issueSetupCode(): string {
  current = crypto.randomBytes(16).toString('hex');
  return current;
}

export function checkSetupCode(submitted: string | undefined): boolean {
  if (!current || typeof submitted !== 'string') return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(current);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearSetupCode(): void {
  current = null;
}
