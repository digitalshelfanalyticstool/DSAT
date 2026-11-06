import { z } from 'zod';
import { httpError } from '../utils/async-handler';
import { keepSecret, maskToken, testFetch } from './common';
import type { ScrapingProviderModule } from './types';

export const apifyProvider: ScrapingProviderModule<'apify'> = {
  kind: 'apify',
  label: 'Apify Proxy',
  description: 'Route requests through Apify Proxy (proxy.apify.com).',
  fields: [
    { key: 'token', label: 'Apify API token', secret: true },
    { key: 'group', label: 'Proxy group', placeholder: 'RESIDENTIAL', default: 'RESIDENTIAL' },
    { key: 'country', label: 'Country (optional)', placeholder: 'US' },
  ],
  schema: z.object({
    token: z.string().optional(),
    group: z.string().regex(/^[A-Z0-9_]+$/, 'Proxy group must be letters, digits or _ (e.g. RESIDENTIAL)').optional(),
    country: z.string().regex(/^([A-Z]{2})?$/, 'Country must be a 2-letter code (e.g. US)').optional(),
  }),
  rendersRemotely: false,
  billsBandwidth: false,

  secrets: (s) => [s.token],
  display: (s) => ({ token: maskToken(s.token), group: s.group, country: s.country ?? '' }),

  merge(fields, stored) {
    const token = keepSecret(fields.token, stored.kind === 'apify' ? stored.token : undefined);
    if (!token) throw httpError(new Error('Apify API token is required'), 400, 'validation_error');
    const country = fields.country || undefined;
    return { kind: 'apify', token, group: fields.group || 'RESIDENTIAL', ...(country ? { country } : {}) };
  },

  test: testFetch,
};
