'use client';

import React, { useId } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
} from 'recharts';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface PriceTrendChartProps {
  data: { date: string; avg_list_price: number; avg_selling_price: number }[];
}

function trimDate(date: string): string {
  if (date && date.length >= 10) {
    return date.slice(5, 10);
  }
  return date;
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

export const PriceTrendChart: React.FC<PriceTrendChartProps> = ({ data }) => {
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
          Price Trends
          <InfoTooltip text="Average list price vs. average selling price over time. A widening gap indicates larger discounts." />
        </div>
        <div role="img" aria-label="Chart: Price Trends (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No price data available</p>
        </div>
      </div>
    );
  }

  const chartData = data.map((d) => ({ ...d, date: trimDate(d.date) }));
  const avgList =
    data.reduce((sum, d) => sum + d.avg_list_price, 0) / data.length;
  const avgSell =
    data.reduce((sum, d) => sum + d.avg_selling_price, 0) / data.length;

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Price Trends
        <InfoTooltip text="Average list price vs. average selling price over time. A widening gap indicates larger discounts." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Line chart showing {data.length} days of avg list price ({formatPrice(avgList)}) vs avg selling price ({formatPrice(avgSell)}).
        </span>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
            <Tooltip
              formatter={(value: number | string | readonly (string | number)[] | undefined) => [
                typeof value === 'number' ? formatPrice(value) : value,
              ]}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="avg_list_price"
              name="Avg List Price"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="avg_selling_price"
              name="Avg Selling Price"
              stroke="var(--color-success)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Price Trends — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Avg List Price</th>
            <th scope="col">Avg Selling Price</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{formatPrice(d.avg_list_price)}</td>
              <td>{formatPrice(d.avg_selling_price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
