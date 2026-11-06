import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * Whether the active scraping provider bills by the byte, as the server reports
 * it. Bandwidth and cost views only mean something while it does.
 * Pass `enabled` = "viewer is an admin": the provider endpoint is admin-only.
 */
export function useBandwidthBilling(enabled: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiClient.getScrapingProvider()
      .then((res) => { if (!cancelled) setActive(res.bills_bandwidth === true); })
      .catch(() => { /* unknown provider → hide the bandwidth views */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return active;
}
