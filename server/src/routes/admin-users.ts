/**
 * Admin User Management Routes
 *
 * Mounted at /api/admin/users by the admin hub router.
 * Auth middleware (authMiddleware + requireRole('admin')) is applied by the parent.
 *
 *   POST   /                 — create user
 *   GET    /                 — list users with filters
 *   GET    /export           — export users as CSV or XLSX
 *   GET    /import-template  — download blank XLSX template
 *   GET    /:id              — get user by ID
 *   PATCH  /:id              — update user fields
 *   DELETE /:id              — soft-delete user
 *   POST   /:id/reactivate   — reactivate user
 *   POST   /:id/lock         — lock user
 *   POST   /:id/unlock       — unlock user
 *   POST   /:id/erase        — erase a deactivated user's personal data
 *   POST   /import           — bulk import users from CSV or XLSX
 */

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import ExcelJS from 'exceljs';
import {
  createUser,
  updateUser,
  deleteUser,
  reactivateUser,
  lockUser,
  unlockUser,
  listUsers,
  getUserById,
} from '../services/user-manager';
import { eraseUserPersonalData } from '../services/user-erasure';
import { bulkCreateOrUpdate, type BulkUserRow } from '../services/user-bulk-ops';
import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import { getAuditContext } from './audit-context';
import { createLogger } from '../utils/logger';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { validate, idParams, type ValidatedRequest } from '../middleware/validate';
import type { AuthenticatedRequest } from '../middleware/auth';
import { csvRow } from '../utils/csv';
import type { Buffer } from 'node:buffer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const logger = createLogger('admin-users-routes');
const router = Router();

// --- Validation Schemas ---
// `username`/`email`/`password` are required-and-truthy in the handler and then
// forwarded to createUser(), which does the deeper validation (length, email
// shape, uniqueness). `role` stays freeform — the handler normalises anything
// that isn't 'admin' to 'user'. Body stays passthrough.
const createUserSchema = z
  .object({
    username: z.string().min(1),
    email: z.string().min(1),
    password: z.string().min(1),
    role: z.any().optional(),
  })
  .passthrough();
const createUserSchemas = { body: createUserSchema };

// user-manager validates length, email shape and uniqueness; this rejects
// wrong types before they reach it. Unknown keys are ignored, as before.
const updateUserSchemas = {
  params: idParams,
  body: z.object({
    username: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    role: z.enum(['admin', 'user']).optional(),
    is_active: z.boolean().optional(),
  }),
};
const userIdSchemas = { params: idParams };



/** Helper to create a user action route (reactivate, lock, unlock). */
function userActionRoute(
  actionFn: (db: DatabaseService, userId: number, adminUserId: number, audit: AuditService, ctx: { ipAddress?: string; userAgent?: string }) => Promise<import('../services/user-manager').UserResponse>,
  operationName: string,
) {
  const operation = `admin${operationName.charAt(0).toUpperCase()}${operationName.slice(1)}`;
  // `UserManagerError` carries its own status, and the catch this replaces
  // derived the envelope type with `errorTypeForStatus` — exactly what the
  // shared handler does, so the responses are unchanged apart from a 500 no
  // longer echoing the raw message.
  const handler = asyncHandler(async (req: ValidatedRequest<typeof userIdSchemas, AuthenticatedRequest>, res: import('express').Response) => {
    const userId = req.params.id;

    const { db, audit, ctx } = await getAuditContext(req);
    const user = await actionFn(db, userId, req.user!.id, audit, ctx);

    logger.info(`User ${operationName} by admin`, {
      operation,
      adminId: req.user!.id,
      targetUserId: userId,
    });

    res.json({ success: true, user });
  }, { operation });
  return [validate(userIdSchemas), handler];
}

// ═══════════════════════════════════════════════════════════════════════════════
// User Management Routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /admin/users:
 *   post:
 *     summary: Create a new user account
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string }
 *               role: { type: string, enum: [admin, user], default: user }
 *     responses:
 *       201:
 *         description: User created
 *       400:
 *         description: Validation error
 *       409:
 *         description: Username or email already exists
 */
