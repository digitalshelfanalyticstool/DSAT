'use client';

import React, { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button, Pagination } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { apiClient } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { formatDateTime } from '@/lib/format';
import { crumbs } from '@/lib/routes';

const PAGE_SIZE = 20;

function truncate(text: string, maxLength = 80): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export default function AdminDlqPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();
  const { confirm, ConfirmDialogHost } = useConfirm();

  const [currentPage, setCurrentPage] = useState(1);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const { data, loading, refetch: loadJobs } = useAsyncResource(
    () => apiClient.getFailedJobs(currentPage, PAGE_SIZE),
    {
      auto: authChecked,
      deps: [currentPage],
      onError: (err) => showToast(err.message || 'Failed to load failed jobs', 'error'),
    },
  );
  const jobs = data?.jobs ?? [];
  const total = data?.total ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleRetry = async (jobId: string) => {
    setActionLoading(jobId);
    try {
      await apiClient.retryFailedJob(jobId);
      showToast('Job retried successfully', 'success');
      loadJobs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to retry job', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDiscard = async (jobId: string) => {
    setActionLoading(jobId);
    try {
      await apiClient.discardFailedJob(jobId);
      showToast('Job discarded', 'success');
      loadJobs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to discard job', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetryAll = async () => {
    const ok = await confirm({
      title: 'Retry all failed jobs',
      message: 'Retry all failed jobs? This will re-queue them for processing.',
      confirmLabel: 'Retry All',
      confirmVariant: 'primary',
    });
    if (!ok) return;
    setActionLoading('bulk');
    try {
      const res = await apiClient.retryAllFailedJobs();
      const failedNote = res.failed > 0 ? `, ${res.failed} failed` : '';
      showToast(`Retried ${res.retried} jobs${failedNote}`, 'success');
      loadJobs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to retry all', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDiscardAll = async () => {
    const ok = await confirm({
      title: 'Discard all failed jobs',
      message: 'Discard all failed jobs? This cannot be undone.',
      confirmLabel: 'Discard All',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    setActionLoading('bulk');
    try {
      const res = await apiClient.discardAllFailedJobs();
      const failedNote = res.failed > 0 ? `, ${res.failed} failed` : '';
      showToast(`Discarded ${res.discarded} jobs${failedNote}`, 'success');
      loadJobs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to discard all', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  if (!authChecked) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <ConfirmDialogHost />
      <Breadcrumbs
        items={crumbs('/admin/dlq')}
      />
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-ink">Failed Jobs</h1>
            <p className="mt-1 text-ink-muted">{total} failed job{total === 1 ? '' : 's'} in queue</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={loadJobs} disabled={loading}>
              Refresh
            </Button>
            {total > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRetryAll}
                  disabled={actionLoading === 'bulk'}
                >
                  Retry All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDiscardAll}
                  disabled={actionLoading === 'bulk'}
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  Discard All
                </Button>
              </>
            )}
          </div>
        </div>

        {loading && (
          <Card><div className="text-center py-8">Loading failed jobs...</div></Card>
        )}
        {!loading && jobs.length === 0 && (
          <Card>
            <div className="text-center py-12">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-surface-tertiary mb-3">
                <svg className="h-5 w-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="font-display text-base font-semibold text-ink">No failed jobs</p>
              <p className="mt-1 text-sm text-ink-muted">Everything is running smoothly.</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="outline" size="sm" onClick={loadJobs}>Refresh</Button>
                <Button variant="outline" size="sm" onClick={() => { globalThis.location.href = '/jobs/history'; }}>
                  Go to Job History
                </Button>
              </div>
            </div>
          </Card>
        )}
        {!loading && jobs.length > 0 && (
          <>
            <Card className="overflow-x-auto">
              <table className="min-w-full divide-y divide-hairline">
                <thead className="bg-surface-secondary">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Job ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Site</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Brand</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Failed At</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Error</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Attempts</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-ink-muted uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-hairline">
                  {jobs.map((job) => (
                    <React.Fragment key={job.id}>
                      <tr
                        className="hover:bg-surface-secondary cursor-pointer"
                        onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-ink-muted">
                          {job.jobId.slice(0, 8)}...
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">{job.site}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink">{job.brand}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                          {job.finishedOn ? formatDateTime(job.finishedOn) : '—'}
                        </td>
                        <td className="px-6 py-4 text-sm text-red-600 max-w-xs" title={job.failedReason}>
                          {truncate(job.failedReason)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">{job.attemptsMade}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                          {/* NOSONAR(typescript:S6847,typescript:S6848,typescript:S6819): the
                              outer <div> is a defensive bubble-blocker — the
                              parent <tr> at line 212 has onClick to toggle
                              expanded state, and this wrapper stops clicks on
                              the Retry/Discard buttons from also toggling the
                              row. role="group" is the correct ARIA semantic
                              for a toolbar of action buttons. The matching
                              onKeyDown mirrors the same stopPropagation for
                              Enter/Space, completing the ARIA contract.
                              S6819: <fieldset>/<details>/<optgroup>/<address>
                              don't fit — this is a toolbar of action buttons
                              inside a <td>, not a labeled form-control group;
                              <fieldset>'s UA-default border + min-width:min-content
                              would break the table-cell flex layout. */}
                          <div // NOSONAR(typescript:S6847,typescript:S6848,typescript:S6819): see rationale block above.
                            className="flex justify-end gap-2"
                            role="group"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
                          >
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRetry(job.id)}
                              disabled={actionLoading === job.id}
                            >
                              Retry
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDiscard(job.id)}
                              disabled={actionLoading === job.id}
                              className="text-red-600 border-red-200 hover:bg-red-50"
                            >
                              Discard
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {expandedJob === job.id && (
                        <tr>
                          <td colSpan={7} className="px-6 py-4 bg-surface-secondary">
                            <div className="space-y-2">
                              <div>
                                <span className="text-xs font-semibold text-ink-muted uppercase">Full Job ID</span>
                                <p className="text-sm font-mono text-ink">{job.jobId}</p>
                              </div>
                              <div>
                                <span className="text-xs font-semibold text-ink-muted uppercase">Error Message</span>
                                <p className="text-sm text-red-700">{job.failedReason}</p>
                              </div>
                              {job.stacktrace.length > 0 && (
                                <div>
                                  <span className="text-xs font-semibold text-ink-muted uppercase">Stack Trace</span>
                                  <pre className="mt-1 p-3 bg-ink text-green-400 text-xs rounded-lg overflow-x-auto max-h-48">
                                    {job.stacktrace.join('\n')}
                                  </pre>
                                </div>
                              )}
                              <div className="flex gap-6 text-xs text-ink-muted">
                                <span>Created: {formatDateTime(job.timestamp)}</span>
                                {job.processedOn && <span>Processed: {formatDateTime(job.processedOn)}</span>}
                                {job.finishedOn && <span>Finished: {formatDateTime(job.finishedOn)}</span>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
