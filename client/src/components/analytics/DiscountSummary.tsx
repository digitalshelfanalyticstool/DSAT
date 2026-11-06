'use client';

import React from 'react';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatNumber } from '@/lib/format';

interface DiscountSummaryProps {
  avgDiscountPct: number;
  onSaleCount: number;
  fullPriceCount: number;
}

export const DiscountSummary: React.FC<DiscountSummaryProps> = ({
  avgDiscountPct,
  onSaleCount,
  fullPriceCount,
}) => {
  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
      <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Discount Summary
        <InfoTooltip text="Average percentage difference between list price and selling price across all variants on sale." />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="text-center">
          <p className="text-2xl font-bold text-ink">
            {avgDiscountPct.toFixed(1)}%
          </p>
          <p className="text-xs text-ink-muted mt-1">Avg Discount</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-emerald-600">
            {formatNumber(onSaleCount)}
          </p>
          <p className="text-xs text-ink-muted mt-1">On Sale</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-ink">
            {formatNumber(fullPriceCount)}
          </p>
          <p className="text-xs text-ink-muted mt-1">Full Price</p>
        </div>
      </div>
    </div>
  );
};
