'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import type { Job } from '@/lib/api-client';
import { useTicketedEventSource } from './useTicketedEventSource';
import { usePolling } from './usePolling';

/**
 * Live job state for `/api/jobs/:id/stream`.
 *
 *  1. **Stream with reconnect.** useTicketedEventSource opens the stream with
 *     a single-use ticket and reports errors and stalls (no event or
 *     `heartbeat` for 45s; the server heartbeats every 30s). On either, this
 *     hook reconciles the job and, while it is still queued or running,
 *     reconnects after a 1s/2s/4s/8s backoff capped at 30s.
 *  2. **Polling safety-net.** Every 30s while the job is queued or running,
 *     skipped while the stream is healthy, so a good stream produces no
 *     redundant GETs.
 *
 * A backoff scheduled for one job must never reconnect after the page moved
 * to another: `generationRef` changes with `jobId`, and a timer from an older
 * generation does nothing.
 */
export interface JobStream {
  /** Latest known job state — from the initial load, the stream, or a poll. */
  job: Job | null;
  /** True until the initial load settles (success or failure). */
  loading: boolean;
  error: string;
  setError: (message: string) => void;
  /** False while the stream is down, so the caller can show a reconnect hint. */
  sseConnected: boolean;
  /** Re-read the job and clear the loading flag — for use after a mutation. */
  reload: () => Promise<void>;
  /**
   * Re-open the stream. Needed after a terminal job is re-queued (continue /
   * restart): reaching `completed` or `failed` closes the stream.
   */
  restart: () => void;
}

/** Server heartbeats every 30s; a longer gap means the socket is dead. */
const HEARTBEAT_STALL_MS = 45_000;
const POLL_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

const isActive = (status: string | undefined) => status === 'queued' || status === 'running';

/** Compare the fields the page renders, so an unchanged poll doesn't re-render. */
function hasJobChanged(prev: Job | null, next: Job): boolean {
  if (!prev) return true;
  return (
    prev.status !== next.status ||
    prev.phase !== next.phase ||
    prev.products_discovered !== next.products_discovered ||
    prev.products_processed !== next.products_processed ||
    prev.variants_extracted !== next.variants_extracted ||
    (prev.failed_products?.length ?? 0) !== (next.failed_products?.length ?? 0) ||
    prev.error_message !== next.error_message ||
    prev.file_path !== next.file_path ||
    prev.started_at !== next.started_at ||
    prev.completed_at !== next.completed_at
  );
}

export function useJobStream(jobId: string): JobStream {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // State drives the visible "Reconnecting…" pill; the ref keeps the poll
  // tick and error handler reading the current value.
  const [sseConnected, setSseConnectedState] = useState(false);
  const sseConnectedRef = useRef(false);
  const setSseConnected = useCallback((value: boolean) => {
    sseConnectedRef.current = value;
    setSseConnectedState(value);
  }, []);

  const jobRef = useRef<Job | null>(null);
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generationRef = useRef(0);

  /** Initial load — always updates state and clears the loading spinner. */
  const loadJob = useCallback(async () => {
    try {
      const response = await apiClient.getJob(jobId);
      setJob(response.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  /** Silently fetch the latest job state; only update React if data differs. */
  const reconcileJob = useCallback(async () => {
    try {
      const response = await apiClient.getJob(jobId);
      if (hasJobChanged(jobRef.current, response.job)) setJob(response.job);
    } catch {
      // Silent — don't flash errors during background reconciliation.
    }
  }, [jobId]);

  const applyEvent = (type: string) => (raw: unknown) => {
    const data = raw as Partial<Job>;
    const terminal = type === 'completed' || type === 'failed' ? type : data.status;
    if (terminal === 'completed' || terminal === 'failed') {
      setJob((prev) => (prev ? { ...prev, ...data, status: terminal } : (data as Job)));
      setSseConnected(false);
      stream.close();
      return;
    }
    setJob((prev) => (prev ? { ...prev, ...data } : (data as Job)));
  };

  const stream = useTicketedEventSource(`/jobs/${jobId}/stream`, {
    events: {
      progress: applyEvent('progress'),
      connected: applyEvent('connected'),
      completed: applyEvent('completed'),
      failed: applyEvent('failed'),
    },
    stallMs: HEARTBEAT_STALL_MS,
    onOpen: () => {
      reconnectAttemptsRef.current = 0;
      setSseConnected(true);
      // Catch any transition during the handshake.
      void reconcileJob();
    },
    onError: () => {
      setSseConnected(false);
      const backoffMs = Math.min(1000 * 2 ** reconnectAttemptsRef.current, RECONNECT_BACKOFF_CAP_MS);
      reconnectAttemptsRef.current++;
      const generation = generationRef.current;
      void reconcileJob().then(() => {
        if (generation !== generationRef.current) return;
        reconnectTimeoutRef.current = setTimeout(() => {
          if (generation === generationRef.current && isActive(jobRef.current?.status)) stream.reconnect();
        }, backoffMs);
      });
    },
  });

  usePolling(
    () => {
      if (!sseConnectedRef.current) void reconcileJob();
    },
    isActive(job?.status) ? POLL_INTERVAL_MS : null,
  );

  // Load once per job; a jobId change (or unmount) retires any pending backoff.
  useEffect(() => {
    void loadJob();
    return () => {
      generationRef.current++;
      clearTimeout(reconnectTimeoutRef.current);
      setSseConnected(false);
    };
  }, [loadJob, setSseConnected]);

  const { reconnect } = stream;
  return { job, loading, error, setError, sseConnected, reload: loadJob, restart: reconnect };
}
