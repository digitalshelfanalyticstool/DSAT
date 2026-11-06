import { z } from 'zod';
import { httpError } from '../utils/async-handler';
import { keepSecret, maskToken, testFetch } from './common';
import type { ScrapingProviderModule } from './types';

export const firecrawlProvider: ScrapingProviderModule<'firecrawl'> = {
  kind: 'firecrawl',
  label: 'Firecrawl',
  description: 'Fetch and render pages through the Firecrawl API (firecrawl.dev), or your own self-hosted Firecrawl.',
  fields: [
    { key: 'apiKey', label: 'Firecrawl API key', secret: true, placeholder: 'fc-…' },
    { key: 'apiUrl', label: 'API URL (optional, for self-hosted)', placeholder: 'https://api.firecrawl.dev' },
  ],
  schema: z.object({
    apiKey: z.string().optional(),
    // Blank means Firecrawl's hosted API; a self-hosted instance is often plain http on the LAN.
    apiUrl: z.string().regex(/^(https?:\/\/[^\s/]+(\/\S*)?)?$/, 'API URL must start with http:// or https://').optional(),
  }),
  rendersRemotely: true,
  billsBandwidth: false,

  secrets: (s) => [s.apiKey],
  display: (s) => ({ apiKey: maskToken(s.apiKey ?? ''), apiUrl: s.apiUrl ?? '' }),

  /** The hosted API needs a key; a self-hosted instance (apiUrl set) may not. A key is never sent to a new URL unseen. */
  merge(fields, stored) {
    const prev = stored.kind === 'firecrawl' ? stored : undefined;
    const apiUrl = fields.apiUrl || undefined;
    const apiKey = keepSecret(fields.apiKey, apiUrl === prev?.apiUrl ? prev?.apiKey : undefined);
    if (!apiKey && !apiUrl) throw httpError(new Error('Firecrawl API key is required'), 400, 'validation_error');
    return { kind: 'firecrawl', ...(apiKey ? { apiKey } : {}), ...(apiUrl ? { apiUrl } : {}) };
  },

  test: testFetch,
};
