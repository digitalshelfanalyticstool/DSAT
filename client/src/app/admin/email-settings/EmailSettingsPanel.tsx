'use client';

import { useState } from 'react';
import { ProviderForm } from './ProviderForm';
import { TemplatesTable } from './TemplatesTable';
import { SendLogTable } from './SendLogTable';

type EmailTab = 'provider' | 'templates' | 'log';

export function EmailSettingsPanel() {
  const [tab, setTab] = useState<EmailTab>('provider');

  const tabs: Array<{ id: EmailTab; label: string }> = [
    { id: 'provider', label: 'Provider' },
    { id: 'templates', label: 'Templates' },
    { id: 'log', label: 'Send Log' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-ink">Email Settings</h2>
        <p className="mt-1 text-ink-muted">Configure email provider and templates</p>
      </div>

      {/* Sub-tab strip */}
      <div role="tablist" className="flex gap-0 border-b border-hairline">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-3 font-medium text-sm transition-colors border-b-2 -mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
              tab === t.id
                ? 'text-accent border-accent'
                : 'text-ink-muted border-transparent hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div>
        {tab === 'provider' && <ProviderForm />}
        {tab === 'templates' && <TemplatesTable />}
        {tab === 'log' && <SendLogTable />}
      </div>
    </div>
  );
}
