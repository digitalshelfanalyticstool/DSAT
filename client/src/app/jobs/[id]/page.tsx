'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { FileExpiredError, SessionExpiredError } from '@/lib/api/http';
import { apiClient } from '@/lib/api-client';
import type { JobBandwidthRecord, JobAnalytics } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { MainLayout } from '@/components/layout/MainLayout';
import { JobAnalyticsPanel } from '@/components/jobs/JobAnalyticsPanel';
import { formatDateTime } from '@/lib/format';
import { useJobStream } from '@/hooks/useJobStream';
import type { Job } from '@/lib/api-client';
import { crumbs } from '@/lib/routes';
import { JobStatusBadge } from '@/components/jobs/JobStatusBadge';

/** Encapsulates download + re-export state to reduce component complexity. */
function useDownloadReExport(jobId: string, setError: (msg: string) => void) {
  const [fileExpired, setFileExpired] = useState(false);
  const [reExporting, setReExporting] = useState(false);
  // Clicking Download twice would fire two downloads. Same
  // shape as `reExporting` above — disable button + swap label while in-flight.
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await apiClient.downloadFile(jobId);
    } catch (err: unknown) {
      if (err instanceof FileExpiredError) {
        setFileExpired(true);
        setError('This file has been cleaned up to save disk space. Click "Regenerate" to re-create it.');
        return;
      }
      // SessionExpiredError: the browser is already on its way to /login.
      if (!(err instanceof SessionExpiredError)) {
        setError(err instanceof Error ? err.message : 'Download failed');
      }
    } finally {
      setDownloading(false);
    }
  };

  const handleReExport = async () => {
    setReExporting(true);
    setError('');
    try {
      const result = await apiClient.reExportFile(jobId);
      if (result.success) {
        setFileExpired(false);
        setReExporting(false);
        await apiClient.downloadFile(jobId);
      }
    } catch (err: unknown) {
      const error = err as Error;
      setError(`Re-export failed: ${error.message}`);
      setReExporting(false);
    }
  };

  return { fileExpired, reExporting, downloading, handleDownload, handleReExport };
}

/** Phase configuration for visual stepper */
const PHASES = [
  { id: 'discovery', label: 'Discovery', description: 'Finding products' },
  { id: 'processing', label: 'Processing', description: 'Preparing products' },
  { id: 'variants', label: 'Variants', description: 'Extracting details' },
  { id: 'excel', label: 'Excel', description: 'Generating report' },
] as const;

/** Get user-facing message for the current job phase */
function getPhaseMessage(phase?: string | null): string {
  switch (phase) {
    case 'discovery':
      return 'Starting Scraping Service';
    case 'processing':
      return 'Products are being processed for download.';
    case 'variants':
      return 'Product Variants are being fetched.';
    case 'excel':
      return 'Generating Excel file for you.';
    default:
      return 'Starting Scraping Service';
  }
}

/** Get the current phase index for progress visualization */
function getCurrentPhaseIndex(phase?: string | null): number {
  const index = PHASES.findIndex(p => p.id === phase);
  return Math.max(index, 0);
}

function phaseTextColor(isActive: boolean, isCompleted: boolean): string {
  if (isActive) return 'text-accent';
  if (isCompleted) return 'text-green-600';
  return 'text-ink-muted';
}

function estimateTimeRemaining(job: Job | null): string {
  if (job?.status !== 'running' || !job.products_discovered || !job.products_processed) {
    return 'Calculating...';
  }
  const elapsed = Date.now() - new Date(job.created_at).getTime();
  const avgTimePerProduct = elapsed / job.products_processed;
  const remaining = (job.products_discovered - job.products_processed) * avgTimePerProduct;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  if (minutes > 0) return `~${minutes}m ${seconds}s`;
  return `~${seconds}s`;
}

