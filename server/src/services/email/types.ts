import type { EncryptedEnvelope } from '../secrets';

export type { EncryptedEnvelope };
export type ProviderKind = 'disabled' | 'smtp';

export interface SmtpConfig {
  kind: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  requireTls?: boolean;
}

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromAddress: string;
  fromName?: string;
}

export interface SendResult {
  status: 'sent' | 'skipped' | 'failed';
  messageId?: string;
  error?: string;
  latencyMs: number;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export interface EmailProvider {
  readonly kind: ProviderKind;
  send(input: SendInput): Promise<SendResult>;
  verify(): Promise<VerifyResult>;
}

export interface EmailSettingsRow {
  id: number;
  provider: ProviderKind;
  from_address: string | null;
  from_name: string | null;
  encrypted_credentials: EncryptedEnvelope | null;
  is_enabled: boolean;
  updated_by: number | null;
  updated_at: Date;
}


export interface EmailTemplate {
  slug: string;
  subject: string;
  body_html: string;
  body_text: string;
  variables: string[];
}
