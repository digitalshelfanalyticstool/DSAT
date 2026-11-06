'use client';

import React, { useCallback, useMemo } from 'react';
import { apiClient, type Site, type Brand } from '@/lib/api-client';
import { createTTLProvider } from './createTTLProvider';

interface ConfigData {
  sites: Site[];
  brands: Brand[];
}

interface ConfigContextValue {
  sites: Site[];
  brands: Brand[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const CONFIG_TTL_MS = 5 * 60_000;
const EMPTY_CONFIG: ConfigData = { sites: [], brands: [] };

async function fetchConfig(): Promise<ConfigData> {
  const [sitesRes, brandsRes] = await Promise.all([
    apiClient.getSites(),
    apiClient.getBrands(),
  ]);
  return { sites: sitesRes.sites, brands: brandsRes.brands };
}

const { Provider: InnerProvider, useValue: useInner, useOptionalValue: useOptionalInner } = createTTLProvider<ConfigData>({
  fetchFn: fetchConfig,
  initialValue: EMPTY_CONFIG,
  ttlMs: CONFIG_TTL_MS,
  displayName: 'Config',
  resetOnError: false,
});

export function ConfigProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  return <InnerProvider>{children}</InnerProvider>;
}

export function useConfig(): ConfigContextValue {
  const { data, loading, error, refresh: innerRefresh } = useInner();
  const refresh = useCallback(async () => {
    await innerRefresh();
  }, [innerRefresh]);
  return useMemo<ConfigContextValue>(
    () => ({ sites: data.sites, brands: data.brands, loading, error, refresh }),
    [data, loading, error, refresh],
  );
}

const NO_SITES: Site[] = [];

/** Configured site names. Empty outside a ConfigProvider (e.g. a bare component test). */
export function useSiteNames(): string[] {
  const sites = useOptionalInner()?.data.sites ?? NO_SITES;
  return useMemo(() => sites.map((s) => s.name), [sites]);
}

/**
 * Label for a site: its configured display_name, else the value itself.
 * Accepts a site name or an older display-name retailer value.
 */
export function useSiteLabel(): (site: string) => string {
  const sites = useOptionalInner()?.data.sites ?? NO_SITES;
  return useCallback((site: string) => {
    const key = site.toLowerCase();
    const match = sites.find((s) => s.name.toLowerCase() === key || s.display_name?.toLowerCase() === key);
    return match?.display_name || site;
  }, [sites]);
}
