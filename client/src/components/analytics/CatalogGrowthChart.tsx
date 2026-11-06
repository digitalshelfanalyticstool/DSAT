'use client';

import React, { useId } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

interface CatalogGrowthChartProps {
  data: { date: string; cumulative_products: number; new_products: number }[];
}

function trimDate(date: string): string {
  if (date && date.length >= 10) {
    return date.slice(5, 10);
  }
  return date;
}

export const CatalogGrowthChart: React.FC<CatalogGrowthChartProps> = ({ data }) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

  // S6819 (applied to each <div role="group"> in this chart-card scaffold):
  // role="group" + aria-labelledby [+ aria-describedby] is the labeled-group
  // semantic. <fieldset> would require neutralizing every UA default (border,
  // padding, min-width:min-content, <legend> float quirks) on every render
  // path, defeating the semantic improvement; the header includes an
  // interactive <InfoTooltip> trigger that fights <legend>'s inline-flow
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
          Catalog Growth
          <InfoTooltip text="Cumulative unique products discovered over time. Shows how the product catalog has grown." />
        </div>
        <div role="img" aria-label="Chart: Catalog Growth (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No catalog data available</p>
        </div>
      </div>
    );
  }

  const chartData = data.map((d) => ({ ...d, date: trimDate(d.date) }));
  const totalProducts = data.length > 0 ? data.at(-1)?.cumulative_products ?? 0 : 0;
  const startProducts = data[0].cumulative_products;
  const growth = totalProducts - startProducts;

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Catalog Growth
        <InfoTooltip text="Cumulative unique products discovered over time. Shows how the product catalog has grown." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Area chart showing cumulative product count growth from {formatNumber(startProducts)} to {formatNumber(totalProducts)} ({formatNumber(growth)} new) over {data.length} days.
        </span>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="catalogGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-violet)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--color-violet)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
            <Area
              type="monotone"
              dataKey="cumulative_products"
              name="Total Products"
              stroke="var(--color-violet)"
              strokeWidth={2}
              fill="url(#catalogGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-ink-muted mt-2 text-center">
        Total catalog size: <span className="font-semibold text-ink">{formatNumber(totalProducts)}</span> products
      </p>
      <table id={tableId} className="sr-only">
        <caption>Catalog Growth — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Total Products</th>
            <th scope="col">New Products</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{formatNumber(d.cumulative_products)}</td>
              <td>{formatNumber(d.new_products)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