function calculateJobProgress(job: Job | null): number {
  if (!job?.products_discovered || job.products_discovered === 0) return 0;
  return Math.round(((job.products_processed || 0) / job.products_discovered) * 100);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- intrinsic complexity: a JSX page with several independent lifecycles (checkpoint, bandwidth, analytics, the completion funnel) plus conditional rendering across five job states. The SSE machine and its eight refs moved to hooks/useJobStream, which is what the earlier version of this justification claimed could not be extracted -- that was true of extracting SUBCOMPONENTS (which would prop-drill the refs), not of extracting the hook, where the refs travel with the logic. NOSONAR(typescript:S3776).
export default function JobStatusPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;
  // The SSE engine (stream + reconnect/backoff + heartbeat-stall detection
  // + polling safety-net) lives in useJobStream; see that file for the
  // invariants it protects. The page consumes six values and owns none of
  // the eight refs the machine needs.
  const { job, loading, error, setError, sseConnected, reload: loadJob, restart: restartStream } = useJobStream(jobId);

  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [bandwidth, setBandwidth] = useState<{ bandwidth: JobBandwidthRecord; estimatedCost: number } | null>(null);
  const [analytics, setAnalytics] = useState<JobAnalytics | null>(null);
  const { confirm, ConfirmDialogHost } = useConfirm();

  // Check for checkpoint when job is failed or cancelled
  useEffect(() => {
    if (job && (job.status === 'failed' || job.status === 'cancelled')) {
      apiClient.checkJobCheckpoint(jobId)
        .then((res) => setHasCheckpoint(res.has_checkpoint))
        .catch(() => setHasCheckpoint(false));
    }
  }, [job?.status, jobId]);

  // Fetch bandwidth data for completed/failed jobs
  useEffect(() => {
    if (job && (job.status === 'completed' || job.status === 'failed')) {
      apiClient.getJobCost(jobId)
        .then((res) => setBandwidth({ bandwidth: res.bandwidth, estimatedCost: res.estimatedCost }))
        .catch(() => setBandwidth(null));
    }
  }, [job?.status, jobId]);

  // Fetch analytics when job is completed
  useEffect(() => {
    if (job?.status === 'completed' && job.job_id) {
      apiClient.getJobAnalytics(job.job_id)
        .then(res => { if (res.success) setAnalytics(res.analytics); })
        .catch(() => { /* analytics are optional, fail silently */ });
    }
  }, [job?.status, job?.job_id]);

  const handleCancel = async () => {
    const ok = await confirm({
      title: 'Cancel job',
      message: 'Are you sure you want to cancel this job?',
      confirmLabel: 'Cancel Job',
      cancelLabel: 'Keep Running',
      confirmVariant: 'danger',
    });
    if (!ok) return;

    setCancelling(true);
    try {
      await apiClient.cancelJob(jobId);
      await loadJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancelling(false);
    }
  };

  const { fileExpired, reExporting, downloading, handleDownload, handleReExport } = useDownloadReExport(jobId, setError);

  const handleRestart = async () => {
    const ok = await confirm({
      title: 'Restart job',
      message: 'This will create a new job with the same parameters. Continue?',
      confirmLabel: 'Restart',
      confirmVariant: 'primary',
    });
    if (!ok) return;
    setRestarting(true);
    setError('');
    try {
      const response = await apiClient.restartJob(jobId);
      router.push(`/jobs/${response.job_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart job');
    } finally {
      setRestarting(false);
    }
  };

  const handleContinue = async () => {
    setContinuing(true);
    setError('');
    try {
      await apiClient.continueJob(jobId);
      await loadJob();
      // The stream and the poll net both stood down when the job went
      // terminal; continuing re-queues it, so re-arm both.
      restartStream();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to continue job');
    } finally {
      setContinuing(false);
    }
  };

  const calculateProgress = () => calculateJobProgress(job);

  if (loading) {
    return (
      <MainLayout>
        <div className="space-y-6 animate-pulse" aria-label="Loading job details" aria-busy="true">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-surface-tertiary" />
            <div className="h-6 w-48 rounded bg-surface-tertiary" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="surface-card p-5 space-y-3">
              <div className="h-3 w-20 rounded bg-surface-tertiary" />
              <div className="h-8 w-32 rounded bg-surface-tertiary" />
            </div>
            <div className="surface-card p-5 space-y-3">
              <div className="h-3 w-20 rounded bg-surface-tertiary" />
              <div className="h-8 w-32 rounded bg-surface-tertiary" />
            </div>
            <div className="surface-card p-5 space-y-3">
              <div className="h-3 w-20 rounded bg-surface-tertiary" />
              <div className="h-8 w-32 rounded bg-surface-tertiary" />
            </div>
          </div>
          <div className="surface-card p-6 space-y-4">
            <div className="h-4 w-24 rounded bg-surface-tertiary" />
            <div className="h-2 w-full rounded bg-surface-tertiary" />
            <div className="h-3 w-64 rounded bg-surface-tertiary" />
          </div>
          <div className="surface-card p-6 space-y-3">
            <div className="h-4 w-32 rounded bg-surface-tertiary" />
            {['row-a', 'row-b', 'row-c', 'row-d'].map((key) => (
              <div key={key} className="h-3 w-full rounded bg-surface-tertiary" />
            ))}
          </div>
        </div>
      </MainLayout>
    );
  }

  if (error || !job) {
    return (
      <MainLayout>
        <Card>
          <div className="text-center text-red-600">
            {error || 'Job not found'}
          </div>
          <div className="mt-4 text-center">
            <Button onClick={() => router.push('/')}>Back to Dashboard</Button>
          </div>
        </Card>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <ConfirmDialogHost />
      <div className="max-w-4xl mx-auto">
      <Breadcrumbs
        items={crumbs('/jobs/history', { label: job.job_id.slice(0, 8) })}
      />
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-ink">Job Status</h1>
      </div>

      <div className="space-y-6">
        <Card>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-xl font-semibold text-ink">Job Details</h2>
                <p className="text-sm text-ink-muted mt-1">ID: {job.job_id}</p>
              </div>
              <div className="flex items-center gap-2">
                {(job.restart_count ?? 0) > 0 && (
                  <Badge variant="info">Attempt #{(job.restart_count ?? 0) + 1}</Badge>
                )}
                <JobStatusBadge status={job.status} />
              </div>
            </div>

            {job.restart_parent_id && (
              <div className="text-sm text-ink-muted">
                Restarted from{' '}
                <button
                  onClick={() => router.push(`/jobs/${job.restart_parent_id ?? ''}`)}
                  className="text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded"
                >
                  {job.restart_parent_id}
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-ink-muted">Site</p>
                <p className="font-medium">{job.site}</p>
              </div>
              <div>
                <p className="text-sm text-ink-muted">Brand</p>
                <p className="font-medium">{job.brand}</p>
              </div>
              <div>
                <p className="text-sm text-ink-muted">Created By</p>
                <p className="font-medium">{job.owner?.username || job.username || job.user_id}</p>
              </div>
              <div>
                <p className="text-sm text-ink-muted">Created At</p>
                <p className="font-medium">
                  {formatDateTime(job.created_at)}
                </p>
              </div>
              {job.started_at && (
                <div>
                  <p className="text-sm text-ink-muted">Started At</p>
                  <p className="font-medium">
                    {formatDateTime(job.started_at)}
                  </p>
                </div>
              )}
              {job.completed_at && (
                <div>
                  <p className="text-sm text-ink-muted">Completed At</p>
                  <p className="font-medium">
                    {formatDateTime(job.completed_at)}
                  </p>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Bandwidth & Cost */}
        {(job.status === 'completed' || job.status === 'failed') && (
          <Card>
            <h2 className="text-xl font-semibold text-ink mb-4">Bandwidth & Cost</h2>
            {bandwidth ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-accent">
                    {(bandwidth.bandwidth.bytesDownloaded / 1073741824).toFixed(2)}
                  </p>
                  <p className="text-sm text-ink-muted">Downloaded (GB)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-accent">
                    {(bandwidth.bandwidth.bytesUploaded / 1073741824).toFixed(2)}
                  </p>
                  <p className="text-sm text-ink-muted">Uploaded (GB)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-accent">
                    {((bandwidth.bandwidth.bytesDownloaded + bandwidth.bandwidth.bytesUploaded) / 1073741824).toFixed(2)}
                  </p>
                  <p className="text-sm text-ink-muted">Total (GB)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-green-600">
                    ${bandwidth.estimatedCost.toFixed(2)}
                  </p>
                  <p className="text-sm text-ink-muted">Estimated Cost</p>
                </div>
              </div>
            ) : (
              <p className="text-ink-muted text-center py-2">N/A</p>
            )}
          </Card>
        )}

        {job.status === 'running' && (
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-ink">Progress</h2>
              {/* Amber "Reconnecting..." pill near the
                  progress bar so the user knows the live stream is in backoff
                  and progress numbers may stale for a moment. The polling loop
                  is still ticking underneath, so this is purely informational. */}
              {!sseConnected && job.status === 'running' && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800"
                  role="status"
                  aria-live="polite"
                  data-testid="sse-reconnecting-pill"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
                  Reconnecting...
                </span>
              )}
            </div>
            <div className="space-y-6">
              {/* Phase Stepper */}
              <div className="relative">
                <div className="flex justify-between items-center">
                  {PHASES.map((phase, index) => {
                    const currentIndex = getCurrentPhaseIndex(job.phase);
                    const isActive = index === currentIndex;
                    const isCompleted = index < currentIndex;
                    const inactiveStateClass = isCompleted
                      ? 'bg-green-600 text-white'
                      : 'bg-surface-tertiary text-ink-muted';

                    return (
                      <div key={phase.id} className="flex-1 relative">
                        <div className="flex flex-col items-center">
                          {/* Circle indicator */}
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-300 ${
                              isActive
                                ? 'bg-accent text-white ring-4 ring-accent-100'
                                : inactiveStateClass
                            }`}
                          >
                            {isCompleted ? (
                              // An SVG rather than the U+2713 glyph, whose rendering varies
                              // by font/OS. It matches the Toast success icon path
                              // and is decorative — the surrounding green circle conveys
                              // completion already, so aria-hidden is correct.
                              <svg
                                className="w-4 h-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2.5}
                                aria-hidden="true"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
                              </svg>
                            ) : (
                              index + 1
                            )}
                          </div>
                          
                          {/* Label */}
                          <div className="mt-2 text-center">
                            <p
                              className={`text-sm font-medium ${
                                phaseTextColor(isActive, isCompleted)
                              }`}
                            >
                              {phase.label}
                            </p>
                            <p className="text-xs text-ink-muted mt-0.5">{phase.description}</p>
                          </div>
                        </div>
                        
                        {/* Connector line */}
                        {index < PHASES.length - 1 && (
                          <div
                            className={`absolute top-5 left-1/2 w-full h-0.5 -z-10 transition-all duration-300 ${
                              index < currentIndex ? 'bg-green-600' : 'bg-surface-tertiary'
                            }`}
                            style={{ transform: 'translateY(-50%)' }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Progress message — aria-live so SSE-driven phase/percent changes are announced */}
              <div className="text-center py-2" aria-live="polite">
                <p className="text-lg text-ink">
                  {getPhaseMessage(job.phase)}
                </p>
                {(job.products_discovered ?? 0) > 0 && (
                  <p className="text-sm text-ink-muted mt-1">
                    {calculateProgress()}% complete — {job.products_processed || 0} of {job.products_discovered} products
                  </p>
                )}
              </div>

              {/* Progress bar */}
              {(() => {
                const isDeterminate = (job.products_discovered ?? 0) > 0;
                const progressPct = calculateProgress();
                const ariaProps = isDeterminate
                  ? {
                      role: 'progressbar' as const,
                      'aria-valuemin': 0,
                      'aria-valuemax': 100,
                      'aria-valuenow': progressPct,
                      'aria-label': `Job progress: ${progressPct}% complete`,
                    }
                  : {
                      role: 'progressbar' as const,
                      'aria-valuetext': 'Starting…',
                      'aria-label': 'Job progress',
                    };
                return (
                  <div className="w-full bg-surface-tertiary rounded-full h-2 overflow-hidden" {...ariaProps}>
                    {isDeterminate ? (
                      <div
                        className="bg-accent h-2 rounded-full transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                      />
                    ) : (
                      <div className="bg-accent h-2 rounded-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite]" />
                    )}
                  </div>
                );
              })()}

              {/* Stats grid */}
              {(job.products_discovered ?? 0) > 0 && (
                <>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-accent">
                        {job.products_discovered || 0}
                      </p>
                      <p className="text-sm text-ink-muted">Discovered</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-accent">
                        {job.products_processed || 0}
                      </p>
                      <p className="text-sm text-ink-muted">Processed</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-accent">
                        {job.variants_extracted || 0}
                      </p>
                      <p className="text-sm text-ink-muted">Variants</p>
                    </div>
                  </div>

                  <div className="text-center text-sm text-ink-muted">
                    Estimated time remaining: <span className="font-medium">{estimateTimeRemaining(job)}</span>
                  </div>
                </>
              )}
            </div>
          </Card>
        )}

        {job.status === 'completed' && (
          <Card>
            <h2 className="text-xl font-semibold text-green-600 mb-4">Job is complete</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-green-600">
                    {job.products_processed || 0}
                  </p>
                  <p className="text-sm text-ink-muted">Products</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-green-600">
                    {job.variants_extracted || 0}
                  </p>
                  <p className="text-sm text-ink-muted">Variants</p>
                </div>
                {job.failed_products !== undefined && job.failed_products.length > 0 && (
                  <div>
                    <p className="text-2xl font-bold text-yellow-600">
                      {job.failed_products.length}
                    </p>
                    <p className="text-sm text-ink-muted">Failed</p>
                  </div>
                )}
              </div>

              <div className="flex justify-center gap-3">
                {fileExpired ? (
                  <Button onClick={handleReExport} variant="primary" size="lg" disabled={reExporting}>
                    {reExporting ? 'Regenerating...' : 'Regenerate Excel Report'}
                  </Button>
                ) : (
                  <Button onClick={handleDownload} variant="primary" size="lg" disabled={downloading}>
                    {downloading ? 'Preparing download...' : 'Download Excel Report'}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* One block for cancelled, failed-with-error-message and
            failed-without-error-message; they differ only in heading copy and
            whether the error body renders. */}
        {(job.status === 'cancelled' || job.status === 'failed') && (
          <Card>
            {job.status === 'failed' && job.error_message ? (
              <>
                <h2 className="text-xl font-semibold text-red-600 mb-4">Error</h2>
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
                  {job.error_message}
                </div>
                <div className="flex gap-3">
                  <Button onClick={handleRestart} disabled={restarting}>
                    {restarting ? 'Restarting...' : 'Restart Job'}
                  </Button>
                  {hasCheckpoint && (
                    <Button variant="outline" onClick={handleContinue} disabled={continuing}>
                      {continuing ? 'Resuming...' : 'Continue from Checkpoint'}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="text-center py-6">
                <p className={`text-lg font-semibold mb-4 ${job.status === 'cancelled' ? 'text-yellow-600' : 'text-red-600'}`}>
                  {job.status === 'cancelled' ? 'Job was cancelled' : 'Job failed'}
                </p>
                <div className="flex justify-center gap-3">
                  <Button onClick={handleRestart} disabled={restarting}>
                    {restarting ? 'Restarting...' : 'Restart Job'}
                  </Button>
                  {hasCheckpoint && (
                    <Button variant="outline" onClick={handleContinue} disabled={continuing}>
                      {continuing ? 'Resuming...' : 'Continue from Checkpoint'}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        {job.status === 'queued' && (
          <Card>
            <div className="text-center py-8">
              <p className="text-ink-muted">Job is queued and will start processing soon...</p>
            </div>
          </Card>
        )}

        <div className="flex gap-4">
          {job.status === 'running' && (
            <Button
              onClick={handleCancel}
              variant="danger"
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling...' : 'Cancel Job'}
            </Button>
          )}
          <Button variant="outline" onClick={() => router.push('/')}>
            Back to Dashboard
          </Button>
        </div>
      </div>

      {job.status === 'completed' && analytics && (
        <JobAnalyticsPanel job={job} analytics={analytics} />
      )}
      </div>
    </MainLayout>
  );
}
