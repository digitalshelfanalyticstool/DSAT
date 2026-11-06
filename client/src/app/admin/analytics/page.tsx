'use client';

import React, { useState, useCallback } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { apiClient } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { usePolling } from '@/hooks/usePolling';
import { useConfig } from '@/providers/ConfigProvider';
import { AnalyticsFilterBar, getDateRange } from '@/components/analytics';
import type { TimeRange } from '@/components/analytics';
import dynamic from 'next/dynamic';

// Lazy load chart components (Recharts is ~80KB)
const SystemHealthCards = dynamic(
  () => import('@/components/admin-analytics/SystemHealthCards').then(m => ({ default: m.SystemHealthCards })),
  { ssr: false }
);
const WorkerUtilization = dynamic(
  () => import('@/components/admin-analytics/WorkerUtilization').then(m => ({ default: m.WorkerUtilization })),
  { ssr: false }
);
const PhaseTimingChart = dynamic(
  () => import('@/components/admin-analytics/PhaseTimingChart').then(m => ({ default: m.PhaseTimingChart })),
  { ssr: false }
);
const RetailerCompleteness = dynamic(
  () => import('@/components/admin-analytics/RetailerCompleteness').then(m => ({ default: m.RetailerCompleteness })),
  { ssr: false }
);
const StaleProductsTable = dynamic(
  () => import('@/components/admin-analytics/StaleProductsTable').then(m => ({ default: m.StaleProductsTable })),
  { ssr: false }
);
const RateLimitBudget = dynamic(
  () => import('@/components/admin-analytics/RateLimitBudget').then(m => ({ default: m.RateLimitBudget })),
  { ssr: false }
);
const CostEfficiency = dynamic(
  () => import('@/components/admin-analytics/CostEfficiency').then(m => ({ default: m.CostEfficiency })),
  { ssr: false }
);
const DiskSpaceWidget = dynamic(
  () => import('@/components/admin-analytics/DiskSpaceWidget').then(m => ({ default: m.DiskSpaceWidget })),
  { ssr: false }
);
const ExcelReportsTable = dynamic(
  () => import('@/components/admin-analytics/ExcelReportsTable').then(m => ({ default: m.ExcelReportsTable })),
  { ssr: false }
);
// Lazy because Recharts is heavy and the admin analytics page already
// loads several other Recharts cards.
const WebVitalsChart = dynamic(
  () => import('@/components/admin-analytics/WebVitalsChart').then(m => ({ default: m.WebVitalsChart })),
  { ssr: false }
);
const FailureModePanel = dynamic(
  () => import('@/components/admin-analytics/FailureModePanel').then(m => ({ default: m.FailureModePanel })),
  { ssr: false }
);
const CacheHitRatePanel = dynamic(
  () => import('@/components/admin-analytics/CacheHitRatePanel').then(m => ({ default: m.CacheHitRatePanel })),
  { ssr: false }
);

// RetailerCostSection uses hand-rolled div bars, not Recharts — static import is safe.
import RetailerCostSection from '@/components/RetailerCostSection';
import { BandwidthTrendWidget } from '@/components/dashboard/BandwidthTrendWidget';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useBandwidthBilling } from '@/hooks/useBandwidthBilling';

