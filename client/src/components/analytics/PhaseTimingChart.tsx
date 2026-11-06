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
import { formatDuration } from '@/lib/format';

interface PhaseTimingChartProps {
  timings: Record<string, number> | null;
}

const PHASE_COLORS: Record<string, string> = {
  discovery: 'var(--color-info)',
  variants: 'var(--color-success)',
  retry: 'var(--color-warning)',
  db_persist: 'var(--color-violet)',
  excel: 'var(--color-accent)',
};

const PHASE_LABELS: Record<string, string> = {
  discovery: 'Discovery',
  variants: 'Variants',
  retry: 'Retry',
  db_persist: 'DB Persist',
  excel: 'Excel',
};

/** Phase timings arrive in seconds. */
const formatSeconds = (seconds: number) => formatDuration(seconds * 1000);

export const PhaseTimingChart: React.FC<PhaseTimingChartProps> = ({ timings }) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

  if (!timings) return null;

  const data = Object.entries(timings)
    .filter(([, value]) => value != null && value > 0)
    .map(([key, value]) => ({
      name: PHASE_LABELS[key] ?? key,
      key,
      value,
      formatted: formatSeconds(value),
      // Per-bar color used by recharts <Bar>; replaces the deprecated <Cell> child API.
      fill: PHASE_COLORS[key] ?? 'var(--color-secondary)',
    }));

  if (data.length === 0) return null;

  const totalDuration = data.reduce((sum, d) => sum + d.value, 0);

  // S6819: role="group" + aria-labelledby + aria-describedby is the
  // labeled-group semantic for this chart card. <fieldset> would require
  // neutralizing UA defaults (border, padding, min-width:min-content,
  // legend float quirks) — defeating the semantic improvement; the header
  // includes an interactive <InfoTooltip> that fights <legend>'s inline-flow
  // contract. <details>/<optgroup>/<address> don't fit.
  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Phase Timings
        <InfoTooltip text="Wall-clock time spent in each pipeline phase. Discovery scans pages, Variants fetches APIs, Excel generates the report." />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Bar chart of {data.length} pipeline phases totaling {formatSeconds(totalDuration)}.
        </span>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 60, left: 10, bottom: 0 }}
          >
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => formatSeconds(v)}
            />
            <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value: number | string | readonly (string | number)[] | undefined) => [typeof value === 'number' ? formatSeconds(value) : String(value ?? ''), 'Duration']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Phase Timings — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <td>{d.name}</td>
              <td>{d.formatted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
