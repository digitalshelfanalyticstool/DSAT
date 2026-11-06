'use client';

import { useState, useMemo } from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { apiClient } from '@/lib/api-client';
import type { ScheduledJobEntry } from '@/lib/api-client';
import { formatDate, formatTime } from '@/lib/format';
import { DAY_LABELS, SCHEDULE_TZ_LABEL, parseDays, nextScheduledRun } from '@/lib/schedule';

const COLLAPSED_COUNT = 3;

export function UpcomingSchedulesWidget() {
  const [expanded, setExpanded] = useState(false);
  const { data, loading } = useAsyncResource(
    async () => (await apiClient.getSchedules()).schedules,
  );
  // Errors stay silent: this widget degrades to its empty state.
  const schedules: ScheduledJobEntry[] = data ?? [];

  const enabled = schedules.filter((s) => s.enabled);

  // Parse schedule_days JSON once per schedule, memoized across re-renders
  const parsedSchedules = useMemo(
    () => enabled.map((s) => ({ schedule: s, days: parseDays(s.schedule_days) })),
    [enabled],
  );

  const withNext = parsedSchedules
    .map(({ schedule, days }) => ({ schedule, days, next: nextScheduledRun(days, schedule.schedule_time) }))
    .filter((x) => x.next !== null)
    .sort((a, b) => a.next!.getTime() - b.next!.getTime());

  const visible = expanded ? withNext : withNext.slice(0, COLLAPSED_COUNT);
  const hiddenCount = Math.max(0, withNext.length - COLLAPSED_COUNT);

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full rounded" />)}
      </div>
    );
  }

  if (withNext.length === 0) {
    return <p className="text-sm text-ink-muted py-4 text-center">No upcoming schedules</p>;
  }

  return (
    <div className="space-y-3">
      {visible.map(({ schedule, days, next }) => {
        return (
          <div key={schedule.id} className="flex items-center justify-between p-3 bg-surface-secondary/50 rounded-lg border border-hairline">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink truncate">
                {schedule.site} / {schedule.brand}
              </p>
              <p className="text-xs text-ink-muted">
                {schedule.schedule_time} {SCHEDULE_TZ_LABEL} — {days.map((d) => DAY_LABELS[d]).join(', ')}
              </p>
            </div>
            <div className="text-right shrink-0 ml-3">
              <p className="text-xs font-medium text-ink">
                {formatDate(next!, { weekday: 'short', month: 'short', day: 'numeric' })}
              </p>
              <p className="text-xs text-ink-muted">
                {formatTime(next!, { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        );
      })}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="w-full text-center text-xs font-medium text-accent border border-dashed border-hairline rounded-lg py-2 hover:bg-surface-secondary/50 transition-colors focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {expanded ? 'Show less' : `Show ${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}
