import type { EmailProvider, SendInput, SendResult, SmtpConfig, VerifyResult } from '../types';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('email/smtp-provider');

// Module-level type only — runtime imports happen inside ensureTransporter().
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type NodemailerModule = typeof import('nodemailer');
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Transporter = ReturnType<NodemailerModule['createTransport']>;

export class SmtpProvider implements EmailProvider {
  readonly kind = 'smtp' as const;

  private transporterPromise: Promise<Transporter> | null = null;

  constructor(private readonly config: SmtpConfig) {}

  private async ensureTransporter(): Promise<Transporter> {
    if (this.transporterPromise) return this.transporterPromise;
    this.transporterPromise = (async () => {
      const nodemailer = (await import('nodemailer')) as NodemailerModule;
      const auth = this.config.user && this.config.password
        ? { user: this.config.user, pass: this.config.password }
        : undefined;
      return nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        requireTLS: this.config.requireTls,
        auth,
      });
    })();
    this.transporterPromise.catch(() => {
      this.transporterPromise = null;
    });
    return this.transporterPromise;
  }

  async send(input: SendInput): Promise<SendResult> {
    const start = Date.now();
    try {
      const transporter = await this.ensureTransporter();
      const info = await transporter.sendMail({
        from: input.fromName ? `"${input.fromName}" <${input.fromAddress}>` : input.fromAddress,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
      return { status: 'sent', messageId: info.messageId, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('SMTP send failed', {
        operation: 'send',
        error: msg,
        to: input.to,
      });
      return { status: 'failed', error: msg, latencyMs: Date.now() - start };
    }
  }

  async verify(): Promise<VerifyResult> {
    try {
      const transporter = await this.ensureTransporter();
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
