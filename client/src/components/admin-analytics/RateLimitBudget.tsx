'use client';

import React from 'react';
import type { RateLimitInfo } from '@/lib/api-client';
import { ChartCard } from '@/components/ui/ChartCard';
import { formatNumber } from '@/lib/format';

interface RateLimitBudgetProps {
  retailers: RateLimitInfo[];
  loading?: boolean;
}

function getLimitColor(pct: number): string {
  if (pct > 80) return 'bg-red-500';
  if (pct > 60) return 'bg-amber-500';
  return 'bg-emerald-500';
}

const TOOLTIP_TEXT = 'Concurrent scrape slots in use per retailer, across all workers, vs the configured maximum (RATE_LIMIT_MAX_CONCURRENT). Green < 60%, amber 60–80%, red > 80%.';

export const RateLimitBudget: React.FC<RateLimitBudgetProps> = ({ retailers, loading = false }) => {
  const maxPct = Math.max(...retailers.map((r) => r.pct_used), 0);

  return (
    <ChartCard
      title="Scrape Slots"
      tooltip={TOOLTIP_TEXT}
      loading={loading}
      loadingSkeleton={
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-6 bg-surface-tertiary rounded animate-pulse" />
          ))}
        </div>
      }
      isEmpty={retailers.length === 0}
      emptyMessage="No scrape slot data"
      summary={
        <>
          Bar chart of scrape slots in use across {retailers.length} retailers (peak {Math.round(maxPct)}%).
        </>
      }
      tableContent={
        <>
          <thead>
            <tr>
              <th scope="col">Retailer</th>
              <th scope="col">In Use</th>
              <th scope="col">Max Concurrent</th>
              <th scope="col">Usage</th>
            </tr>
          </thead>
          <tbody>
            {retailers.map((r) => (
              <tr key={r.site}>
                <td>{r.site}</td>
                <td>{formatNumber(r.in_use)}</td>
                <td>{formatNumber(r.max_concurrent)}</td>
                <td>{Math.round(r.pct_used)}%</td>
              </tr>
            ))}
          </tbody>
        </>
      }
    >
      <div className="space-y-3">
        {retailers.map((r) => (
          <div key={r.site}>
            <div className="flex justify-between text-xs text-ink-muted mb-1">
              <span className="font-medium capitalize">{r.site}</span>
              <span>{formatNumber(r.in_use)} / {formatNumber(r.max_concurrent)}</span>
            </div>
            <div className="w-full bg-surface-tertiary rounded-full h-3 overflow-hidden">
              <div
                className={`h-3 rounded-full transition-all duration-500 ${getLimitColor(r.pct_used)}`}
                style={{ width: `${Math.min(r.pct_used, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
};
