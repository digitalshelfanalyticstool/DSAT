'use client';

import React from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { apiClient } from '@/lib/api-client';
import { DAY_LABELS } from '@/lib/schedule';


function getDayLabels(count: number): string[] {
  const today = new Date();
  const labels: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    labels.push(DAY_LABELS[d.getDay()]);
  }
  return labels;
}

function BandwidthTrendWidgetBase() {
  const { data, loading } = useAsyncResource(async () => {
    const res = await apiClient.getBrightDataUsage();
    // Sum daily_bw arrays across all zones, take last 7 entries
    const maxLen = Math.max(...res.zones.map((z) => z.bandwidth.daily_bw.length), 0);
    const summed: number[] = new Array(maxLen).fill(0);
    for (const zone of res.zones) {
      for (let i = 0; i < zone.bandwidth.daily_bw.length; i++) {
        summed[i] += zone.bandwidth.daily_bw[i];
      }
    }
    return summed.slice(-7);
  });
  // Errors stay silent: this widget degrades to its empty state.
  const dailyData: number[] = data ?? [];

  if (loading) {
    return <div className="h-36 w-full rounded bg-surface-tertiary animate-pulse" />;
  }

  if (dailyData.length === 0) {
    return <p className="text-sm text-ink-muted py-8 text-center">No bandwidth data</p>;
  }

  const maxVal = Math.max(...dailyData, 1);
  const dayLabels = getDayLabels(dailyData.length);

  return (
    <div className="flex gap-2 h-36">
      {dailyData.map((val, i) => {
        const heightPct = Math.max((val / maxVal) * 100, 4);
        const gb = val / 1073741824;
        // Day labels are unique and stable; use them as a content-derived key.
        return (
          <div key={dayLabels[i]} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full flex-1 flex items-end relative group">
              <div
                className="w-full rounded-t transition-all duration-300"
                style={{ height: `${heightPct}%`, backgroundColor: 'var(--color-accent)' }}
              />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-ink text-white text-xs px-2 py-1 rounded-lg shadow-lg whitespace-nowrap z-10">
                {gb < 0.01 ? `${(gb * 1024).toFixed(1)} MB` : `${gb.toFixed(2)} GB`}
              </div>
            </div>
            <span className="text-[10px] text-ink-muted">{dayLabels[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

export const BandwidthTrendWidget = React.memo(BandwidthTrendWidgetBase);
