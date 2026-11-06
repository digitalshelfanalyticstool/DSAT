'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
import { apiClient } from '@/lib/api-client';
import type { SitePreview } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useConfig } from '@/providers/ConfigProvider';

type SiteSuggestion = { name: string; display_name: string; existing: boolean };
type SampleRow = Record<string, string>;

const PROBLEM_COPY: Record<NonNullable<SitePreview['problem']>, string> = {
  blocked: 'This site blocked the request. Check the scraping provider on the Config page, then try again.',
  no_links: 'No product links found — edit the pattern and preview again.',
  no_data: "Found products but couldn't read product data from their pages.",
  timeout: 'The site took too long to answer. Try again in a moment.',
};

const SAMPLE_COLUMNS = (['title', 'color', 'size', 'selling_price', 'list_price', 'inventory'] as const).map((key) => ({
  header: key.replace('_', ' '),
  accessor: key as keyof SampleRow,
}));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** "Add a retailer": paste a brand page, preview what we'd find, then save the site and brand and start a job. */
export default function AddRetailerPage() {
  const router = useRouter();
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { refresh: refreshConfig } = useConfig();

  const [url, setUrl] = useState('');
  const [brand, setBrand] = useState('');
  const [adapters, setAdapters] = useState<string[]>([]);
  const [adapter, setAdapter] = useState('');
  // Adapters that discover by matching listing links; the server says which.
  const [patternAdapters, setPatternAdapters] = useState<string[]>([]);
  const needsPattern = patternAdapters.includes(adapter);
  const [pattern, setPattern] = useState('');
  const [preview, setPreview] = useState<SitePreview | null>(null);
  const [site, setSite] = useState<SiteSuggestion | null>(null);
  const [siteName, setSiteName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!authChecked) return;
    apiClient.getAdapters().then((r) => {
      setAdapters(r.adapters);
      setPatternAdapters(r.needs_link_pattern ?? []);
    }, () => setAdapters([]));
  }, [authChecked]);

  const runPreview = async (again: boolean) => {
    setPreviewing(true);
    setError('');
    try {
      const res = await apiClient.previewSite({
        url: url.trim(),
        brand: brand.trim(),
        ...(again && adapter && { adapter }),
        ...(again && pattern.trim() && { product_link_pattern: pattern.trim() }),
      });
      setPreview(res.preview);
      setAdapter(res.preview.adapter);
      if (!again || res.preview.suggested_pattern) setPattern(res.preview.suggested_pattern ?? pattern);
      setSite(res.site);
      setSiteName(res.site.name);
      setDisplayName(res.site.display_name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPreviewing(false);
    }
  };

  const confirm = async () => {
    if (!site) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiClient.onboardSite({
        url: url.trim(),
        brand: brand.trim(),
        adapter,
        ...(pattern.trim() && needsPattern && { product_link_pattern: pattern.trim() }),
        ...(!site.existing && { name: siteName.trim(), display_name: displayName.trim() }),
      });
      // The new site must appear in site pickers without waiting out the cache.
      void refreshConfig();
      router.push(`/jobs/${res.job_id}`);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  const rows: SampleRow[] = preview?.samples.flatMap((s) => s.rows) ?? [];
  const canPreview = url.trim() !== '' && brand.trim() !== '' && !previewing;

  return (
    <MainLayout>
      <div className="max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold text-ink">Add a retailer</h1>

        <Card title="1. Brand page" titleAs="h2">
          <div className="space-y-4">
            <Input
              label="Brand page URL"
              placeholder="https://store.example/collections/your-brand"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input label="Brand name" value={brand} onChange={(e) => setBrand(e.target.value)} />
            <Button onClick={() => runPreview(false)} disabled={!canPreview}>
              {previewing && !preview ? 'Previewing...' : 'Preview'}
            </Button>
          </div>
        </Card>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        {preview && (
          <Card title="2. Preview" titleAs="h2">
            <div className="space-y-4">
              <Select
                label="Adapter"
                value={adapter}
                options={adapters.map((id) => ({ value: id, label: id }))}
                onChange={(e) => setAdapter(e.target.value)}
              />
              {needsPattern && (
                <div>
                  <Input label="Product link pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} />
                  {preview.suggested_pattern && pattern === preview.suggested_pattern && (
                    <p className="mt-1 text-xs text-ink-muted">Suggested from the links on the page. Edit it if it picks the wrong links.</p>
                  )}
                </div>
              )}
              <Button variant="secondary" onClick={() => runPreview(true)} disabled={!canPreview}>
                {previewing ? 'Previewing...' : 'Preview again'}
              </Button>

              {preview.problem ? (
                <p className="text-sm text-danger">
                  {PROBLEM_COPY[preview.problem]}
                  {preview.message && <span className="block text-xs text-ink-muted">{preview.message}</span>}
                </p>
              ) : (
                <>
                  <p className="text-sm text-ink">
                    Found <strong>{preview.link_count} product links</strong>. Sample from {preview.samples.length} product pages:
                  </p>
                  <Table columns={SAMPLE_COLUMNS} data={rows} />
                  <p className="text-sm text-ink-muted">
                    Filled: {preview.fields.filled.join(', ') || 'none'}. Empty: {preview.fields.empty.join(', ') || 'none'}.
                  </p>
                </>
              )}
            </div>
          </Card>
        )}

        {preview && !preview.problem && site && (
          <Card title="3. Save and start" titleAs="h2">
            <div className="space-y-4">
              {site.existing ? (
                <p className="text-sm text-ink">Adds {brand.trim()} to {site.display_name}, which is already set up for this store.</p>
              ) : (
                <>
                  <Input label="Site name" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
                  <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </>
              )}
              <Button onClick={confirm} disabled={saving}>
                {saving ? 'Saving...' : 'Add retailer and start first job'}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}
