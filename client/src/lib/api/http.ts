/**
 * Transport for every API call: the in-memory access token, silent refresh
 * from the httpOnly refresh cookie, the 429 cooldown, JSON parsing and the
 * one authenticated download path. Feature modules (`./jobs`, `./config`, …)
 * build on `http.request` and own their request and response types.
 */

/** Error envelope returned by the API on non-2xx responses. */
interface ApiError {
  success: false;
  error_type: string;
  message: string;
  details?: string;
  timestamp: string;
}

/**
 * The session could not be recovered: a 401 survived a silent refresh. The
 * browser is already on its way to /login, so callers usually stay quiet.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

/** A download answered 410: the file was cleaned up and can be re-exported. */
export class FileExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileExpiredError';
  }
}

type QueryValue = string | number | boolean | null | undefined;

/**
 * `?a=1&b=x` from the entries that are set (not undefined, null or ''), or ''
 * when none are.
 */
export function qs<T extends { [K in keyof T]: QueryValue }>(params?: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {}) as [string, QueryValue][]) {
    if (value !== undefined && value !== null && value !== '') search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as Partial<ApiError>;
  return data.message || fallback;
}

class Http {
  private accessToken: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private rateLimitedUntil = 0;

  constructor(readonly baseUrl: string) {}

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  /**
   * Mint an access token from the httpOnly refresh cookie. Concurrent callers
   * share one in-flight request.
   */
  refresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          this.accessToken = data.token;
          return true;
        }
      } catch {
        // Network error: refresh failed.
      }
      return false;
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  /** JSON request. Throws with the server's message on a non-2xx answer. */
  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const isFormData = options.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers as Record<string, string>),
    };
    const response = await this.fetchAuthed(endpoint, { ...options, headers });
    const data = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error((data as ApiError).message || 'An error occurred');
    }
    return data as T;
  }

  /**
   * GET an authenticated file and hand it to the browser as a download. The
   * filename comes from Content-Disposition when the server sends one.
   * Throws FileExpiredError on 410.
   */
  async download(endpoint: string, fallbackFilename: string): Promise<void> {
    const response = await this.fetchAuthed(endpoint, { method: 'GET' });
    if (response.status === 410) {
      throw new FileExpiredError(await errorMessage(response, 'File has been cleaned up'));
    }
    if (!response.ok) {
      throw new Error(await errorMessage(response, `Download failed (${response.status})`));
    }
    const disposition = response.headers.get('Content-Disposition');
    const match = disposition ? /filename="?([^"]+)"?/.exec(disposition) : null;
    saveBlob(await response.blob(), match?.[1] || fallbackFilename);
  }

  /**
   * The auth-context chokepoint shared by request() and download(): the 429
   * cooldown, the cold-start refresh, and one refresh-and-retry on 401. A
   * 401 that survives that sends the browser to /login and throws
   * SessionExpiredError.
   */
  private async fetchAuthed(endpoint: string, options: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;

    // Block requests while rate limited (prevents a cascade).
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const waitSeconds = Math.ceil((this.rateLimitedUntil - now) / 1000);
      throw new Error(`Rate limited. Please wait ${waitSeconds} seconds before trying again.`);
    }

    // Cold start: the access token lives only in memory, so after a page load
    // the first call would spend a round-trip earning a certain 401. Mint one
    // from the refresh cookie first; refresh() dedupes, so a burst of
    // first-paint requests shares one /auth/refresh. /auth/login has no
    // session to refresh.
    if (!this.accessToken && endpoint !== '/auth/login' && globalThis.window !== undefined) {
      await this.refresh();
    }

    let response = await this.send(url, options);

    // Only a rate limiter's 429 (it sends RateLimit-Reset) starts the global
    // cooldown. Any other 429 is a rule such as the active-job limit: it falls
    // through so request() throws with the server's message.
    const resetHeader = response.status === 429 ? response.headers.get('RateLimit-Reset') : null;
    if (resetHeader) {
      const retryAfter = Number.parseInt(resetHeader, 10) || 60;
      this.rateLimitedUntil = Date.now() + retryAfter * 1000;
      throw new Error(`Too many requests. Please wait ${retryAfter} seconds before trying again.`);
    }

    if (response.status === 401) {
      if (!(await this.refresh())) this.expireSession();
      response = await this.send(url, options);
      if (response.status === 401) this.expireSession();
    }
    return response;
  }

  private send(url: string, options: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    return fetch(url, { ...options, headers, credentials: 'include' });
  }

  private expireSession(): never {
    this.accessToken = null;
    // /setup is the first-run page: nobody is signed in there by design, and
    // /login would bounce straight back to it.
    const path = globalThis.window?.location.pathname ?? '';
    if (globalThis.window !== undefined && !path.startsWith('/login') && !path.startsWith('/setup')) {
      globalThis.window.location.href = '/login?session_expired=true';
    }
    throw new SessionExpiredError();
  }

  /**
   * Parse a Response as JSON, failing loudly when it isn't: an HTML error
   * page (nginx 502, Next.js 404) would otherwise surface as a cryptic
   * `Unexpected token '<'`.
   */
  private async parseJsonResponse(response: Response): Promise<unknown> {
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('json')) {
      const bodyText = await response.text().catch(() => '');
      const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim();
      throw new Error(`Server unavailable (HTTP ${response.status})${snippet ? `: ${snippet}` : ''}`);
    }
    return response.json();
  }
}

export const http = new Http(process.env.NEXT_PUBLIC_API_URL || '/api');
