import { DatabaseService } from '../database';
import { createLogger } from '../../utils/logger';
import { decrypt, encrypt } from '../secrets';
import { renderTemplate } from './template-renderer';
import { SettingsStore } from '../settings-store';
import { SmtpProvider } from './providers/smtp-provider';
import { NullProvider } from './providers/null-provider';
import type {
  EmailProvider, EmailSettingsRow, EmailTemplate, EncryptedEnvelope,
  ProviderKind, SmtpConfig,
} from './types';

const logger = createLogger('email-service');
const SETTINGS_CACHE_TTL_MS = 30_000;

export interface EmailSettingsForDisplay {
  provider: ProviderKind;
  from_address: string | null;
  from_name: string | null;
  has_credentials: boolean;
  is_enabled: boolean;
  updated_at: string;
  updated_by: number | null;
}

export interface UpdateSettingsInput {
  provider: ProviderKind;
  from_address?: string | null;
  from_name?: string | null;
  smtp_credentials?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    requireTls?: boolean;
  } | null;
  is_enabled?: boolean;
  updated_by: number;
}

export class EmailService {
  private readonly settings = new SettingsStore<EmailSettingsRow, EmailSettingsRow>(
    'email_settings',
    ['id', 'provider', 'from_address', 'from_name', 'encrypted_credentials', 'is_enabled', 'updated_by', 'updated_at'],
    {
      ttlMs: () => SETTINGS_CACHE_TTL_MS,
      parse: (row) => {
        if (!row) throw new Error('email_settings row 1 missing — did migration 42 run?');
        return row;
      },
    },
  );

  constructor(private readonly db: DatabaseService) {}

  private async loadSettings(): Promise<EmailSettingsRow> {
    return this.settings.read(this.db);
  }

  private buildProvider(row: EmailSettingsRow): EmailProvider {
    if (!row.is_enabled || row.provider === 'disabled') {
      return new NullProvider();
    }
    if (row.provider === 'smtp') {
      if (!row.encrypted_credentials) {
        logger.warn('SMTP provider missing credentials; falling back to NullProvider');
        return new NullProvider();
      }
      const creds = decrypt<SmtpConfig>(row.encrypted_credentials);
      return new SmtpProvider({ ...creds, kind: 'smtp' });
    }
    return new NullProvider();
  }

  /** Fetch a template by slug, throws if not found. */
  private async loadTemplate(slug: string): Promise<EmailTemplate> {
    const row = await this.db.get<{
      slug: string;
      subject: string;
      body_html: string;
      body_text: string;
      variables: string[];
    }>(
      `SELECT slug, subject, body_html, body_text, variables
         FROM email_templates WHERE slug = $1`,
      slug,
    );
    if (!row) throw new Error(`email template "${slug}" not found`);
    return {
      slug: row.slug,
      subject: row.subject,
      body_html: row.body_html,
      body_text: row.body_text,
      variables: Array.isArray(row.variables) ? row.variables : [],
    };
  }

