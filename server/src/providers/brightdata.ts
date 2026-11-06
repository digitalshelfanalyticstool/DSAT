import { z } from 'zod';
import { config } from '../config';
import { httpError } from '../utils/async-handler';
import { testBrightDataConnection } from '../services/config-manager';
import { fetchHtml, redactProxyUrl } from '../scrapers/scraping-provider';
import { errorText, keepSecret, maskToken, TEST_TIMEOUT_MS } from './common';
import type { ScrapingProviderModule } from './types';

export const brightdataProvider: ScrapingProviderModule<'brightdata'> = {
  kind: 'brightdata',
  label: 'Bright Data',
  description: 'Web Unlocker for page HTML, rendering JavaScript pages on its side.',
  fields: [
    { key: 'apiKey', label: 'Web Unlocker API key', secret: true },
    { key: 'zone', label: 'Web Unlocker zone', placeholder: 'Zone name from your Bright Data dashboard' },
  ],
  schema: z.object({
    apiKey: z.string().optional(),
    zone: z.string().optional(),
  }),
  rendersRemotely: true,
  billsBandwidth: true,

  secrets: (s) => [s.apiKey],
  // Page fetches go through the Web Unlocker, which needs the key. The words are
  // what the job's failure category is read from ("not configured" → config).
  missingConfig: (s) => (s.apiKey ? undefined : 'BRIGHTDATA_API_KEY is not configured'),
  display: (s) => ({
    apiKey: maskToken(s.apiKey ?? ''),
    zone: s.zone ?? '',
  }),

  merge(fields, stored) {
    const prev = stored.kind === 'brightdata' ? stored : undefined;
    const apiKey = keepSecret(fields.apiKey, prev?.apiKey);
    const zone = fields.zone || undefined;
    if (apiKey && !zone) {
      throw httpError(new Error('Enter the Web Unlocker zone name from your Bright Data dashboard'), 400, 'validation_error');
    }
    return { kind: 'brightdata', apiKey, zone };
  },

  /** Key, then zone (one real Web Unlocker request). */
  async test(s) {
    if (!s.apiKey) return { success: false, message: 'Enter a Web Unlocker API key' };
    const key = await testBrightDataConnection(s.apiKey);
    if (!key.success) return key;
    try {
      const { response } = await fetchHtml(s, config.scrapingProvider.testUrl, {
        timeoutMs: TEST_TIMEOUT_MS,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (!response.ok) return { success: false, message: `Web Unlocker zone "${s.zone}" returned HTTP ${response.status}` };
    } catch (err) {
      return { success: false, message: `Web Unlocker zone "${s.zone}" failed: ${redactProxyUrl(errorText(err))}` };
    }
    return { success: true, message: 'Connection successful' };
  },
};
