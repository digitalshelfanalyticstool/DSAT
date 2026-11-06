import { DatabaseService } from './database';
import { createLogger } from '../utils/logger';
import { cleanupAttempts } from './rate-limit-store';

const logger = createLogger('auth-token-cleanup');

// --- Token Cleanup ---

/**
 * Delete expired refresh tokens from the database.
 * Should be called periodically (e.g., daily).
 * Returns the number of tokens deleted.
 */
export async function cleanupExpiredTokens(db: DatabaseService): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.run(
    'DELETE FROM refresh_tokens WHERE expires_at < $1 OR revoked_at IS NOT NULL',
    now,
  );

  logger.info('Expired refresh tokens cleaned up', {
    operation: 'cleanupExpiredTokens',
    deletedCount: result.changes,
  });

  return result.changes;
}

/** Delete expired refresh tokens and day-old rate-limit attempts. Run daily by background-tasks.ts. */
export async function runTokenCleanup(db: DatabaseService): Promise<void> {
  const deleted = await cleanupExpiredTokens(db);
  const rateLimitCleaned = await cleanupAttempts(db, 24 * 60 * 60 * 1000);
  logger.info('Scheduled cleanup completed', {
    operation: 'runTokenCleanup',
    tokensDeleted: deleted,
    rateLimitEntriesCleaned: rateLimitCleaned,
  });
}
