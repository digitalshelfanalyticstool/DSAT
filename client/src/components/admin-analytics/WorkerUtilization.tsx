'use client';

import React from 'react';
import type { WorkerInfo } from '@/lib/api-client';
import { ChartCard } from '@/components/ui/ChartCard';

interface WorkerUtilizationProps {
  workers: WorkerInfo[];
  loading?: boolean;
}

function getUtilColor(pct: number): string {
  if (pct > 90) return 'bg-red-500';
  if (pct > 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

const TOOLTIP_TEXT = 'Live view of BullMQ worker processes. Shows active jobs vs max concurrency per worker. Green < 70%, amber 70–90%, red > 90%.';

function workerPct(w: WorkerInfo): number {
  return w.concurrency_max > 0
    ? Math.round((w.concurrency_active / w.concurrency_max) * 100)
    : 0;
}

export const WorkerUtilization: React.FC<WorkerUtilizationProps> = ({
  workers,
  loading = false,
}) => {
  const totalActive = workers.reduce((sum, w) => sum + w.concurrency_active, 0);
  const totalMax = workers.reduce((sum, w) => sum + w.concurrency_max, 0);
  const overallPct = totalMax > 0 ? Math.round((totalActive / totalMax) * 100) : 0;

  return (
    <ChartCard
      title="Worker Utilization"
      tooltip={TOOLTIP_TEXT}
      loading={loading}
      loadingSkeleton={
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-6 bg-surface-tertiary rounded animate-pulse" />
          ))}
        </div>
      }
      isEmpty={workers.length === 0}
      emptyMessage="No active workers"
      summary={
        <>
          Bar chart of {workers.length} workers at {overallPct}% overall utilization ({totalActive} of {totalMax} slots active).
        </>
      }
      tableContent={
        <>
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col">Active</th>
              <th scope="col">Max</th>
              <th scope="col">Utilization</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id}>
                <td>{w.id}</td>
                <td>{w.concurrency_active}</td>
                <td>{w.concurrency_max}</td>
                <td>{workerPct(w)}%</td>
              </tr>
            ))}
          </tbody>
        </>
      }
    >
      <div className="space-y-3">
        {workers.map((w) => {
          const pct = workerPct(w);
          return (
            <div key={w.id}>
              <div className="flex justify-between text-xs text-ink-muted mb-1">
                <span className="font-medium">{w.id}</span>
                <span>
                  {w.concurrency_active}/{w.concurrency_max} ({pct}%)
                </span>
              </div>
              <div className="w-full bg-surface-tertiary rounded-full h-4 overflow-hidden">
                <div
                  className={`h-4 rounded-full transition-all duration-500 ${getUtilColor(pct)}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
};
