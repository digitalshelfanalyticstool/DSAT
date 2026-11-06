'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useSiteLabel } from '@/providers/ConfigProvider';

const PAGE_SIZE = 10;

function truncate(text: string, maxLength = 35): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

interface TopProductsTableProps {
  data: {
    product_name: string;
    product_url: string | null;
    retailer: string;
    variant_count: number;
    colors: string[];
  }[];
}

export const TopProductsTable: React.FC<TopProductsTableProps> = ({ data }) => {
  const siteLabel = useSiteLabel();
  const [retailerFilter, setRetailerFilter] = useState('');
  const [page, setPage] = useState(1);

  const retailers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of data) {
      const key = d.retailer.toLowerCase();
      if (!seen.has(key)) seen.set(key, d.retailer);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const matchesRetailer = (retailer: string) =>
    retailer.toLowerCase() === retailerFilter.toLowerCase();

  const filtered = useMemo(() => {
    return retailerFilter ? data.filter(d => matchesRetailer(d.retailer)) : data;
  }, [data, retailerFilter]);

  useEffect(() => {
    setPage(1);
  }, [data, retailerFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (!data || data.length === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
        <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
          Top Products by Variants
          <InfoTooltip text="Products with the most unique color + size combinations in the selected period." />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">No product data available</p>
      </div>
    );
  }

  const maxVariants = Math.max(...filtered.map(d => d.variant_count), 1);

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1 text-sm font-semibold text-ink">
          Top Products by Variants
          <InfoTooltip text="Products with the most unique color + size combinations in the selected period." />
        </div>
        <div className="flex items-center gap-3">
          {retailers.length > 1 && (
            <select
              value={retailerFilter}
              onChange={(e) => setRetailerFilter(e.target.value)}
              aria-label="Filter products by retailer"
              className="text-xs border border-hairline rounded-lg px-2.5 py-1.5 bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              <option value="">All Retailers</option>
              {retailers.map(r => (
                <option key={r} value={r}>{siteLabel(r)}</option>
              ))}
            </select>
          )}
          <span className="text-xs text-ink-muted">
            {filtered.length} product{filtered.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline">
              <th className="text-left text-xs font-semibold text-ink-muted pb-2 pr-3">Product</th>
              <th className="text-left text-xs font-semibold text-ink-muted pb-2 px-3">Retailer</th>
              <th className="text-left text-xs font-semibold text-ink-muted pb-2 px-3">Colors</th>
              <th className="text-right text-xs font-semibold text-ink-muted pb-2 pl-3">Variants</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((item) => (
              <tr key={`${item.retailer}-${item.product_name}`} className="border-b border-hairline hover:bg-surface-secondary transition-colors">
                <td className="py-2 pr-3 font-medium">
                  {item.product_url ? (
                    <a
                      href={item.product_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:text-accent hover:underline transition-colors"
                      title={item.product_name}
                    >
                      {truncate(item.product_name)}
                    </a>
                  ) : (
                    <span className="text-ink" title={item.product_name}>
                      {truncate(item.product_name)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-ink-muted text-xs whitespace-nowrap">
                  {siteLabel(item.retailer)}
                </td>
                <td className="py-2 px-3">
                  <div className="flex flex-wrap gap-1">
                    {item.colors.slice(0, 4).map(color => (
                      <span
                        key={color}
                        className="inline-block px-1.5 py-0.5 rounded bg-surface-tertiary text-ink-muted text-[10px] font-medium"
                      >
                        {color}
                      </span>
                    ))}
                    {item.colors.length > 4 && (
                      <span
                        className="inline-block px-1.5 py-0.5 rounded bg-surface-secondary text-ink-muted text-[10px] font-medium"
                        title={item.colors.join(', ')}
                      >
                        +{item.colors.length - 4}
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pl-3">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-20 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent-500 rounded-full"
                        style={{ width: `${(item.variant_count / maxVariants) * 100}%` }}
                      />
                    </div>
                    <span className="text-ink tabular-nums font-medium text-xs w-8 text-right">
                      {item.variant_count}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-sm text-ink-muted">
                  No products for this retailer
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-hairline">
          <span className="text-xs text-ink-muted">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-ink-muted hover:bg-surface-tertiary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`w-7 h-7 rounded-md text-xs font-medium transition-colors ${
                  p === page
                    ? 'bg-accent text-white'
                    : 'text-ink-muted hover:bg-surface-tertiary'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-ink-muted hover:bg-surface-tertiary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
