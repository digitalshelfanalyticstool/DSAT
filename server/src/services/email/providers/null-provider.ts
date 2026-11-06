import type { EmailProvider, SendResult, VerifyResult } from '../types';

export class NullProvider implements EmailProvider {
  readonly kind = 'disabled' as const;

  async send(): Promise<SendResult> {
    return { status: 'skipped', latencyMs: 0 };
  }

  async verify(): Promise<VerifyResult> {
    return { ok: true };
  }
}
