import { z } from 'zod';
import { httpError } from '../utils/async-handler';
import { redactProxyUrl } from '../scrapers/scraping-provider';
import { testFetch } from './common';
import type { ScrapingProviderModule } from './types';

const REDACTED_PASSWORD = '[REDACTED]';

function proxyPassword(proxyUrl: string | undefined): string | undefined {
  if (!proxyUrl) return undefined;
  try {
    return decodeURIComponent(new URL(proxyUrl).password);
  } catch {
    return undefined; // malformed URL: nothing to register
  }
}

export const directProvider: ScrapingProviderModule<'direct'> = {
  kind: 'direct',
  label: 'Direct',
  description: 'Fetch pages with a local browser, optionally through your own HTTP(S) proxy.',
  hint: 'Department stores usually block requests without a proxy. Leave blank only for testing.',
  fields: [{ key: 'proxyUrl', label: 'Proxy URL (optional)', placeholder: 'http://user:pass@proxy.example.com:8080' }],
  schema: z.object({
    proxyUrl: z.string().regex(/^(https?:\/\/\S+)?$/, 'Proxy URL must start with http:// or https://').optional(),
  }),
  rendersRemotely: false,
  billsBandwidth: false,

  secrets: (s) => [proxyPassword(s.proxyUrl)],
  display: (s) => ({ proxyUrl: s.proxyUrl ? redactProxyUrl(s.proxyUrl) : '' }),

  /**
   * Blank means "no proxy". A URL still carrying the redacted password keeps the
   * stored one only for the same user at the same scheme, host and port, so an
   * edited host can't be handed a password the admin never saw.
   */
  merge(fields, stored) {
    const sent = fields.proxyUrl ?? '';
    if (!sent) return { kind: 'direct' };

    const url = new URL(sent);
    if (decodeURIComponent(url.password) !== REDACTED_PASSWORD) return { kind: 'direct', proxyUrl: sent };

    const prev = stored.kind === 'direct' && stored.proxyUrl ? new URL(stored.proxyUrl) : undefined;
    if (!prev?.password || prev.username !== url.username || prev.protocol !== url.protocol || prev.host !== url.host) {
      throw httpError(new Error('Re-enter the proxy password: there is no saved one for this user and host.'), 400, 'validation_error');
    }
    url.password = prev.password;
    return { kind: 'direct', proxyUrl: url.toString().replace(/\/$/, sent.endsWith('/') ? '/' : '') };
  },

  test: testFetch,
};
