'use client';

import React, { useState, useEffect } from 'react';
import type { StaleProduct } from '@/lib/api-client';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatDate } from '@/lib/format';

interface StaleProductsTableProps {
  products: StaleProduct[];
  loading?: boolean;
}

const PAGE_SIZE = 10;

export const StaleProductsTable: React.FC<StaleProductsTableProps> = ({ products, loading = false }) => {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [products]);
  const totalPages = Math.ceil(products.length / PAGE_SIZE);
  const paged = products.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (loading) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
        <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">Stale Products <InfoTooltip text="Products that failed to scrape in 5+ jobs within the selected window (threshold configurable). May have been removed from the retailer's site — click a link to verify. Rows without a title/link are products that have only ever failed." /></div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 bg-surface-secondary rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
        <div className="text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5">Stale Products <InfoTooltip text="Products that failed to scrape in 5+ jobs within the selected window (threshold configurable). May have been removed from the retailer's site — click a link to verify. Rows without a title/link are products that have only ever failed." /></div>
        <p className="text-sm text-ink-muted text-center py-8">No stale products found</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-ink-muted flex items-center gap-1.5">
          Stale Products <span className="text-ink-muted">({products.length})</span> <InfoTooltip text="Products that failed to scrape in 5+ jobs within the selected window (threshold configurable). May have been removed from the retailer's site — click a link to verify. Rows without a title/link are products that have only ever failed." />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table">
          <thead>
            <tr className="border-b border-hairline">
              <th className="py-2 pr-4 text-left text-xs font-medium text-ink-muted uppercase">Product</th>
              <th className="py-2 pr-4 text-left text-xs font-medium text-ink-muted uppercase">Retailer</th>
              <th className="py-2 pr-4 text-right text-xs font-medium text-ink-muted uppercase">Failures</th>
              <th className="py-2 text-right text-xs font-medium text-ink-muted uppercase">Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((p) => (
              <tr key={`${p.retailer}-${p.style_id}`} className="border-b border-hairline">
                <td className="py-2 pr-4">
                  {p.url ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline truncate block max-w-[200px]"
                      title={p.title || p.style_id}
                    >
                      {p.title || p.style_id}
                    </a>
                  ) : (
                    <span className="text-ink truncate block max-w-[200px]" title={p.title || p.style_id}>
                      {p.title || p.style_id}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-ink-muted capitalize">{p.retailer}</td>
                <td className="py-2 pr-4 text-right">
                  <span className="text-red-600 font-medium">{p.consecutive_failures}</span>
                </td>
                <td className="py-2 text-right text-ink-muted">
                  {p.last_seen_at ? formatDate(p.last_seen_at) : '\u2014'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-ink-muted">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-hairline disabled:opacity-40 hover:bg-surface-secondary"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded border border-hairline disabled:opacity-40 hover:bg-surface-secondary"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