router.post('/', validate(createUserSchemas), asyncHandler(async (req: ValidatedRequest<typeof createUserSchemas, AuthenticatedRequest>, res) => {
  const { username, email, password, role } = req.body;

  const userRole = role === 'admin' ? 'admin' : 'user';
  const { db, audit, ctx } = await getAuditContext(req);

  const user = await createUser(
    db,
    { username, email, password, role: userRole },
    req.user!.id,
    audit,
    ctx,
  );

  logger.info('User created by admin', {
    operation: 'adminCreateUser',
    adminId: req.user!.id,
    newUserId: user.id,
  });

  res.status(201).json({ success: true, user });
}, { operation: 'adminCreateUser' }));

/**
 * @openapi
 * /admin/users:
 *   get:
 *     summary: List users with optional filters
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [admin, user] }
 *       - in: query
 *         name: is_active
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by username or email
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const { role, is_active, search } = req.query;

  const filters: { role?: 'admin' | 'user'; is_active?: boolean; search?: string } = {};
  if (role === 'admin' || role === 'user') filters.role = role;
  if (is_active === 'true') filters.is_active = true;
  if (is_active === 'false') filters.is_active = false;
  if (search) filters.search = String(search);

  const db = await DatabaseService.getInstance();
  const users = await listUsers(db, filters);

  res.json({ success: true, users });
}, { operation: 'adminListUsers' }));

/**
 * @openapi
 * /admin/users/export:
 *   get:
 *     summary: Export all users as CSV or XLSX
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [csv, xlsx], default: xlsx }
 *     responses:
 *       200:
 *         description: File download
 *         content:
 *           text/csv:
 *             schema: { type: string }
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema: { type: string, format: binary }
 */
router.get('/export', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (format !== 'csv' && format !== 'xlsx') {
    res.status(400).json(errorResponse('format must be "csv" or "xlsx"', 'validation_error'));
    return;
  }

  const db = await DatabaseService.getInstance();
  const users = await listUsers(db, {});
  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="users-${dateStr}.csv"`);

    res.write('Username,Email,Role,Active,Created At,Last Login\n');
    for (const u of users) {
      res.write(csvRow([u.username, u.email, u.role, u.is_active ? 'true' : 'false', u.created_at, u.last_login]) + '\n');
    }
    res.end();
    return;
  }

  // XLSX format using ExcelJS
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Users');
  sheet.columns = [
    { header: 'Username', key: 'username', width: 20 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Role', key: 'role', width: 10 },
    { header: 'Active', key: 'is_active', width: 10 },
    { header: 'Created At', key: 'created_at', width: 22 },
    { header: 'Last Login', key: 'last_login', width: 22 },
  ];

  for (const u of users) {
    sheet.addRow({
      username: u.username,
      email: u.email,
      role: u.role,
      is_active: u.is_active ? 'true' : 'false',
      created_at: u.created_at,
      last_login: u.last_login ?? '',
    });
  }

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="users-${dateStr}.xlsx"`);

  await workbook.xlsx.write(res);
  res.end();
}, { operation: 'userExport' }));

/**
 * @openapi
 * /admin/users/import-template:
 *   get:
 *     summary: Download a blank XLSX template for bulk user import
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: XLSX template file
 */
router.get('/import-template', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const workbook = new ExcelJS.Workbook();

  // Users sheet with sample row
  const sheet = workbook.addWorksheet('Users');
  sheet.columns = [
    { header: 'username', key: 'username', width: 20 },
    { header: 'email', key: 'email', width: 30 },
    { header: 'role', key: 'role', width: 10 },
    { header: 'password', key: 'password', width: 20 },
  ];

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  });
  headerRow.commit();

  sheet.addRow({ username: 'jsmith', email: 'jsmith@example.com', role: 'user', password: '' });

  // Add note to password header cell
  const pwHeader = sheet.getCell('D1');
  pwHeader.note = 'Optional. If omitted, a random password is generated. New non-admin users must change their password on first login.';

  // Instructions sheet
  const instructions = workbook.addWorksheet('Instructions');
  instructions.getColumn(1).width = 50;
  instructions.getColumn(2).width = 60;

  const title = instructions.getRow(1);
  title.getCell(1).value = 'Bulk User Import Instructions';
  title.getCell(1).font = { bold: true, size: 14 };

  const rows = [
    ['', ''],
    ['Column', 'Description'],
    ['username', 'Required. 3-50 characters. Must be unique.'],
    ['email', 'Required. Must be a valid email. Used to match existing users for updates.'],
    ['role', 'Optional. "user" (default) or "admin".'],
    ['password', 'Optional. At least 12 characters, with upper and lower case, a digit and a symbol. If omitted, a random password is generated.'],
    ['', ''],
    ['Notes', ''],
    ['Default password', 'Set the password column to a shared temporary password for all new users.'],
    ['First login', 'Imported non-admin users are required to change their password on first login.'],
    ['Existing users', 'If the email matches an existing user, their username and role are updated. Password is not changed.'],
    ['Errors', 'Rows with errors are skipped. The import result shows which rows failed and why.'],
  ];

  for (const [a, b] of rows) {
    const r = instructions.addRow([a, b]);
    if (a === 'Column' || a === 'Notes') {
      r.getCell(1).font = { bold: true };
      r.getCell(2).font = { bold: true };
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="user-import-template.xlsx"');

  await workbook.xlsx.write(res);
  res.end();
}, { operation: 'importTemplate' }));

