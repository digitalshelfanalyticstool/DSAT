'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { apiClient } from '@/lib/api-client';
import type { AlertKind, AlertRule, AlertRuleInput, AlertTargetType, Brand, Site } from '@/lib/api-client';
import { KIND_OPTIONS, brandOptions, errorText, money, siteOptions } from './format';

const TARGET_OPTIONS: { value: AlertTargetType; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'brand', label: 'One brand' },
  { value: 'site', label: 'One retailer' },
  { value: 'product', label: 'One product' },
];

interface Draft {
  id?: number;
  name: string;
  enabled: boolean;
  kind: AlertKind;
  target_type: AlertTargetType;
  target_site: string;
  target_brand: string;
  target_style_id: string;
  threshold: string;
  percent: string;
}

const EMPTY: Draft = {
  name: '', enabled: true, kind: 'price_drop', target_type: 'all', target_site: '', target_brand: '',
  target_style_id: '', threshold: '', percent: '',
};

function draftFrom(rule: AlertRule): Draft {
  return {
    id: rule.id, name: rule.name, enabled: rule.enabled, kind: rule.kind, target_type: rule.target_type,
    target_site: rule.target_site ?? '', target_brand: rule.target_brand ?? '', target_style_id: rule.target_style_id ?? '',
    threshold: rule.threshold?.toString() ?? '', percent: rule.percent?.toString() ?? '',
  };
}

const positive = (v: string) => Number.isFinite(Number(v)) && Number(v) > 0;

/** What's missing before the draft can be saved, or null. */
function missing(d: Draft): string | null {
  if (!d.name.trim()) return 'Give the rule a name.';
  if (d.kind === 'price_below' && !positive(d.threshold)) return 'Enter the price to alert below.';
  if (d.kind === 'price_drop' && d.percent && (!positive(d.percent) || Number(d.percent) > 100)) return 'The minimum drop is a percent from 1 to 100.';
  if (d.target_type === 'brand' && !d.target_brand) return 'Pick a brand.';
  if (d.target_type === 'site' && !d.target_site) return 'Pick a retailer.';
  if (d.target_type === 'product' && !(d.target_site && d.target_style_id.trim())) return 'Pick a retailer and enter the style ID.';
  return null;
}

function toInput(d: Draft): AlertRuleInput {
  return {
    name: d.name.trim(), enabled: d.enabled, kind: d.kind, target_type: d.target_type,
    target_site: d.target_type === 'site' || d.target_type === 'product' ? d.target_site : null,
    target_brand: d.target_type === 'brand' ? d.target_brand : null,
    target_style_id: d.target_type === 'product' ? d.target_style_id.trim() : null,
    threshold: d.kind === 'price_below' ? Number(d.threshold) : null,
    percent: d.kind === 'price_drop' && d.percent ? Number(d.percent) : null,
  };
}

function describeWhen(r: AlertRule): string {
  if (r.kind === 'price_below') return `Price below ${money(r.threshold)}`;
  if (r.kind === 'price_drop') return r.percent ? `Price drops ${r.percent}% or more` : 'Any price drop';
  return KIND_OPTIONS.find((k) => k.value === r.kind)?.label ?? r.kind;
}

function describeTarget(r: AlertRule): string {
  switch (r.target_type) {
    case 'all': return 'Everything';
    case 'brand': return `Brand: ${r.target_brand}`;
    case 'site': return `Retailer: ${r.target_site}`;
    case 'product': return `Product ${r.target_style_id} at ${r.target_site}`;
  }
}

export function AlertRules({ sites, brands }: Readonly<{ sites: Site[]; brands: Brand[] }>) {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    apiClient.getAlertRules().then((r) => setRules(r.rules), (err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      if (draft.id) await apiClient.updateAlertRule(draft.id, toInput(draft));
      else await apiClient.createAlertRule(toInput(draft));
      setDraft(null);
      load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toDelete = async () => {
    if (!deleting) return;
    try {
      await apiClient.deleteAlertRule(deleting.id);
      load();
    } catch (err) {
      setError(errorText(err));
    }
    setDeleting(null);
  };

  const problem = draft && missing(draft);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        Rules are checked after every job. A product alerts once when it starts matching a rule, and again only after it stops matching and starts again.
      </p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {!draft && <Button onClick={() => setDraft({ ...EMPTY })}>New rule</Button>}

      {draft && (
        <Card title={draft.id ? 'Edit rule' : 'New rule'} titleAs="h2">
          <div className="space-y-4">
            <Input label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            <Select label="Alert when" value={draft.kind} options={KIND_OPTIONS} onChange={(e) => set({ kind: e.target.value as AlertKind })} />
            {draft.kind === 'price_below' && (
              <Input label="Price below ($)" type="number" min="0" step="0.01" value={draft.threshold} onChange={(e) => set({ threshold: e.target.value })} />
            )}
            {draft.kind === 'price_drop' && (
              <Input
                label="Minimum drop (%)"
                type="number"
                min="1"
                max="100"
                placeholder="Leave blank for any drop"
                value={draft.percent}
                onChange={(e) => set({ percent: e.target.value })}
              />
            )}
            <Select
              label="Applies to"
              value={draft.target_type}
              options={TARGET_OPTIONS}
              onChange={(e) => set({ target_type: e.target.value as AlertTargetType })}
            />
            {draft.target_type === 'brand' && (
              <Select label="Brand" value={draft.target_brand} options={brandOptions(brands)} placeholder="Pick a brand" onChange={(e) => set({ target_brand: e.target.value })} />
            )}
            {(draft.target_type === 'site' || draft.target_type === 'product') && (
              <Select label="Retailer" value={draft.target_site} options={siteOptions(sites)} placeholder="Pick a retailer" onChange={(e) => set({ target_site: e.target.value })} />
            )}
            {draft.target_type === 'product' && (
              <Input label="Style ID" placeholder="As shown in exports" value={draft.target_style_id} onChange={(e) => set({ target_style_id: e.target.value })} />
            )}
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              {' '}Enabled
            </label>
            {problem && <p className="text-xs text-ink-muted">{problem}</p>}
            <div className="flex gap-2">
              <Button onClick={save} disabled={Boolean(problem) || saving}>{saving ? 'Saving...' : 'Save rule'}</Button>
              <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}

      {rules?.length === 0 && !draft && <p className="text-sm text-ink-muted">No rules yet.</p>}
      {rules && rules.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {r.name}
                  {!r.enabled && <span className="ml-2 text-xs font-normal text-ink-muted">(off)</span>}
                </p>
                <p className="text-sm text-ink-muted">{describeWhen(r)} · {describeTarget(r)}</p>
              </div>
              <Button variant="outline" size="sm" aria-label={`Edit ${r.name}`} onClick={() => setDraft(draftFrom(r))}>Edit</Button>
              <Button variant="outline" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete rule"
        message={`Delete “${deleting?.name}”? Alerts it already raised stay in the list.`}
        confirmLabel="Delete"
        onConfirm={toDelete}
      />
    </div>
  );
}
