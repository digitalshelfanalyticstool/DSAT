/**
 * User Bulk Operations — import/export users from CSV/spreadsheet data.
 *
 * Handles:
 *   - Bulk create-or-update from parsed CSV/XLSX rows
 *   - Per-row validation and error collection
 *   - Audit logging for bulk import actions
 */

import crypto from 'node:crypto';
import { DatabaseService } from './database';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { validatePasswordStrength } from '../utils/password-validator.js';
import type { AuditLogger, AuditRequestContext } from './audit-service';
import { hashPassword, mustChangePasswordOnCreate, validateEmail, validateUsername } from './user-records';
import { invalidateUserCache } from './user-cache';

const logger = createLogger('user-bulk-ops');

// --- Types ---

export interface BulkUserRow {
  username: string;
  email: string;
  role: string;
  password?: string;
  is_active?: string;
}

export interface BulkImportResult {
  created: number;
  updated: number;
  errors: Array<{ row: number; error: string }>;
}

// --- Bulk Helpers ---

/** Nobody is told this password; the admin resets it to hand the account over. */
function generateRandomPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

interface ValidatedRow {
  username: string;
  email: string;
  role: 'admin' | 'user';
}

function validateBulkRow(row: BulkUserRow): ValidatedRow {
  if (!row.username?.trim()) throw new Error('Username is required');
  if (!row.email?.trim()) throw new Error('Email is required');

  const username = row.username.trim().toLowerCase();
  const email = row.email.trim().toLowerCase();
  const role: 'admin' | 'user' = (row.role?.trim().toLowerCase() === 'admin') ? 'admin' : 'user';

  validateUsername(username);
  validateEmail(email);

  return { username, email, role };
}

// A row that passed validation and matched an existing user by email.
interface PendingUpdate {
  id: number;
  username: string;
  role: string;
  // null → row omitted is_active, so keep the existing DB value (COALESCE).
  isActive: number | null;
}

// A row that passed validation with no email match — a new user to create.
// `password` is the resolved plaintext; hashing is deferred to a bounded pool.
interface PendingCreate {
  username: string;
  email: string;
  role: string;
  password: string;
}

/**
 * Parse a spreadsheet `is_active` cell into 0/1, or null when unset.
 * Mirrors the original per-row semantics: an omitted/empty cell leaves the
 * existing value untouched.
 */
function parseIsActive(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  return ['true', '1', 'yes'].includes(raw.toLowerCase()) ? 1 : 0;
}

/**
 * Resolve the plaintext password for a new user, validating an explicitly
 * supplied one (throws → per-row error, exactly as before). Hashing is done
 * later so it can be parallelised across rows.
 */
function resolveNewPassword(row: BulkUserRow): string {
  const password = row.password?.trim() || generateRandomPassword();
  if (row.password?.trim()) {
    const pwResult = validatePasswordStrength(password);
    if (!pwResult.valid) {
      throw new Error(`Password: ${pwResult.errors.join('; ')}`);
    }
  }
  return password;
}

/**
 * Map `fn` over `items` with bounded concurrency, preserving input order.
 * bcrypt is CPU-bound (runs on libuv's threadpool), so hashing every new
 * user's password at once would oversubscribe; this caps in-flight work.
 */
async function mapWithConcurrency<T, R>(
  items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Batched UPDATE for email-matched rows. One unnest()-driven round-trip per
 * `batchSize` rows instead of one per row. `is_active` uses COALESCE so a null
 * (row omitted the column) keeps the stored value.
 */
async function flushUpdates(
  tx: { run: (sql: string, ...params: unknown[]) => Promise<unknown> },
  updates: PendingUpdate[], now: number, batchSize: number,
): Promise<void> {
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    const ids: number[] = [];
    const usernames: string[] = [];
    const roles: string[] = [];
    const isActives: Array<number | null> = [];
    const updatedAts: number[] = [];
    for (const u of batch) {
      ids.push(u.id);
      usernames.push(u.username);
      roles.push(u.role);
      isActives.push(u.isActive);
      updatedAts.push(now);
    }
    await tx.run(
      `UPDATE users AS u SET
         username = v.username,
         role = v.role,
         is_active = COALESCE(v.is_active, u.is_active),
         updated_at = v.updated_at
       FROM unnest($1::int[], $2::text[], $3::text[], $4::int[], $5::bigint[])
         AS v(id, username, role, is_active, updated_at)
       WHERE u.id = v.id`,
      ids, usernames, roles, isActives, updatedAts,
    );
  }
}

/**
 * Batched INSERT for new users. One unnest()-driven round-trip per `batchSize`
 * rows. must_change_password follows mustChangePasswordOnCreate(role), the
 * same rule as accounts created from the admin form.
 */