  /**
   * Send a templated email. Never throws to the caller — template/render errors
   * are logged to email_log with status='failed' and a successful Promise<SendResult>
   * is returned. A misconfigured email subsystem must not crash a scrape worker.
   */
  async send(
    templateSlug: string,
    to: string,
    vars: Record<string, string>,
  ): Promise<{ status: 'sent' | 'skipped' | 'failed'; error?: string }> {
    const settings = await this.loadSettings();
    const provider = this.buildProvider(settings);

    // Short-circuit when the resolved provider is the NullProvider — no point
    // loading or rendering a template that will never be sent. Writes one
    // email_log row with status='skipped' so audit shows the call happened.
    if (provider.kind === 'disabled') {
      await this.writeLog({
        to_address: to,
        template_slug: templateSlug,
        subject: null,
        provider: settings.provider,
        status: 'skipped',
        message_id: null,
        error: null,
        latency_ms: 0,
      });
      return { status: 'skipped' };
    }

    let rendered: { subject: string; html: string; text: string };
    try {
      const template = await this.loadTemplate(templateSlug);
      rendered = renderTemplate(template, vars);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.writeLog({
        to_address: to,
        template_slug: templateSlug,
        subject: null,
        provider: settings.provider,
        status: 'failed',
        message_id: null,
        error: msg,
        latency_ms: 0,
      });
      return { status: 'failed', error: msg };
    }

    const result = await provider.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      fromAddress: settings.from_address ?? '',
      fromName: settings.from_name ?? undefined,
    });

    await this.writeLog({
      to_address: to,
      template_slug: templateSlug,
      subject: rendered.subject,
      provider: settings.provider,
      status: result.status,
      message_id: result.messageId ?? null,
      error: result.error ?? null,
      latency_ms: result.latencyMs,
    });

    return { status: result.status, error: result.error };
  }

  /** Send a hardcoded test email (used by the admin "Send test" button). */
  async testSend(to: string): Promise<{ status: 'sent' | 'skipped' | 'failed'; error?: string }> {
    const settings = await this.loadSettings();
    const provider = this.buildProvider(settings);
    const result = await provider.send({
      to,
      subject: 'Product Scraper — test email',
      html: '<p>This is a test email from the Product Scraper admin panel.</p><p>If you can read this, outbound mail is working.</p>',
      text: 'This is a test email from the Product Scraper admin panel.\nIf you can read this, outbound mail is working.\n',
      fromAddress: settings.from_address ?? '',
      fromName: settings.from_name ?? undefined,
    });
    await this.writeLog({
      to_address: to,
      template_slug: 'test-send',
      subject: 'Product Scraper — test email',
      provider: settings.provider,
      status: result.status,
      message_id: result.messageId ?? null,
      error: result.error ?? null,
      latency_ms: result.latencyMs,
    });
    return { status: result.status, error: result.error };
  }

  async updateSettings(input: UpdateSettingsInput): Promise<void> {
    // Encrypt only when switching to smtp with fresh credentials. For every
    // other transition (smtp without new creds, or moving off smtp) the
    // stored ciphertext is cleared, so the row never carries stale creds
    // for the wrong provider.
    const encryptedCreds: EncryptedEnvelope | null =
      input.provider === 'smtp' && input.smtp_credentials
        ? encrypt({ ...input.smtp_credentials, kind: 'smtp' })
        : null;
    // is_enabled left undefined keeps the stored value.
    await this.settings.write(this.db, {
      provider: input.provider,
      from_address: input.from_address ?? null,
      from_name: input.from_name ?? null,
      encrypted_credentials: encryptedCreds ? JSON.stringify(encryptedCreds) : null,
      is_enabled: input.is_enabled,
    }, input.updated_by);
  }

  async getSettingsForDisplay(): Promise<EmailSettingsForDisplay> {
    const row = await this.loadSettings();
    return {
      provider: row.provider,
      from_address: row.from_address,
      from_name: row.from_name,
      has_credentials: row.encrypted_credentials !== null,
      is_enabled: row.is_enabled,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      updated_by: row.updated_by,
    };
  }

  async listLog(
    opts: { limit?: number; status?: 'sent' | 'failed' | 'skipped' } = {},
  ): Promise<
    Array<{
      id: number;
      to_address: string;
      template_slug: string | null;
      subject: string | null;
      provider: string;
      status: string;
      message_id: string | null;
      error: string | null;
      latency_ms: number | null;
      sent_at: string;
    }>
  > {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const params: unknown[] = [];
    let where = '';
    if (opts.status) {
      where = 'WHERE status = $1';
      params.push(opts.status);
    }
    const rows = await this.db.all<{
      id: number;
      to_address: string;
      template_slug: string | null;
      subject: string | null;
      provider: string;
      status: string;
      message_id: string | null;
      error: string | null;
      latency_ms: number | null;
      sent_at: Date;
    }>(
      `SELECT id, to_address, template_slug, subject, provider, status,
              message_id, error, latency_ms, sent_at
         FROM email_log ${where}
         ORDER BY sent_at DESC LIMIT ${limit}`,
      ...params,
    );
    return rows.map((r) => ({
      ...r,
      sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at),
    }));
  }

  private async writeLog(entry: {
    to_address: string;
    template_slug: string | null;
    subject: string | null;
    provider: string;
    status: string;
    message_id: string | null;
    error: string | null;
    latency_ms: number;
  }): Promise<void> {
    try {
      await this.db.run(
        `INSERT INTO email_log
           (to_address, template_slug, subject, provider, status, message_id, error, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        entry.to_address,
        entry.template_slug,
        entry.subject,
        entry.provider,
        entry.status,
        entry.message_id,
        entry.error,
        entry.latency_ms,
      );
    } catch (err) {
      logger.warn('Failed to write email_log row', {
        operation: 'writeLog',
        error: (err as Error).message,
      });
    }
  }
}

// Module-level singleton handle — `getEmailService()` memoises the instance
// once DB is available. Per-test code should `new EmailService(mockDb)` directly
// rather than using the singleton, so the 30s cache stays test-isolated.
let _instance: EmailService | null = null;

export async function getEmailService(): Promise<EmailService> {
  if (_instance) return _instance;
  const db = await DatabaseService.getInstance();
  _instance = new EmailService(db);
  return _instance;
}
