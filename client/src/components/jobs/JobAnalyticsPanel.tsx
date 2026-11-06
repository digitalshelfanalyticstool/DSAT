'use client';

import dynamic from 'next/dynamic';
import { StatCard } from '@/components/analytics/StatCard';
import type { JobAnalytics } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

// Each analytics widget is loaded only when this panel mounts (job.status ===
// 'completed' + analytics fetched). Recharts is heavy; keeping these as
// `dynamic(..., { ssr: false })` keeps the cold-load bundle small.
const CoverageFunnel = dynamic(() => import('@/components/analytics/CoverageFunnel').then(m => ({ default: m.CoverageFunnel })), { ssr: false });
const PhaseTimingChart = dynamic(() => import('@/components/analytics/PhaseTimingChart').then(m => ({ default: m.PhaseTimingChart })), { ssr: false });
const PriceDistribution = dynamic(() => import('@/components/analytics/PriceDistribution').then(m => ({ default: m.PriceDistribution })), { ssr: false });
const DiscountSummary = dynamic(() => import('@/components/analytics/DiscountSummary').then(m => ({ default: m.DiscountSummary })), { ssr: false });
const VariantHeatmap = dynamic(() => import('@/components/analytics/VariantHeatmap').then(m => ({ default: m.VariantHeatmap })), { ssr: false });
const DataCompleteness = dynamic(() => import('@/components/analytics/DataCompleteness').then(m => ({ default: m.DataCompleteness })), { ssr: false });

interface JobSummaryStats {
  products_discovered?: number;
  products_processed?: number;
  variants_extracted?: number;
  failed_products?: string[];
  started_at?: string;
  completed_at?: string;
}

interface Props {
  job: JobSummaryStats;
  analytics: JobAnalytics;
}

export function JobAnalyticsPanel({ job, analytics }: Readonly<Props>) {
  return (
    <div className="space-y-4 mt-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Products Discovered" value={job.products_discovered || 0}
          tooltip="Total unique products found during the discovery phase by scanning retailer category pages." />
        <StatCard label="Variants Extracted" value={job.variants_extracted || 0}
          tooltip="Individual SKU-level records (one per color + size combination) successfully pulled from retailer APIs." />
        <StatCard label="Failed Products" value={job.failed_products?.length ?? 0}
          tooltip="Products where variant data could not be retrieved after all retry attempts."
          className={(job.failed_products?.length ?? 0) > 0 ? 'border-red-300' : undefined} />
        <StatCard label="Duration" value={job.started_at && job.completed_at
          ? formatDuration(new Date(job.completed_at).getTime() - new Date(job.started_at).getTime())
          : '—'}
          tooltip="Wall-clock time from job start to Excel file generation." />
      </div>

      {/* Row 1: Coverage + Phase Timing */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CoverageFunnel
          discovered={job.products_discovered || 0}
          processed={job.products_processed || 0}
          extracted={job.variants_extracted || 0}
          failed={job.failed_products?.length ?? 0}
        />
        <PhaseTimingChart timings={analytics.phase_timings} />
      </div>

      {/* Row 2: Price Distribution + Discount */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PriceDistribution data={analytics.price_distribution} />
        <DiscountSummary
          avgDiscountPct={analytics.discount_summary.avg_discount_pct}
          onSaleCount={analytics.discount_summary.on_sale_count}
          fullPriceCount={analytics.discount_summary.full_price_count}
        />
      </div>

      {/* Row 3: Heatmap + Completeness */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <VariantHeatmap
            colors={analytics.variant_heatmap.colors}
            sizes={analytics.variant_heatmap.sizes}
            matrix={analytics.variant_heatmap.matrix}
          />
        </div>
        <DataCompleteness completeness={analytics.data_completeness} />
      </div>
    </div>
  );
}
