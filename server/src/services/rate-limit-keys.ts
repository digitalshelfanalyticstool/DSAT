/**
 * Redis names of the per-site scrape-slot limiter, shared by rate-limiter.ts
 * (which holds the slots) and the admin views that report them. Zero imports.
 *
 * Bottleneck keys every limiter's state as `b_<id>_<part>`; `running` in the
 * settings hash is the number of slots held across all workers.
 */

/**
 * Bottleneck limiter id for one site. `scrape-slots:` replaced the earlier
 * `ratelimit:` limiters, whose reservoir counting leaked a slot per crashed
 * worker; the old keys expire on their own.
 */
export function scrapeSlotLimiterId(site: string): string {
  return `scrape-slots:${site}`;
}

/** The hash whose `running` field is the site's slots in use. */
export function scrapeSlotSettingsKey(site: string): string {
  return `b_${scrapeSlotLimiterId(site)}_settings`;
}
