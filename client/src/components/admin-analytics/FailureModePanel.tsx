'use client';

import React from 'react';
import type { FailureModeEntry } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';
import { useSiteLabel, useSiteNames } from '@/providers/ConfigProvider';

interface FailureModePanelProps {
  failures: FailureModeEntry[];
  loading?: boolean;
}

const CATEGORIES = [
  { key: 'bd_quota', label: 'BD Quota' },
  { key: 'network', label: 'Network' },
  { key: 'db_error', label: 'DB' },
  { key: 'retailer_changed', label: 'Retailer Changed' },
  { key: 'config', label: 'Config' },
  { key: 'other', label: 'Other' },
] as const;

/** Configured sites first, then any site that only appears in the data. */
function rowSites(configured: string[], fromData: string[]): string[] {
  return [...new Set([...configured, ...fromData])];
}

const TOOLTIP =
  'Failed scrape jobs in the last 7 days, grouped by retailer and failure category. Transient (BD Quota, Network) vs structural (Retailer Changed, DB, Config). Empty cells mean zero — a healthy operational state.';

const HEADER = 'Failures (last 7 days)';

function buildMatrix(failures: FailureModeEntry[]): {
  cell: (site: string, category: string) => number;
  rowTotal: (site: string) => number;
  grandTotal: number;
} {
  const map = new Map<string, number>();
  for (const f of failures) {
    map.set(`${f.site}::${f.failure_category}`, (map.get(`${f.site}::${f.failure_category}`) ?? 0) + f.count);
  }
  const cell = (site: string, category: string): number => map.get(`${site}::${category}`) ?? 0;
  const rowTotal = (site: string): number =>
    CATEGORIES.reduce((sum, c) => sum + cell(site, c.key), 0);
  const grandTotal = failures.reduce((sum, f) => sum + f.count, 0);
  return { cell, rowTotal, grandTotal };
}

export const FailureModePanel: React.FC<FailureModePanelProps> = ({ failures, loading = false }) => {
  const siteNames = useSiteNames();
  const siteLabel = useSiteLabel();
  if (loading) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm">
        <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          {HEADER} <InfoTooltip text={TOOLTIP} />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-8 bg-surface-secondary rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const { cell, rowTotal, grandTotal } = buildMatrix(failures);

  if (grandTotal === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm">
        <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          {HEADER} <InfoTooltip text={TOOLTIP} />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">
          No failures in the last 7 days.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
          {HEADER} <span className="text-ink-muted">({grandTotal})</span>{' '}
          <InfoTooltip text={TOOLTIP} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-hairline">
              <th className="py-2 pr-4 text-left text-xs font-medium text-ink-muted uppercase">Retailer</th>
              {CATEGORIES.map((c) => (
                <th key={c.key} className="py-2 px-2 text-right text-xs font-medium text-ink-muted uppercase">
                  {c.label}
                </th>
              ))}
              <th className="py-2 pl-2 text-right text-xs font-medium text-ink-muted uppercase">Total</th>
            </tr>
          </thead>
          <tbody>
            {rowSites(siteNames, failures.map((f) => f.site)).map((site) => {
              const total = rowTotal(site);
              return (
                <tr key={site} className="border-b border-surface-secondary">
                  <td className="py-2 pr-4 text-ink">{siteLabel(site)}</td>
                  {CATEGORIES.map((c) => {
                    const n = cell(site, c.key);
                    return (
                      <td key={c.key} className="py-2 px-2 text-right">
                        {n === 0 ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          <span className="font-medium text-red-600">{formatNumber(n)}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="py-2 pl-2 text-right">
                    {total === 0 ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="font-semibold text-ink">{formatNumber(total)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
