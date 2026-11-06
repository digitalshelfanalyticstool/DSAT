'use client';

import Link from 'next/link';
import { Card, Button } from '@/components/ui';
import { apiClient, type EmailTemplate } from '@/lib/api-client';
import { useAsyncResource } from '@/hooks/useAsyncResource';
import { formatDate, formatTime } from '@/lib/format';

export function TemplatesTable() {
  const { data, loading } = useAsyncResource<EmailTemplate[]>(
    async () => {
      const response = await apiClient.listEmailTemplates();
      // The old code only assigned on `success`, leaving the previous list in
      // place otherwise; returning [] here keeps that visible rather than
      // silently rendering stale rows.
      return response.success ? response.templates : [];
    },
    { onError: 'toast' },
  );
  const templates: EmailTemplate[] = data ?? [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="text-center py-12">
        <svg className="w-12 h-12 text-ink-muted mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0013.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12a3.375 3.375 0 110-6.75M8.25 21H5.625M15 21H12.75" />
        </svg>
        <h3 className="font-display text-lg font-semibold text-ink mb-1">No templates found</h3>
        <p className="text-sm text-ink-muted">Templates will appear here once configured.</p>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto -m-6">
        <table className="min-w-full divide-y divide-hairline">
          <thead className="bg-surface-secondary/80">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Slug</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Subject</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Updated</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {templates.map((template) => (
              <tr key={template.slug} className="hover:bg-surface-secondary/50 transition-colors">
                <td className="px-6 py-4 whitespace-nowrap">
                  <code className="text-sm font-mono text-ink bg-surface-tertiary px-2 py-1 rounded">{template.slug}</code>
                </td>
                <td className="px-6 py-4 text-sm text-ink max-w-xs truncate">{template.subject}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-ink-muted">
                  {formatDate(template.updated_at)} {formatTime(template.updated_at, { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <Link href={`/admin/email-settings/templates/${template.slug}`}>
                    <Button variant="outline" size="sm">Edit</Button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
