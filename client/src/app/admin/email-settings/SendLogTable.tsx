'use client';

import { useState } from 'react';
import { Card, Select, Badge } from '@/components/ui';
import { apiClient, type EmailLogEntry } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { usePolling } from '@/hooks/usePolling';
import { formatDate, formatTime } from '@/lib/format';

export function SendLogTable() {
  const [status, setStatus] = useState('');
  const [expandedErrorId, setExpandedErrorId] = useState<number | null>(null);

  const { data, loading, refetch } = useAsyncResource<EmailLogEntry[]>(
    async () => {
      const response = await apiClient.listEmailLog({ status: status || undefined, limit: 100 });
      return response.success ? response.log : [];
    },
    { deps: [status], onError: 'toast' },
  );
  const log: EmailLogEntry[] = data ?? [];

  // Auto-refresh every 30s while mounted, paused when the tab is hidden.
  usePolling(refetch, 30_000, { whenVisible: true });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    );
  }

  const statusOptions = [
    { value: '', label: 'All statuses' },
    { value: 'sent', label: 'Sent' },
    { value: 'failed', label: 'Failed' },
    { value: 'skipped', label: 'Skipped' },
  ];

  const getStatusBadgeVariant = (s: string): 'success' | 'error' | 'warning' | 'default' => {
    switch (s) {
      case 'sent': return 'success';
      case 'failed': return 'error';
      case 'skipped': return 'warning';
      default: return 'default';
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={statusOptions}
        />
      </div>

      <Card className="overflow-hidden">
        {log.length === 0 ? (
          <div className="text-center py-12">
            <svg className="w-12 h-12 text-ink-muted mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <h3 className="font-display text-lg font-semibold text-ink mb-1">No send logs</h3>
            <p className="text-sm text-ink-muted">Email send attempts will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto -m-6">
            <table className="min-w-full divide-y divide-hairline">
              <thead className="bg-surface-secondary/80">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Sent</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">To</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Template</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Latency</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {log.map((entry) => (
                  <tr key={entry.id} className="hover:bg-surface-secondary/50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                      {formatDate(entry.sent_at)} {formatTime(entry.sent_at, { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">{entry.to_address}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                      {entry.template_slug ? (
                        <code className="bg-surface-tertiary px-2 py-1 rounded text-xs font-mono">{entry.template_slug}</code>
                      ) : (
                        <span className="text-ink-muted">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <Badge variant={getStatusBadgeVariant(entry.status)}>
                        {entry.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                      {entry.latency_ms ? `${entry.latency_ms}ms` : '-'}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      {entry.error ? (
                        <div className="max-w-xs">
                          <p className="text-red-700 truncate">
                            {(() => {
                              if (expandedErrorId === entry.id) return entry.error;
                              const ellipsis = entry.error.length > 50 ? '...' : '';
                              return entry.error.substring(0, 50) + ellipsis;
                            })()}
                          </p>
                          {entry.error.length > 50 && (
                            <button
                              onClick={() => setExpandedErrorId(expandedErrorId === entry.id ? null : entry.id)}
                              className="text-xs text-accent hover:text-accent-dark mt-1"
                            >
                              {expandedErrorId === entry.id ? 'Collapse' : 'Expand'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-ink-muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-ink-muted">Auto-refreshing every 30 seconds</p>
    </div>
  );
}
