/** Helpers shared by the provider modules. */
import { config } from '../config';
import { maskToken } from '../services/credential-manager';
import { fetchHtml, redactProxyUrl, type ProviderSettings } from '../scrapers/scraping-provider';
import type { ProviderTestResult } from './types';

export const TEST_TIMEOUT_MS = 15_000;

export { maskToken };

/** A submitted secret that is blank or still the masked display keeps the stored value. */
export function keepSecret(submitted: string | undefined, stored: string | undefined): string | undefined {
  if (!submitted || (stored && submitted === maskToken(stored))) return stored || undefined;
  return submitted;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch the configured test URL through the provider; report the egress IP when it answers with one. */
export async function testFetch(s: ProviderSettings): Promise<ProviderTestResult> {
  try {
    const { response } = await fetchHtml(s, config.scrapingProvider.testUrl, {
      timeoutMs: TEST_TIMEOUT_MS,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!response.ok) return { success: false, message: `Test request returned HTTP ${response.status}` };
    const text = await response.text();
    let egressIp: string | undefined;
    try {
      egressIp = (JSON.parse(text) as { ip?: string }).ip;
    } catch {
      // The test URL is configurable and need not return JSON.
    }
    return { success: true, message: 'Connection successful', ...(egressIp ? { egressIp } : {}) };
  } catch (err) {
    return { success: false, message: `Connection failed: ${redactProxyUrl(errorText(err))}` };
  }
}
