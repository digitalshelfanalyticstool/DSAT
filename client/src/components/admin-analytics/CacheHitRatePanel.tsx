'use client';

import React from 'react';
import type { CacheHitRateEntry } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';
import { useSiteLabel, useSiteNames } from '@/providers/ConfigProvider';

interface CacheHitRatePanelProps {
  entries: CacheHitRateEntry[];
  loading?: boolean;
}

/** Configured sites first, then any site that only appears in the data. */
function rowSites(configured: string[], fromData: string[]): string[] {
  return [...new Set([...configured, ...fromData])];
}

const HEADER = 'Cache hit rate (last 7 days)';
const TOOLTIP =
  'Cache effectiveness across the three pipeline decision points. Discovery: % of runs that skipped discovery. Variant: % of products served from fresh-TTL cache vs needing fresh fetch. Fill: % of failed products recovered from cached snapshots in Phase 4. Higher = lower Bright Data spend. Tune DISCOVERY_CACHE_TTL_HOURS / VARIANT_CACHE_TTL_HOURS based on these.';

function pct(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function colorFor(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return 'text-ink-muted';
  if (rate >= 0.7) return 'text-emerald-600 font-semibold';
  if (rate >= 0.3) return 'text-amber-600 font-medium';
  return 'text-rose-600';
}

export const CacheHitRatePanel: React.FC<CacheHitRatePanelProps> = ({ entries, loading = false }) => {
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

  const bySite = new Map(entries.map((e) => [e.site, e]));
  const totalRuns = entries.reduce((sum, e) => sum + e.total_runs, 0);

  if (totalRuns === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm">
        <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          {HEADER} <InfoTooltip text={TOOLTIP} />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">
          No scrape runs in the last 7 days.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
          {HEADER} <span className="text-ink-muted">({totalRuns} runs)</span>{' '}
          <InfoTooltip text={TOOLTIP} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-hairline">
              <th className="py-2 pr-4 text-left text-xs font-medium text-ink-muted uppercase">Retailer</th>
              <th className="py-2 px-2 text-right text-xs font-medium text-ink-muted uppercase">Runs</th>
              <th className="py-2 px-2 text-right text-xs font-medium text-ink-muted uppercase">Discovery</th>
              <th className="py-2 px-2 text-right text-xs font-medium text-ink-muted uppercase">Variant</th>
              <th className="py-2 px-2 text-right text-xs font-medium text-ink-muted uppercase">Fill</th>
            </tr>
          </thead>
          <tbody>
            {rowSites(siteNames, entries.map((e) => e.site)).map((site) => {
              const e = bySite.get(site);
              if (!e || e.total_runs === 0) {
                return (
                  <tr key={site} className="border-b border-surface-secondary">
                    <td className="py-2 pr-4 text-ink">{siteLabel(site)}</td>
                    <td className="py-2 px-2 text-right text-ink-muted">—</td>
                    <td className="py-2 px-2 text-right text-ink-muted">—</td>
                    <td className="py-2 px-2 text-right text-ink-muted">—</td>
                    <td className="py-2 px-2 text-right text-ink-muted">—</td>
                  </tr>
                );
              }
              return (
                <tr key={site} className="border-b border-surface-secondary">
                  <td className="py-2 pr-4 text-ink">{siteLabel(site)}</td>
                  <td className="py-2 px-2 text-right text-ink">
                    {formatNumber(e.total_runs)}
                  </td>
                  <td
                    className={`py-2 px-2 text-right ${colorFor(e.discovery_hit_rate)}`}
                    title={`${e.discovery_hits}/${e.total_runs} runs`}
                  >
                    {pct(e.discovery_hit_rate)}
                  </td>
                  <td
                    className={`py-2 px-2 text-right ${colorFor(e.variant_hit_rate)}`}
                    title={`${formatNumber(e.variant_cache_hits)} hits / ${formatNumber(e.variant_cache_misses)} misses`}
                  >
                    {pct(e.variant_hit_rate)}
                  </td>
                  <td
                    className={`py-2 px-2 text-right ${colorFor(e.cache_fill_rate)}`}
                    title={`${formatNumber(e.cache_fill_hits)} filled / ${formatNumber(e.cache_fill_misses)} still missing`}
                  >
                    {pct(e.cache_fill_rate)}
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
