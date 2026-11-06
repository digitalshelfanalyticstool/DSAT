/**
 * Admin Global Messages Routes — CRUD for system-wide announcements.
 *
 * Mounted at /api/admin/messages by the parent admin router.
 *
 *   - POST   /            — create a new global message
 *   - GET    /            — list all global messages (admin view)
 *   - PATCH  /:id         — update a global message
 *   - DELETE /:id         — delete a global message
 */

import { Router } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/database';
import { getAuditContext } from './audit-context';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { createGlobalMessage, isMessageType } from '../services/global-messages';
import { validate, idParams, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';

const logger = createLogger('admin-messages-routes');
const router = Router();

// --- Validation Schemas ---

// `message` is the only required field; `title`/`type`/`expires_at` stay
// freeform — the handler normalises `type` (anything not in the enum → 'info')
// and `Number()`s `expires_at`, so the schema must not narrow them.
const createMessageSchema = z
  .object({
    message: z.string().trim().min(1),
    title: z.string().optional(),
    type: z.any().optional(),
    expires_at: z.any().optional(),
  })
  .passthrough();
const createMessageSchemas = { body: createMessageSchema };

// Same leniency for `type`/`expires_at`; strings must be strings.
const updateMessageSchemas = {
  params: idParams,
  body: z
    .object({
      message: z.string().trim().min(1).optional(),
      title: z.string().nullable().optional(),
      type: z.any().optional(),
      active: z.any().optional(),
      expires_at: z.any().optional(),
    })
    .passthrough(),
};
const deleteMessageSchemas = { params: idParams };

async function auditMessage(req: AuthenticatedRequest, action: string, messageId: unknown): Promise<void> {
  const { audit, ctx } = await getAuditContext(req);
  await audit.log({
    userId: req.user!.id,
    action,
    resourceType: 'global_message',
    resourceId: String(messageId),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/**
 * POST /api/admin/messages
 * Create a new global message.
 */
router.post(
  '/',
  validate(createMessageSchemas),
  asyncHandler(async (req: ValidatedRequest<typeof createMessageSchemas, AuthenticatedRequest>, res) => {
    const { title, message, type, expires_at } = req.body;

    const db = await DatabaseService.getInstance();
    const created = await createGlobalMessage(db, {
      userId: req.user!.id,
      title,
      message,
      type: isMessageType(type) ? type : 'info',
      expiresAt: expires_at ? Number(expires_at) : null,
    });
    await auditMessage(req, 'create_global_message', created?.id);

    logger.info('Global message created', {
      operation: 'createMessage',
      adminId: req.user!.id,
      messageId: created?.id,
    });

    res.status(201).json({ success: true, message: created });
  }, { operation: 'createMessage' }),
);

/**
 * GET /api/admin/messages
 * List all global messages (admin view).
 */
router.get('/', asyncHandler(async (_req: AuthenticatedRequest, res) => {
    const db = await DatabaseService.getInstance();
    const messages = await db.all<Record<string, unknown>>(
      'SELECT gm.*, u.username AS author FROM global_messages gm LEFT JOIN users u ON gm.user_id = u.id ORDER BY gm.created_at DESC',
    );
  res.json({ success: true, messages });
}, { operation: 'listMessages' }));

/**
 * PATCH /api/admin/messages/:id
 * Update a global message.
 */
router.patch('/:id', validate(updateMessageSchemas), asyncHandler(async (req: ValidatedRequest<typeof updateMessageSchemas, AuthenticatedRequest>, res) => {
    const msgId = req.params.id;

    const db = await DatabaseService.getInstance();
    const existing = await db.get<Record<string, unknown>>('SELECT id FROM global_messages WHERE id = $1', msgId);
    if (!existing) {
      res.status(404).json(errorResponse('Message not found', 'not_found'));
      return;
    }

    const { title, message, type, active, expires_at } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];

    if (title !== undefined) { sets.push(`title = $${params.push(title?.trim() || null)}`); }
    if (message !== undefined) { sets.push(`message = $${params.push(message)}`); }
    if (isMessageType(type)) { sets.push(`type = $${params.push(type)}`); }
    if (active !== undefined) { sets.push(`active = $${params.push(active ? 1 : 0)}`); }
    if (expires_at !== undefined) { sets.push(`expires_at = $${params.push(expires_at ? Number(expires_at) : null)}`); }

    if (sets.length === 0) {
      res.status(400).json(errorResponse('No fields to update', 'validation_error'));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    sets.push(`updated_at = $${params.push(now)}`);
    params.push(msgId);

    await db.run(
      `UPDATE global_messages SET ${sets.join(', ')} WHERE id = $${params.length}`,
      ...params,
    );

    const updated = await db.get<Record<string, unknown>>('SELECT * FROM global_messages WHERE id = $1', msgId);
    await auditMessage(req, 'update_global_message', msgId);

    logger.info('Global message updated', {
      operation: 'updateMessage',
      adminId: req.user!.id,
      messageId: msgId,
    });

    res.json({ success: true, message: updated });
  }, { operation: 'updateMessage' }),
);

/**
 * DELETE /api/admin/messages/:id
 * Delete a global message.
 */
router.delete('/:id', validate(deleteMessageSchemas), asyncHandler(async (req: ValidatedRequest<typeof deleteMessageSchemas, AuthenticatedRequest>, res) => {
    const msgId = req.params.id;

    const db = await DatabaseService.getInstance();
    const existing = await db.get<Record<string, unknown>>('SELECT id FROM global_messages WHERE id = $1', msgId);
    if (!existing) {
      res.status(404).json(errorResponse('Message not found', 'not_found'));
      return;
    }

    await db.run('DELETE FROM global_messages WHERE id = $1', msgId);
    await auditMessage(req, 'delete_global_message', msgId);

    logger.info('Global message deleted', {
      operation: 'deleteMessage',
      adminId: req.user!.id,
      messageId: msgId,
    });

    res.json({ success: true, message: 'Message deleted' });
  }, { operation: 'deleteMessage' }),
);

export default router;
