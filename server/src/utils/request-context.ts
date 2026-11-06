/**
 * Request-scoped context — leaf module.
 *
 * Owns the AsyncLocalStorage instance that carries the current request ID
 * across async boundaries. It lives here, not in middleware/request-id.ts, so
 * the logger (utils layer) never imports from the middleware layer.
 *
 * This module has zero project imports, so it can never participate in an
 * import cycle. Node's module cache guarantees a single AsyncLocalStorage
 * instance shared by the middleware (writer) and the logger (reader).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** AsyncLocalStorage instance that holds the current request ID */
export const requestIdStorage = new AsyncLocalStorage<string>();
