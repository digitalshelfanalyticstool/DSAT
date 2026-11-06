'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileExpiredError, SessionExpiredError } from '@/lib/api/http';
import { apiClient } from '@/lib/api-client';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { MainLayout } from '@/components/layout/MainLayout';
import { useToast } from '@/components/ui/Toast';
import { useConfig } from '@/providers/ConfigProvider';
import { formatDateTime } from '@/lib/format';
import type { Job } from '@/lib/api-client';
import { JobStatusBadge } from '@/components/jobs/JobStatusBadge';

interface Filters {
  site: string;
  brand: string;
  status: string;
  date_from: string;
  date_to: string;
}

function JobHistoryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const { sites: allSites, brands: allBrands } = useConfig();
  const sites = allSites.map((s) => s.name);
  const brands = allBrands.map((b) => b.name);
  const [jobs, setJobs] = useState<Job[]>([]);
  // `loading` is true ONLY for the initial fetch (first paint, no rows yet);
  // `isFetching` is true for every refetch after that. Re-filtering or paging
  // keeps the existing rows on screen with `aria-busy="true"` instead of
  // flashing the skeleton (which made the page feel like it lost data).
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isFinite(p) && p > 0 ? p : 1;
  });
  const [totalPages, setTotalPages] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const pageSize = 25;

  const [filters, setFilters] = useState<Filters>(() => ({
    site: searchParams.get('site') ?? '',
    brand: searchParams.get('brand') ?? '',
    status: searchParams.get('status') ?? '',
    date_from: searchParams.get('date_from') ?? '',
    date_to: searchParams.get('date_to') ?? '',
  }));

  // Sync URL when filters or page change
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.site) params.set('site', filters.site);
    if (filters.brand) params.set('brand', filters.brand);
    if (filters.status) params.set('status', filters.status);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);
    if (currentPage > 1) params.set('page', String(currentPage));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }, [filters, currentPage, router]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [jobBandwidth, setJobBandwidth] = useState<Record<string, { bytesDownloaded: number; bytesUploaded: number; estimatedCost: number } | null>>({});

  useEffect(() => {
    setSelectedIds(new Set());
    loadJobs();
  }, [currentPage, filters]);

  // Fetch bandwidth data for completed/failed jobs in the current page — one batched request
  useEffect(() => {
    const missing = jobs
      .filter((j) => (j.status === 'completed' || j.status === 'failed') && jobBandwidth[j.job_id] === undefined)
      .map((j) => j.job_id);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.getJobsBandwidth(missing);
        if (cancelled) return;
        setJobBandwidth((prev) => {
          const next = { ...prev };
          for (const id of missing) {
            const hit = res.results[id];
            next[id] = hit
              ? {
                  bytesDownloaded: hit.bandwidth.bytesDownloaded,
                  bytesUploaded: hit.bandwidth.bytesUploaded,
                  estimatedCost: hit.estimatedCost,
                }
              : null;
          }
          return next;
        });
      } catch {
        if (cancelled) return;
        setJobBandwidth((prev) => {
          const next = { ...prev };
          for (const id of missing) next[id] = null;
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);


  const loadJobs = async () => {
    // First load shows the skeleton; subsequent loads show isFetching only.
    if (jobs.length === 0) {
      setLoading(true);
    } else {
      setIsFetching(true);
    }
    setError('');

    try {
      const params: {
        page: number;
        page_size: number;
        site?: string;
        brand?: string;
        status?: string;
        date_from?: string;
        date_to?: string;
      } = {
        page: currentPage,
        page_size: pageSize,
      };

      if (filters.site) params.site = filters.site;
      if (filters.brand) params.brand = filters.brand;
      if (filters.status) params.status = filters.status;
      if (filters.date_from) params.date_from = filters.date_from;
      if (filters.date_to) params.date_to = filters.date_to;

      const response = await apiClient.getJobs(params);
      setJobs(response.jobs);
      setTotalPages(response.total_pages);
      setTotalJobs(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
      setIsFetching(false);
    }
  };

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCurrentPage(1);
  };

  const handleClearFilters = () => {
    setFilters({
      site: '',
      brand: '',
      status: '',
      date_from: '',
      date_to: '',
    });
    setCurrentPage(1);
  };

  const [reExportingJobId, setReExportingJobId] = useState<string | null>(null);

  const handleDownload = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      await apiClient.downloadFile(jobId);
    } catch (err: unknown) {
      if (err instanceof FileExpiredError) {
        showToast(
          'This file has been cleaned up. Click "Regenerate" to re-create it.',
          'info',
        );
        setReExportingJobId(jobId);
        return;
      }
      // SessionExpiredError: the browser is already on its way to /login.
      if (!(err instanceof SessionExpiredError)) {
        showToast(err instanceof Error ? err.message : 'Download failed', 'error');
      }
    }
  };

  const handleReExport = async (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    try {
      setReExportingJobId(jobId);
      const result = await apiClient.reExportFile(jobId);
      if (result.success) {
        showToast('File regenerated successfully. Starting download...', 'success');
        setReExportingJobId(null);
        await apiClient.downloadFile(jobId);
      }
    } catch (err: unknown) {
      const error = err as Error;
      showToast(`Re-export failed: ${error.message}`, 'error');
      setReExportingJobId(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(ids.map((id) => apiClient.deleteJob(id)));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    showToast(
      failed === 0 ? `${succeeded} job(s) deleted` : `${succeeded} deleted, ${failed} failed`,
      failed === 0 ? 'success' : 'error',
    );
    setSelectedIds(new Set());
    loadJobs();
  };

  const columns = [
    {
      header: '',
      accessor: 'job_id' as const,
      headerRender: () => (
        <input
          type="checkbox"
          checked={jobs.length > 0 && selectedIds.size === jobs.length}
          onChange={(e) => {
            e.stopPropagation();
            if (e.target.checked) {
              setSelectedIds(new Set(jobs.map((j) => j.job_id)));
            } else {
              setSelectedIds(new Set());
            }
          }}
          className="rounded border-hairline"
        />
      ),
      render: (job: Job) => (
        <input
          type="checkbox"
          checked={selectedIds.has(job.job_id)}
          onChange={(e) => {
            e.stopPropagation();
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(job.job_id);
              else next.delete(job.job_id);
              return next;
            });
          }}
          onClick={(e) => e.stopPropagation()}
          className="rounded border-hairline"
        />
      ),
    },
    {
      header: 'Job ID',
      accessor: 'job_id' as const,
      render: (job: Job) => (
        <a
          href={`/jobs/${job.job_id}`}
          className="font-mono text-sm text-accent hover:text-accent-dark"
          title={job.job_id}
          onClick={(e) => {
            e.stopPropagation();
            router.push(`/jobs/${job.job_id}`);
            e.preventDefault();
          }}
        >
          {job.job_id.slice(0, 8)}
        </a>
      ),
    },
    {
      header: 'Site',
      accessor: 'site' as const,
    },
    {
      header: 'Brand',
      accessor: 'brand' as const,
    },
    {
      header: 'Status',
      accessor: 'status' as const,
      render: (job: Job) => <JobStatusBadge status={job.status} />,
    },
    {
      header: 'User',
      accessor: 'username' as const,
      render: (job: Job) => job.owner?.username || job.username || job.user_id,
    },
    {
      header: 'Created',
      accessor: 'created_at' as const,
      render: (job: Job) => formatDateTime(job.created_at),
    },
    {
      header: 'Products',
      accessor: 'products_processed' as const,
      render: (job: Job) =>
        job.status === 'completed' ? job.products_processed || 0 : '-',
    },
    {
      header: 'Variants',
      accessor: 'variants_extracted' as const,
      render: (job: Job) =>
        job.status === 'completed' ? job.variants_extracted || 0 : '-',
    },
    {
      header: 'Bandwidth',
      accessor: 'job_id' as const,
      render: (job: Job) => {
        if (job.status !== 'completed' && job.status !== 'failed') return '-';
        const bw = jobBandwidth[job.job_id];
        if (bw === undefined) return <span className="text-ink-muted text-xs" aria-hidden="true">...</span>;
        if (bw === null) return <span className="text-ink-muted">N/A</span>;
        const totalGB = (bw.bytesDownloaded + bw.bytesUploaded) / 1073741824;
        return <span className="text-sm">{totalGB < 0.01 ? `${(totalGB * 1024).toFixed(1)} MB` : `${totalGB.toFixed(2)} GB`}</span>;
      },
    },
    {
      header: 'Est. Cost',
      accessor: 'job_id' as const,
      render: (job: Job) => {
        if (job.status !== 'completed' && job.status !== 'failed') return '-';
        const bw = jobBandwidth[job.job_id];
        if (bw === undefined) return <span className="text-ink-muted text-xs" aria-hidden="true">...</span>;
        if (bw === null) return <span className="text-ink-muted">N/A</span>;
        return <span className="text-sm">${bw.estimatedCost.toFixed(2)}</span>;
      },
    },
    {
      header: 'Actions',
      accessor: 'job_id' as const,
      render: (job: Job) => (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/jobs/create?site=${encodeURIComponent(job.site)}&brand=${encodeURIComponent(job.brand)}`);
            }}
          >
            Run Again
          </Button>
          {job.status === 'completed' && (
            reExportingJobId === job.job_id ? (
              <Button
                size="sm"
                variant="primary"
                onClick={(e) => handleReExport(e, job.job_id)}
              >
                Regenerate
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => handleDownload(e, job.job_id)}
              >
                Download
              </Button>
            )
          )}
        </div>
      ),
    },
  ];

  return (
    <MainLayout>
      <div className={totalPages > 1 ? 'pb-16' : ''}>
      <div className="animate-in mb-6 flex justify-between items-center">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Job History</h1>
          <p className="text-ink-muted mt-1">
            {totalJobs} total job{totalJobs !== 1 ? 's' : ''}
          </p>
        </div>
        <Button onClick={() => router.push('/jobs/create')}>
          Create New Job
        </Button>
      </div>

      <div className="animate-in-delay mb-6 space-y-6 relative z-10" style={{ '--stagger': 1 } as React.CSSProperties}>
        <h2 className="font-display text-lg font-bold text-ink">Filters</h2>
        <div className="flex gap-2">
          {([
            ['Last 7 days', 7],
            ['Last 30 days', 30],
            ['This month', 0],
          ] as const).map(([label, days]) => (
            <Button
              key={label}
              variant="outline"
              size="sm"
              onClick={() => {
                const now = new Date();
                let dateFrom: string;
                if (days === 0) {
                  dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
                } else {
                  const from = new Date(now);
                  from.setDate(from.getDate() - days);
                  dateFrom = from.toISOString().split('T')[0];
                }
                const dateTo = now.toISOString().split('T')[0];
                setFilters((prev) => ({ ...prev, date_from: dateFrom, date_to: dateTo }));
                setCurrentPage(1);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <Select
            label="Site"
            placeholder="All sites"
            value={filters.site}
            onChange={(e) => handleFilterChange('site', e.target.value)}
            options={[
              { value: '', label: 'All sites' },
              ...sites.map((site) => ({ value: site, label: site })),
            ]}
          />

          <Select
            label="Brand"
            placeholder="All brands"
            value={filters.brand}
            onChange={(e) => handleFilterChange('brand', e.target.value)}
            options={[
              { value: '', label: 'All brands' },
              ...brands.map((brand) => ({ value: brand, label: brand })),
            ]}
          />

          <Select
            label="Status"
            placeholder="All statuses"
            value={filters.status}
            onChange={(e) => handleFilterChange('status', e.target.value)}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'queued', label: 'Queued' },
              { value: 'running', label: 'Running' },
              { value: 'completed', label: 'Completed' },
              { value: 'failed', label: 'Failed' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />

          <Input
            label="From Date"
            type="date"
            value={filters.date_from}
            onChange={(e) => handleFilterChange('date_from', e.target.value)}
          />

          <Input
            label="To Date"
            type="date"
            value={filters.date_to}
            onChange={(e) => handleFilterChange('date_to', e.target.value)}
          />
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={handleClearFilters}>
            Clear Filters
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3">
          <svg className="w-5 h-5 shrink-0 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span className="text-sm">{error}</span>
        </div>
      )}

      {(() => {
        const jobsContent = jobs.length === 0 ? (
          <div className="animate-in-delay text-center py-20" style={{ '--stagger': 2 } as React.CSSProperties}>
            <svg className="w-16 h-16 text-ink-muted mx-auto mb-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
            <p className="font-display text-lg font-bold text-ink mb-1">No jobs found</p>
            <p className="text-ink-muted text-sm mb-6">Try adjusting your filters or create a new job.</p>
            <Button variant="primary" onClick={() => router.push('/jobs/create')}>
              Create New Job
            </Button>
          </div>
        ) : (
          <>
            {/* Keep the table mounted during refilters; aria-busy on
                the wrapper tells AT users a refresh is in progress without
                removing rows from the DOM. */}
            <div aria-busy={isFetching ? 'true' : undefined} data-testid="jobs-history-table-wrapper">
              <Card className="animate-in-delay" style={{ '--stagger': 2 } as React.CSSProperties}>
                <Table
                  columns={columns}
                  data={jobs}
                />
              </Card>
            </div>

            {totalPages > 1 && (
              <div
                className="fixed bottom-0 left-0 right-0 z-30 bg-surface/80 backdrop-blur-lg border-t border-hairline/60 shadow-premium py-3 px-4"
                // Add home-indicator safe-area on notched iPhones so the pagination
                // bar isn't hidden behind the system gesture bar.
                style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
              >
                <div className="container mx-auto">
                  <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={setCurrentPage}
                  />
                </div>
              </div>
            )}
          </>
        );

        return loading ? (
          <div className="animate-in-delay space-y-2" style={{ '--stagger': 2 } as React.CSSProperties}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          jobsContent
        );
      })()}
      </div>

      {selectedIds.size > 0 && (
        <div
          className={`fixed ${totalPages > 1 ? 'bottom-20' : 'bottom-6'} left-1/2 -translate-x-1/2 z-40 bg-ink text-white px-5 py-3 rounded-xl shadow-premium-lg flex items-center gap-4 text-sm`}
          role="status"
          aria-live="polite"
          aria-label={`${selectedIds.size} job${selectedIds.size !== 1 ? 's' : ''} selected`}
        >
          <span>{selectedIds.size} selected</span>
          <Button size="sm" variant="danger" onClick={handleBulkDelete}>
            Delete
          </Button>
        </div>
      )}
    </MainLayout>
  );
}

export default function JobHistoryPage() {
  return (
    <Suspense fallback={
      <MainLayout>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton h-14 w-full rounded-xl" />
          ))}
        </div>
      </MainLayout>
    }>
      <JobHistoryPageInner />
    </Suspense>
  );
}
