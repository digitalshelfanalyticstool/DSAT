'use client';

import React from 'react';
import { format, startOfMonth, startOfWeek, startOfYear, subMonths, subWeeks } from 'date-fns';
import { useSiteLabel, useSiteNames } from '@/providers/ConfigProvider';

export type TimeRange = 'mtd' | 'wow' | 'mom' | 'yoy' | 'custom';

interface AnalyticsFilterBarProps {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  site: string;
  onSiteChange: (site: string) => void;
  brand: string;
  onBrandChange: (brand: string) => void;
  brands: string[];
  retailers?: { value: string; label: string }[];
  from: string;
  to: string;
  onCustomRange?: (from: string, to: string) => void;
  excludeAdmin?: boolean;
  onExcludeAdminChange?: (excludeAdmin: boolean) => void;
}

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  mtd: 'MTD',
  wow: 'WoW',
  mom: 'MoM',
  yoy: 'YoY',
  custom: 'Custom',
};

const TIME_RANGES: TimeRange[] = ['mtd', 'wow', 'mom', 'yoy', 'custom'];


export function getDateRange(range: TimeRange): { from: string; to: string } {
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');

  switch (range) {
    case 'mtd':
      return { from: format(startOfMonth(now), 'yyyy-MM-dd'), to: today };
    case 'wow':
      return { from: format(subWeeks(startOfWeek(now, { weekStartsOn: 1 }), 1), 'yyyy-MM-dd'), to: today };
    case 'mom':
      return { from: format(startOfMonth(subMonths(now, 1)), 'yyyy-MM-dd'), to: today };
    case 'yoy':
      return { from: format(startOfYear(now), 'yyyy-MM-dd'), to: today };
    case 'custom':
      return { from: format(startOfMonth(now), 'yyyy-MM-dd'), to: today };
  }
}

export const AnalyticsFilterBar: React.FC<AnalyticsFilterBarProps> = ({
  timeRange,
  onTimeRangeChange,
  site,
  onSiteChange,
  brand,
  onBrandChange,
  brands,
  retailers,
  from,
  to,
  onCustomRange,
  excludeAdmin,
  onExcludeAdminChange,
}) => {
  const siteNames = useSiteNames();
  const siteLabel = useSiteLabel();
  const retailerOptions = retailers ?? [
    { value: '', label: 'All Retailers' },
    ...siteNames.map((name) => ({ value: name, label: siteLabel(name) })),
  ];
  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm flex flex-wrap items-center gap-3">
      {/* Time range toggle */}
      <div className="flex items-center gap-1 bg-surface-tertiary rounded-lg p-1">
        {TIME_RANGES.map((range) => (
          <button
            key={range}
            onClick={() => onTimeRangeChange(range)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              timeRange === range
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {TIME_RANGE_LABELS[range]}
          </button>
        ))}
      </div>

      {/* Retailer dropdown */}
      <select
        value={site}
        onChange={(e) => onSiteChange(e.target.value)}
        aria-label="Filter by retailer"
        className="text-sm border border-hairline rounded-lg px-3 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
      >
        {retailerOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Brand dropdown */}
      <select
        value={brand}
        onChange={(e) => onBrandChange(e.target.value)}
        aria-label="Filter by brand"
        className="text-sm border border-hairline rounded-lg px-3 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
      >
        <option value="">All Brands</option>
        {brands.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>

      {/* Exclude admin toggle */}
      {onExcludeAdminChange && (
        <label
          className="flex items-center gap-1.5 text-sm text-ink-muted cursor-pointer select-none"
          title="Hide jobs initiated by accounts with admin role. Useful when admins occasionally trigger preview/test scrapes; off by default since admin accounts also run production scrapes."
        >
          <input
            type="checkbox"
            checked={excludeAdmin ?? false}
            onChange={(e) => onExcludeAdminChange(e.target.checked)}
            className="rounded border-hairline text-accent focus:ring-accent-500"
          />
          <span>Hide admin test runs</span>
        </label>
      )}

      {/* Custom date pickers */}
      {timeRange === 'custom' && onCustomRange && (
        <div className="flex items-center gap-2 ml-auto">
          <label htmlFor="analytics-from" className="text-sm text-ink-muted">From</label>
          <input
            id="analytics-from"
            type="date"
            value={from}
            onChange={(e) => onCustomRange(e.target.value, to)}
            className="text-sm border border-hairline rounded-lg px-3 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
          <label htmlFor="analytics-to" className="text-sm text-ink-muted">To</label>
          <input
            id="analytics-to"
            type="date"
            value={to}
            onChange={(e) => onCustomRange(from, e.target.value)}
            className="text-sm border border-hairline rounded-lg px-3 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
      )}
    </div>
  );
};
