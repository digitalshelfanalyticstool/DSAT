'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Pagination } from '@/components/ui/Pagination';
import { ALERTS_READ_EVENT } from '@/components/layout/Sidebar';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import type { AlertFilter, AlertItem, AlertKind, Brand, Site } from '@/lib/api-client';
import { KIND_OPTIONS, alertTitle, errorText, money, siteOptions, brandOptions } from './format';

const PAGE_SIZE = 50;

interface Props {
  sites: Site[];
  brands: Brand[];
  onShowRules?: () => void;
}

/** The current filter without its empty fields. */
function activeFilter(f: AlertFilter): AlertFilter {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as AlertFilter;
}

function priceChange(details: Record<string, unknown>): string | null {
  const from = money(details.old_price);
  const to = money(details.new_price);
  if (from && to) return `${from} → ${to}`;
  return to;
}

export function AlertList({ sites, brands, onShowRules }: Readonly<Props>) {
  const [filter, setFilter] = useState<AlertFilter>({});
  const [show, setShow] = useState<'all' | 'unread'>('all');
  const [page, setPage] = useState(1);
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    // Responses apply in request order: a slow earlier filter must not overwrite a later one.
    let current = true;
    apiClient.getAlerts({ ...activeFilter(filter), unread: show === 'unread' ? true : undefined, page, limit: PAGE_SIZE }).then(
      (r) => {
        if (!current) return;
        setAlerts(r.alerts);
        setTotal(r.total);
        setError('');
      },
      (err) => current && setError(errorText(err)),
    );
    return () => { current = false; };
  }, [filter, show, page, reload]);

  const changeFilter = (patch: Partial<AlertFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const markRead = useCallback(async (body: Parameters<typeof apiClient.markAlertsRead>[0]) => {
    try {
      await apiClient.markAlertsRead(body);
      globalThis.dispatchEvent(new Event(ALERTS_READ_EVENT));
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <Select
          label="Type"
          value={filter.kind ?? ''}
          options={[{ value: '', label: 'All types' }, ...KIND_OPTIONS]}
          onChange={(e) => changeFilter({ kind: (e.target.value || undefined) as AlertKind | undefined })}
        />
        <Select
          label="Retailer"
          value={filter.site ?? ''}
          options={[{ value: '', label: 'All retailers' }, ...siteOptions(sites)]}
          onChange={(e) => changeFilter({ site: e.target.value || undefined })}
        />
        <Select
          label="Brand"
          value={filter.brand ?? ''}
          options={[{ value: '', label: 'All brands' }, ...brandOptions(brands)]}
          onChange={(e) => changeFilter({ brand: e.target.value || undefined })}
        />
        <Select
          label="Show"
          value={show}
          options={[{ value: 'all', label: 'All alerts' }, { value: 'unread', label: 'Unread only' }]}
          onChange={(e) => { setShow(e.target.value as 'all' | 'unread'); setPage(1); }}
        />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">{total} {total === 1 ? 'alert' : 'alerts'}</p>
        <Button variant="secondary" size="sm" onClick={() => markRead({ filter: activeFilter(filter) })} disabled={total === 0}>
          Mark all read
        </Button>
      </div>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {alerts?.length === 0 && (
        <div className="rounded-lg border border-hairline p-6 text-sm text-ink-muted">
          No alerts. They appear after a job finishes and one of your rules matches.
          {onShowRules && (
            <> <button className="text-accent hover:underline" onClick={onShowRules}>Set up rules</button>.</>
          )}
        </div>
      )}

      <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
        {alerts?.map((a) => {
          const title = a.product_title || a.style_id;
          const prices = a.kind === 'price_below' || a.kind === 'price_drop' ? priceChange(a.details) : null;
          return (
            <li key={a.id} data-testid="alert-row" className={`flex flex-wrap items-start gap-x-4 gap-y-1 p-4 ${a.read ? '' : 'bg-accent-50/40'}`}>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm">
                  {!a.read && <span className="inline-block w-2 h-2 mr-2 rounded-full bg-accent" aria-label="Unread" />}
                  <span className="font-semibold text-ink">{alertTitle(a.kind, a.details)}</span>
                  {prices && <span className="ml-2 text-ink">{prices}</span>}
                </p>
                <p className="text-sm text-ink">
                  <span>{title}</span>
                  <span className="text-ink-muted"> · {a.retailer} · {a.brand}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  {formatDateTime(a.created_at)} · rule “{a.rule_name}”
                  {a.kind === 'broken_image' && typeof a.details.image_url === 'string' && a.details.image_url && (
                    <> · <a href={a.details.image_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">image</a></>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {a.product_url && (
                  <a href={a.product_url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent hover:underline">
                    View on retailer
                  </a>
                )}
                {!a.read && (
                  <Button variant="outline" size="sm" onClick={() => markRead({ ids: [a.id] })}>Mark read</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {total > PAGE_SIZE && (
        <Pagination currentPage={page} totalPages={Math.ceil(total / PAGE_SIZE)} onPageChange={setPage} />
      )}
    </div>
  );
}
