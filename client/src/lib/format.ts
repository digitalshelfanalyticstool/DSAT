/**
 * Shared formatting utilities for date-time and number display.
 * These preserve the locale and formatting of inline toLocaleString() calls throughout the codebase.
 */

/**
 * Calculate percentage change between two values.
 * @param current The current value
 * @param previous The previous value
 * @returns Rounded percentage change, or undefined if previous is 0 (avoid division by zero)
 * @example pctChange(150, 100) // 50
 * @example pctChange(50, 100) // -50
 * @example pctChange(100, 0) // undefined
 */
export function pctChange(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Accepted date inputs: an ISO/date string, a millisecond epoch timestamp, or a Date.
 *
 * NOTE: epoch-seconds values must be multiplied by 1000 at the call site
 * (e.g. `formatDateTime(s.last_run_at * 1000)`) — the helpers never guess units.
 */
export type DateInput = string | number | Date;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Date-only display in the user's default locale.
 * Byte-identical to `new Date(value).toLocaleDateString(undefined, options)`.
 * @example formatDate(user.created_at) // "3/15/2026" (en-US)
 * @example formatDate(d, { month: 'short', day: 'numeric' }) // "Mar 15"
 */
export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleDateString(undefined, options);
}

/**
 * Date + time display in the user's default locale.
 * Byte-identical to `new Date(value).toLocaleString(undefined, options)`.
 * @example formatDateTime(job.created_at) // "3/15/2026, 2:30:45 PM" (en-US)
 */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleString(undefined, options);
}

/**
 * Time-only display in the user's default locale.
 * Byte-identical to `new Date(value).toLocaleTimeString(undefined, options)`.
 * @example formatTime(ts, { hour: '2-digit', minute: '2-digit' }) // "02:30 PM"
 */
export function formatTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  return toDate(value).toLocaleTimeString(undefined, options);
}

/**
 * Thousands-grouped number display in the user's default locale.
 * Byte-identical to `value.toLocaleString()`.
 * @example formatNumber(1234567) // "1,234,567" (en-US)
 */
export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/**
 * Byte counts as B, KB, MB or GB; null shows as an em dash.
 * @example formatBytes(1536) // "2 KB"
 * @example formatBytes(5_242_880) // "5.0 MB"
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Durations: milliseconds under a second, then seconds, then minutes.
 * @example formatDuration(850) // "850ms"
 * @example formatDuration(125_000) // "2m 5s"
 * @example formatDuration(120_000) // "2m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * How long ago `value` was, coarsely: "12s ago", "5m ago", "3h ago", "2d ago".
 * Future times read as "0s ago"; an unparseable date gives ''.
 */
export function timeAgo(value: DateInput, now: number = Date.now()): string {
  const then = toDate(value).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
