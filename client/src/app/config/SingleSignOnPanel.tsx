'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiClient } from '@/lib/api-client';
import type { SsoFields } from '@/lib/api-client';

type Form = Omit<SsoFields, 'allowedEmailDomains'> & { domains: string };

const EMPTY: Form = { enabled: false, issuerUrl: '', clientId: '', clientSecret: '', domains: '', buttonLabel: '' };

function toFields(f: Form): SsoFields {
  const { domains, ...rest } = f;
  return { ...rest, allowedEmailDomains: domains.split(',').map((d) => d.trim()).filter(Boolean) };
}

export function SingleSignOnPanel() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [form, setForm] = useState<Form>(EMPTY);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  // The exact input the last successful test covered; Save is enabled only while it still matches.
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');

  const adopt = (fields: SsoFields) => setForm({ ...fields, domains: fields.allowedEmailDomains.join(', ') });

  useEffect(() => {
    apiClient.getSsoSettings()
      .then((res) => { setRedirectUri(res.redirectUri); adopt(res.fields); })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load single sign-on settings'))
      .finally(() => setLoading(false));
  }, []);

  const fields = toFields(form);
  const inputKey = JSON.stringify(fields);
  // A failed load means we don't know what is stored; saving could overwrite it blind.
  // Turning SSO off needs no test, so a provider that is down can still be switched off.
  const canSave = (testedKey === inputKey || !form.enabled) && !saving && !loadError;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
    setSaveMessage('');
    setSaveError('');
  };

  const handleTest = async () => {
    setTesting(true);
    setSaveMessage('');
    try {
      const result = await apiClient.testSsoSettings({ fields });
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
      const res = await apiClient.saveSsoSettings({ fields });
      // The server re-masks the secret; adopt it so a re-test sends the mask, not plaintext.
      adopt(res.fields);
      setTestedKey(null);
      setTestResult(null);
      setSaveMessage('Saved.');
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save single sign-on settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card title="Single sign-on" titleAs="h2"><p className="text-sm text-ink-muted">Loading…</p></Card>;

  return (
    <Card title="Single sign-on" titleAs="h2">
      <div className="space-y-5">
        {loadError && <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">{loadError}</div>}
        <p className="text-sm text-ink-muted">
          Connect any OpenID Connect provider (Microsoft Entra ID, Okta, Google Workspace, …). Password sign-in stays available.
        </p>

        {redirectUri && (
          <div>
            <p className="block text-sm font-medium text-ink mb-1">Redirect URI — register this with your identity provider</p>
            <div className="flex items-center gap-2">
              <code className="text-sm bg-surface-secondary px-2 py-1 rounded break-all">{redirectUri}</code>
              <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(redirectUri); }}>Copy</Button>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Show &quot;Sign in with SSO&quot; on the sign-in page
        </label>

        <div className="space-y-4">
          <Input label="Issuer URL" value={form.issuerUrl} placeholder="https://login.example.com/tenant/v2.0" autoComplete="off"
            onChange={(e) => set('issuerUrl', e.target.value)} />
          <Input label="Client ID" value={form.clientId} autoComplete="off" onChange={(e) => set('clientId', e.target.value)} />
          <Input label="Client secret" type="password" value={form.clientSecret} autoComplete="off"
            onChange={(e) => set('clientSecret', e.target.value)} />
          <Input label="Allowed email domains" value={form.domains} placeholder="example.com, example.org" autoComplete="off"
            onChange={(e) => set('domains', e.target.value)} />
          <p className="text-xs text-ink-muted">
            People from these domains get an account (role: user) the first time they sign in with SSO. An existing non-admin account on one of these domains is connected to SSO by matching email. Leave empty to only let in accounts already connected to SSO.
          </p>
          <Input label="Button label (optional)" value={form.buttonLabel} placeholder="SSO" autoComplete="off"
            onChange={(e) => set('buttonLabel', e.target.value)} />
          <p className="text-xs text-ink-muted">The saved secret is shown masked. Leave it as-is to keep the stored value; changing the issuer URL or client ID needs the secret entered again.</p>
        </div>

        {testResult && (
          <div role="status" className={`px-4 py-3 rounded border ${
            testResult.success ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>{testResult.message}</div>
        )}
        {saveMessage && <div role="status" className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded">{saveMessage}</div>}
        {saveError && <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded">{saveError}</div>}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={handleTest} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</Button>
          {!canSave && !saving && (
            <span className="text-xs text-ink-muted">
              {loadError ? 'Reload the page to load the current settings before saving.' : 'Test the connection before saving (not needed to turn SSO off).'}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
