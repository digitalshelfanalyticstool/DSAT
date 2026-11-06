'use client';

import React, { useId } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { CostEfficiencyRetailer, CostEfficiencyTrend } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

interface CostEfficiencyProps {
  byRetailer: CostEfficiencyRetailer[];
  trend: CostEfficiencyTrend[];
  loading?: boolean;
}

const TOOLTIP_TEXT = 'Estimated Bright Data cost per scraping job by retailer. Based on bandwidth consumed × configured cost rate. Trend line shows daily cost changes.';

export const CostEfficiency: React.FC<CostEfficiencyProps> = ({ byRetailer, trend, loading = false }) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

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
          Cost Efficiency <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Cost Efficiency (loading)">
          <div className="h-[300px] bg-surface-secondary rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (byRetailer.length === 0 && trend.length === 0) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          Cost Efficiency <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Cost Efficiency (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No cost data available</p>
        </div>
      </div>
    );
  }

  const maxCost = Math.max(...byRetailer.map(r => r.avg_cost_per_job), 0.01);
  const totalJobs = byRetailer.reduce((sum, r) => sum + r.total_jobs, 0);
  const avgCostPerJob =
    totalJobs > 0
      ? byRetailer.reduce((sum, r) => sum + r.avg_cost_per_job * r.total_jobs, 0) / totalJobs
      : 0;

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
        Cost Efficiency <InfoTooltip text={TOOLTIP_TEXT} />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Cost-per-job across {byRetailer.length} retailers (avg ${avgCostPerJob.toFixed(2)}); trend line over {trend.length} days.
        </span>

        {/* Cost per job by retailer (horizontal bars) */}
        {byRetailer.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-ink-muted mb-2">Avg Cost per Job</div>
            <div className="space-y-2">
              {byRetailer.map((r) => {
                const widthPct = Math.max((r.avg_cost_per_job / maxCost) * 100, 2);
                return (
                  <div key={r.site}>
                    <div className="flex justify-between text-xs text-ink-muted mb-0.5">
                      <span className="capitalize">{r.site}</span>
                      <span>${r.avg_cost_per_job.toFixed(2)} ({r.total_jobs} jobs)</span>
                    </div>
                    <div className="w-full bg-surface-tertiary rounded-full h-3 overflow-hidden">
                      <div
                        className="h-3 rounded-full bg-accent transition-all duration-500"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Daily cost trend (line chart) */}
        {trend.length > 0 && (
          <div>
            <div className="text-xs text-ink-muted mb-2">Daily Cost Trend</div>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={trend} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(value: number | string | readonly (string | number)[] | undefined) => [`$${Number(value).toFixed(2)}`, 'Avg Cost/Job']} contentStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="avg_cost_per_job" stroke="var(--color-accent)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      <table id={tableId} className="sr-only">
        <caption>Cost Efficiency — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Section</th>
            <th scope="col">Key</th>
            <th scope="col">Avg Cost/Job</th>
            <th scope="col">Jobs</th>
          </tr>
        </thead>
        <tbody>
          {byRetailer.map((r) => (
            <tr key={`retailer-${r.site}`}>
              <td>By Retailer</td>
              <td>{r.site}</td>
              <td>${r.avg_cost_per_job.toFixed(2)}</td>
              <td>{formatNumber(r.total_jobs)}</td>
            </tr>
          ))}
          {trend.map((t) => (
            <tr key={`trend-${t.date}`}>
              <td>Daily Trend</td>
              <td>{t.date}</td>
              <td>${t.avg_cost_per_job.toFixed(2)}</td>
              <td>—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
