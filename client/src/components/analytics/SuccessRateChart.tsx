'use client';

import React from 'react';
import { ChartCard } from '@/components/ui/ChartCard';
import { useSiteLabel } from '@/providers/ConfigProvider';

interface SuccessRateChartProps {
  data: { site: string; success_rate: number }[];
}

function getBarColor(rate: number): string {
  if (rate >= 95) return 'var(--color-success)';
  if (rate >= 90) return 'var(--color-warning)';
  return 'var(--color-error)';
}

function getTextColor(rate: number): string {
  if (rate >= 95) return 'text-emerald-700';
  if (rate >= 90) return 'text-amber-700';
  return 'text-red-700';
}

export const SuccessRateChart: React.FC<SuccessRateChartProps> = ({ data }) => {
  const siteLabel = useSiteLabel();
  const isEmpty = !data || data.length === 0;
  const avg = isEmpty ? 0 : data.reduce((sum, d) => sum + d.success_rate, 0) / data.length;

  const tableContent = (
    <>
      <thead>
        <tr>
          <th scope="col">Retailer</th>
          <th scope="col">Success Rate</th>
        </tr>
      </thead>
      <tbody>
        {data.map((item) => (
          <tr key={item.site}>
            <td>{siteLabel(item.site)}</td>
            <td>{item.success_rate.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </>
  );

  return (
    <ChartCard
      title="Success Rates"
      tooltip="Percentage of scraping jobs that completed successfully per retailer. Green ≥95%, amber ≥90%, red <90%."
      titleClassName="flex items-center gap-1 text-sm font-semibold text-ink mb-3"
      isEmpty={isEmpty}
      emptyMessage="No success rate data available"
      emptyClassName="text-sm text-ink-muted text-center py-8"
      summary={`Bar chart of success rates across ${data.length} retailers (avg ${avg.toFixed(1)}%).`}
      tableContent={tableContent}
    >
      <div className="space-y-3">
        {data.map((item) => {
          const pct = Math.min(Math.max(item.success_rate, 0), 100);
          const barColor = getBarColor(pct);
          const textColor = getTextColor(pct);
          const label = siteLabel(item.site);

          return (
            <div key={item.site}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-sm font-medium text-ink">{label}</span>
                <span className={`text-xs font-semibold ${textColor}`}>{pct.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-surface-tertiary rounded-full h-5 overflow-hidden">
                <div
                  className="h-5 rounded-full flex items-center justify-end pr-2 transition-all duration-500"
                  style={{ width: `${pct}%`, backgroundColor: barColor }}
                >
                  {pct >= 20 && (
                    <span className="text-white text-xs font-semibold">{pct.toFixed(1)}%</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
};
