'use client';

import React from 'react';
import Link from 'next/link';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';
import { useSiteLabel } from '@/providers/ConfigProvider';

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700',
  running: 'bg-accent-50 text-accent',
  failed: 'bg-red-50 text-red-700',
  queued: 'bg-surface-secondary text-ink-muted',
  cancelled: 'bg-amber-50 text-amber-700',
};

interface RecentJobsTableProps {
  data: {
    job_id: string;
    site: string;
    brand: string;
    status: string;
    products_discovered: number;
    variants_extracted: number;
    completed_at: string | null;
  }[];
}

export const RecentJobsTable: React.FC<RecentJobsTableProps> = ({ data }) => {
  const siteLabel = useSiteLabel();
  if (!data || data.length === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
        <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
          Recent Jobs
          <InfoTooltip text="The most recent scraping jobs run in the selected time period." />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">No jobs in this period</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
      <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Recent Jobs
        <InfoTooltip text="The most recent scraping jobs run in the selected time period." />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              <th className="text-left text-xs font-semibold text-ink-muted pb-2 pr-3">Retailer</th>
              <th className="text-left text-xs font-semibold text-ink-muted pb-2 px-3">Brand</th>
              <th className="text-center text-xs font-semibold text-ink-muted pb-2 px-3">Status</th>
              <th className="text-right text-xs font-semibold text-ink-muted pb-2 px-3">Products</th>
              <th className="text-right text-xs font-semibold text-ink-muted pb-2 pl-3">Variants</th>
            </tr>
          </thead>
          <tbody>
            {data.map((job) => (
              <tr key={job.job_id} className="border-b border-hairline hover:bg-surface-secondary transition-colors">
                <td className="py-2 pr-3 text-ink font-medium">
                  {siteLabel(job.site)}
                </td>
                <td className="py-2 px-3 text-ink-muted">
                  <Link
                    href={`/jobs/${job.job_id}`}
                    className="text-accent hover:text-accent hover:underline transition-colors"
                  >
                    {job.brand}
                  </Link>
                </td>
                <td className="py-2 px-3 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[job.status] || 'bg-surface-secondary text-ink-muted'}`}>
                    {job.status}
                  </span>
                </td>
                <td className="py-2 px-3 text-right text-ink tabular-nums">
                  {formatNumber(job.products_discovered)}
                </td>
                <td className="py-2 pl-3 text-right text-ink tabular-nums">
                  {formatNumber(job.variants_extracted)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
