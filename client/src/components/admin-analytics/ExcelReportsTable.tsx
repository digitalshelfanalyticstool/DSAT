'use client';

import React, { useState, useEffect, useId, useRef } from 'react';
import { apiClient } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { formatDateTime, formatBytes } from '@/lib/format';
import type { ExcelReport, PagePagination as Pagination } from '@/lib/api-client';

const PAGE_SIZE = 25;

const TOOLTIP_TEXT =
  'All Excel reports currently on disk. Use Delete to remove a specific report (frees the listed bytes immediately). Reports past the retention window shown here are also cleaned up automatically.';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDateTime(iso, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export const ExcelReportsTable: React.FC = () => {
  const titleId = useId();
  const [confirmJobId, setConfirmJobId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);

  // `page` is the source of truth and the fetch derives from it. Previously the
  // page number lived only inside the response (`pagination.page`) and the
  // fetch was fired imperatively from the pager buttons with no request guard,
  // so clicking through pages quickly could render whichever response landed
  // last rather than the page that was actually selected.
  const [page, setPage] = useState(1);
  const { data, loading, refetch } = useAsyncResource(
    () => apiClient.getAdminExcelReports(page, PAGE_SIZE),
    {
      deps: [page],
      onError: (err) => setToast({ kind: 'error', msg: `Failed to load reports: ${err.message}` }),
    },
  );

  const reports: ExcelReport[] = data?.reports ?? [];
  // Falls back to the requested page so the pager stays correct on the first
  // render and while a page change is in flight.
  const pagination: Pagination = data?.pagination ?? { page, limit: PAGE_SIZE, total: 0 };

  // Auto-dismiss toast after 4s — long enough to read, short enough not to nag
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Drive the native <dialog> open/close lifecycle imperatively so the browser
  // provides a real focus trap, ::backdrop, and Esc-to-close (S1082 fix).
  useEffect(() => {
    if (confirmJobId) {
      confirmDialogRef.current?.showModal();
    } else {
      confirmDialogRef.current?.close();
    }
  }, [confirmJobId]);

  const confirmDelete = (jobId: string) => setConfirmJobId(jobId);
  const cancelDelete = () => setConfirmJobId(null);

  const doDelete = async (jobId: string) => {
    setDeleting(jobId);
    setConfirmJobId(null);
    try {
      const res = await apiClient.deleteAdminExcelReport(jobId);
      const freed = res.bytes_freed > 0 ? ` (${formatBytes(res.bytes_freed)} freed)` : '';
      setToast({ kind: 'success', msg: `${res.message}${freed}` });
      void refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ kind: 'error', msg: `Delete failed: ${msg}` });
    } finally {
      setDeleting(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  const totalBytes = reports.reduce((s, r) => s + (r.file_size_bytes ?? 0), 0);

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline shadow-sm" role="region" aria-labelledby={titleId}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <h2 id={titleId} className="text-sm font-medium text-ink-muted">Excel Reports</h2>
          <InfoTooltip text={TOOLTIP_TEXT} />
        </div>
        <div className="text-xs text-ink-muted">
          {pagination.total} report{pagination.total === 1 ? '' : 's'} on disk
          {data?.retention_days !== undefined && ` · deleted after ${data.retention_days} day${data.retention_days === 1 ? '' : 's'}`}
          {reports.length > 0 && ` · ${formatBytes(totalBytes)} on this page`}
        </div>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`text-xs px-3 py-2 rounded mb-3 ${toast.kind === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'}`}
        >
          {toast.msg}
        </div>
      )}

      {loading && reports.length === 0 && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-surface-tertiary rounded animate-pulse" />
          ))}
        </div>
      )}
      {!loading && reports.length === 0 && (
        <p className="text-sm text-ink-muted text-center py-8">No Excel reports on disk.</p>
      )}
      {reports.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-ink-muted border-b border-hairline">
                  <th scope="col" className="py-2 pr-3 font-medium">Completed</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Site</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Brand</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Job ID</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">Size</th>
                  <th scope="col" className="py-2 pl-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.job_id} className="border-b border-hairline/50 last:border-0">
                    <td className="py-2 pr-3 text-ink-muted">{formatDate(r.completed_at ?? r.created_at)}</td>
                    <td className="py-2 pr-3">{r.site}</td>
                    <td className="py-2 pr-3">{r.brand}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-muted truncate max-w-[180px]" title={r.job_id}>{r.job_id}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatBytes(r.file_size_bytes)}
                    </td>
                    <td className="py-2 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => confirmDelete(r.job_id)}
                        disabled={deleting === r.job_id}
                        className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={`Delete excel report for job ${r.job_id}`}
                      >
                        {deleting === r.job_id ? 'Deleting…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-ink-muted mt-3">
              <span>
                Page {pagination.page} of {totalPages} · {pagination.total} total
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={pagination.page <= 1 || loading}
                  className="px-2 py-1 rounded border border-hairline hover:bg-surface-tertiary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={pagination.page >= totalPages || loading}
                  className="px-2 py-1 rounded border border-hairline hover:bg-surface-tertiary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Confirmation dialog — native <dialog> opened via showModal() so the
          browser provides focus trap, ::backdrop, and Esc-to-close (S1082 fix).
          Click-outside-cancel intentionally dropped — Sonar's a11y rules treat
          onClick on a non-interactive element as a violation even when guarded
          to backdrop-only. Dismissal paths: Esc (native), Cancel button, or
          successful Delete. */}
      <dialog
        ref={confirmDialogRef}
        aria-labelledby={`${titleId}-confirm`}
        className="rounded-xl p-5 max-w-sm w-full shadow-xl bg-surface backdrop:bg-black/40"
        onClose={cancelDelete}
      >
        <h3 id={`${titleId}-confirm`} className="text-base font-medium mb-2">Delete this Excel report?</h3>
        <p className="text-sm text-ink-muted mb-4">
          The file will be removed from disk and the download link will return 404. The job record itself is preserved
          (status, products discovered, etc.). The user can still re-export from stored variant data if needed.
        </p>
        <p className="text-xs font-mono text-ink-muted mb-4 break-all">{confirmJobId}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={cancelDelete}
            className="text-sm px-3 py-1.5 rounded border border-hairline hover:bg-surface-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => confirmJobId && doDelete(confirmJobId)}
            className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700"
            autoFocus
          >
            Delete
          </button>
        </div>
      </dialog>
    </div>
  );
};
