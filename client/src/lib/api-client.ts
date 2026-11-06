/**
 * The one object pages and components call the API through.
 *
 * Each feature module under `./api/` owns its endpoints and their request and
 * response types; this file only composes them. Add an endpoint to its
 * feature module, not here. Transport (auth, refresh, 429, downloads) lives
 * in `./api/http`.
 *
 * Kept as a single facade so tests can mock one module
 * (`vi.mock('@/lib/api-client', () => ({ apiClient: { … } }))`) and so the
 * eslint cache-bypass rule can match `apiClient.getSession()` and friends.
 */
import { authApi } from './api/auth';
import { jobsApi } from './api/jobs';
import { configApi } from './api/config';
import { alertsApi } from './api/alerts';
import { usersApi } from './api/users';
import { messagesApi } from './api/messages';
import { emailApi } from './api/email';
import { analyticsApi } from './api/analytics';
import { brightdataApi } from './api/brightdata';
import { systemApi } from './api/system';
import { siteMonitorApi } from './api/site-monitor';

export type * from './api/auth';
export type * from './api/jobs';
export type * from './api/config';
export type * from './api/alerts';
export type * from './api/users';
export type * from './api/messages';
export type * from './api/email';
export type * from './api/analytics';
export type * from './api/brightdata';
export type * from './api/system';
export type * from './api/site-monitor';
export { SessionExpiredError, FileExpiredError } from './api/http';

export const apiClient = {
  ...authApi,
  ...jobsApi,
  ...configApi,
  ...alertsApi,
  ...usersApi,
  ...messagesApi,
  ...emailApi,
  ...analyticsApi,
  ...brightdataApi,
  ...systemApi,
  ...siteMonitorApi,
};
