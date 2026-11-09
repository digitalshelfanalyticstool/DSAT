/**
 * The one place the scraper touches the network. Every page fetch — Web
 * Unlocker-style HTML, xAPI JSON, and pooled browsers — goes through
 * `fetchHtml` or `openBrowser`, dispatched on the admin-chosen provider:
 *
 *  - direct     — plain Chromium / HTTP, optionally through a user proxy
 *  - brightdata — Web Unlocker HTTP API (renders on its side)
 *  - apify      — Apify Proxy as a standard HTTP proxy
 *  - firecrawl  — Firecrawl's /v2/scrape API (hosted, or self-hosted via apiUrl);
 *                 renders on its side, so local browsers launch without a proxy
 *
 * Imports only zero-import leaves (the destination guard), on purpose:
 * settings arrive as an argument, so this module can be imported from
 * anywhere without cycles.
 *
 * Retailer URLs and redirects are untrusted. The direct and proxy paths follow
 * redirects themselves and check every hop with the destination guard; the
 * local browser checks every request it makes.
 */

import { createHash } from 'node:crypto';
import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright-core';
import { Agent, fetch, ProxyAgent, Response, type Dispatcher } from 'undici';
import { assertPublicDestination, publicOnlyLookup } from './destination-guard';

export type ProviderSettings =
  | { kind: 'direct'; proxyUrl?: string }
  | { kind: 'brightdata'; apiKey?: string; zone?: string }
  | { kind: 'apify'; token: string; group: string; country?: string }
  | { kind: 'firecrawl'; apiKey?: string; apiUrl?: string };

export interface HttpFetchOptions {
  timeoutMs: number;
  render?: boolean;
  /** Headers meant for the target site. Bright Data forwards them in its request body. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Bright Data only: ask for the x-brd-debug response header. */
  debug?: boolean;
  /** Bright Data only: connection pool for api.brightdata.com. */
  dispatcher?: Dispatcher;
  /** Hostnames the direct/proxy/browser paths may reach even on a non-public address. */
  allowedPrivateHosts?: readonly string[];
}

export interface HttpFetchResponse {
  response: Response;
  /** The body sent upstream (Bright Data only), for bandwidth accounting. */
  requestBody?: string;
}

export const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';
const APIFY_PROXY_HOST = 'proxy.apify.com:8000';
export const FIRECRAWL_API_URL = 'https://api.firecrawl.dev';
const RENDER_SETTLE_MS = 3_000;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function proxyUrlFor(s: ProviderSettings): string | undefined {
  if (s.kind === 'direct') return s.proxyUrl || undefined;
  if (s.kind === 'apify') {
    const user = s.country ? `groups-${s.group},country-${s.country}` : `groups-${s.group}`;
    return `http://${user}:${encodeURIComponent(s.token)}@${APIFY_PROXY_HOST}`;
  }
  return undefined;
}

const CREDENTIAL_URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):[^@/\s]+@/gi;

export function redactProxyUrl(text: string): string {
  // Function replacer: a password containing `$&` must not be interpreted.
  return text.replace(CREDENTIAL_URL_RE, (_m, scheme: string, user: string) => `${scheme}${user}:[REDACTED]@`);
}

export function fingerprint(s: ProviderSettings): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

function redactError(err: unknown): unknown {
  if (err instanceof Error) {
    err.message = redactProxyUrl(err.message);
    if (err.stack) err.stack = redactProxyUrl(err.stack);
  }
  return err;
}

function playwrightProxy(proxyUrl: string): NonNullable<LaunchOptions['proxy']> {
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.host}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

// One agent per proxy URL — keeps connections alive across requests.
const proxyAgents = new Map<string, ProxyAgent>();
function proxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

// One agent per allowlist; its lookup refuses non-public addresses at connect
// time, so a name that re-resolves inward after the per-hop check still fails.
const guardedAgents = new Map<string, Agent>();
function guardedAgent(allowed: readonly string[] | undefined): Agent {
  const key = (allowed ?? []).join(',');
  let agent = guardedAgents.get(key);
  if (!agent) {
    agent = new Agent({ connect: { lookup: publicOnlyLookup(allowed) } });
    guardedAgents.set(key, agent);
  }
  return agent;
}

/**
 * Fail every browser request (navigation, each redirect hop, subresources) to a
 * non-public destination. Raw CDP Fetch, because Playwright's page.route does
 * not see redirect hops. The browser resolves names itself, so a name that
 * re-resolves inward between check and connect is not caught here.
 */
async function guardBrowserRequests(page: Page, allowed: readonly string[] | undefined): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Fetch.requestPaused', (e) => {
    const check = /^https?:/i.test(e.request.url) ? assertPublicDestination(e.request.url, allowed) : Promise.resolve();
    check.then(
      () => cdp.send('Fetch.continueRequest', { requestId: e.requestId }),
      () => cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }),
    ).catch(() => undefined); // the page closed under us
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

export async function openBrowser(s: ProviderSettings, connectTimeoutMs: number): Promise<Browser> {
  try {
    // Remote-rendering providers (Bright Data, Firecrawl) never reach here from
    // the pipeline; any other caller gets a local browser without a proxy.
    const proxyUrl = proxyUrlFor(s);
    return await chromium.launch({
      headless: true,
      timeout: connectTimeoutMs,
      ...(proxyUrl ? { proxy: playwrightProxy(proxyUrl) } : {}),
    });
  } catch (err) {
    throw redactError(err);
  }
}