/**
 * @openapi
 * /admin/users/{id}:
 *   get:
 *     summary: Get user details by ID
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User details
 *       404:
 *         description: User not found
 */
router.get('/:id', validate(userIdSchemas), asyncHandler(async (req: ValidatedRequest<typeof userIdSchemas, AuthenticatedRequest>, res) => {
  const userId = req.params.id;

  const { db, audit, ctx } = await getAuditContext(req);
  const user = await getUserById(db, userId, req.user!.id, audit, ctx);

  res.json({ success: true, user });
}, { operation: 'adminGetUser' }));

/**
 * @openapi
 * /admin/users/{id}:
 *   patch:
 *     summary: Update user fields
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *               email: { type: string }
 *               password: { type: string }
 *               role: { type: string, enum: [admin, user] }
 *               is_active: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated user
 *       404:
 *         description: User not found
 */
router.patch('/:id', validate(updateUserSchemas), asyncHandler(async (req: ValidatedRequest<typeof updateUserSchemas, AuthenticatedRequest>, res) => {
  const userId = req.params.id;
  const updates = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));

  if (Object.keys(updates).length === 0) {
    res.status(400).json(errorResponse('No fields to update', 'validation_error'));
    return;
  }

  const { db, audit, ctx } = await getAuditContext(req);
  const user = await updateUser(db, userId, updates, req.user!.id, audit, ctx);

  logger.info('User updated by admin', {
    operation: 'adminUpdateUser',
    adminId: req.user!.id,
    targetUserId: userId,
  });

  res.json({ success: true, user });
}, { operation: 'adminUpdateUser' }));

/**
 * @openapi
 * /admin/users/{id}:
 *   delete:
 *     summary: Soft-delete a user
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User deleted
 *       404:
 *         description: User not found
 */
router.delete('/:id', validate(userIdSchemas), asyncHandler(async (req: ValidatedRequest<typeof userIdSchemas, AuthenticatedRequest>, res) => {
  const userId = req.params.id;

  const { db, audit, ctx } = await getAuditContext(req);
  await deleteUser(db, userId, req.user!.id, audit, ctx);

  logger.info('User deleted by admin', {
    operation: 'adminDeleteUser',
    adminId: req.user!.id,
    targetUserId: userId,
  });

  res.json({ success: true, message: 'User deleted' });
}, { operation: 'adminDeleteUser' }));

/**
 * @openapi
 * /admin/users/{id}/reactivate:
 *   post:
 *     summary: Reactivate a soft-deleted user
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User reactivated
 *       404:
 *         description: User not found
 */
router.post('/:id/reactivate', userActionRoute(reactivateUser, 'reactivate'));

/**
 * @openapi
 * /admin/users/{id}/lock:
 *   post:
 *     summary: Lock a user account
 *     description: Admin-only. Locks the account preventing login. Cannot lock admin accounts or self.
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User locked
 *       400:
 *         description: Cannot lock admin accounts or self
 *       404:
 *         description: User not found
 */
router.post('/:id/lock', userActionRoute(lockUser, 'lock'));

/**
 * @openapi
 * /admin/users/{id}/unlock:
 *   post:
 *     summary: Unlock a locked-out user account
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: User unlocked
 *       404:
 *         description: User not found
 */
router.post('/:id/unlock', userActionRoute(unlockUser, 'unlock'));

