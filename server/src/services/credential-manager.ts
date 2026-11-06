import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('credential-manager');

/**
 * Returns the Bright Data API key from config.
 * Never logs or displays the raw key value.
 */
export function getApiToken(): string {
  const token = config.brightdata.apiKey || '';
  if (!token) {
    logger.warn('Bright Data API key is not configured', { operation: 'getApiToken' });
  }
  return token;
}

/**
 * Masks a token for safe display.
 * Shows first 4 and last 4 characters with asterisks in between.
 * Tokens shorter than 10 characters are fully masked.
 */
export function maskToken(token: string): string {
  if (!token || token.length === 0) {
    return '';
  }
  if (token.length < 10) {
    return '****';
  }
  const first = token.slice(0, 4);
  const last = token.slice(-4);
  return `${first}${'*'.repeat(token.length - 8)}${last}`;
}
