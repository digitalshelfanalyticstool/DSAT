/**
 * Site Change Monitor Service
 *
 * Fingerprinting and diff detection for retail product pages. The fingerprint
 * runs the site's own adapter on the page, so the main signal is the one that
 * matters: would the scraper still read this page? It also records JSON-LD and
 * embedded-product-JSON shape as early warnings.
 *
 * Scheduling and running the monitor live in site-monitor-runner.ts.
 */

import * as crypto from 'node:crypto';
import { findProductJsonInScripts, forEachScriptTag } from '../scrapers/html-utils';
import { getAdapter, type SiteConfig } from '../adapters';

// ─── Types ───────────────────────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export interface StructuralFingerprint {
  jsonLdPresent: boolean;
  jsonLdCount: number;
  productJsonTopKeys: string[];
  /** The site's adapter produced at least one row from the page. */
  extractOk: boolean;
  /** Required fields that were empty in the first extracted row. */
  emptyFields: string[];
}

export interface ChangeDetectionResult {
  changeType: string;
  selectorOrField: string;
  severity: Severity;
  description: string;
  beforeValue: string | null;
  afterValue: string | null;
}

// ─── Severity mapping ────────────────────────────────────────────────

const CHANGE_TYPE_SEVERITY: Record<string, Severity> = {
  extraction_failed: 'critical',
  json_schema_changed: 'critical',
  field_missing: 'warning',
  jsonld_changed: 'warning',
  fetch_error: 'warning',
};

export function getSeverityForChangeType(changeType: string): Severity {
  return CHANGE_TYPE_SEVERITY[changeType] ?? 'info';
}

// ─── Fingerprint extraction ──────────────────────────────────────────

/** Fields a usable row must carry; one going empty is a `field_missing` change. */
const REQUIRED_FIELDS = ['title', 'selling_price', 'image_url'] as const;

function countJsonLdTags(html: string): number {
  let count = 0;
  forEachScriptTag(html, (_content, tagAttributes) => {
    if (tagAttributes.includes('application/ld+json')) count++;
    return undefined;
  });
  return count;
}

/** Extract a fingerprint by running the site's adapter on the page. */
export function extractFingerprint(html: string, site: SiteConfig, url: string): StructuralFingerprint {
  const adapter = getAdapter(site.adapter);
  let rows: ReturnType<typeof adapter.extract> = [];
  try {
    rows = adapter.extract({ url, html, site });
  } catch {
    // An unreadable page is exactly what extractOk records.
  }
  const first = rows[0];
  const jsonLdCount = countJsonLdTags(html);
  const productJson = findProductJsonInScripts(html);

  return {
    jsonLdPresent: jsonLdCount > 0,
    jsonLdCount,
    productJsonTopKeys: productJson ? Object.keys(productJson).sort((a, b) => a.localeCompare(b)) : [],
    extractOk: rows.length > 0,
    emptyFields: first ? REQUIRED_FIELDS.filter((f) => !first[f]) : [],
  };
}

// ─── Fingerprint serialization ───────────────────────────────────────

/**
 * Sort object keys recursively for deterministic serialization.
 */
function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) { // NOSONAR(typescript:S2871): keys are always strings; lexicographic sort is the deterministic-fingerprint contract
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function serializeFingerprint(fp: StructuralFingerprint): string {
  return JSON.stringify(sortKeys(fp));
}

export function deserializeFingerprint(json: string): StructuralFingerprint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid structural fingerprint JSON');
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof p.jsonLdPresent !== 'boolean' ||
    typeof p.jsonLdCount !== 'number' ||
    !Array.isArray(p.productJsonTopKeys) ||
    typeof p.extractOk !== 'boolean' ||
    !Array.isArray(p.emptyFields)
  ) {
    throw new TypeError('Invalid structural fingerprint JSON');
  }
  return parsed as StructuralFingerprint;
}

// ─── Fingerprint comparison ──────────────────────────────────────────

function compareExtraction(baseline: StructuralFingerprint, current: StructuralFingerprint): ChangeDetectionResult[] {
  if (!baseline.extractOk || current.extractOk) return [];
  return [{
    changeType: 'extraction_failed',
    selectorOrField: 'adapter',
    severity: getSeverityForChangeType('extraction_failed'),
    description: "The site's adapter can no longer read this product page",
    beforeValue: 'ok',
    afterValue: 'failed',
  }];
}

function compareEmptyFields(baseline: StructuralFingerprint, current: StructuralFingerprint): ChangeDetectionResult[] {
  return current.emptyFields
    .filter((f) => !baseline.emptyFields.includes(f))
    .map((field) => ({
      changeType: 'field_missing',
      selectorOrField: field,
      severity: getSeverityForChangeType('field_missing'),
      description: `"${field}" is now empty in the extracted product`,
      beforeValue: 'present',
      afterValue: '',
    }));
}

function compareJsonLd(baseline: StructuralFingerprint, current: StructuralFingerprint): ChangeDetectionResult[] {
  if (baseline.jsonLdPresent === current.jsonLdPresent && baseline.jsonLdCount === current.jsonLdCount) {
    return [];
  }
  return [{
    changeType: 'jsonld_changed',
    selectorOrField: 'jsonLd',
    severity: getSeverityForChangeType('jsonld_changed'),
    description: `JSON-LD script tags changed (present: ${baseline.jsonLdPresent}→${current.jsonLdPresent}, count: ${baseline.jsonLdCount}→${current.jsonLdCount})`,
    beforeValue: JSON.stringify({ present: baseline.jsonLdPresent, count: baseline.jsonLdCount }),
    afterValue: JSON.stringify({ present: current.jsonLdPresent, count: current.jsonLdCount }),
  }];
}

function compareJsonKeys(baseline: StructuralFingerprint, current: StructuralFingerprint): ChangeDetectionResult[] {
  const baselineKeys = JSON.stringify(baseline.productJsonTopKeys);
  const currentKeys = JSON.stringify(current.productJsonTopKeys);
  if (baselineKeys === currentKeys) return [];
  return [{
    changeType: 'json_schema_changed',
    selectorOrField: 'productJsonTopKeys',
    severity: getSeverityForChangeType('json_schema_changed'),
    description: `Top-level keys in embedded product JSON changed`,
    beforeValue: baselineKeys,
    afterValue: currentKeys,
  }];
}

export function compareFingerprints(
  baseline: StructuralFingerprint,
  current: StructuralFingerprint,
): ChangeDetectionResult[] {
  return [
    ...compareExtraction(baseline, current),
    ...compareEmptyFields(baseline, current),
    ...compareJsonLd(baseline, current),
    ...compareJsonKeys(baseline, current),
  ];
}

// ─── SHA-256 hashing ─────────────────────────────────────────────────

export function computeHtmlHash(html: string): string {
  return crypto.createHash('sha256').update(html).digest('hex');
}
