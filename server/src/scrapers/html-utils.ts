/**
 * Shared HTML parsing and formatting utilities for scraper adapters.
 *
 * Centralizes formatPrice, cleanDescription and script-tag extraction so each
 * adapter doesn't duplicate them.
 */

/**
 * Strips all HTML tags from a string: each `<` through the next `>` goes, and a
 * `<` with no `>` after it is kept with the rest of the text. Same output as
 * looping `replace(/<[^>]*>/g, '')`, but a linear scan: that regex rescanned to
 * the end of the string from every unclosed `<`, quadratic on retailer input.
 * One pass is enough, since the only `<` it leaves has no `>` after it.
 */
function stripHtmlTags(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    const gt = lt === -1 ? -1 : text.indexOf('>', lt + 1);
    if (gt === -1) return out + text.slice(i);
    out += text.slice(i, lt);
    i = gt + 1;
  }
}

/**
 * Formats a price value as a string with exactly 2 decimal places.
 * Handles numbers, numeric strings, null/undefined.
 * Returns empty string for invalid values.
 */
export function formatPrice(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (Number.isNaN(num) || !Number.isFinite(num)) return '';
  return num.toFixed(2);
}

/**
 * Strips HTML tags and trims a description string, truncating to maxLength.
 */
export function cleanDescription(raw: unknown, maxLength = 2000): string {
  if (raw === null || raw === undefined) return '';
  const text = stripHtmlTags(String(raw)).trim();
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}


/**
 * Iterates over `<script>` tags in HTML using indexOf-based extraction.
 * Avoids regex-based HTML parsing pitfalls flagged by static analysis (CodeQL).
 *
 * Calls `visitor(content, tagAttributes)` for each script tag found.
 * - `content`: the text between `<script...>` and `</script>`
 * - `tagAttributes`: the full opening tag string (e.g. `<script type="application/ld+json">`)
 *
 * If the visitor returns a truthy value, iteration stops and that value is returned.
 */
export function forEachScriptTag<T>(
  html: string,
  visitor: (content: string, tagAttributes: string) => T | undefined,
): T | undefined {
  let searchStart = 0;
  while (searchStart < html.length) {
    const openIdx = html.indexOf('<script', searchStart);
    if (openIdx === -1) break;
    const tagEnd = html.indexOf('>', openIdx);
    if (tagEnd === -1) break;
    const closeIdx = html.indexOf('</script>', tagEnd + 1);
    if (closeIdx === -1) break;

    const tagAttributes = html.substring(openIdx, tagEnd + 1);
    const content = html.substring(tagEnd + 1, closeIdx).trim();
    searchStart = closeIdx + 9; // length of '</script>'

    const result = visitor(content, tagAttributes);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * Scans all `<script>` tags in HTML for a JSON object containing product-related keys.
 * Returns the parsed object if found, otherwise undefined.
 */
export function findProductJsonInScripts(html: string): object | undefined {
  return forEachScriptTag(html, (content) => {
    // First '{' to the last '}' within 1 MB of it, at least 10 chars apart: the
    // span the old greedy regex matched, found in linear time. That regex
    // backtracked quadratically on a run of '{' with no '}' after it.
    const start = content.indexOf('{');
    if (start === -1) return undefined;
    const end = content.lastIndexOf('}', start + 1_000_001);
    if (end - start - 1 < 10) return undefined;
    try {
      const parsed = JSON.parse(content.slice(start, end + 1));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed.variants || parsed.product || parsed.styleId || parsed.style_id ||
         parsed.productId || parsed.colors || parsed.sizes || parsed.skulists ||
         parsed.contentData || parsed.skus)
      ) {
        return parsed as object;
      }
    } catch {
      // Not valid JSON, continue
    }
    return undefined;
  });
}

const PRODUCT_TYPES = new Set(['Product', 'ProductGroup']);

function isProductNode(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return false;
  const type = (node as { '@type'?: unknown })['@type'];
  return Array.isArray(type) ? type.some((t) => PRODUCT_TYPES.has(t)) : PRODUCT_TYPES.has(type as string);
}

/**
 * Every schema.org `Product`/`ProductGroup` node across all JSON-LD blocks,
 * in page order. Flattens top-level arrays and `@graph`; skips other types.
 */
export function findJsonLdProducts(html: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  forEachScriptTag(html, (content, tagAttributes) => {
    if (!tagAttributes.includes('application/ld+json')) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      const graph = (node as { '@graph'?: unknown } | null)?.['@graph'];
      for (const n of Array.isArray(graph) ? graph : [node]) {
        if (isProductNode(n)) found.push(n);
      }
    }
    return undefined;
  });
  return found;
}
