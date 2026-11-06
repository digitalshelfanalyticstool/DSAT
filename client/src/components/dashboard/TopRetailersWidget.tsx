'use client';

import React from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { apiClient } from '@/lib/api-client';
import type { RetailerCostSummary } from '@/lib/api-client';

export const COST_PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
];

interface TopRetailersWidgetProps {
  readonly period?: string;
}

function TopRetailersWidgetBase({ period = 'month' }: TopRetailersWidgetProps) {
  // Refetches whenever `period` changes. The hand-rolled version had no
  // request guard, so switching periods quickly could render whichever
  // response happened to land last rather than the one for the selected
  // period; useAsyncResource drops superseded results.
  const { data, loading } = useAsyncResource(
    async () => {
      const res = await apiClient.getRetailerCosts(period);
      return [...res.data.retailers].sort((a, b) => b.estimatedCost - a.estimatedCost).slice(0, 3);
    },
    { deps: [period] },
  );
  // Errors stay silent: this widget degrades to its empty state.
  const retailers: RetailerCostSummary[] = data ?? [];

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-10 w-full rounded" />)}
      </div>
    );
  }

  if (retailers.every(r => r.estimatedCost === 0)) {
    return <p className="text-sm text-ink-muted py-4 text-center">No cost data for this period</p>;
  }

  return (
    <div className="space-y-3">
      {retailers.map((r) => (
        <div key={r.site} className="flex items-center justify-between p-3 bg-surface-secondary/50 rounded-lg border border-hairline">
          <span className="text-sm font-medium text-ink">{r.site}</span>
          <span className="text-sm font-mono font-semibold text-ink">${r.estimatedCost.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export const TopRetailersWidget = React.memo(TopRetailersWidgetBase);
