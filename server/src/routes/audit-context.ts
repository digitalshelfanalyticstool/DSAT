import { AuditService } from '../services/audit-service';
import { DatabaseService } from '../services/database';
import type { Request } from 'express';

export interface AuditContext {
  db: DatabaseService;
  audit: AuditService;
  ctx: { ipAddress?: string; userAgent?: string };
}

/** Client IP and user agent for an audit record; unknown values stay null, not placeholders. */
export function auditRequestContext(req: Request): AuditContext['ctx'] {
  return { ipAddress: req.ip ?? undefined, userAgent: req.get('user-agent') };
}

/** Resolve the DB instance, audit service, and request context for audit logging. */
export async function getAuditContext(req: Request): Promise<AuditContext> {
  const db = await DatabaseService.getInstance();
  return { db, audit: new AuditService(db), ctx: auditRequestContext(req) };
}
