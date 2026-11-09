/**
 * Irreversible erasure of a deactivated user's personal data.
 *
 * The users row stays (jobs, schedules and scrape history keep pointing at its
 * id) but its identifying fields are overwritten, sessions and schedules end,
 * and IP addresses, user agents and attempted usernames that name the user are
 * scrubbed from audit_logs and email_log.
 */

import type { DatabaseService } from './database';
import type { UserRow } from '../types/auth';
import type { AuditLogger, AuditRequestContext } from './audit-service';
import { ERASED_PREFIX, UserManagerError, isErasedUsername } from './user-records';
import { unusablePasswordHash } from './sso-user-resolver';
import { invalidateUserCache } from './user-cache';
import { createLogger } from '../utils/logger';

const logger = createLogger('user-erasure');

export { ERASED_PREFIX };

export async function eraseUserPersonalData(
  db: DatabaseService,
  userId: number,
  adminUserId: number,
  audit?: AuditLogger,
  ctx?: AuditRequestContext,
): Promise<void> {
  if (userId === adminUserId) {
    throw new UserManagerError('Cannot erase your own account', 400);
  }
  const old = await db.get<UserRow>('SELECT * FROM users WHERE id = $1', userId);
  if (!old) {
    throw new UserManagerError('User not found', 404);
  }
  if (old.role === 'admin') {
    throw new UserManagerError('Demote the admin before erasing', 400);
  }
  if (old.is_active !== 0) {
    throw new UserManagerError('Deactivate the user before erasing', 409);
  }
  if (isErasedUsername(old.username)) {
    throw new UserManagerError('User is already erased', 409);
  }

  // bcrypt is slow; hash before opening the transaction.
  const passwordHash = await unusablePasswordHash();
  const nowSec = Math.floor(Date.now() / 1000);

  await db.transaction(async (tx) => {
    // Re-check the preconditions in the same statement, so a concurrent
    // reactivation or promotion cannot slip in between the check and the erase.
    const res = await tx.run(
      `UPDATE users SET username = $1, email = $2, password_hash = $3,
         sso_issuer = NULL, sso_subject = NULL, last_login = NULL,
         must_change_password = 0, failed_login_attempts = 0, updated_at = $4
       WHERE id = $5 AND is_active = 0 AND role <> 'admin' AND NOT starts_with(username, 'erased-')`,
      `${ERASED_PREFIX}${userId}`, `${ERASED_PREFIX}${userId}@erased.invalid`, passwordHash, nowSec, userId,
    );
    if (res.changes === 0) {
      throw new UserManagerError('User changed while erasing; try again', 409);
    }
    await tx.run('DELETE FROM refresh_tokens WHERE user_id = $1', userId);
    // scheduled_jobs.updated_at is in milliseconds.
    await tx.run(
      'UPDATE scheduled_jobs SET enabled = 0, next_retry_at = NULL, updated_at = $2 WHERE user_id = $1',
      userId, nowSec * 1000,
    );
    await tx.run('UPDATE audit_logs SET ip_address = NULL, user_agent = NULL WHERE user_id = $1', userId);
    // details is free text written from unauthenticated login attempts, so it is
    // never cast to jsonb in SQL (one malformed row would fail every erase).
    // strpos narrows the rows; the exact username match happens here.
    const names = new Set([old.username.toLowerCase(), old.email.toLowerCase()]);
    const attempts = await tx.all<{ id: number; details: string | null }>(
      `SELECT id, details FROM audit_logs
       WHERE action = 'failed_login' AND user_id IS NULL
         AND (strpos(LOWER(details), $1) > 0 OR strpos(LOWER(details), $2) > 0)`,
      old.username.toLowerCase(), old.email.toLowerCase(),
    );
    const ids = attempts.filter((a) => names.has(attemptedUsername(a.details))).map((a) => a.id);
    if (ids.length > 0) {
      await tx.run(
        'UPDATE audit_logs SET details = NULL, ip_address = NULL, user_agent = NULL WHERE id = ANY($1::int[])',
        ids,
      );
    }
    // create_user rows are filed under the admin but record the new user's username and email.
    await tx.run(
      "UPDATE audit_logs SET details = NULL WHERE action = 'create_user' AND resource_type = 'user' AND resource_id = $1",
      String(userId),
    );
    await tx.run("UPDATE email_log SET to_address = 'erased' WHERE LOWER(to_address) = LOWER($1)", old.email);
  });

  if (audit) {
    await audit.log({
      userId: adminUserId,
      action: 'erase_user',
      resourceType: 'user',
      resourceId: String(userId),
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    });
  }

  invalidateUserCache(String(userId));

  logger.info('User personal data erased', { operation: 'eraseUserPersonalData', userId, adminUserId });
}

function attemptedUsername(details: string | null): string {
  try {
    const name = (JSON.parse(details ?? '') as { username?: unknown })?.username;
    return typeof name === 'string' ? name.toLowerCase() : '';
  } catch {
    return '';
  }
}
