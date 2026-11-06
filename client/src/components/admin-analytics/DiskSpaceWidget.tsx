'use client';

import React, { useId } from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { apiClient } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import type { DiskCategory, DiskInfo } from '@/lib/api-client';
import { formatBytes } from '@/lib/format';

const TOOLTIP_TEXT =
  'Server disk usage with per-category breakdown. Warning appears when available space drops below 25%. Excel reports are cleaned up automatically after the retention window shown in the Excel Reports table; use the Excel Reports table below to remove specific files manually.';

// Stable colors per category — must match the legend swatches. Muted grey for
// "other" keeps the user's eye on actionable buckets (excels) without lying
// about the unaccounted bytes.
const CATEGORY_COLORS: Record<DiskCategory['name'], string> = {
  excels:        'bg-sky-500',
  variant_cache: 'bg-violet-500',
  logs:          'bg-amber-500',
  other:         'bg-slate-300',
};

export const DiskSpaceWidget: React.FC = () => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();
  // Errors stay silent: the widget degrades to its empty state.
  const { data: disk, loading } = useAsyncResource<DiskInfo>(
    async () => (await apiClient.getDiskSpace()).disk,
  );

  // S6819 (each <div role="group"> below): role="group" + aria-labelledby
  // [+ aria-describedby] is the labeled-group semantic. <fieldset> would
  // require neutralizing UA defaults (border, padding, min-width:min-content,
  // legend float quirks) — defeating the semantic improvement; the header
  // includes an interactive <InfoTooltip> that fights <legend>'s inline-flow
  // contract. <details>/<optgroup>/<address> don't fit.
  if (loading) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          Disk Space <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Disk Space (loading)">
          <div className="space-y-3">
            <div className="h-6 bg-surface-tertiary rounded animate-pulse" />
            <div className="h-4 bg-surface-tertiary rounded animate-pulse w-1/2" />
            <div className="h-16 bg-surface-tertiary rounded animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (!disk) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          Disk Space <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Disk Space (no data available)">
          <p className="text-sm text-ink-muted text-center py-4">Unable to retrieve disk space</p>
        </div>
      </div>
    );
  }

  // Render the categories in a stable, useful order: actionable buckets first,
  // then variant cache, then logs, then "other" trailing in muted grey.
  const orderedCats = [...(disk.categories ?? [])].sort((a, b) => {
    const rank = (c: DiskCategory) => ({ excels: 0, variant_cache: 1, logs: 2, other: 3 }[c.name]);
    return rank(a) - rank(b);
  });

  return (
    <div
      className={`bg-surface rounded-xl p-4 border shadow-sm ${disk.warning ? 'border-amber-300' : 'border-hairline'}`}
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
        Disk Space <InfoTooltip text={TOOLTIP_TEXT} />
        {disk.warning && (
          <span className="ml-auto text-xs font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Low Space</span>
        )}
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Disk usage at {disk.used_percent}% ({disk.used_gb} GB of {disk.total_gb} GB), broken down by file category.
        </span>

        {/* Overall usage line */}
        <div className="flex justify-between text-xs text-ink-muted mb-1.5">
          <span className="font-medium">Storage</span>
          <span>{disk.used_gb} GB / {disk.total_gb} GB</span>
        </div>

        {/* Stacked horizontal bar — each segment is a category, widths sum to used_percent */}
        <div
          className="w-full bg-surface-tertiary rounded-full h-3 overflow-hidden flex"
          aria-hidden="true"
        >
          {orderedCats.map((cat) => {
            const widthPct = (cat.bytes / (disk.total_gb * 1_073_741_824)) * 100;
            if (widthPct < 0.1) return null;
            return (
              <div
                key={cat.name}
                className={`h-3 ${CATEGORY_COLORS[cat.name]} transition-all duration-500`}
                style={{ width: `${widthPct}%` }}
                title={`${cat.label}: ${formatBytes(cat.bytes)} (${cat.percent_of_used}% of used)`}
              />
            );
          })}
        </div>

        <div className="flex justify-between text-xs text-ink-muted mt-2 mb-3">
          <span>{disk.available_gb} GB available ({disk.available_percent}%)</span>
          <span>{disk.used_percent}% used</span>
        </div>

        {/* Category legend */}
        <div className="border-t border-hairline pt-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-muted mb-2 font-medium">Breakdown by category</div>
          <ul className="space-y-1.5">
            {orderedCats.map((cat) => (
              <li
                key={cat.name}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className={`inline-block w-3 h-3 rounded-sm ${CATEGORY_COLORS[cat.name]} flex-shrink-0`}
                  aria-hidden="true"
                />
                <span className="text-ink-muted flex-1">{cat.label}</span>
                {cat.count !== undefined && (
                  <span className="text-ink-muted/70 tabular-nums">{cat.count} files</span>
                )}
                <span className="font-medium tabular-nums text-ink">{formatBytes(cat.bytes)}</span>
                <span className="text-ink-muted/70 tabular-nums w-12 text-right">{cat.percent_of_used}%</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Hidden tabular data for screen readers */}
      <table id={tableId} className="sr-only">
        <caption>Disk Space — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Total</td><td>{disk.total_gb} GB</td></tr>
          <tr><td>Used</td><td>{disk.used_gb} GB ({disk.used_percent}%)</td></tr>
          <tr><td>Available</td><td>{disk.available_gb} GB ({disk.available_percent}%)</td></tr>
          {orderedCats.map((cat) => (
            <tr key={cat.name}>
              <td>{cat.label}</td>
              <td>{formatBytes(cat.bytes)} ({cat.percent_of_used}% of used)</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
