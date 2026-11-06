'use client';

import React from 'react';
import type { RetailerCompleteness as RetailerCompletenessData } from '@/lib/api-client';
import { ChartCard } from '@/components/ui/ChartCard';
import { formatNumber } from '@/lib/format';

interface RetailerCompletenessProps {
  retailers: RetailerCompletenessData[];
  loading?: boolean;
}

const FIELDS = [
  { key: 'upc_pct', label: 'UPC' },
  { key: 'selling_price_pct', label: 'Price' },
  { key: 'list_price_pct', label: 'List Price' },
  { key: 'inventory_pct', label: 'Inventory' },
  { key: 'item_number_pct', label: 'Item #' },
] as const;

function getBarColor(pct: number): string {
  if (pct >= 90) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-accent-500';
  if (pct >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

const TOOLTIP_TEXT = "Percentage of scraped variants that have each data field populated (UPC, price, list price, inventory, item number). Low values indicate missing data from the retailer's API.";

export const RetailerCompleteness: React.FC<RetailerCompletenessProps> = ({ retailers, loading = false }) => {
  return (
    <ChartCard
      title="Data Completeness by Retailer"
      tooltip={TOOLTIP_TEXT}
      loading={loading}
      loadingSkeleton={
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 bg-surface-secondary rounded animate-pulse" />
          ))}
        </div>
      }
      isEmpty={retailers.length === 0}
      emptyMessage="No completeness data available"
      emptyClassName="text-sm text-ink-muted text-center py-8"
      summary={
        <>
          Field-completeness bar chart for {retailers.length} retailers across {FIELDS.length} fields.
        </>
      }
      tableContent={
        <>
          <thead>
            <tr>
              <th scope="col">Retailer</th>
              <th scope="col">Variants</th>
              {FIELDS.map((f) => (
                <th key={f.key} scope="col">{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {retailers.map((r) => (
              <tr key={r.site}>
                <td>{r.site}</td>
                <td>{formatNumber(r.total_variants)}</td>
                {FIELDS.map((f) => (
                  <td key={f.key}>{r[f.key]}%</td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      }
    >
      <div className="space-y-4">
        {retailers.map((r) => (
          <div key={r.site}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-medium text-ink capitalize">{r.site}</span>
              <span className="text-ink-muted">{formatNumber(r.total_variants)} variants</span>
            </div>
            <div className="space-y-1">
              {FIELDS.map((f) => {
                const pct = r[f.key];
                return (
                  <div key={f.key} className="flex items-center gap-2">
                    <span className="text-[10px] text-ink-muted w-14 text-right">{f.label}</span>
                    <div className="flex-1 bg-surface-tertiary rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-3 rounded-full transition-all duration-500 ${getBarColor(pct)}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-ink-muted w-8">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
};
