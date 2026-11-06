'use client';

import React, { useId } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

interface PriceDistributionProps {
  data: { range: string; count: number }[];
}

export const PriceDistribution: React.FC<PriceDistributionProps> = ({ data }) => {
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
          Price Distribution
          <InfoTooltip text="Histogram of selling prices across all variants. Shows how many variants fall into each price range." />
        </div>
        <div role="img" aria-label="Chart: Price Distribution (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No price data available</p>
        </div>
      </div>
    );
  }

  const totalVariants = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Price Distribution
        <InfoTooltip text="Histogram of selling prices across all variants. Shows how many variants fall into each price range." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Histogram of {formatNumber(totalVariants)} variants across {data.length} price ranges.
        </span>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart
            data={data}
            margin={{ top: 0, right: 10, left: 0, bottom: 20 }}
          >
            <XAxis
              dataKey="range"
              tick={{ fontSize: 11 }}
              angle={-30}
              textAnchor="end"
              interval={0}
            />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value: number | string | readonly (string | number)[] | undefined) => [typeof value === 'number' ? formatNumber(value) : String(value ?? ''), 'Variants']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="count" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Price Distribution — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Price Range</th>
            <th scope="col">Variants</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.range}>
              <td>{d.range}</td>
              <td>{formatNumber(d.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
