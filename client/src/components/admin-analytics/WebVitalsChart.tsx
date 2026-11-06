'use client';

import React, { useId } from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { apiClient, type WebVitalsP75Entry } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

const TOOLTIP_TEXT = 'p75 of Interaction to Next Paint (INP) per route, last 7 days. Lower is better — Google flags >200ms as "needs improvement". Helps spot slow-clicking pages before users complain.';

const COLOR_GOOD = 'var(--color-success)';
const COLOR_NEEDS_IMPROVEMENT = 'var(--color-warning)';
const COLOR_POOR = 'var(--color-danger, #ef4444)';

function inpColor(p75: number): string {
  if (p75 <= 200) return COLOR_GOOD;
  if (p75 <= 500) return COLOR_NEEDS_IMPROVEMENT;
  return COLOR_POOR;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: WebVitalsP75Entry }>;
}

function CustomTooltip({ active, payload }: Readonly<ChartTooltipProps>) {
  if (!active || !payload || payload.length === 0) return null;
  const entry = payload[0].payload;
  return (
    <div className="bg-surface border border-hairline rounded-lg px-3 py-2 shadow-md text-xs">
      <div className="font-medium text-ink mb-1">{entry.route}</div>
      <div className="text-ink-muted">p75 INP: {entry.p75.toFixed(0)} ms</div>
      <div className="text-ink-muted">Samples: {formatNumber(entry.sample_count)}</div>
    </div>
  );
}

export const WebVitalsChart: React.FC = () => {
  const titleId = useId();
  const summaryId = useId();
  // The hand-rolled `cancelled` flag is now the hook's request-id guard.
  const { data, loading, error: loadError } = useAsyncResource(async () => {
    const res = await apiClient.getAdminWebVitals(7, 20);
    // Server returns all five metric names; this card only shows INP.
    // (LCP/CLS/TTFB/FCP would each warrant their own card with different
    //  thresholds and units — keeping the surface small for v1.)
    return res.data.filter((r) => r.name === 'INP');
  });
  const rows: WebVitalsP75Entry[] = data ?? [];
  const error = loadError ? (loadError.message || 'Failed to load') : null;

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
          p75 INP per Route (7d) <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div role="img" aria-label="Chart: p75 INP per Route (loading)">
          <div className="h-[260px] bg-surface-secondary rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || rows.length === 0) {
    return (
      <div
        className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
        // NOSONAR(typescript:S6819): see S6819 rationale above.
        role="group"
        aria-labelledby={titleId}
      >
        <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
          p75 INP per Route (7d) <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">
          {error ? `Error: ${error}` : 'No Web Vitals samples in the last 7 days yet.'}
        </p>
      </div>
    );
  }

  // Inject per-row fill so recharts <Bar> can color bars without the deprecated <Cell> child API.
  const chartData = rows.map((r) => ({ ...r, fill: inpColor(r.p75) }));

  return (
    <div
      className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      role="group"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
    >
      <div id={titleId} className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">
        p75 INP per Route (7d) <InfoTooltip text={TOOLTIP_TEXT} />
      </div>
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          Bar chart of p75 Interaction to Next Paint per route over the last 7 days, top {rows.length} worst routes.
        </span>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-100)" />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v.toFixed(0)}ms`} />
            <YAxis type="category" dataKey="route" width={140} tick={{ fontSize: 11 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="p75" radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
