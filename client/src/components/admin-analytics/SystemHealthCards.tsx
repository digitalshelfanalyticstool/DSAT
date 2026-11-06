'use client';

import React, { useMemo } from 'react';
import type { SystemHealth } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface SystemHealthCardsProps {
  health: SystemHealth | null;
  totalCostThisMonth?: number;
  totalBandwidthGb?: number;
  loading?: boolean;
}

export const SystemHealthCards: React.FC<SystemHealthCardsProps> = ({
  health,
  totalCostThisMonth,
  totalBandwidthGb,
  loading = false,
}) => {
  const cards = useMemo(() => [
    {
      label: 'Est. Cost (Month)',
      value: totalCostThisMonth === undefined ? '\u2014' : `$${totalCostThisMonth.toFixed(2)}`,
      color: 'text-accent',
      tooltip: 'Estimated Bright Data spend this month based on bandwidth × cost rate.',
    },
    {
      label: 'Bandwidth Used',
      value: totalBandwidthGb === undefined ? '\u2014' : `${totalBandwidthGb.toFixed(2)} GB`,
      color: 'text-accent',
      tooltip: 'Total Bright Data bandwidth consumed across all zones this month.',
    },
    {
      label: 'Active Workers',
      value: health ? health.active_workers.toString() : '\u2014',
      color: 'text-emerald-600',
      tooltip: 'Number of PM2 worker processes currently running and processing jobs.',
    },
    {
      label: 'Queue Depth',
      value: health ? `${health.queue_waiting + health.queue_active}` : '\u2014',
      subtitle: health
        ? `${health.queue_waiting} waiting \u00b7 ${health.queue_active} active`
        : undefined,
      color: 'text-amber-600',
      tooltip: 'Total jobs in the BullMQ queue. Waiting jobs are queued; active jobs are being processed.',
    },
  ], [health, totalCostThisMonth, totalBandwidthGb]);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm"
        >
          <div className="text-sm font-medium text-ink-muted mb-1 flex items-center gap-1.5">{card.label} <InfoTooltip text={card.tooltip} /></div>
          {loading ? (
            <div className="h-8 bg-surface-tertiary rounded animate-pulse" />
          ) : (
            <>
              <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
              {card.subtitle && (
                <div className="text-xs text-ink-muted mt-0.5">{card.subtitle}</div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
};
