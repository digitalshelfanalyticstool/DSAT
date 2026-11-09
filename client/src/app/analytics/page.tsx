'use client';

import React, { useState, useEffect } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { apiClient } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import type { AnalyticsOverview } from '@/lib/api-client';
import { useConfig } from '@/providers/ConfigProvider';
import dynamic from 'next/dynamic';
import { StatCard, AnalyticsFilterBar, getDateRange } from '@/components/analytics';
import type { TimeRange } from '@/components/analytics';
import { Button } from '@/components/ui/Button';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { pctChange } from '@/lib/format';

// Lazy load chart components — Recharts is ~80KB and only needed on this page
const DailyActivityChart = dynamic(() => import('@/components/analytics/DailyActivityChart').then(m => ({ default: m.DailyActivityChart })), { ssr: false });
const RetailerBreakdown = dynamic(() => import('@/components/analytics/RetailerBreakdown').then(m => ({ default: m.RetailerBreakdown })), { ssr: false });
const PriceTrendChart = dynamic(() => import('@/components/analytics/PriceTrendChart').then(m => ({ default: m.PriceTrendChart })), { ssr: false });
const CatalogGrowthChart = dynamic(() => import('@/components/analytics/CatalogGrowthChart').then(m => ({ default: m.CatalogGrowthChart })), { ssr: false });
const SuccessRateChart = dynamic(() => import('@/components/analytics/SuccessRateChart').then(m => ({ default: m.SuccessRateChart })), { ssr: false });
const RecentJobsTable = dynamic(() => import('@/components/analytics/RecentJobsTable').then(m => ({ default: m.RecentJobsTable })), { ssr: false });
const TopProductsTable = dynamic(() => import('@/components/analytics/TopProductsTable').then(m => ({ default: m.TopProductsTable })), { ssr: false });

