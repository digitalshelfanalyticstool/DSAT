'use client';

import React, { useId } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { PhaseTimingEntry } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatDuration } from '@/lib/format';

interface PhaseTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: PhaseTimingEntry }>;
}

interface PhaseTimingChartProps {
  phases: PhaseTimingEntry[];
  loading?: boolean;
}

const PHASE_COLORS: Record<string, string> = {
  discovery: 'var(--color-info)',
  variant_fetch: 'var(--color-success)',
  retry: 'var(--color-warning)',
  db_persist: 'var(--color-violet)',
  excel: 'var(--color-accent)',
};

function CustomTooltip({ active, payload }: Readonly<PhaseTooltipProps>) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload;
  return (
    <div className="bg-surface border border-hairline rounded-lg px-3 py-2 shadow-md text-xs">
      <div className="font-medium text-ink mb-1 capitalize">{entry.phase}</div>
      <div className="text-ink-muted">Avg: {formatDuration(entry.avg_ms)}</div>
      <div className="text-ink-muted">P50: {formatDuration(entry.p50_ms)}</div>
      <div className="text-ink-muted">P95: {formatDuration(entry.p95_ms)}</div>
    </div>
  );
}

const TOOLTIP_TEXT = 'Average duration of each scraping pipeline phase. Hover bars for P50 and P95 percentiles. Helps identify which phase is the bottleneck.';

export const PhaseTimingChart: React.FC<PhaseTimingChartProps> = ({ phases, loading = false }) => {
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
        className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          Phase Timing (avg) <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Phase Timing (loading)">
          <div className="h-[200px] bg-surface-secondary rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (phases.length === 0) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          Phase Timing (avg) <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: Phase Timing (no data available)">
          <p className="text-sm text-ink-muted text-center py-8">No phase timing data available</p>
        </div>
      </div>
    );
  }

  const totalAvg = phases.reduce((sum, p) => sum + p.avg_ms, 0);

  // Inject per-row fill so recharts <Bar> colors bars; replaces the deprecated <Cell> child API.
  const chartData = phases.map((p) => ({
    ...p,
    fill: PHASE_COLORS[p.phase] || 'var(--color-secondary)',
  }));

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={tableId}
    >
      <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
        Phase Timing (avg) <InfoTooltip text={TOOLTIP_TEXT} />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Bar chart of {phases.length} pipeline phases totaling {formatDuration(totalAvg)} average wall-clock.
        </span>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatDuration(v)} />
            <YAxis type="category" dataKey="phase" width={90} tick={{ fontSize: 12 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="avg_ms" radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table id={tableId} className="sr-only">
        <caption>Phase Timing — tabular data</caption>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Avg</th>
            <th scope="col">P50</th>
            <th scope="col">P95</th>
          </tr>
        </thead>
        <tbody>
          {phases.map((p) => (
            <tr key={p.phase}>
              <td>{p.phase}</td>
              <td>{formatDuration(p.avg_ms)}</td>
              <td>{formatDuration(p.p50_ms)}</td>
              <td>{formatDuration(p.p95_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
