/**
 * Daily-digest email scheduler.
 *
 * Once per `config.email.digestIntervalMs` (default 24h), aggregates failed
 * jobs from the prior interval and emails every admin user. Skips the send
 * entirely when failedCount is 0 — avoiding "0 failures" noise emails was a
 * deliberate call; flip the early-return to send-anyway if admins want a
 * heartbeat that the digest scheduler is alive.
 *
 * Scheduled by background-tasks.ts (first run an hour after startup).
 *
 * The send itself goes through EmailService — which never throws and writes
 * a row to email_log for every attempt. A misconfigured email subsystem
 * cannot crash the scheduler.
 */

import { DatabaseService } from './database';
import { getEmailService } from './email';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const logger = createLogger('email-digest-scheduler');

interface FailedJobsResult {
  failedCount: number;
}

interface AdminRow {
  email: string;
}

/**
 * Count jobs that completed in a 'failed' state in the last 24 hours.
 *
 * The seeded `daily-digest` template's subject reads "X failed jobs in the
 * last 24h" — so the SQL window matches that copy literally. Bump the
 * INTERVAL alongside the template if you change one.
 *
 * The status filter is intentionally narrow: only rows where the worker
 * reached the failure branch in worker.ts::handleJob. If you want to also
 * count 'cancelled' (admin-cancelled) or 'timeout' jobs, extend the IN
 * clause and update the digest template copy to match — "X failed jobs"
 * misrepresents 'cancelled' which is operator-initiated, not a real error.
 */
async function countFailedJobs(db: DatabaseService): Promise<number> {
  const row = await db.get<FailedJobsResult>(
    `SELECT COUNT(*)::int AS "failedCount"
       FROM jobs
      WHERE status = 'failed'
        AND completed_at >= NOW() - INTERVAL '24 hours'`,
  );
  return row?.failedCount ?? 0;
}

async function loadAdminEmails(db: DatabaseService): Promise<string[]> {
  const rows = await db.all<AdminRow>(
    `SELECT email FROM users WHERE role = 'admin' AND is_active = 1 AND email IS NOT NULL`,
  );
  return rows.map((r) => r.email).filter((e) => e?.includes('@'));
}

/**
 * Run one digest tick. Exported for ad-hoc invocation.
 */
export async function runEmailDigest(): Promise<{
  failedCount: number;
  recipientCount: number;
  sent: number;
  skipped: number;
}> {
  const db = await DatabaseService.getInstance();
  const failedCount = await countFailedJobs(db);

  if (failedCount === 0) {
    logger.info('Daily digest: no failed jobs in window, skipping send', {
      operation: 'runEmailDigest',
      failedCount,
    });
    return { failedCount, recipientCount: 0, sent: 0, skipped: 0 };
  }

  const recipients = await loadAdminEmails(db);
  if (recipients.length === 0) {
    logger.warn('Daily digest: no admin recipients found, skipping send', {
      operation: 'runEmailDigest',
      failedCount,
    });
    return { failedCount, recipientCount: 0, sent: 0, skipped: 0 };
  }

  const emailService = await getEmailService();
  const dashboardUrl = `${config.email.appPublicUrl}/admin/analytics`;

  let sent = 0;
  let skipped = 0;
  for (const to of recipients) {
    const result = await emailService.send('daily-digest', to, {
      failedCount: String(failedCount),
      dashboardUrl,
    });
    if (result.status === 'sent') sent++;
    else skipped++;
  }

  logger.info('Daily digest send complete', {
    operation: 'runEmailDigest',
    failedCount,
    recipientCount: recipients.length,
    sent,
    skipped,
  });

  return {
    failedCount,
    recipientCount: recipients.length,
    sent,
    skipped,
  };
}
