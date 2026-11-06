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

interface CoverageFunnelProps {
  discovered: number;
  processed: number;
  extracted: number;
  failed: number;
}

// Order matches `data` below: Discovered → Processed → Extracted → Failed
const COLORS = [
  'var(--color-info)',
  'var(--color-accent)',
  'var(--color-violet)',
  'var(--color-error)',
];

export const CoverageFunnel: React.FC<CoverageFunnelProps> = ({
  discovered,
  processed,
  extracted,
  failed,
}) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

  // `fill` on each entry replaces the deprecated <Cell> child API on <Bar>.
  // Order must match — first entry colors first bar, etc.
  const data = [
    { name: 'Discovered', value: discovered, fill: COLORS[0] },
    { name: 'Processed', value: processed, fill: COLORS[1] },
    { name: 'Extracted', value: extracted, fill: COLORS[2] },
    { name: 'Failed', value: failed, fill: COLORS[3] },
  ];

  // S6819: role="group" + aria-labelledby + aria-describedby is the
  // labeled-group semantic for this chart card. <fieldset> would require
  // neutralizing UA defaults (border, padding, min-width:min-content,
  // legend float quirks) that defeat the semantic improvement; the header
  // includes an interactive <InfoTooltip> trigger that fights <legend>'s
  // inline-flow contract. <details>/<optgroup>/<address> don't fit.
  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Coverage Funnel
        <InfoTooltip text="Shows how products flow through the scraping pipeline from discovery to extraction." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Horizontal bar chart: {formatNumber(discovered)} discovered, {formatNumber(processed)} processed, {formatNumber(extracted)} extracted, {formatNumber(failed)} failed.
        </span>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 20, left: 10, bottom: 0 }}
          >
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value: number | string | readonly (string | number)[] | undefined) => [typeof value === 'number' ? formatNumber(value) : String(value ?? ''), 'Count']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Coverage Funnel — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.name}>
              <td>{d.name}</td>
              <td>{formatNumber(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
