import winston from 'winston';
import LokiTransport from 'winston-loki';
import { requestIdStorage } from './request-context';
import { config } from '../config';

// Secrets that live outside env (scraping-provider credentials saved in the DB).
const registeredSecrets = new Set<string>();
// Shorter values would redact ordinary words.
const MIN_SECRET_LENGTH = 8;

/** Add a credential to log redaction. Called when provider settings are loaded. */
export function registerLogSecret(value: string | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) registeredSecrets.add(value);
}

function activeSecrets(): string[] {
  const envToken = config.brightdata.apiKey;
  return envToken ? [envToken, ...registeredSecrets] : [...registeredSecrets];
}

function redactAll(text: string, secrets: string[]): string {
  // split/join: no regex special-character issues
  return secrets.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), text);
}

/**
 * Redacts the BRIGHTDATA_API_KEY and any registered secret from a string.
 */
function redactToken(message: string): string {
  const secrets = activeSecrets();
  return secrets.length === 0 ? message : redactAll(message, secrets);
}

/**
 * Deep-redacts secret values from any object by serializing,
 * replacing, and deserializing. Returns a new object.
 */
function redactObject(obj: unknown): unknown {
  const secrets = activeSecrets();
  if (secrets.length === 0) return obj;
  try {
    return JSON.parse(redactAll(JSON.stringify(obj), secrets));
  } catch {
    return obj;
  }
}

/**
 * Sensitive field names that must never appear in logs.
 * Covers request body fields, database columns, and common aliases.
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'password_hash',
  'currentPassword',
  'newPassword',
  'current_password',
  'new_password',
]);

/**
 * Recursively strip sensitive fields from an object.
 * Returns a new object with password-related fields replaced by '[REDACTED]'.
 */
function redactSensitiveFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitiveFields);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.has(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveFields(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Winston format that injects the current requestId from AsyncLocalStorage.
 * This allows every log entry produced during request handling to include
 * the correlation ID without explicit parameter passing.
 */
const requestIdFormat = winston.format((info) => {
  const requestId = requestIdStorage.getStore();
  if (requestId) {
    info.requestId = requestId;
  }
  return info;
});

/**
 * Winston format that strips password fields from all log entries.
 */
const passwordRedactionFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    if (SENSITIVE_FIELDS.has(key)) {
      info[key] = '[REDACTED]';
    } else if (typeof info[key] === 'object' && info[key] !== null) {
      info[key] = redactSensitiveFields(info[key]);
    }
  }
  return info;
});

/**
 * Winston format that redacts the BRIGHTDATA_API_KEY and registered secrets from all log fields.
 */
const tokenRedactionFormat = winston.format((info) => {
  if (activeSecrets().length === 0) {
    return info;
  }

  // Redact the message
  if (typeof info.message === 'string') {
    info.message = redactToken(info.message);
  }

  // Redact all other fields
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    const val = info[key];
    if (typeof val === 'string') {
      info[key] = redactToken(val);
    } else if (typeof val === 'object' && val !== null) {
      info[key] = redactObject(val);
    }
  }

  return info;
});

const transports: winston.transport[] = [
  new winston.transports.Console(),
];

// Send logs to Loki when LOKI_URL is configured (e.g. http://localhost:3100)
const lokiUrl = config.observability.lokiUrl;
if (lokiUrl) {
  transports.push(
    new LokiTransport({
      host: lokiUrl,
      labels: { app: 'product-scraper' },
      json: true,
      batching: true,
      interval: 5,
      replaceTimestamp: true,
      onConnectionError: (err: Error) => {
         
        console.error('Loki transport error:', err.message);
      },
    }),
  );
}

const baseLogger = winston.createLogger({
  level: config.observability.logLevel,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    requestIdFormat(),
    passwordRedactionFormat(),
    tokenRedactionFormat(),
    winston.format.json(),
  ),
  transports,
});

/**
 * Creates a child logger with a fixed `component` field.
 * Usage:
 *   const logger = createLogger('auth-service');
 *   logger.info('User logged in', { operation: 'login', userId: '123' });
 */
export function createLogger(component: string): winston.Logger {
  return baseLogger.child({ component });
}

export { redactToken, redactObject, redactSensitiveFields };
export default baseLogger;