async function flushCreates(
  tx: { run: (sql: string, ...params: unknown[]) => Promise<unknown> },
  creates: PendingCreate[], hashes: string[], now: number, batchSize: number,
): Promise<void> {
  for (let i = 0; i < creates.length; i += batchSize) {
    const batch = creates.slice(i, i + batchSize);
    const usernames: string[] = [];
    const emails: string[] = [];
    const passwordHashes: string[] = [];
    const roles: string[] = [];
    const createdAts: number[] = [];
    const updatedAts: number[] = [];
    const mustChanges: number[] = [];
    for (let j = 0; j < batch.length; j++) {
      usernames.push(batch[j].username);
      emails.push(batch[j].email);
      passwordHashes.push(hashes[i + j]);
      roles.push(batch[j].role);
      createdAts.push(now);
      updatedAts.push(now);
      mustChanges.push(mustChangePasswordOnCreate(batch[j].role) ? 1 : 0);
    }
    await tx.run(
      `INSERT INTO users (username, email, password_hash, role, created_at, updated_at, is_active, must_change_password)
       SELECT username, email, password_hash, role, created_at, updated_at, 1, must_change_password
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::int[])
         AS t(username, email, password_hash, role, created_at, updated_at, must_change_password)`,
      usernames, emails, passwordHashes, roles, createdAts, updatedAts, mustChanges,
    );
  }
}

/**
 * Bulk create or update users from a parsed spreadsheet/CSV.
 * - If email matches existing user → update (username, role, is_active)
 * - If no match → create
 * Validates all rows upfront and collects per-row errors.
 */
export async function bulkCreateOrUpdate(
  db: DatabaseService,
  rows: BulkUserRow[],
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<BulkImportResult> {
  const result: BulkImportResult = { created: 0, updated: 0, errors: [] };

  if (rows.length === 0) return result;

  // Load only what the import needs (id for updates, email/username as lookup
  // keys). Avoids pulling password_hash and every other column for the whole
  // users table into memory on each import.
  const existingUsers = await db.all<{ id: number; email: string; username: string }>(
    'SELECT id, email, username FROM users',
  );
  const emailToUser = new Map<string, { id: number }>();
  const existingUsernames = new Set<string>();
  for (const u of existingUsers) {
    emailToUser.set(u.email.toLowerCase(), u);
    existingUsernames.add(u.username.toLowerCase());
  }

  const now = Math.floor(Date.now() / 1000);

  // Phase 1: validate + classify every row into pending update/create sets,
  // collecting per-row errors. No DB writes yet — this is pure CPU work so a
  // single bad row never aborts the whole import (unchanged semantics).
  const pendingUpdates: PendingUpdate[] = [];
  const pendingCreates: PendingCreate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +2 for 1-indexed + header row
    try {
      const { username, email, role } = validateBulkRow(rows[i]);
      const existingUser = emailToUser.get(email);

      if (existingUser) {
        pendingUpdates.push({
          id: existingUser.id,
          username,
          role,
          isActive: parseIsActive(rows[i].is_active),
        });
      } else {
        // Username uniqueness is checked against the in-memory set (built from
        // the single load above + usernames created earlier in THIS batch),
        // replacing a per-row SELECT — an N+1 across the import.
        if (existingUsernames.has(username)) {
          throw new Error(`Username "${username}" already exists`);
        }
        // Validate an explicit password before reserving the username, so an
        // invalid-password row stays an error and doesn't consume the name.
        const password = resolveNewPassword(rows[i]);
        pendingCreates.push({ username, email, role, password });
        existingUsernames.add(username);
      }
    } catch (err) {
      result.errors.push({ row: rowNum, error: (err as Error).message });
    }
  }

  // Phase 2: hash new-user passwords with bounded parallelism. bcrypt is
  // CPU-bound (~250ms/hash) and can't be batched into SQL, so this is the one
  // per-user cost we keep — but we run it concurrently instead of serially.
  const hashes = await mapWithConcurrency(
    pendingCreates,
    config.auth.userImportHashConcurrency,
    (c) => hashPassword(c.password),
  );

  // Phase 3: flush all writes as batched unnest() statements in ONE atomic
  // transaction instead of N per-row round-trips.
  if (pendingUpdates.length > 0 || pendingCreates.length > 0) {
    const batchSize = config.auth.userImportBatchSize;
    await db.transaction(async (tx) => {
      await flushUpdates(tx, pendingUpdates, now, batchSize);
      await flushCreates(tx, pendingCreates, hashes, now, batchSize);
    });
    for (const u of pendingUpdates) invalidateUserCache(String(u.id));
  }

  result.updated = pendingUpdates.length;
  result.created = pendingCreates.length;

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'bulk_user_import',
      resourceType: 'user',
      details: JSON.stringify({
        total_rows: rows.length,
        created: result.created,
        updated: result.updated,
        errors: result.errors.length,
      }),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  logger.info('Bulk user import complete', {
    operation: 'bulkCreateOrUpdate',
    totalRows: rows.length,
    created: result.created,
    updated: result.updated,
    errors: result.errors.length,
  });

  return result;
}
