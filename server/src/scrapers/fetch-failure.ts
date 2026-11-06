/**
 * Why a page fetch failed, as data rather than as text to be parsed back out
 * of an error message. The fetch layer sets it; retry, permanent-failure and
 * backoff decisions read it.
 *
 * Zero project imports, so
 * pure modules such as site-onboarding can use it without pulling in the
 * browser pool.
 */

export type FetchFailure =
  /** The provider or origin answered with a non-2xx status. */
  | { kind: 'http'; status: number }
  /** Our own request timeout fired. */
  | { kind: 'timeout' }
  /** The active provider is missing a setting it needs; no retry can help. */
  | { kind: 'config' }
  /** Anything else: DNS, TLS, socket, browser connect. */
  | { kind: 'network' };

/** A failed fetch, thrown by callers that want an exception; keeps the typed failure. */
export class FetchError extends Error {
  constructor(message: string, readonly failure?: FetchFailure) {
    super(message);
    this.name = 'FetchError';
  }
}

/** The HTTP status of a failure, or undefined when it wasn't an HTTP answer. */
export function failureStatus(failure: FetchFailure | undefined): number | undefined {
  return failure?.kind === 'http' ? failure.status : undefined;
}

/**
 * Whether a first-pass failure is worth one retry with rendering. Rendering
 * costs several times a plain fetch, so only when the failure is plausibly
 * JavaScript-dependent: 403/503 (anti-bot, transient origin) and our own
 * timeout. Never on 404/410/451 or 429, on config errors, or on unclassified
 * transport errors. `reason` is a short snake_case tag for logs and metrics.
 */
export function shouldRetryWithRender(failure: FetchFailure | undefined): { retry: boolean; reason: string } {
  if (!failure) return { retry: false, reason: 'no_error' };
  switch (failure.kind) {
    case 'config': return { retry: false, reason: 'config_error' };
    case 'timeout': return { retry: true, reason: 'timeout' };
    case 'network': return { retry: false, reason: 'unclassified' };
    case 'http': return { retry: failure.status === 403 || failure.status === 503, reason: `http_${failure.status}` };
  }
}

/**
 * A failure no later retry can fix: 404, 410, 451, or a config error. The
 * next phase skips these instead of paying the render rate again.
 */
export function isPermanentFailure(failure: FetchFailure | undefined): boolean {
  if (failure?.kind === 'config') return true;
  const status = failureStatus(failure);
  return status === 404 || status === 410 || status === 451;
}

/** An anti-bot or rate-limit answer (403, 503, 429) that adaptive backoff should slow down for. */
export function isRateLimitedError(failure: FetchFailure | undefined): boolean {
  const status = failureStatus(failure);
  return status === 403 || status === 503 || status === 429;
}
