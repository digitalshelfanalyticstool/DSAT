import type { Response } from 'express';

export const SSE_HEARTBEAT_MS = 30_000;

/**
 * Set SSE response headers. Call before writing any events.
 */
export function initSSE(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * Write a named SSE event with JSON-serialized data.
 */
export function sendSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Start a heartbeat timer that sends a named `heartbeat` event.
 * Returns the timer handle for cleanup.
 *
 * A real event, not a `:comment` line: EventSource never surfaces comments,
 * so the client's stall detector (useJobStream) could not see them and
 * reconnected healthy streams. Clients that don't listen for `heartbeat`
 * ignore it.
 */
export function startHeartbeat(res: Response, intervalMs: number = SSE_HEARTBEAT_MS): NodeJS.Timeout {
  return setInterval(() => {
    try {
      res.write('event: heartbeat\ndata: {}\n\n');
    } catch {
      // Connection closed — caller's cleanup handler will clear the interval
    }
  }, intervalMs);
}
