'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { MainLayout } from '@/components/layout/MainLayout';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Card, Button, Input, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiClient, type EmailTemplate } from '@/lib/api-client';
import { crumbs } from '@/lib/routes';

function TemplateEditorInner() {
  const router = useRouter();
  const params = useParams();
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();
  const slug = params.slug as string;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [template, setTemplate] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [variablesJson, setVariablesJson] = useState('[]');
  const [variablesError, setVariablesError] = useState('');
  const [variables, setVariables] = useState<string[]>([]);

  const parseVariables = (json: string) => {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        setVariablesError('Variables must be an array of strings');
        return false;
      }
      setVariables(parsed);
      setVariablesError('');
      return true;
    } catch {
      setVariablesError('Invalid JSON');
      return false;
    }
  };

  useEffect(() => {
    if (!authChecked) return;
    loadTemplate();
  }, [authChecked]);

  const loadTemplate = async () => {
    setLoading(true);
    try {
      const response = await apiClient.getEmailTemplate(slug);
      if (response.success && response.template) {
        const t = response.template;
        setTemplate(t);
        setSubject(t.subject);
        setBodyHtml(t.body_html);
        setBodyText(t.body_text);
        const varJson = JSON.stringify(t.variables, null, 2);
        setVariablesJson(varJson);
        setVariables(t.variables);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load template', 'error');
      router.back();
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!parseVariables(variablesJson)) {
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiClient.updateEmailTemplate(slug, {
        subject,
        body_html: bodyHtml,
        body_text: bodyText,
        variables,
      });
      if (response.success) {
        showToast('Template saved', 'success');
        setTemplate(response.template);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save template', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    );
  }

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  if (!template) {
    return (
      <MainLayout>
        <Breadcrumbs
          items={crumbs('/config', { label: 'Email', href: '/config?tab=email' }, { label: 'Template not found' })}
        />
        <div className="text-center py-12">
          <h3 className="font-display text-lg font-semibold text-ink mb-1">Template not found</h3>
          <Button variant="outline" onClick={() => router.back()} className="mt-4">
            Go back
          </Button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <Breadcrumbs
        items={crumbs('/config', { label: 'Email', href: '/config?tab=email' }, { label: slug })}
      />

      <div className="space-y-6">
        <div className="animate-in flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-ink">Edit Template</h1>
            <p className="mt-1 text-sm text-ink-muted">
              <code className="bg-surface-tertiary px-2 py-1 rounded text-xs font-mono">{slug}</code>
            </p>
          </div>
        </div>

        <Card>
          <div className="space-y-6">
            <Input
              label="Subject"
              placeholder="Email subject line"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-required="true"
            />

            <div>
              <label htmlFor="email-template-body-html" className="block text-sm font-medium text-ink mb-2">HTML Body</label>
              <textarea
                id="email-template-body-html"
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                rows={12}
                className="w-full px-3 py-2 border border-hairline rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
                placeholder="<html>...</html>"
                aria-required="true"
              />
            </div>

            <div>
              <label htmlFor="email-template-body-text" className="block text-sm font-medium text-ink mb-2">Text Body</label>
              <textarea
                id="email-template-body-text"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 border border-hairline rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
                placeholder="Plain text version"
                aria-required="true"
              />
            </div>

            <div>
              <label htmlFor="email-template-variables-json" className="block text-sm font-medium text-ink mb-2">Variables (JSON)</label>
              <textarea
                id="email-template-variables-json"
                value={variablesJson}
                onChange={(e) => {
                  setVariablesJson(e.target.value);
                  parseVariables(e.target.value);
                }}
                rows={4}
                className={`w-full px-3 py-2 border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  variablesError ? 'border-red-300 focus:ring-red-300/50' : 'border-hairline'
                }`}
                placeholder='["name", "email", "link"]'
              />
              {variablesError && <p className="text-xs text-red-700 mt-1">{variablesError}</p>}
            </div>

            {variables.length > 0 && (
              <div>
                <p className="block text-sm font-medium text-ink mb-2">Variables List</p>
                <div className="flex flex-wrap gap-2">
                  {variables.map((v) => (
                    <Badge key={v} variant="info">{v}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-hairline">
              <Button variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={submitting || !!variablesError}>
                {submitting ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </MainLayout>
  );
}

export default function TemplateEditorPage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    }>
      <TemplateEditorInner />
    </Suspense>
  );
}
