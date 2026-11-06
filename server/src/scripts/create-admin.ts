/**
 * Recovery: create an admin, or promote and reactivate an existing account,
 * when nobody can sign in as an admin. Prints a one-time password the admin
 * must change on first sign-in.
 *
 * Usage: npm run create-admin -w server -- --username <name> --email <email>
 * Runs against DATABASE_URL.
 */

import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import bcrypt from 'bcrypt';
import { DatabaseService } from '../services/database';
import { config } from '../config';

export async function runCreateAdmin(
  db: DatabaseService,
  args: { username: string; email: string },
): Promise<{ created: boolean; password: string }> {
  const password = crypto.randomBytes(18).toString('base64url');
  const hash = await bcrypt.hash(password, config.auth.bcryptCost);
  const now = Math.floor(Date.now() / 1000);
  const email = args.email.trim().toLowerCase();

  const existing = await db.get<{ id: number }>('SELECT id FROM users WHERE LOWER(email) = $1', email);
  if (existing) {
    await db.run(
      `UPDATE users SET role = 'admin', is_active = 1, must_change_password = 1, password_hash = $1,
         failed_login_attempts = 0, locked_until = NULL, updated_at = $2 WHERE id = $3`,
      hash, now, existing.id,
    );
    await db.run('UPDATE refresh_tokens SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL', now, existing.id);
    return { created: false, password };
  }
  await db.run(
    `INSERT INTO users (username, email, password_hash, role, created_at, updated_at, is_active, must_change_password)
     VALUES ($1, $2, $3, 'admin', $4, $4, 1, 1)`,
    args.username.trim().toLowerCase(), email, hash, now,
  );
  return { created: true, password };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { username: { type: 'string' }, email: { type: 'string' } } });
  if (!values.username || !values.email) {
    console.error('Usage: npm run create-admin -w server -- --username <name> --email <email>');
    process.exit(1);
  }
  const db = await DatabaseService.getInstance();
  try {
    const { created, password } = await runCreateAdmin(db, { username: values.username, email: values.email });
    console.log(`${created ? 'Created' : 'Promoted and reactivated'} admin for ${values.email}.`);
    console.log(`One-time password (change it at first sign-in): ${password}`);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('create-admin failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
