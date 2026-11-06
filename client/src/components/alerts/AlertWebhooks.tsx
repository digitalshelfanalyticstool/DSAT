'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { apiClient } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import type { AlertWebhook, AlertWebhookInput } from '@/lib/api-client';
import { errorText } from './format';

interface Draft {
  id?: number;
  name: string;
  url: string;
  enabled: boolean;
  /** Blank: keep the stored secret (or set none, for a new webhook). */
  secret: string;
  has_secret: boolean;
  remove_secret: boolean;
}

const EMPTY: Draft = { name: '', url: '', enabled: true, secret: '', has_secret: false, remove_secret: false };

function toInput(d: Draft): AlertWebhookInput {
  const input: AlertWebhookInput = { name: d.name.trim(), url: d.url.trim(), enabled: d.enabled };
  if (d.secret) input.secret = d.secret;
  else if (d.remove_secret) input.secret = null;
  return input;
}

function lastDelivery(h: AlertWebhook): string | null {
  if (!h.last_attempt_at) return null;
  const when = formatDateTime(h.last_attempt_at);
  return h.last_error ? `Last delivery failed (${h.last_error}), ${when}` : `Last delivered (HTTP ${h.last_status}), ${when}`;
}

export function AlertWebhooks() {
  const [hooks, setHooks] = useState<AlertWebhook[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AlertWebhook | null>(null);
  const [testResult, setTestResult] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    apiClient.getAlertWebhooks().then((r) => setHooks(r.webhooks), (err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      if (draft.id) await apiClient.updateAlertWebhook(draft.id, toInput(draft));
      else await apiClient.createAlertWebhook(toInput(draft));
      setDraft(null);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (h: AlertWebhook) => {
    setTestResult((t) => ({ ...t, [h.id]: 'Sending...' }));
    try {
      const r = await apiClient.testAlertWebhook(h.id);
      setTestResult((t) => ({ ...t, [h.id]: r.success ? `Test sent: HTTP ${r.status}` : `Test failed: ${r.error}` }));
    } catch (err) {
      setTestResult((t) => ({ ...t, [h.id]: `Test failed: ${errorText(err)}` }));
    }
    load();
  };

  const toDelete = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteAlertWebhook(deleting.id);
      load();
    } catch (err) {
      setError(errorText(err));
    }
    setDeleting(null);
  };

  const canSave = draft && draft.name.trim() && /^https?:\/\/\S+$/i.test(draft.url.trim()) && !saving;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        After a job raises alerts, each webhook gets one JSON POST listing them. Its <code>text</code> field is a readable summary, so a Slack
        incoming-webhook URL works as is. With a secret set, requests carry <code>X-Signature: sha256=&lt;HMAC of the body&gt;</code>.
      </p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {!draft && <Button onClick={() => setDraft({ ...EMPTY })}>New webhook</Button>}

      {draft && (
        <Card title={draft.id ? 'Edit webhook' : 'New webhook'} titleAs="h2">
          <div className="space-y-4">
            <Input label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            <Input label="URL" type="url" placeholder="https://hooks.slack.com/services/..." value={draft.url} onChange={(e) => set({ url: e.target.value })} />
            <div>
              <Input
                label="Secret (optional)"
                type="password"
                autoComplete="new-password"
                value={draft.secret}
                disabled={draft.remove_secret}
                onChange={(e) => set({ secret: e.target.value })}
              />
              {draft.has_secret && (
                <p className="mt-1 text-xs text-ink-muted">A secret is stored. Leave this blank to keep it, or type a new one to replace it.</p>
              )}
            </div>
            {draft.has_secret && (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={draft.remove_secret} onChange={(e) => set({ remove_secret: e.target.checked, secret: '' })} />
                {' '}Remove the stored secret
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              {' '}Enabled
            </label>
            <div className="flex gap-2">
              <Button onClick={save} disabled={!canSave}>{saving ? 'Saving...' : 'Save webhook'}</Button>
              <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      {hooks?.length === 0 && !draft && <p className="text-sm text-ink-muted">No webhooks yet.</p>}
      {hooks && hooks.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
          {hooks.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-sm font-semibold text-ink">
                  {h.name}
                  {!h.enabled && <span className="ml-2 text-xs font-normal text-ink-muted">(off)</span>}
                </p>
                <p className="text-sm text-ink-muted truncate">{h.url}</p>
                <p className="text-xs text-ink-muted">
                  {h.has_secret ? 'Secret set' : 'No secret'}
                  {lastDelivery(h) && <> · {lastDelivery(h)}</>}
                </p>
                {testResult[h.id] && <p role="status" className="text-xs text-ink">{testResult[h.id]}</p>}
              </div>
              <Button variant="secondary" size="sm" onClick={() => sendTest(h)}>Send test</Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Edit ${h.name}`}
                onClick={() => setDraft({ id: h.id, name: h.name, url: h.url, enabled: h.enabled, secret: '', has_secret: h.has_secret, remove_secret: false })}
              >
                Edit
              </Button>
              <Button variant="outline" size="sm" aria-label={`Delete ${h.name}`} onClick={() => setDeleting(h)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete webhook"
        message={`Delete “${deleting?.name}”? It stops receiving alerts.`}
        confirmLabel="Delete"
        onConfirm={toDelete}
      />
    </div>
  );
}
