'use client';

import React, { useId } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
} from 'recharts';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

interface DailyActivityChartProps {
  data: { date: string; jobs: number; products: number }[];
}

function trimDate(date: string): string {
  // Convert yyyy-MM-dd to MM-DD
  if (date && date.length >= 10) {
    return date.slice(5, 10);
  }
  return date;
}

export const DailyActivityChart: React.FC<DailyActivityChartProps> = ({ data }) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

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
          Daily Activity
          <InfoTooltip text="Number of scraping jobs and products fetched per day over the selected time range." />
        </div>
        <div role="img" aria-label="Chart: Daily Activity (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No activity data available</p>
        </div>
      </div>
    );
  }

  const chartData = data.map((d) => ({ ...d, date: trimDate(d.date) }));
  const totalJobs = data.reduce((sum, d) => sum + d.jobs, 0);
  const totalProducts = data.reduce((sum, d) => sum + d.products, 0);
  const avgJobs = Math.round(totalJobs / data.length);
  const avgProducts = Math.round(totalProducts / data.length);

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Daily Activity
        <InfoTooltip text="Number of scraping jobs and products fetched per day over the selected time range." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Area chart showing {data.length} days of jobs (avg {formatNumber(avgJobs)}) and products (avg {formatNumber(avgProducts)}).
        </span>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="jobsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-info)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-info)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="productsGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-success)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-success)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="jobs"
              name="Jobs"
              stroke="var(--color-info)"
              strokeWidth={2}
              fill="url(#jobsGradient)"
            />
            <Area
              type="monotone"
              dataKey="products"
              name="Products"
              stroke="var(--color-success)"
              strokeWidth={2}
              fill="url(#productsGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* SR-only data table fallback */}
      <table id={tableId} className="sr-only">
        <caption>Daily Activity — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Jobs</th>
            <th scope="col">Products</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{formatNumber(d.jobs)}</td>
              <td>{formatNumber(d.products)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
