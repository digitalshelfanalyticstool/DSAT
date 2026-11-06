'use client';

import React from 'react';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface StatCardProps {
  label: string;
  value: string | number;
  tooltip?: string;
  change?: number; // percentage change, positive = green, negative = red
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, tooltip, change, className = '' }) => {
  const hasChange = change !== undefined && change !== null;
  const isPositive = hasChange && change >= 0;

  return (
    <div className={`bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm ${className}`}>
      <div className="flex items-center gap-1 text-sm font-medium text-ink-muted mb-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-ink">{value}</span>
        {hasChange && (
          <span
            className={`text-sm font-semibold mb-0.5 ${
              isPositive ? 'text-emerald-600' : 'text-red-500'
            }`}
          >
            {isPositive ? '+' : ''}
            {change.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
};
