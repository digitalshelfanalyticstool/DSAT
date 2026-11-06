'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';

export interface TicketedEventSourceOptions {
  /** Named server events and their handlers; each receives the parsed JSON `data`. */
  events: Record<string, (data: unknown) => void>;
  onOpen?: () => void;
  /**
   * The stream failed: it errored, stalled, or no ticket could be minted. It
   * is already closed. It is never reopened automatically, because tickets
   * are single-use and the browser's own retry would replay a spent one and
   * 401 forever; call `reconnect()` to open a fresh one.
   */
  onError?: () => void;
  /**
   * Treat the stream as dead when nothing arrives, not even the server's
   * `heartbeat` event, for this long after it opens. A proxy can drop a
   * socket without the browser ever firing `error`.
   */
  stallMs?: number;
}

export interface TicketedEventSource {
  /** Close the stream. It stays closed until `reconnect()` or a new `path`. */
  close: () => void;
  /** Open a fresh stream (new ticket) on the current path. */
  reconnect: () => void;
}

/**
 * An EventSource on an authenticated API stream. Access tokens never go in a
 * URL, so every open mints a single-use ticket first (POST /auth/sse-ticket).
 * `path` is relative to the API base (`/jobs/:id/stream`); `null` keeps the
 * stream closed. Handlers are read through a ref, so inline closures are fine.
 */
export function useTicketedEventSource(path: string | null, options: TicketedEventSourceOptions): TicketedEventSource {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<() => void>(() => {});
  const close = useCallback(() => closeRef.current(), []);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    let lastActivity = 0;

    const shutDown = () => {
      clearInterval(stallTimer);
      es?.close();
    };
    const fail = () => {
      if (cancelled) return;
      cancelled = true;
      shutDown();
      optionsRef.current.onError?.();
    };
    closeRef.current = () => {
      cancelled = true;
      shutDown();
    };

    (async () => {
      const ticket = await apiClient.getSseTicket().catch(() => null);
      if (cancelled) return;
      if (!ticket) {
        fail();
        return;
      }
      const source = new EventSource(`${apiClient.getBaseUrl()}${path}?token=${encodeURIComponent(ticket)}`);
      es = source;
      const touch = () => {
        lastActivity = Date.now();
      };

      source.onopen = () => {
        touch();
        const { stallMs } = optionsRef.current;
        if (stallMs) {
          clearInterval(stallTimer);
          stallTimer = setInterval(() => {
            if (Date.now() - lastActivity > stallMs) fail();
          }, stallMs / 3);
        }
        optionsRef.current.onOpen?.();
      };
      source.onerror = fail;
      // The server's keep-alive (server/src/utils/sse.ts startHeartbeat).
      source.addEventListener('heartbeat', touch);
      for (const name of Object.keys(optionsRef.current.events)) {
        source.addEventListener(name, (event) => {
          touch();
          let data: unknown;
          try {
            data = JSON.parse((event as MessageEvent).data);
          } catch {
            return; // Malformed payload: ignore it.
          }
          optionsRef.current.events[name]?.(data);
        });
      }
    })();

    return () => {
      cancelled = true;
      shutDown();
    };
  }, [path, attempt]);

  return { close, reconnect };
}
