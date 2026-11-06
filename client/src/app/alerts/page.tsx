'use client';

import { useState } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { AlertList } from '@/components/alerts/AlertList';
import { AlertRules } from '@/components/alerts/AlertRules';
import { AlertWebhooks } from '@/components/alerts/AlertWebhooks';
import { useSession } from '@/providers/SessionProvider';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useConfig } from '@/providers/ConfigProvider';

type Tab = 'alerts' | 'rules' | 'webhooks';

/** Alerts for everyone; rules and webhooks for admins. */
export default function AlertsPage() {
  const { authChecked } = useRequireAuth();
  const { session } = useSession();
  const isAdmin = session?.user.role === 'admin';
  const [tab, setTab] = useState<Tab>('alerts');
  const { sites, brands } = useConfig();

  const tabs: { id: Tab; label: string }[] = [
    { id: 'alerts', label: 'Alerts' },
    ...(isAdmin ? [{ id: 'rules' as const, label: 'Rules' }, { id: 'webhooks' as const, label: 'Webhooks' }] : []),
  ];

  return (
    <MainLayout>
      <div className="max-w-5xl space-y-6">
        <h1 className="text-2xl font-semibold text-ink">Alerts</h1>
        <div role="tablist" aria-label="Alerts sections" className="flex gap-1 border-b border-hairline">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
                tab === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {authChecked && (
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'alerts' && <AlertList sites={sites} brands={brands} onShowRules={isAdmin ? () => setTab('rules') : undefined} />}
            {tab === 'rules' && isAdmin && <AlertRules sites={sites} brands={brands} />}
            {tab === 'webhooks' && isAdmin && <AlertWebhooks />}
          </div>
        )}
      </div>
    </MainLayout>
  );
}
