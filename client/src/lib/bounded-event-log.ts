/**
 * Cap the site-monitor live-log buffer.
 *
 * The /admin/site-monitor page subscribes to a long-running SSE stream and
 * appends every `progress` event to React state. A 4-retailer monitor run
 * over a fully-stocked brand catalog can emit 5,000+ events, which:
 *   - bloats client memory (each event holds the full URL + message);
 *   - turns every render into a 5,000-row map() that React diffs against
 *     the prior frame, which is observable as visible scroll-jank;
 *   - blocks GC of every JSON.parse'd object until the user navigates
 *     away from the page.
 *
 * Cap the in-memory log at MAX_LOG_EVENTS (500) and discard the oldest
 * entries once we exceed that ceiling. The UI shows a small notice when
 * the cap is in effect so operators understand they're seeing only the
 * tail.
 *
 * The function is pure so it can be unit-tested without mounting React.
 */
export const MAX_LOG_EVENTS = 500;

export function appendBoundedEvents<T>(prev: T[], event: T, max = MAX_LOG_EVENTS): T[] {
  const next = [...prev, event];
  if (next.length <= max) return next;
  // slice(-max) keeps the most recent `max` entries — strictly correct
  // even if `prev` arrived already over-cap (e.g. legacy state from a
  // previous session, or a test that constructs an oversize array).
  return next.slice(-max);
}
