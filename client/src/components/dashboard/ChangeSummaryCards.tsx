'use client';

import React, { useState } from 'react';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { apiClient } from '@/lib/api-client';
import type { ChangeSummary } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconPlus() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

function IconMinus() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18 9 11.25l4.306 4.307a11.95 11.95 0 0 1 5.814-5.519l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941" />
    </svg>
  );
}

function IconArrowDown() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6 9 12.75l4.306-4.307a11.95 11.95 0 0 1 5.814 5.519l2.74 1.22m0 0-5.94 2.281m5.94-2.28-2.28-5.941" />
    </svg>
  );
}

function IconTag() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6Z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

// ─── Card Definitions ─────────────────────────────────────────────────────────

interface CardConfig {
  key: keyof Pick<
    ChangeSummary,
    'new_products' | 'dropped_products' | 'price_increases' | 'price_decreases' | 'new_sellouts' | 'restocked'
  >;
  label: string;
  Icon: React.FC;
  /** Fixed color scheme (always shown regardless of zero). */
  fixedColor?: { iconBg: string; iconText: string; valueText: string };
  /** Conditional color: shown when value > 0; gray-100/gray-400 when zero. */
  activeColor?: { iconBg: string; iconText: string; valueText: string };
}

// Zero-state value/icon use gray-500 (4.6:1 on white) for WCAG 1.4.3.
const ZERO_COLOR = { iconBg: 'bg-surface-tertiary', iconText: 'text-ink-muted', valueText: 'text-ink-muted' };

const CARDS: CardConfig[] = [
  {
    key: 'new_products',
    label: 'New Products',
    Icon: IconPlus,
    fixedColor: { iconBg: 'bg-emerald-50', iconText: 'text-emerald-600', valueText: 'text-ink' },
  },
  {
    key: 'dropped_products',
    label: 'Dropped Products',
    Icon: IconMinus,
    fixedColor: { iconBg: 'bg-red-50', iconText: 'text-red-500', valueText: 'text-ink' },
  },
  {
    key: 'price_increases',
    label: 'Price Increases',
    Icon: IconArrowUp,
    fixedColor: { iconBg: 'bg-orange-50', iconText: 'text-orange-500', valueText: 'text-ink' },
  },
  {
    key: 'price_decreases',
    label: 'Price Decreases',
    Icon: IconArrowDown,
    fixedColor: { iconBg: 'bg-accent-50', iconText: 'text-accent', valueText: 'text-ink' },
  },
  {
    key: 'new_sellouts',
    label: 'New Sellouts',
    Icon: IconTag,
    activeColor: { iconBg: 'bg-amber-50', iconText: 'text-amber-500', valueText: 'text-ink' },
  },
  {
    key: 'restocked',
    label: 'Restocked',
    Icon: IconRefresh,
    activeColor: { iconBg: 'bg-teal-50', iconText: 'text-teal-500', valueText: 'text-ink' },
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({ config, value, loading }: Readonly<{ config: CardConfig; value: number; loading: boolean }>) {
  const isZero = value === 0;
  let colors: { iconBg: string; iconText: string; valueText: string };

  if (config.fixedColor) {
    // Fixed color: always use the brand color; mute only the number when zero
    colors = isZero
      ? { ...config.fixedColor, valueText: 'text-ink-muted' }
      : config.fixedColor;
  } else {
    // Conditional color: switch to gray scheme when zero
    colors = isZero ? ZERO_COLOR : config.activeColor!;
  }

  return (
    <div className="surface-card p-4 flex flex-col gap-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.iconBg} ${colors.iconText}`}>
        <config.Icon />
      </div>
      <div>
        {loading ? (
          <div className="skeleton h-7 w-12 mb-1" />
        ) : (
          <p className={`text-2xl font-display font-bold tabular-nums leading-none ${colors.valueText}`}>
            {formatNumber(value)}
          </p>
        )}
        <p className="text-xs text-ink-muted mt-1">{config.label}</p>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ChangeSummaryCards() {
  const [selectedSite, setSelectedSite] = useState<string | null>(null);

  // The pill filter refetches. The hand-rolled version fired the request
  // imperatively from the click handler with no guard, so clicking through
  // pills quickly could render whichever response landed last rather than the
  // one for the selected pill; useAsyncResource drops superseded results.
  const { data, loading, error } = useAsyncResource<ChangeSummary>(
    () => apiClient.getChangeSummary(selectedSite ?? undefined),
    { deps: [selectedSite] },
  );

  const handlePillClick = (site: string | null) => {
    if (site === selectedSite) return;
    setSelectedSite(site);
  };

  // Hide the whole widget when there is no data to show. `error` is checked
  // explicitly because the hook RETAINS the last good data across a failed
  // refetch, while this widget's contract is to disappear when the endpoint
  // fails rather than show a stale summary.
  if (error) return null;
  if (!loading && (!data || !data.has_data)) return null;

  const retailers = data?.retailers_compared ?? [];

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-display text-sm font-semibold text-ink">Changes Since Last Scrape</h2>
        {/* Pill filter — only render once we have retailer data */}
        {retailers.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => handlePillClick(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                selectedSite === null
                  ? 'bg-accent text-white'
                  : 'bg-surface-tertiary text-ink-muted hover:bg-surface-tertiary'
              }`}
            >
              All
            </button>
            {retailers.map((site) => (
              <button
                key={site}
                onClick={() => handlePillClick(site)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors capitalize ${
                  selectedSite === site
                    ? 'bg-accent text-white'
                    : 'bg-surface-tertiary text-ink-muted hover:bg-surface-tertiary'
                }`}
              >
                {site}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {CARDS.map((config) => (
          <MetricCard
            key={config.key}
            config={config}
            value={data?.[config.key] ?? 0}
            loading={loading}
          />
        ))}
      </div>
    </div>
  );
}
