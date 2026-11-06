'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, Button } from '@/components/ui';
import { apiClient } from '@/lib/api-client';
import type { CacheInventoryEntry as CacheInfo } from '@/lib/api-client';
import { formatBytes } from '@/lib/format';

interface CatalogCachePanelProps {
  showToast: (msg: string, type: 'success' | 'error') => void;
  confirmAction: (title: string, message: string, isDanger: boolean) => Promise<boolean>;
}

function formatAge(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Admin panel: lists the on-disk discovery/variant caches and lets an admin purge
 * a poisoned one (move-aside on the server), forcing fresh discovery next run.
 * Receives showToast/confirmAction as props so it stays trivially testable.
 */
export function CatalogCachePanel({ showToast, confirmAction }: Readonly<CatalogCachePanelProps>) {
  const [caches, setCaches] = useState<CacheInfo[] | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.getCacheInventory();
      setCaches(res.caches);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load caches', 'error');
      setCaches([]);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handlePurge = async (c: CacheInfo) => {
    const ok = await confirmAction(
      `Purge ${c.site} / ${c.brand}`,
      'Move this discovery + variant cache aside? The next run will re-discover from scratch.',
      true,
    );
    if (!ok) return;

    const key = `${c.site}/${c.brand}`;
    setPurging(key);
    try {
      const result = await apiClient.healthAction('purge-cache', { site: c.site, brand: c.brand });
      showToast(result.message, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Purge failed', 'error');
    } finally {
      setPurging(null);
    }
  };

  const handlePurgeAll = async () => {
    const ok = await confirmAction(
      'Purge all catalog caches',
      `Move all ${caches?.length ?? 0} discovery + variant cache(s) aside? The next run for each will re-discover from scratch.`,
      true,
    );
    if (!ok) return;

    setPurging('__ALL__');
    try {
      const result = await apiClient.healthAction('purge-all-caches');
      showToast(result.message, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Purge all failed', 'error');
    } finally {
      setPurging(null);
    }
  };

  return (
    <Card className="p-4">
      {/* Header mirrors ActionsPanel on this page: full-width toggle, caret on
          the far right, so the carets of stacked panels line up. The panel's
          action buttons live inside the expanded body — they can't sit in the
          header without nesting interactive elements in the toggle button. */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <h3 className="text-sm font-semibold text-ink">Catalog Caches</h3>
        <svg
          className={`h-4 w-4 text-ink-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={purging !== null} onClick={() => void load()}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={purging !== null || caches === null || caches.length === 0}
              onClick={() => void handlePurgeAll()}
            >
              {purging === '__ALL__' ? 'Purging All…' : 'Purge All'}
            </Button>
          </div>

          {caches === null && <p className="text-sm text-ink-muted">Loading…</p>}
          {caches !== null && caches.length === 0 && (
            <p className="text-sm text-ink-muted">No catalog caches found.</p>
          )}

          {caches !== null && caches.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-muted uppercase tracking-wide">
                    <th className="py-1 pr-3">Site</th>
                    <th className="py-1 pr-3">Brand</th>
                    <th className="py-1 pr-3 text-right">Discovery</th>
                    <th className="py-1 pr-3 text-right">Age</th>
                    <th className="py-1 pr-3 text-right">Variants</th>
                    <th className="py-1 pr-3">Status</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {caches.map((c) => {
                    const key = `${c.site}/${c.brand}`;
                    return (
                      <tr
                        key={key}
                        className={`border-t border-hairline ${c.suspectedPoisoned ? 'bg-amber-50' : ''}`}
                      >
                        <td className="py-1.5 pr-3 text-ink">{c.site}</td>
                        <td className="py-1.5 pr-3 text-ink">{c.brand}</td>
                        <td className="py-1.5 pr-3 text-right text-ink-muted">{formatBytes(c.discoveryBytes)}</td>
                        <td className="py-1.5 pr-3 text-right text-ink-muted">{formatAge(c.discoveryAgeHours)}</td>
                        <td className="py-1.5 pr-3 text-right text-ink-muted">{c.variantProductCount}</td>
                        <td className="py-1.5 pr-3">
                          {c.suspectedPoisoned
                            ? <span className="text-amber-700 font-medium">Suspected poisoned</span>
                            : <span className="text-emerald-700">OK</span>}
                        </td>
                        <td className="py-1.5 text-right">
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={purging !== null}
                            onClick={() => handlePurge(c)}
                          >
                            {purging === key ? 'Purging…' : 'Purge'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
