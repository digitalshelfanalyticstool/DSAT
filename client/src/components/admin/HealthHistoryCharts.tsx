'use client';

/**
 * Standalone chart panel for /admin/health.
 *
 * Recharts is ~80KB gzipped and is the largest single dependency on the
 * admin health page. By extracting the chart rendering here and loading
 * the panel via `next/dynamic({ ssr: false })` from the page, the recharts
 * barrel ends up on a separate chunk that only downloads when an admin
 * actually scrolls to the historical-trends card. The status banner,
 * service cards, and actions panel all paint immediately without waiting
 * on charting JS.
 */

import { Card } from '@/components/ui';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  formatDate as formatDateShared,
  formatDateTime,
  formatTime as formatTimeShared,
} from '@/lib/format';
import type { HealthSnapshot, HealthRange } from '@/lib/api-client';


function formatTime(bucket: string): string {
  const d = new Date(bucket);
  return formatTimeShared(d, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(bucket: string): string {
  const d = new Date(bucket);
  return formatDateShared(d, { month: 'short', day: 'numeric' });
}

interface HealthHistoryChartsProps {
  snapshots: HealthSnapshot[];
  range: HealthRange;
  onRangeChange: (r: HealthRange) => void;
  loading: boolean;
}

export default function HealthHistoryCharts({
  snapshots,
  range,
  onRangeChange,
  loading,
}: Readonly<HealthHistoryChartsProps>) {
  const tickFormatter = range === '24h' ? formatTime : formatDate;
  const isEmptySnapshots = snapshots.length === 0;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-ink">Historical Trends</h3>
        <div className="flex gap-1">
          {(['24h', '7d', '30d'] as HealthRange[]).map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
                range === r
                  ? 'bg-accent-100 text-accent'
                  : 'text-ink-muted hover:bg-surface-tertiary'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
        </div>
      )}
      {!loading && isEmptySnapshots && (
        <p className="text-sm text-ink-muted text-center py-12">
          No snapshot data yet. Data will appear after the first 5-minute recording cycle.
        </p>
      )}
      {!loading && !isEmptySnapshots && (
        <div className="space-y-6">
          {/* Queue Depth Chart */}
          <div>
            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">Queue Depth</p>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={snapshots}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="bucket" tickFormatter={tickFormatter} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(label) => formatDateTime(label as string)}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="queue_waiting" stroke="var(--color-accent)" name="Waiting" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="queue_active" stroke="#10b981" name="Active" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="queue_stalled" stroke="#f59e0b" name="Stalled" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Worker Count Chart */}
          <div>
            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">Workers</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={snapshots}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="bucket" tickFormatter={tickFormatter} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                <Tooltip
                  labelFormatter={(label) => formatDateTime(label as string)}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="stepAfter" dataKey="workers_active" stroke="var(--color-accent)" name="Active" dot={false} strokeWidth={2} />
                <Line type="stepAfter" dataKey="workers_expected" stroke="#d1d5db" name="Expected" dot={false} strokeWidth={1.5} strokeDasharray="4 4" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Status Timeline */}
          <div>
            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">Status Timeline</p>
            <div className="flex h-6 rounded-lg overflow-hidden border border-hairline">
              {snapshots.map((s) => {
                const colorMap: Record<string, string> = {
                  healthy: 'bg-emerald-400',
                  degraded: 'bg-amber-400',
                };
                const bgClass = colorMap[s.status] ?? 'bg-red-400';
                return (
                  <div
                    key={s.bucket}
                    className={`flex-1 ${bgClass}`}
                    title={`${formatDateTime(s.bucket)} — ${s.status}`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-ink-muted mt-1">
              <span>{snapshots.length > 0 ? formatDateTime(snapshots[0].bucket) : ''}</span>
              <span>{snapshots.length > 0 ? formatDateTime(snapshots.at(-1)!.bucket) : ''}</span>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
