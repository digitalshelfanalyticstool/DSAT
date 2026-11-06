'use client';

import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button, Select, Input, Pagination } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { apiClient } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import type { AuditLogEntry } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { formatDateTime } from '@/lib/format';
import { crumbs } from '@/lib/routes';

const PAGE_SIZE = 50;

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'create_user', label: 'Create User' },
  { value: 'update_user', label: 'Update User' },
  { value: 'delete_user', label: 'Delete User' },
  { value: 'reactivate_user', label: 'Reactivate User' },
  { value: 'view_user', label: 'View User' },
  { value: 'delete_job', label: 'Delete Job' },
  { value: 'login', label: 'Login' },
  { value: 'logout', label: 'Logout' },
  { value: 'failed_login', label: 'Failed Login' },
];

const RESOURCE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'user', label: 'User' },
  { value: 'job', label: 'Job' },
  { value: 'session', label: 'Session' },
];

export default function AdminAuditLogsPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();

  const [currentPage, setCurrentPage] = useState(1);

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Page and filters are the source of truth; the response supplies the totals.
  // `auto: authChecked` holds the fetch until the admin gate opens.
  const { data, loading } = useAsyncResource(
    async () => {
      const filters: {
        page: number;
        limit: number;
        action?: string;
        resource_type?: string;
        start_date?: string;
        end_date?: string;
      } = {
        page: currentPage,
        limit: PAGE_SIZE,
      };
      if (actionFilter) filters.action = actionFilter;
      if (resourceFilter) filters.resource_type = resourceFilter;
      if (startDate) filters.start_date = startDate;
      if (endDate) filters.end_date = endDate;

      return apiClient.getAuditLogs(filters);
    },
    {
      auto: authChecked,
      deps: [currentPage, actionFilter, resourceFilter, startDate, endDate],
      onError: 'toast',
    },
  );

  const logs: AuditLogEntry[] = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const handleClearFilters = () => {
    setActionFilter('');
    setResourceFilter('');
    setStartDate('');
    setEndDate('');
    setCurrentPage(1);
  };

  const formatAction = (action: string) => {
    return action.replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase());
  };

  if (!authChecked) {
    return (
      <div className="min-h-dvh bg-surface-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    );
  }

  return (
    <MainLayout>
      <Breadcrumbs
        items={crumbs('/admin/audit-logs')}
      />
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-ink">Audit Logs</h1>
          <p className="mt-1 text-ink-muted">{total} total entr{total === 1 ? 'y' : 'ies'}</p>
        </div>

        {/* Filters */}
        <Card>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Select
              label="Action"
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setCurrentPage(1); }}
              options={ACTION_OPTIONS}
            />
            <Select
              label="Resource Type"
              value={resourceFilter}
              onChange={(e) => { setResourceFilter(e.target.value); setCurrentPage(1); }}
              options={RESOURCE_OPTIONS}
            />
            <Input
              label="From Date"
              type="date"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setCurrentPage(1); }}
            />
            <Input
              label="To Date"
              type="date"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setCurrentPage(1); }}
            />
          </div>
          <div className="mt-4 flex justify-between">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={async () => {
                try {
                  const params = new URLSearchParams();
                  params.set('format', 'csv');
                  if (actionFilter) params.set('action', actionFilter);
                  if (resourceFilter) params.set('resource_type', resourceFilter);
                  if (startDate) params.set('start_date', startDate);
                  if (endDate) params.set('end_date', endDate);
                  await apiClient.downloadExport(`/admin/audit-logs/export?${params.toString()}`, 'audit-logs.csv');
                } catch (err) {
                  showToast(err instanceof Error ? err.message : 'Export failed', 'error');
                }
              }}>Export CSV</Button>
              <Button variant="outline" size="sm" onClick={async () => {
                try {
                  const params = new URLSearchParams();
                  params.set('format', 'json');
                  if (actionFilter) params.set('action', actionFilter);
                  if (resourceFilter) params.set('resource_type', resourceFilter);
                  if (startDate) params.set('start_date', startDate);
                  if (endDate) params.set('end_date', endDate);
                  await apiClient.downloadExport(`/admin/audit-logs/export?${params.toString()}`, 'audit-logs.json');
                } catch (err) {
                  showToast(err instanceof Error ? err.message : 'Export failed', 'error');
                }
              }}>Export JSON</Button>
            </div>
            <Button variant="outline" size="sm" onClick={handleClearFilters}>Clear Filters</Button>
          </div>
        </Card>

        {/* Logs table */}
        {loading && (
          <Card><div className="text-center py-8">Loading audit logs...</div></Card>
        )}
        {!loading && logs.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-surface-tertiary mb-3">
                {/* eslint-disable-next-line no-restricted-syntax -- decorative empty-state icon, aria-hidden */}
                <svg className="h-5 w-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="font-display text-base font-semibold text-ink">No audit logs found</p>
              <p className="mt-1 text-sm text-ink-muted">Try adjusting your filters to see more activity.</p>
              <div className="mt-4 flex justify-center">
                <Button variant="outline" size="sm" onClick={handleClearFilters}>Clear filters</Button>
              </div>
            </div>
          </Card>
        )}
        {!loading && logs.length > 0 && (
          <>
            <Card className="overflow-x-auto">
              <table className="min-w-full divide-y divide-hairline">
                <thead className="bg-surface-secondary">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Timestamp</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">User</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Action</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Resource</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Resource ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Details</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-hairline">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-surface-secondary">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                        {formatDateTime(typeof log.created_at === 'number' ? log.created_at * 1000 : log.created_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">
                        {log.user?.username || (log.user?.id ? `User #${log.user.id}` : '—')}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">
                        {formatAction(log.action)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                        {log.resource_type}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                        {log.resource_name || log.resource_id || '—'}
                      </td>
                      <td className="px-6 py-4 text-sm text-ink-muted max-w-xs truncate" title={log.details || ''}>
                        {log.details || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {totalPages > 1 && (
              <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
