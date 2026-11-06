'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiClient } from '@/lib/api-client';
import type { ScrapingProviderCatalogEntry } from '@/lib/api-client';

type Fields = Record<string, string>;

/** Each provider's form values before anything is loaded: the catalog's defaults. */
function defaultValues(catalog: ScrapingProviderCatalogEntry[]): Record<string, Fields> {
  return Object.fromEntries(catalog.map((p) => [p.kind, Object.fromEntries(p.fields.map((f) => [f.key, f.default ?? '']))]));
}

type TestResult = { success: boolean; message: string; egressIp?: string };

export function ScrapingProviderPanel() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [source, setSource] = useState<'db' | 'env'>('env');
  const [provider, setProvider] = useState<string>('direct');
  // The server's list of providers; empty until it loads.
  const [catalog, setCatalog] = useState<ScrapingProviderCatalogEntry[]>([]);
  // Values per provider, so flipping the radio back restores what was there.
  const [values, setValues] = useState<Record<string, Fields>>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  // The exact input the last successful test covered; Save is enabled only while it still matches.
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    apiClient.getScrapingProvider()
      .then((res) => {
        setCatalog(res.catalog);
        setProvider(res.provider);
        setSource(res.source);
        const defaults = defaultValues(res.catalog);
        setValues({ ...defaults, [res.provider]: { ...defaults[res.provider], ...res.fields } });
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load scraping provider'))
      .finally(() => setLoading(false));
  }, []);

  const spec = catalog.find((p) => p.kind === provider);
  const input = { provider, fields: values[provider] ?? {} };
  const inputKey = JSON.stringify(input);
  // A failed load means we don't know what is stored; saving could overwrite it blind.
  const canSave = testedKey === inputKey && !saving && !loadError;

  const resetStatus = () => {
    setTestResult(null);
    setSaveMessage('');
    setSaveError('');
  };

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [provider]: { ...prev[provider], [key]: value } }));
    resetStatus();
  };

  const handleTest = async () => {
    resetStatus();
    setTesting(true);
    try {
      const result = await apiClient.testScrapingProvider(input);
      setTestResult(result);
      setTestedKey(result.success ? inputKey : null);
    } catch (err: unknown) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Connection test failed' });
      setTestedKey(null);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const res = await apiClient.saveScrapingProvider(input);
      setSource(res.source);
      // The server re-masks secrets; adopt its values so a re-test sends masks, not plaintext.
      setValues((prev) => ({ ...prev, [res.provider]: { ...prev[res.provider], ...res.fields } }));
      setTestedKey(null);
      setTestResult(null);
      setSaveMessage('Saved. Running workers switch to it within a minute.');
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save scraping provider');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card title="Scraping provider" titleAs="h2"><p className="text-sm text-ink-muted">Loading…</p></Card>;

  return (
    <Card title="Scraping provider" titleAs="h2">
      <div className="space-y-5">
        {loadError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">{loadError}</div>
        )}
        {source === 'env' && (
          <p className="text-sm text-ink-muted">Using settings from environment variables. Saving here overrides them.</p>
        )}

        <fieldset>
          <legend className="block text-sm font-medium text-ink mb-2">How should the scraper fetch pages?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {catalog.map((p) => (
              <label
                key={p.kind}
                className={`flex gap-2 rounded-lg border p-3 cursor-pointer ${
                  provider === p.kind ? 'border-accent bg-accent/5' : 'border-hairline'
                }`}
              >
                <input
                  type="radio"
                  name="scraping-provider"
                  value={p.kind}
                  checked={provider === p.kind}
                  onChange={() => { setProvider(p.kind); resetStatus(); }}
                  aria-labelledby={`provider-${p.kind}-label`}
                  aria-describedby={`provider-${p.kind}-desc`}
                />
                <span>
                  <span id={`provider-${p.kind}-label`} className="block text-sm font-medium text-ink">{p.label}</span>
                  <span id={`provider-${p.kind}-desc`} className="block text-xs text-ink-muted">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-4">
          {spec?.fields.map((f) => (
            <Input
              key={`${provider}-${f.key}`}
              label={f.label}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              value={values[provider]?.[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          ))}
          {spec?.hint && <p className="text-sm text-ink-muted">{spec.hint}</p>}
          {spec?.fields.some((f) => f.secret) && (
            <p className="text-xs text-ink-muted">Saved secrets are shown masked. Leave them as-is to keep the stored value.</p>
          )}
        </div>

        {testResult && (
          <div
            role="status"
            className={`px-4 py-3 rounded border ${
              testResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700'
            }`}
          >
            <p>{testResult.message}</p>
            {testResult.egressIp && <p className="text-sm">Requests leave from {testResult.egressIp}.</p>}
          </div>
        )}
        {saveMessage && (
          <div role="status" className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded">{saveMessage}</div>
        )}
        {saveError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">{saveError}</div>
        )}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {!canSave && !saving && (
            <span className="text-xs text-ink-muted">
              {loadError ? 'Reload the page to load the current settings before saving.' : 'Test the connection before saving.'}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
