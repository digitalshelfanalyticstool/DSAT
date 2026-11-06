/**
 * Scheduled-run helpers. Schedules store "HH:MM" on weekdays in the server's
 * scheduling timezone (server/src/services/scheduler.ts BUSINESS_TZ), not the
 * viewer's, so anything that computes a run time must do it in that zone.
 */

/** Must match the server's SCHEDULE_TIMEZONE (config.scheduling.timezone). Set at build time. */
export const SCHEDULE_TIMEZONE = process.env.NEXT_PUBLIC_SCHEDULE_TIMEZONE || 'America/New_York';
/** Short label shown next to schedule times, e.g. "ET". */
export const SCHEDULE_TZ_LABEL =
  new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TIMEZONE, timeZoneName: 'shortGeneric' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value ?? SCHEDULE_TIMEZONE;

/** Index = JS weekday (0 = Sunday), as stored in schedule_days. */
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** schedule_days arrives as a JSON array string; anything unparseable is no days. */
export function parseDays(raw: string): number[] {
  try {
    const days: unknown = JSON.parse(raw);
    return Array.isArray(days) ? days.filter((d): d is number => typeof d === 'number') : [];
  } catch {
    return [];
  }
}

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

/** Wall-clock fields of `date` in the scheduling timezone, as a UTC timestamp. */
function wallClockMs(date: Date): number {
  const p = Object.fromEntries(partsFormat.formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** The instant at which the scheduling timezone's clock reads the given wall time. */
function zonedInstant(year: number, month0: number, day: number, hour: number, minute: number): Date {
  const target = Date.UTC(year, month0, day, hour, minute);
  let guess = target;
  // Two corrections settle the zone offset, including across a DST change.
  for (let i = 0; i < 2; i++) guess -= wallClockMs(new Date(guess)) - target;
  return new Date(guess);
}

/**
 * The next time a schedule fires after `now`: the first listed weekday,
 * today included, whose "HH:MM" in the scheduling timezone is still ahead.
 * Null when no days are selected.
 */
export function nextScheduledRun(days: number[], scheduleTime: string, now: Date = new Date()): Date | null {
  if (days.length === 0) return null;
  const [hour, minute] = scheduleTime.split(':').map(Number);
  const today = new Date(wallClockMs(now));
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    if (!days.includes(date.getUTCDay())) continue;
    const at = zonedInstant(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    if (at > now) return at;
  }
  return null;
}
