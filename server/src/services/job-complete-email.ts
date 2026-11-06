/**
 * Job-complete email helper.
 *
 * Resolves the job's submitter from the users table and fires a templated
 * 'job-complete' email via EmailService. Called from worker.ts::handleJob
 * on the success path; the worker wraps the call in `void ... .catch()` so
 * the worker never awaits the send.
 *
 * Failure modes that are silently swallowed (return early, no email sent):
 *   - job has no user_id (orphan / scheduled-only job)
 *   - user has no email or empty email
 *   - email subsystem is disabled (NullProvider) — handled inside EmailService
 *
 * The send itself never throws (per EmailService.send contract); every
 * outcome (sent / skipped / failed) writes a row to email_log.
 */

import { DatabaseService } from './database';
import { getEmailService } from './email';
import { createLogger } from '../utils/logger';
import { config } from '../config';

const logger = createLogger('job-complete-email');

interface JobUserRow {
  user_id: number | null;
}

interface UserRow {
  email: string | null;
  username: string | null;
}

export interface JobCompleteEmailInput {
  jobId: string;
  site: string;
  brand: string;
  rowCount: number;
}

export async function sendJobCompleteEmail(
  input: JobCompleteEmailInput,
): Promise<{ status: 'sent' | 'skipped' | 'failed' | 'no-recipient'; error?: string }> {
  const db = await DatabaseService.getInstance();

  const jobRow = await db.get<JobUserRow>(
    `SELECT user_id FROM jobs WHERE job_id = $1`,
    input.jobId,
  );
  if (!jobRow || jobRow.user_id == null) {
    logger.debug('Job-complete email: no user_id on job, skipping', {
      operation: 'sendJobCompleteEmail',
      jobId: input.jobId,
    });
    return { status: 'no-recipient' };
  }

  const userRow = await db.get<UserRow>(
    `SELECT email, username FROM users WHERE id = $1`,
    jobRow.user_id,
  );
  if (!userRow || !userRow.email || !userRow.email.includes('@')) {
    logger.debug('Job-complete email: user has no usable email, skipping', {
      operation: 'sendJobCompleteEmail',
      jobId: input.jobId,
      userId: jobRow.user_id,
    });
    return { status: 'no-recipient' };
  }

  const emailService = await getEmailService();
  const resultUrl = `${config.email.appPublicUrl}/jobs/${input.jobId}`;

  return emailService.send('job-complete', userRow.email, {
    userName: userRow.username ?? userRow.email,
    jobId: input.jobId,
    retailer: `${input.site} (${input.brand})`,
    rowCount: String(input.rowCount),
    resultUrl,
  });
}
