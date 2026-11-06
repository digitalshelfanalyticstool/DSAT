'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { apiClient } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { UpcomingSchedulesWidget } from '@/components/dashboard/UpcomingSchedulesWidget';
import { BandwidthTrendWidget } from '@/components/dashboard/BandwidthTrendWidget';
import { TopRetailersWidget, COST_PERIOD_OPTIONS } from '@/components/dashboard/TopRetailersWidget';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ChangeSummaryCards } from '@/components/dashboard/ChangeSummaryCards';
import { UpdatedAgo } from '@/components/dashboard/UpdatedAgo';
import { formatDateTime } from '@/lib/format';
import { useBandwidthBilling } from '@/hooks/useBandwidthBilling';
import { usePolling } from '@/hooks/usePolling';
import type { Job, JobStats as Stats } from '@/lib/api-client';
import { JobStatusBadge } from '@/components/jobs/JobStatusBadge';

// Module-level helpers extracted to avoid nesting > 4 levels (sonarjs/no-nested-functions).
function byCreatedAtDesc(a: Job, b: Job): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

function reinsertJob(prev: Job[], job: Job): Job[] {
  if (prev.some((j) => j.job_id === job.job_id)) return prev;
  return [...prev, job].sort(byCreatedAtDesc);
}

export default function DashboardPage() {
  const router = useRouter();
  const { showToast } = useToast();
  // SessionProvider caches /auth/session for 60s across pages, so navigating Dashboard → Analytics → Dashboard fires one
  // /session request, not three.
  const { user, authChecked } = useRequireAuth();
  const bandwidthBilled = useBandwidthBilling(user?.role === 'admin');
  const [stats, setStats] = useState<Stats>({ jobsToday: 0, activeJobs: 0, recentCompletions: 0 });
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [costPeriod, setCostPeriod] = useState('month');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDashboardData = useCallback(async () => {
    try {
      const response = await apiClient.getJobStats();
      setRecentJobs(response.recentJobs);
      setStats(response.stats);
      setLastUpdatedAt(Date.now());
    } catch (err: unknown) {
      console.error('Failed to load dashboard data:', err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // useRequireAuth handles redirect to /login on auth error; only load data once auth is checked.
    if (!authChecked) return;
    loadDashboardData().finally(() => setLoading(false));
  }, [authChecked, loadDashboardData]);

  // Poll fast while jobs are queued or running, slowly until the first load
  // lands, and not at all once idle and populated (nothing on the
  // page would change). Paused while the tab is hidden.
  const hasActiveJobs = recentJobs.some(j => j.status === 'queued' || j.status === 'running');
  let pollMs: number | null = null;
  if (autoRefresh && !loading) {
    if (hasActiveJobs) pollMs = 5_000;
    else if (lastUpdatedAt === null) pollMs = 60_000;
  }
  usePolling(loadDashboardData, pollMs, { whenVisible: true });

  const handleDeleteJob = useCallback((jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const removedJob = recentJobs.find((j) => j.job_id === jobId);
    if (!removedJob) return;

    // Optimistically remove from list
    setRecentJobs((prev) => prev.filter((j) => j.job_id !== jobId));
    setDeletingJobId(jobId);

    // Clear any existing undo timer
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);

    // Show undo toast — API call fires after toast expires
    showToast('Job deleted.', 'info', {
      label: 'Undo',
      onClick: () => {
        // Restore the job
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        setRecentJobs((prev) => reinsertJob(prev, removedJob));
        setDeletingJobId(null);
      },
    });

    undoTimerRef.current = setTimeout(async () => {
      try {
        await apiClient.deleteJob(jobId);
        await loadDashboardData();
      } catch (err) {
        console.error('Failed to delete job:', err);
        // Restore on failure
        setRecentJobs((prev) => reinsertJob(prev, removedJob));
      } finally {
        setDeletingJobId(null);
      }
    }, 4200);
  }, [recentJobs, showToast, loadDashboardData]);

  if (loading) {
    return (
      <MainLayout>
        <div className="space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <div className="skeleton h-9 w-48 mb-2" />
              <div className="skeleton h-5 w-64" />
            </div>
            <div className="skeleton h-12 w-40 rounded-md" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="surface-card p-6">
                <div className="skeleton h-4 w-20 mb-3" />
                <div className="skeleton h-8 w-24" />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-20 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="animate-in flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-3xl font-bold text-ink">Dashboard</h1>
              <button
                onClick={() => setAutoRefresh((v) => !v)}
                aria-label={autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
                aria-pressed={autoRefresh}
                title="Toggle auto-refresh (pauses polling)"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  autoRefresh
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-surface-tertiary text-ink-muted hover:bg-surface-tertiary'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-ink-muted'}`} />
                {autoRefresh ? 'Live' : 'Paused'}
              </button>
              {lastUpdatedAt !== null && <UpdatedAgo since={lastUpdatedAt} />}
            </div>
            <p className="mt-1 text-ink-muted">Welcome back, {user?.username}</p>
          </div>
          <Link href="/jobs/create">
            <Button variant="primary" size="lg">
              Create New Job
            </Button>
          </Link>
        </div>

        {/* Stat Cards */}
        <div className="animate-in-delay grid grid-cols-1 md:grid-cols-3 gap-6" style={{ '--stagger': 1 } as React.CSSProperties}>
          {/* Jobs Today */}
          <div className="surface-card p-6">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
              <span className="text-sm text-ink-muted">Jobs Today</span>
              <InfoTooltip text="Number of scraping jobs created today" />
            </div>
            <p className="text-3xl font-display font-bold tabular-nums text-ink">{stats.jobsToday}</p>
          </div>

          {/* Active Jobs */}
          <div className="surface-card p-6">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
              </svg>
              <span className="text-sm text-ink-muted">Active Jobs</span>
              <InfoTooltip text="Jobs currently in progress (running or queued)" />
            </div>
            <p className="text-3xl font-display font-bold tabular-nums text-accent">{stats.activeJobs}</p>
          </div>

          {/* Completions */}
          <div className="surface-card p-6">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              <span className="text-sm text-ink-muted">Completions</span>
              <InfoTooltip text="Jobs completed in the last 24 hours" />
            </div>
            <p className="text-3xl font-display font-bold tabular-nums text-emerald-600">{stats.recentCompletions}</p>
          </div>
        </div>

        {/* Change Summary */}
        <div className="animate-in-delay" style={{ '--stagger': 2 } as React.CSSProperties}>
          <ChangeSummaryCards />
        </div>

        {/* Upcoming Schedules — visible to all users */}
        <div className="animate-in-delay grid grid-cols-1 gap-6" style={{ '--stagger': 3 } as React.CSSProperties}>
          <div className="surface-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline">
              <h2 className="font-display font-semibold text-sm text-ink flex items-center gap-1.5">Upcoming Schedules <InfoTooltip text="Scheduled scraping jobs that will run automatically" /></h2>
            </div>
            <div className="p-5">
              <UpcomingSchedulesWidget />
            </div>
          </div>
        </div>

        {/* Admin Widgets — both read Bright Data usage, so only while it is the provider */}
        {user?.role === 'admin' && bandwidthBilled && (
          <div className="animate-in-delay grid grid-cols-1 md:grid-cols-2 gap-6" style={{ '--stagger': 4 } as React.CSSProperties}>
            <div className="surface-card overflow-hidden">
              <div className="px-5 py-4 border-b border-hairline">
                <h2 className="font-display font-semibold text-sm text-ink flex items-center gap-1.5">Bandwidth (7 days) <InfoTooltip text="Total data downloaded via Bright Data over the last 7 days" /></h2>
              </div>
              <div className="p-5">
                <BandwidthTrendWidget />
              </div>
            </div>

            <div className="surface-card overflow-hidden">
              <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                <h2 className="font-display font-semibold text-sm text-ink flex items-center gap-1.5">Top Retailers (Cost) <InfoTooltip text="Estimated Bright Data cost by retailer based on bandwidth usage and configured $/GB rate" /></h2>
                <select
                  value={costPeriod}
                  onChange={(e) => setCostPeriod(e.target.value)}
                  className="text-xs px-2 py-1 border border-hairline rounded-md text-ink-muted bg-surface cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {COST_PERIOD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="p-5">
                <TopRetailersWidget period={costPeriod} />
              </div>
            </div>
          </div>
        )}

        {/* Recent Jobs */}
        <div className="animate-in-delay" style={{ '--stagger': 5 } as React.CSSProperties}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-lg font-semibold text-ink">Recent Jobs</h2>
            <Link href="/jobs/history" className="text-sm font-medium text-accent hover:text-accent-dark transition-colors">
              View All
            </Link>
          </div>

          {recentJobs.length === 0 ? (
            <div className="surface-card text-center py-12 px-6">
              <div className="w-12 h-12 rounded-xl bg-surface-tertiary flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 0 0 .75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 0 0-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0 1 12 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 0 1-.673-.38m0 0A2.18 2.18 0 0 1 3 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 0 1 3.413-.387m7.5 0V5.25A2.25 2.25 0 0 0 13.5 3h-3a2.25 2.25 0 0 0-2.25 2.25v.894m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </div>
              {/* Distinguish "paused by user" from "no jobs yet" so the CTA
                  matches the actual user state. */}
              {autoRefresh ? (
                <>
                  <p className="text-ink mb-2 font-medium">No jobs yet</p>
                  <p className="text-ink-muted mb-4">Create your first job to get started.</p>
                  <Link href="/jobs/create">
                    <Button variant="primary">
                      Create New Job
                    </Button>
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-ink mb-2 font-medium">Auto-refresh is paused</p>
                  <p className="text-ink-muted mb-4">Recent jobs won't update until you resume.</p>
                  <Button variant="primary" onClick={() => setAutoRefresh(true)}>
                    Resume live updates
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {recentJobs.map((job) => (
                <div
                  key={job.job_id}
                  className="surface-card p-4 hover:shadow-premium transition-all duration-200"
                >
                  <div className="flex items-center justify-between">
                    <Link
                      href={`/jobs/${job.job_id}`}
                      className="flex-1 min-w-0 rounded focus:outline-none focus:ring-2 focus:ring-accent/50 -m-1 p-1"
                    >
                      <div className="flex items-center gap-3">
                        <h3 className="font-display font-semibold text-ink truncate">
                          {job.site} - {job.brand}
                        </h3>
                        <JobStatusBadge status={job.status} />
                      </div>
                      <p className="text-sm text-ink-muted mt-1">
                        {formatDateTime(job.created_at)}
                      </p>
                      {job.status === 'completed' && (
                        <p className="text-sm text-ink-muted mt-0.5">
                          {job.products_discovered || 0} products, {job.variants_extracted || 0} variants
                        </p>
                      )}
                    </Link>
                    <div className="flex gap-2 ml-4 flex-shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          // ?quick_rerun=true tells
                          // /jobs/create to auto-submit on mount when site+brand are
                          // both present — collapses the two-page friction (open form
                          // → click submit) into one click on the dashboard.
                          router.push(
                            `/jobs/create?site=${encodeURIComponent(job.site)}&brand=${encodeURIComponent(job.brand)}&quick_rerun=true`,
                          );
                        }}
                      >
                        Run Again
                      </Button>
                      {(job.status === 'queued' || job.status === 'completed' || job.status === 'failed') && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={(e) => handleDeleteJob(job.job_id, e)}
                          disabled={deletingJobId === job.job_id}
                        >
                          {deletingJobId === job.job_id ? 'Deleting...' : 'Delete'}
                        </Button>
                      )}
                      <Link
                        href={`/jobs/${job.job_id}`}
                        className="inline-flex items-center rounded-lg border border-hairline bg-surface text-ink px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:bg-surface-secondary hover:border-hairline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2"
                      >
                        View Details
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
