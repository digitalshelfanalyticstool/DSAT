/**
 * Encryption for credentials stored in the database: SMTP, scraping provider,
 * SSO client secret and webhook signing secrets.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;
const HEX_KEY_LENGTH = 64; // 32 bytes encoded as hex

/** AES-256-GCM ciphertext as stored in JSONB columns. */
export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

function loadKey(): Buffer {
  const raw = config.secrets.encryptionKey ?? '';
  if (raw.length !== HEX_KEY_LENGTH || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      'EMAIL_CONFIG_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(raw, 'hex');
}

export function encrypt(plaintext: unknown): EncryptedEnvelope {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const serialized = JSON.stringify(plaintext);
  const ct = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decrypt<T = unknown>(envelope: EncryptedEnvelope): T {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${(envelope as { v: number }).v}`);
  }
  const key = loadKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid auth tag length');
  // Pin the GCM auth-tag length: rejects truncated-tag forgery attempts at the
  // cipher layer (defense-in-depth alongside the explicit tag.length check above).
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  const ct = Buffer.from(envelope.ct, 'base64');
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as T;
}
