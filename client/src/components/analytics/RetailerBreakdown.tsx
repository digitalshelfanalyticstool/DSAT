'use client';

import React, { useId } from 'react';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';
import { useSiteLabel } from '@/providers/ConfigProvider';

interface RetailerBreakdownProps {
  data: { site: string; job_count: number; product_count: number }[];
}

const RETAILER_COLORS = [
  'var(--color-error)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-violet)',
];

export const RetailerBreakdown: React.FC<RetailerBreakdownProps> = ({ data }) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();
  const siteLabel = useSiteLabel();

  // S6819 (each <div role="group"> below): role="group" + aria-labelledby
  // [+ aria-describedby] is the labeled-group semantic. <fieldset> would
  // require neutralizing UA defaults (border, padding, min-width:min-content,
  // legend float quirks) — defeating the semantic improvement; the header
  // includes an interactive <InfoTooltip> that fights <legend>'s inline-flow
  // contract. <details>/<optgroup>/<address> don't fit.
  if (!data || data.length === 0) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
          Retailer Breakdown
          <InfoTooltip text="Number of jobs and products fetched per retailer over the selected time range." />
        </div>
        <div role="img" aria-label="Chart: Retailer Breakdown (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No retailer data available</p>
        </div>
      </div>
    );
  }

  const maxJobs = Math.max(...data.map((d) => d.job_count), 1);
  const totalJobs = data.reduce((sum, d) => sum + d.job_count, 0);
  const totalProducts = data.reduce((sum, d) => sum + d.product_count, 0);

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Retailer Breakdown
        <InfoTooltip text="Number of jobs and products fetched per retailer over the selected time range." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Bar chart of {data.length} retailers totaling {formatNumber(totalJobs)} jobs and {formatNumber(totalProducts)} products.
        </span>
        <div className="space-y-3">
          {data.map((item, i) => {
            const pct = Math.round((item.job_count / maxJobs) * 100);
            const color = RETAILER_COLORS[i % RETAILER_COLORS.length];
            const label = siteLabel(item.site);

            return (
              <div key={item.site}>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-medium text-ink">{label}</span>
                  <div className="flex items-center gap-3 text-xs text-ink-muted">
                    <span>{item.job_count} jobs</span>
                    <span>{formatNumber(item.product_count)} products</span>
                  </div>
                </div>
                <div className="w-full bg-surface-tertiary rounded-full h-2.5">
                  <div
                    className="h-2.5 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Retailer Breakdown — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Retailer</th>
            <th scope="col">Jobs</th>
            <th scope="col">Products</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item) => {
            const label = siteLabel(item.site);
            return (
              <tr key={item.site}>
                <td>{label}</td>
                <td>{formatNumber(item.job_count)}</td>
                <td>{formatNumber(item.product_count)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
