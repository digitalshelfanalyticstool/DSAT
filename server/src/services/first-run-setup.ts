/**
 * First-run admin setup: on a fresh install the first visitor creates the
 * admin account. Once any user exists this path is closed for good.
 */

import type { DatabaseService } from './database';
import type { UserRow } from '../types/auth';
import { UserManagerError, hashPassword, validateEmail, validateUsername } from './user-records';
import { validatePasswordStrength } from '../utils/password-validator.js';

// Arbitrary constant; serializes concurrent setup attempts.
const SETUP_LOCK_KEY = 4_215_001;

export async function needsSetup(db: DatabaseService): Promise<boolean> {
  const row = await db.get<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS exists');
  return !row?.exists;
}

/** Creates the admin, or returns null when users already exist. */
export async function createFirstAdmin(
  db: DatabaseService,
  input: { username: string; email: string; password: string },
): Promise<UserRow | null> {
  validateUsername(input.username);
  validateEmail(input.email);
  const pw = validatePasswordStrength(input.password);
  if (!pw.valid) throw new UserManagerError(pw.errors.join('; '), 400);

  const passwordHash = await hashPassword(input.password);
  const now = Math.floor(Date.now() / 1000);

  return db.transaction(async (tx) => {
    // Two racing requests would both see an empty table without this lock.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);
    const existing = await tx.get<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS exists');
    if (existing?.exists) return null;
    const user = await tx.get<UserRow>(
      `INSERT INTO users (username, email, password_hash, role, created_at, updated_at, is_active, must_change_password)
       VALUES ($1, $2, $3, 'admin', $4, $4, 1, 0) RETURNING *`,
      input.username.trim().toLowerCase(), input.email.trim().toLowerCase(), passwordHash, now,
    );
    return user ?? null;
  });
}