/**
 * Render `url` in a page of an already-open browser and return the HTML with the
 * origin's real status (a block page or 404 must not read as success). Closes
 * the page, not the browser, so callers can pool browsers.
 */
export async function renderPage(
  browser: Browser, url: string, timeoutMs: number, signal?: AbortSignal, allowedPrivateHosts?: readonly string[],
): Promise<Response> {
  const aborted = () => Object.assign(new Error('Render aborted'), { name: 'AbortError' });
  // Service workers make requests the page's CDP session cannot see.
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const onAbort = () => { void page.close().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw aborted();
    await guardBrowserRequests(page, allowedPrivateHosts);
    // Retail pages keep long-polling, so networkidle often never arrives; wait
    // for the DOM, then give client-side rendering a moment.
    const nav = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(RENDER_SETTLE_MS);
    return new Response(await page.content(), { status: nav?.status() ?? 502, headers: { 'content-type': 'text/html' } });
  } catch (err) {
    throw signal?.aborted ? aborted() : err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await page.close().catch(() => undefined);
  }
}

/** One-off render with its own browser, for callers without a pool. */
async function renderInBrowser(s: ProviderSettings, url: string, o: HttpFetchOptions): Promise<Response> {
  const browser = await openBrowser(s, o.timeoutMs);
  try {
    return await renderPage(browser, url, o.timeoutMs, o.signal, o.allowedPrivateHosts);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const PRE_OPEN = '<pre';
const PRE_CLOSE = '</pre>';

function decodeHtmlText(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

/**
 * Firecrawl loads URLs in a browser, so a JSON endpoint (the WooCommerce Store
 * API, Shopify's `.js`) can come back as the browser's JSON viewer: the body
 * inside a lone <pre>. Hand adapters the JSON itself; leave real pages alone.
 */
function unwrapBrowserJson(rawHtml: string, contentType: string | undefined): string {
  if (!/json/i.test(contentType ?? '')) return rawHtml;
  const open = rawHtml.indexOf(PRE_OPEN);
  const close = rawHtml.lastIndexOf(PRE_CLOSE);
  if (open === -1 || close < open || rawHtml.indexOf(PRE_OPEN, open + 1) !== -1) return rawHtml;
  const start = rawHtml.indexOf('>', open);
  return start === -1 || start > close ? rawHtml : decodeHtmlText(rawHtml.slice(start + 1, close));
}

interface FirecrawlScrape {
  success?: boolean;
  data?: { rawHtml?: string | null; metadata?: { statusCode?: number; contentType?: string } };
}

async function fetchViaFirecrawl(s: Extract<ProviderSettings, { kind: 'firecrawl' }>, url: string, o: HttpFetchOptions): Promise<Response> {
  // Accept-Encoding is for a direct origin fetch; Firecrawl decodes for us.
  const headers = Object.fromEntries(Object.entries(o.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'accept-encoding'));
  let base = s.apiUrl || FIRECRAWL_API_URL;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const response = await fetch(`${base}/v2/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      url,
      formats: ['rawHtml'],
      onlyMainContent: false,
      maxAge: 0, // never a cached copy: prices and stock must be current
      timeout: o.timeoutMs,
      ...(o.render ? { waitFor: RENDER_SETTLE_MS } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }),
    signal: o.signal,
  });
  if (!response.ok) return new Response(await response.text(), { status: response.status });

  const scrape = (await response.json()) as FirecrawlScrape;
  const rawHtml = scrape.data?.rawHtml;
  if (!scrape.success || typeof rawHtml !== 'string') {
    return new Response('Firecrawl returned no page content', { status: 502 });
  }
  const status = scrape.data?.metadata?.statusCode;
  return new Response(unwrapBrowserJson(rawHtml, scrape.data?.metadata?.contentType), {
    status: status && status >= 200 && status <= 599 ? status : 200,
    headers: { 'content-type': scrape.data?.metadata?.contentType ?? 'text/html' },
  });
}

export async function fetchHtml(s: ProviderSettings, url: string, o: HttpFetchOptions): Promise<HttpFetchResponse> {
  try {
    if (s.kind === 'firecrawl') return { response: await fetchViaFirecrawl(s, url, o) };

    if (s.kind === 'brightdata') {
      const requestBody = JSON.stringify({
        zone: s.zone,
        url,
        format: 'raw',
        ...(o.debug ? { debug: true } : {}),
        ...(o.headers ? { headers: o.headers } : {}),
        ...(o.render ? { render: true } : {}),
      });
      const response = await fetch(BRIGHTDATA_REQUEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${s.apiKey}`,
          'Accept-Encoding': 'gzip, br',
        },
        body: requestBody,
        signal: o.signal,
        dispatcher: o.dispatcher,
      });
      return { response, requestBody };
    }

    // A plain proxy cannot execute JavaScript; render requests need a real browser.
    if (o.render) return { response: await renderInBrowser(s, url, o) };

    // Behind a proxy the proxy resolves names, so only the per-hop check applies.
    const proxyUrl = proxyUrlFor(s);
    const dispatcher = proxyUrl ? proxyAgent(proxyUrl) : guardedAgent(o.allowedPrivateHosts);
    let current = url;
    for (let hop = 0; ; hop++) {
      await assertPublicDestination(current, o.allowedPrivateHosts);
      const response = await fetch(current, {
        headers: { 'User-Agent': DEFAULT_USER_AGENT, ...o.headers },
        signal: o.signal,
        dispatcher,
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return { response };
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
      current = new URL(location, current).toString();
    }
  } catch (err) {
    throw redactError(err);
  }
}
