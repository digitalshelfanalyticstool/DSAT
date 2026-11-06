import type { DatabaseService } from './database';

export const MESSAGE_TYPES = ['info', 'warning', 'error'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
}

export interface NewGlobalMessage {
  message: string;
  title?: string | null;
  type?: MessageType;
  /** Unix seconds; null means never expires. */
  expiresAt?: number | null;
  /** Null for system-generated messages. */
  userId?: number | null;
}

/** The only writer of new global_messages rows (its timestamps are epoch seconds). */
export async function createGlobalMessage(
  db: Pick<DatabaseService, 'get'>,
  input: NewGlobalMessage,
): Promise<Record<string, unknown> | undefined> {
  const now = Math.floor(Date.now() / 1000);
  return db.get<Record<string, unknown>>(
    `INSERT INTO global_messages (user_id, title, message, type, active, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $6)
     RETURNING *`,
    input.userId ?? null,
    input.title?.trim() || null,
    input.message.trim(),
    input.type ?? 'info',
    input.expiresAt ?? null,
    now,
  );
}