/**
 * @openapi
 * /admin/users/{id}/erase:
 *   post:
 *     summary: Erase a deactivated user's personal data
 *     description: Admin-only and irreversible. Anonymises the user row and scrubs their IP addresses, user agents and email address from logs. Jobs and scrape history are kept.
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Personal data erased
 *       400:
 *         description: Cannot erase self or an admin
 *       404:
 *         description: User not found
 *       409:
 *         description: User is still active or already erased
 */
router.post('/:id/erase', validate(userIdSchemas), asyncHandler(async (req: ValidatedRequest<typeof userIdSchemas, AuthenticatedRequest>, res) => {
  const userId = req.params.id;

  const { db, audit, ctx } = await getAuditContext(req);
  await eraseUserPersonalData(db, userId, req.user!.id, audit, ctx);

  res.json({ success: true, message: 'Personal data erased' });
}, { operation: 'adminEraseUser' }));

/** Parse an XLSX/XLS file buffer into BulkUserRow[]. Throws on format errors. */
async function parseXlsxFile(buffer: Buffer): Promise<BulkUserRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in file');

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim().toLowerCase();
  });

  const colMap: Record<string, number> = {};
  const knownHeaders: Record<string, string[]> = {
    username: ['username'], email: ['email'], role: ['role'],
    password: ['password'], is_active: ['active', 'is_active'],
  };
  for (let c = 1; c < headers.length + 1; c++) {
    for (const [key, aliases] of Object.entries(knownHeaders)) {
      if (aliases.includes(headers[c])) colMap[key] = c;
    }
  }

  if (!colMap.username || !colMap.email) {
    throw new Error('File must have "username" and "email" columns');
  }

  const rows: BulkUserRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const getCell = (key: string) => colMap[key] ? String(row.getCell(colMap[key]).value ?? '').trim() : '';
    rows.push({
      username: getCell('username'),
      email: getCell('email'),
      role: getCell('role') || 'user',
      password: getCell('password') || undefined,
      is_active: getCell('is_active') || undefined,
    });
  });
  return rows;
}

/** Parse a CSV line into fields, handling quoted values. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

/** Parse a CSV buffer into BulkUserRow[]. Throws on format errors. */
function parseCsvFile(buffer: Buffer): BulkUserRow[] {
  const content = buffer.toString('utf-8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replaceAll(/^"|"$/g, ''));
  const usernameIdx = headers.indexOf('username');
  const emailIdx = headers.indexOf('email');
  if (usernameIdx === -1 || emailIdx === -1) {
    throw new Error('CSV must have "username" and "email" columns');
  }

  const roleIdx = headers.indexOf('role');
  const passwordIdx = headers.indexOf('password');
  const activeIdx = headers.findIndex(h => h === 'active' || h === 'is_active');

  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    return {
      username: fields[usernameIdx] ?? '',
      email: fields[emailIdx] ?? '',
      role: (roleIdx >= 0 ? fields[roleIdx] : '') || 'user',
      password: passwordIdx >= 0 ? fields[passwordIdx] || undefined : undefined,
      is_active: activeIdx >= 0 ? fields[activeIdx] || undefined : undefined,
    };
  });
}

/**
 * @openapi
 * /admin/users/import:
 *   post:
 *     summary: Bulk import/update users from CSV or XLSX file
 *     tags: [Admin - Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: CSV or XLSX file with username, email columns
 *     responses:
 *       200:
 *         description: Import results (created, updated, errors)
 *       400:
 *         description: No file or unsupported format
 */
router.post('/import', upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json(errorResponse('No file uploaded', 'validation_error'));
    return;
  }

  const fileName = file.originalname.toLowerCase();
  let rows: BulkUserRow[];

  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    rows = await parseXlsxFile(file.buffer);
  } else if (fileName.endsWith('.csv')) {
    rows = parseCsvFile(file.buffer);
  } else {
    res.status(400).json(errorResponse('Unsupported file format. Use .csv, .xlsx, or .xls', 'validation_error'));
    return;
  }

  rows = rows.filter(r => r.username || r.email);
  if (rows.length === 0) {
    res.status(400).json(errorResponse('No data rows found in file', 'validation_error'));
    return;
  }

  const { audit, ctx } = await getAuditContext(req);
  const result = await bulkCreateOrUpdate(
    await DatabaseService.getInstance(),
    rows,
    req.user!.id,
    audit,
    ctx,
  );

  res.json({ success: true, ...result });
}, { operation: 'userImport' }));

export default router;