/** A panel's own load failure, in place of the panel. */
function PanelError({ error, children }: Readonly<{ error: Error | null; children: React.ReactNode }>) {
  if (!error) return <>{children}</>;
  return (
    <div role="alert" className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm text-sm text-error-dark">
      Failed to load: {error.message}
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const bandwidthBilled = useBandwidthBilling(authChecked);
  // Sites and brands come from the cached ConfigProvider, not apiClient.
  const { sites: configSites, brands: configBrands } = useConfig();
  const brands = configBrands.map((b) => b.name);
  const retailers = [
    { value: '', label: 'All Retailers' },
    ...configSites.filter((s) => s.enabled).map((s) => ({ value: s.site_id, label: s.name })),
  ];

  // Filter state
  const [timeRange, setTimeRange] = useState<TimeRange>('mtd');
  const [site, setSite] = useState('');
  const [brand, setBrand] = useState('');
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(getDateRange('mtd'));
  const [excludeAdmin, setExcludeAdmin] = useState(false);


  // Handle time range changes
  const handleTimeRangeChange = useCallback((newRange: TimeRange) => {
    setTimeRange(newRange);
    if (newRange !== 'custom') {
      setDateRange(getDateRange(newRange));
    }
  }, []);

  const handleCustomRange = useCallback((from: string, to: string) => {
    setDateRange({ from, to });
  }, []);

  // Each panel is its own resource, so charts un-skeleton as their own data
  // arrives (one Promise.all mounting five ResponsiveContainers at once froze
  // the page) and a failing endpoint shows an error in its panel only.
  const { from, to } = dateRange;
  const rangeDeps = [from, to, site, excludeAdmin];

  // Live system health, refreshed every 30s while the tab is visible.
  const live = useAsyncResource(async () => {
    const [h, w, r] = await Promise.all([
      apiClient.getAdminSystemHealth(),
      apiClient.getAdminWorkers(),
      apiClient.getAdminRateLimits(),
    ]);
    return { health: h.health, workers: w.workers, rateLimits: r.retailers };
  }, { auto: authChecked });
  usePolling(live.refetch, authChecked ? 30_000 : null, { whenVisible: true });

  const phases = useAsyncResource(
    async () => (await apiClient.getAdminPhaseTiming(from, to)).phases,
    { auto: authChecked, deps: rangeDeps },
  );
  const completeness = useAsyncResource(
    async () => (await apiClient.getAdminDataCompleteness(from, to)).retailers,
    { auto: authChecked, deps: rangeDeps },
  );
  const stale = useAsyncResource(
    async () => (await apiClient.getAdminStaleProducts(from, to, site || undefined)).products,
    { auto: authChecked, deps: rangeDeps },
  );
  const cost = useAsyncResource(
    () => apiClient.getAdminCostEfficiency(from, to, excludeAdmin),
    { auto: authChecked, deps: rangeDeps },
  );
  // Pinned 7-day windows: "what's broken / is the cache TTL right THIS week".
  const failures = useAsyncResource(
    async () => (await apiClient.getAdminFailures(7)).breakdown,
    { auto: authChecked },
  );
  const cacheHitRate = useAsyncResource(
    async () => (await apiClient.getAdminCacheHitRate(7)).per_site,
    { auto: authChecked },
  );
  // Month-to-date bandwidth for the KPI card. The api client caches usage for
  // 60s, so BandwidthTrendWidget's call below is a hit.
  const bandwidth = useAsyncResource(async () => {
    const res = await apiClient.getBrightDataUsage();
    const bytes = res.zones.reduce((sum, z) => sum + z.bandwidth.sums.current_month.bw_sum, 0);
    return bytes / 1_073_741_824;
  }, { auto: authChecked && bandwidthBilled });

  const totalCost = cost.data?.by_retailer.reduce((sum, r) => sum + r.avg_cost_per_job * r.total_jobs, 0);

  if (!authChecked) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-light text-black">Admin Analytics</h1>
          <p className="text-sm text-ink-muted mt-1">
            Operational health, data quality, and cost monitoring
          </p>
        </div>

        {/* Filter Bar */}
        <div className="mb-6">
          <AnalyticsFilterBar
            timeRange={timeRange}
            onTimeRangeChange={handleTimeRangeChange}
            site={site}
            onSiteChange={setSite}
            brand={brand}
            onBrandChange={setBrand}
            brands={brands}
            retailers={retailers.length > 1 ? retailers : undefined}
            from={dateRange.from}
            to={dateRange.to}
            onCustomRange={handleCustomRange}
            excludeAdmin={excludeAdmin}
            onExcludeAdminChange={setExcludeAdmin}
          />
        </div>

        {/* KPI Cards */}
        <div className="mb-6">
          <PanelError error={live.error}>
            <SystemHealthCards
              health={live.data?.health ?? null}
              totalCostThisMonth={totalCost}
              totalBandwidthGb={bandwidth.data ?? undefined}
              loading={live.loading && cost.loading}
            />
          </PanelError>
        </div>

        {/* Row 1: Workers + Daily Bandwidth */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <PanelError error={live.error}><WorkerUtilization workers={live.data?.workers ?? []} loading={live.loading} /></PanelError>
          {bandwidthBilled && (
          <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm flex flex-col">
            <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">Daily Bandwidth (Last 7 Days) <InfoTooltip text="Bright Data bandwidth consumption per day across all zones. Hover bars to see exact values. Helps spot unusual spikes in scraping activity." /></div>
            <div className="flex-1 flex items-end">
              <div className="w-full">
                <BandwidthTrendWidget />
              </div>
            </div>
          </div>
          )}
        </div>

        {/* Row 2: Phase Timing + Data Completeness */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <PanelError error={phases.error}><PhaseTimingChart phases={phases.data ?? []} loading={phases.loading} /></PanelError>
          <PanelError error={completeness.error}><RetailerCompleteness retailers={completeness.data ?? []} loading={completeness.loading} /></PanelError>
        </div>

        {/* Row 3: Rate Limits + Cost Efficiency */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <PanelError error={live.error}><RateLimitBudget retailers={live.data?.rateLimits ?? []} loading={live.loading} /></PanelError>
          <PanelError error={cost.error}><CostEfficiency byRetailer={cost.data?.by_retailer ?? []} trend={cost.data?.trend ?? []} loading={cost.loading} /></PanelError>
        </div>

        {/* Row 4: Failure Mode Panel + Cache Hit Rate (paired operational/cost signals) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <PanelError error={failures.error}><FailureModePanel failures={failures.data ?? []} loading={failures.loading} /></PanelError>
          <PanelError error={cacheHitRate.error}><CacheHitRatePanel entries={cacheHitRate.data ?? []} loading={cacheHitRate.loading} /></PanelError>
        </div>

        {/* Row 5: Stale Products */}
        <div className="grid grid-cols-1 gap-6 mb-6">
          <PanelError error={stale.error}><StaleProductsTable products={stale.data ?? []} loading={stale.loading} /></PanelError>
        </div>

        {/* Row 5: Disk Space + Web Vitals */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <DiskSpaceWidget />
          <WebVitalsChart />
        </div>

        {/* Row 6: Excel Reports (full width — admin cleanup table beneath the disk widget) */}
        <div className="mb-6">
          <ExcelReportsTable />
        </div>

        {/* Row 7: Retailer Cost Analytics (full width — has its own cards and controls) */}
        {bandwidthBilled && (
          <div className="mb-6">
            <RetailerCostSection />
          </div>
        )}
      </div>
    </MainLayout>
  );
}
