import { getSites } from './config-manager';

/**
 * Names of every configured site. Used for zero-fill in analytics aggregations
 * (so each retailer appears in dashboard panels even with no data in the window).
 */
export async function knownRetailers(): Promise<string[]> {
  return (await getSites()).map((s) => s.name);
}
