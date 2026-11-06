'use client';

import { useState } from 'react';
import { Card, Button } from '@/components/ui';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { apiClient } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import type { CostAggregation, RetailerCostSummary } from '@/lib/api-client';
import { formatDate, formatNumber } from '@/lib/format';

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
] as const;

/** Format bytes to human-readable GB string */
function formatGB(gb: number): string {
  if (gb < 0.01) return `${(gb * 1024).toFixed(2)} MB`;
  return `${gb.toFixed(2)} GB`;
}

/** Format dollar amount */
function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/** Simple horizontal bar chart for comparing retailer bandwidth */
function RetailerBarChart({ retailers }: Readonly<{ retailers: RetailerCostSummary[] }>) {
  const maxBytes = Math.max(...retailers.map((r) => r.totalBytes), 1);

  return (
    <div className="space-y-3" role="img" aria-label="Retailer bandwidth comparison chart">
      {retailers.map((r) => {
        const pct = (r.totalBytes / maxBytes) * 100;
        return (
          <div key={r.site} className="flex items-center gap-3">
            <span className="text-sm text-ink w-28 shrink-0 truncate" title={r.site}>
              {r.site}
            </span>
            <div className="flex-1 bg-surface-tertiary rounded h-6 overflow-hidden">
              <div
                className="h-full rounded transition-all duration-300"
                style={{
                  width: `${Math.max(pct, pct > 0 ? 1 : 0)}%`,
                  backgroundColor: '#0066CC',
                }}
              />
            </div>
            <span className="text-sm text-ink-muted w-20 text-right shrink-0">
              {formatGB(r.totalGigabytes)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function RetailerCostSection() {
  const { showToast } = useToast();
  const [period, setPeriod] = useState('30d');
  const [excludeAdmin, setExcludeAdmin] = useState(false);
  // Cost rate editing
  const [editingRate, setEditingRate] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [savingRate, setSavingRate] = useState(false);

  const [exporting, setExporting] = useState(false);

  const { data, loading, error: loadError, refetch: fetchCosts } = useAsyncResource<CostAggregation>(
    async () => (await apiClient.getRetailerCosts(period, undefined, undefined, excludeAdmin)).data,
    { deps: [period, excludeAdmin], onError: 'toast' },
  );
  const error = loadError?.message ?? null;
  // Derived rather than mirrored into its own state: the save handler refetches
  // immediately, so a separate `costRate` could only ever hold the same value
  // one render earlier.
  const costRate = data?.costRate ?? null;

  const handleSaveRate = async () => {
    const newRate = Number.parseFloat(rateInput);
    if (Number.isNaN(newRate) || newRate < 0) {
      showToast('Please enter a valid non-negative number', 'error');
      return;
    }
    setSavingRate(true);
    try {
      await apiClient.updateCostRate(newRate);
      setEditingRate(false);
      showToast('Cost rate updated', 'success');
      // Recalculate costs with new rate without full reload
      await fetchCosts();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSavingRate(false);
    }
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      await apiClient.downloadRetailerCostsCsv(period, undefined, undefined, excludeAdmin);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setExporting(false);
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600 mx-auto" />
          <p className="text-sm text-ink-muted mt-2">Loading retailer costs...</p>
        </div>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <div className="text-center py-8">
          <p className="text-red-600 mb-4">{error}</p>
          <Button onClick={fetchCosts} variant="primary" size="sm">Retry</Button>
        </div>
      </Card>
    );
  }

  const retailers = data?.retailers ?? [];

  return (
    <div className="space-y-6">
      {/* Header with period selector and actions */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <h2 className="text-lg font-normal text-black">Retailer Cost Analytics</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <Select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
              aria-label="Select time period"
            />
            <label
              className="flex items-center gap-1.5 text-sm text-ink-muted cursor-pointer select-none"
              title="Hide jobs initiated by accounts with admin role. Useful when admins occasionally trigger preview/test scrapes; off by default since admin accounts also run production scrapes."
            >
              <input
                type="checkbox"
                checked={excludeAdmin}
                onChange={(e) => setExcludeAdmin(e.target.checked)}
                className="rounded border-hairline text-accent focus:ring-accent-500"
              />
              <span>Hide admin test runs</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={exporting || !data}
            >
              {exporting ? 'Exporting...' : 'Export CSV'}
            </Button>
          </div>
        </div>

        {/* Cost rate display/editor */}
        <div className="flex items-center gap-2 text-sm text-ink-muted mb-4">
          <span>Cost Rate:</span>
          {editingRate ? (
            <div className="flex items-center gap-2">
              <span>$</span>
              <Input
                type="number"
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                className="w-24"
                min="0"
                step="0.01"
                aria-label="Cost per GB"
              />
              <span>/GB</span>
              <Button size="sm" variant="primary" onClick={handleSaveRate} disabled={savingRate}>
                {savingRate ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditingRate(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <button
              onClick={() => {
                setRateInput(String(costRate ?? 3));
                setEditingRate(true);
              }}
              className="text-accent hover:text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 rounded px-1"
            >
              {formatCost(costRate ?? 3)}/GB
            </button>
          )}
        </div>

        {/* Period range */}
        {data?.period && (
          <p className="text-xs text-ink-muted">
            {formatDate(data.period.from)} — {formatDate(data.period.to)}
          </p>
        )}
      </Card>

      {/* Summary totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <p className="text-sm text-ink-muted">Total Bandwidth</p>
          <p className="text-2xl font-semibold text-black mt-1">
            {formatGB(data?.totalGigabytes ?? 0)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-muted">Total Estimated Cost</p>
          <p className="text-2xl font-semibold text-black mt-1">
            {formatCost(data?.totalCost ?? 0)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-muted">Total Requests</p>
          <p className="text-2xl font-semibold text-black mt-1">
            {formatNumber(retailers.reduce((sum, r) => sum + r.requestCount, 0))}
          </p>
        </Card>
      </div>

      {/* Per-retailer cards */}
      {retailers.length === 0 ? (
        <Card>
          <p className="text-center text-ink-muted py-4">No retailer cost data for this period.</p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {retailers.map((r) => (
              <Card key={r.site}>
                <h3 className="text-sm font-medium text-ink mb-2">{r.site}</h3>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Bandwidth</span>
                    <span className="font-medium">{formatGB(r.totalGigabytes)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Cost</span>
                    <span className="font-medium">{formatCost(r.estimatedCost)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Requests</span>
                    <span className="font-medium">{formatNumber(r.requestCount)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Jobs</span>
                    <span className="font-medium">{r.jobCount}</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Bar chart */}
          <Card>
            <h3 className="text-sm font-medium text-ink mb-3">Bandwidth by Retailer</h3>
            <RetailerBarChart retailers={retailers} />
          </Card>
        </>
      )}
    </div>
  );
}