export default function AnalyticsPage() {
  // Session and brands come from the cached providers. Each has its own TTL (60s session,
  // 5min config); on a navigation between Analytics ↔ Dashboard the second
  // page hits a warm cache.
  const { authChecked } = useRequireAuth();
  const { brands: configBrands } = useConfig();
  const brands = configBrands.map((b) => b.name);
  const [timeRange, setTimeRange] = useState<TimeRange>('mtd');
  const [site, setSite] = useState('');
  const [brand, setBrand] = useState('');
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(getDateRange('mtd'));
  // Update date range when timeRange changes (non-custom)
  useEffect(() => {
    if (timeRange !== 'custom') {
      setDateRange(getDateRange(timeRange));
    }
  }, [timeRange]);

  // `auto: authChecked` is the hook's auth-gate form: nothing is fetched until
  // the gate opens, and `loading` reads true from the render the gate opens in,
  // so the page never flashes its empty state in between.
  const { data, loading } = useAsyncResource<AnalyticsOverview>(
    async () => {
      const response = await apiClient.getAnalyticsOverview({
        from: dateRange.from,
        to: dateRange.to,
        site: site || undefined,
        brand: brand || undefined,
      });
      if (!response.success) throw new Error('Analytics request was unsuccessful');
      return response.analytics;
    },
    {
      auto: authChecked,
      deps: [dateRange, site, brand],
      onError: 'toast',
    },
  );

  const handleCustomRange = (from: string, to: string) => {
    setDateRange({ from, to });
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="animate-in">
          <h1 className="font-display text-3xl font-bold text-ink">Analytics</h1>
          <p className="mt-1 text-ink-muted">Track scraping performance, product coverage, and price trends.</p>
        </div>

        {/* Filter Bar */}
        <div className="animate-in" style={{ '--stagger': 1 } as React.CSSProperties}>
          <AnalyticsFilterBar
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            site={site}
            onSiteChange={setSite}
            brand={brand}
            onBrandChange={setBrand}
            brands={brands}
            from={dateRange.from}
            to={dateRange.to}
            onCustomRange={handleCustomRange}
          />
        </div>

        {/* Content-shaped skeleton (4 KPI cards above two rows of chart
            placeholders) so the page reserves the same vertical space
            as the loaded layout (no scroll-jump on first paint). */}
        {loading && (
          <div className="space-y-4" aria-label="Loading analytics" aria-busy="true" data-testid="analytics-skeleton">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="analytics-skeleton-kpis">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="surface-card p-4" data-testid="analytics-skeleton-kpi">
                  <div className="skeleton h-3 w-20 mb-3" />
                  <div className="skeleton h-7 w-24" />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 surface-card p-4">
                <div className="skeleton h-4 w-32 mb-4" />
                <div className="skeleton h-56 w-full rounded" />
              </div>
              <div className="surface-card p-4">
                <div className="skeleton h-4 w-32 mb-4" />
                <div className="skeleton h-56 w-full rounded" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {[0, 1].map((i) => (
                <div key={i} className="surface-card p-4">
                  <div className="skeleton h-4 w-32 mb-4" />
                  <div className="skeleton h-48 w-full rounded" />
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && data && (
          <>
            {/* KPI Cards */}
            <div
              className="animate-in grid grid-cols-2 lg:grid-cols-4 gap-3"
              style={{ '--stagger': 2 } as React.CSSProperties}
            >
              <StatCard
                label="Total Jobs"
                value={data.kpi.total_jobs}
                change={pctChange(data.kpi.total_jobs, data.kpi.total_jobs_prev)}
                tooltip="Count of scraping jobs run in the selected period."
              />
              <StatCard
                label="Products Scraped"
                value={data.kpi.products_scraped}
                change={pctChange(data.kpi.products_scraped, data.kpi.products_scraped_prev)}
                tooltip="Total unique products found during the discovery phase by scanning retailer category pages."
              />
              <StatCard
                label="Variants Extracted"
                value={data.kpi.variants_extracted}
                change={pctChange(data.kpi.variants_extracted, data.kpi.variants_extracted_prev)}
                tooltip="Individual SKU-level records (one per color + size combination) successfully pulled from retailer APIs."
              />
              <StatCard
                label="Success Rate"
                value={`${data.kpi.success_rate}%`}
                change={pctChange(data.kpi.success_rate, data.kpi.success_rate_prev)}
                tooltip="Percentage of jobs that completed without errors. Calculated as completed jobs / total jobs."
              />
            </div>

            {/* Row 1: DailyActivityChart (2/3) + RetailerBreakdown (1/3) */}
            <div
              className="animate-in grid grid-cols-1 lg:grid-cols-3 gap-4"
              style={{ '--stagger': 3 } as React.CSSProperties}
            >
              <div className="lg:col-span-2">
                <DailyActivityChart data={data.daily_activity} />
              </div>
              <div>
                <RetailerBreakdown data={data.by_retailer} />
              </div>
            </div>

            {/* Row 2: PriceTrendChart (1/2) + CatalogGrowthChart (1/2) */}
            <div
              className="animate-in grid grid-cols-1 lg:grid-cols-2 gap-4"
              style={{ '--stagger': 4 } as React.CSSProperties}
            >
              <PriceTrendChart data={data.price_trend} />
              <CatalogGrowthChart data={data.catalog_growth} />
            </div>

            {/* Row 3: SuccessRateChart + Recent Jobs */}
            <div
              className="animate-in grid grid-cols-1 lg:grid-cols-2 gap-4"
              style={{ '--stagger': 5 } as React.CSSProperties}
            >
              <SuccessRateChart data={data.success_by_retailer} />
              <RecentJobsTable data={data.recent_jobs} />
            </div>

            {/* Row 4: Top Products by Variants */}
            <div
              className="animate-in"
              style={{ '--stagger': 6 } as React.CSSProperties}
            >
              <TopProductsTable data={data.top_products} />
            </div>
          </>
        )}

        {/* Empty state */}
        {!loading && !data && (
          <div className="surface-card text-center py-16 px-6">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-surface-tertiary mb-3">
              {/* eslint-disable-next-line no-restricted-syntax -- decorative empty-state icon, aria-hidden */}
              <svg className="h-5 w-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19a3 3 0 11-6 0 3 3 0 016 0zm12-3a3 3 0 11-6 0 3 3 0 016 0zM9 10l12-3" />
              </svg>
            </div>
            <p className="font-display text-base font-semibold text-ink">No analytics data</p>
            <p className="mt-1 text-sm text-ink-muted">No analytics data for the selected filters.</p>
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSite('');
                  setBrand('');
                  setTimeRange('mtd');
                  setDateRange(getDateRange('mtd'));
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
