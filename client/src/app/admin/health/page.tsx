'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { apiClient } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePolling } from '@/hooks/usePolling';
import { useTicketedEventSource } from '@/hooks/useTicketedEventSource';
import { CatalogCachePanel } from './CatalogCachePanel';
import type { HealthReport, HealthSnapshot, HealthRange } from '@/lib/api-client';
import { crumbs } from '@/lib/routes';

// Recharts (~80KB gzipped) is the heaviest dep on this page and the chart
// panel is below the fold. Loading the panel through next/dynamic with ssr=false keeps the StatusBanner +
// ServiceCards + ActionsPanel paint identical, while the recharts barrel
// drops onto its own chunk that only fires once this section enters the
// viewport-adjacent render path.
const ChartSkeleton = () => (
  <Card className="p-4">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-sm font-semibold text-ink">Historical Trends</h3>
      <div className="h-6 w-32 rounded bg-surface-tertiary" />
    </div>
    <div className="flex items-center justify-center py-16">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
    </div>
  </Card>
);

const HealthHistoryCharts = dynamic(
  () => import('@/components/admin/HealthHistoryCharts'),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

// ─── Types ──────────────────────────────────────────────────────────────────

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

const STATUS_STYLES: Record<HealthStatus | 'unknown', { dot: string; bg: string; text: string }> = {
  healthy: { dot: 'bg-emerald-500', bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  degraded: { dot: 'bg-amber-500', bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  unhealthy: { dot: 'bg-red-500', bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
  unknown: { dot: 'bg-surface-tertiary', bg: 'bg-surface-secondary border-hairline', text: 'text-ink-muted' },
};

// ─── Status Banner ──────────────────────────────────────────────────────────

function StatusBanner({ health }: Readonly<{ health: HealthReport | null }>) {
  if (!health) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-secondary p-4 flex items-center gap-3">
        <div className="h-3 w-3 rounded-full bg-surface-tertiary animate-pulse" />
        <span className="text-sm text-ink-muted">Connecting to health stream...</span>
      </div>
    );
  }

  const styles = STATUS_STYLES[health.status];
  return (
    <div className={`rounded-xl border p-4 flex items-center justify-between ${styles.bg}`}>
      <div className="flex items-center gap-3">
        <div className={`h-3 w-3 rounded-full ${styles.dot} animate-pulse`} />
        <span className={`text-sm font-semibold capitalize ${styles.text}`}>
          {health.status}
        </span>
        <span className="text-xs text-ink-muted">Uptime: {formatUptime(health.uptime)}</span>
      </div>
      <span className="text-xs text-ink-muted">Live</span>
    </div>
  );
}

// ─── Service Cards ──────────────────────────────────────────────────────────

function ServiceCard({
  title,
  ok,
  children,
}: Readonly<{
  title: string;
  ok: boolean;
  children: React.ReactNode;
}>) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className={`h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
      </div>
      <div className="space-y-1 text-sm text-ink-muted">{children}</div>
    </Card>
  );
}

function ServiceCards({ health }: Readonly<{ health: HealthReport | null }>) {
  if (!health) return null;
  const { postgresql, redis, queue, workers } = health.checks;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <ServiceCard title="PostgreSQL" ok={postgresql.ok}>
        <div className="flex justify-between"><span>Pool Size</span><span className="font-medium">{postgresql.poolSize}</span></div>
        <div className="flex justify-between"><span>Active Connections</span><span className="font-medium">{postgresql.activeConnections}</span></div>
      </ServiceCard>

      <ServiceCard title="Redis" ok={redis.ok}>
        <div className="flex justify-between"><span>Memory</span><span className="font-medium">{redis.memoryUsageMb} MB</span></div>
        <div className="flex justify-between"><span>Clients</span><span className="font-medium">{redis.connectedClients}</span></div>
      </ServiceCard>

      <ServiceCard title="BullMQ Queue" ok={queue.ok}>
        <div className="flex justify-between"><span>Waiting</span><span className="font-medium">{queue.waiting}</span></div>
        <div className="flex justify-between"><span>Active</span><span className="font-medium">{queue.active}</span></div>
        <div className="flex justify-between"><span>Stalled</span><span className="font-medium text-amber-600">{queue.stalled}</span></div>
      </ServiceCard>

      <ServiceCard title="Workers" ok={workers.ok}>
        <div className="flex justify-between">
          <span>Active / Expected</span>
          <span className={`font-medium ${workers.activeWorkers < workers.expectedWorkers ? 'text-amber-600' : ''}`}>
            {workers.activeWorkers} / {workers.expectedWorkers}
          </span>
        </div>
      </ServiceCard>
    </div>
  );
}

// ─── Actions Panel ──────────────────────────────────────────────────────────

interface ActionDef {
  label: string;
  action: string;
  body?: Record<string, unknown>;
  group: string;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm: string;
}

const ACTIONS: ActionDef[] = [
  { group: 'Processes', label: 'Restart API', action: 'restart-api', variant: 'secondary', confirm: 'Restart the API process? Active requests may be interrupted.' },
  { group: 'Processes', label: 'Restart Worker 1', action: 'restart-worker', body: { name: 'scraper-worker-1' }, variant: 'secondary', confirm: 'Restart worker 1?' },
  { group: 'Processes', label: 'Restart Worker 2', action: 'restart-worker', body: { name: 'scraper-worker-2' }, variant: 'secondary', confirm: 'Restart worker 2?' },
  { group: 'Processes', label: 'Restart Worker 3', action: 'restart-worker', body: { name: 'scraper-worker-3' }, variant: 'secondary', confirm: 'Restart worker 3?' },
  { group: 'Processes', label: 'Restart Worker 4', action: 'restart-worker', body: { name: 'scraper-worker-4' }, variant: 'secondary', confirm: 'Restart worker 4?' },
  { group: 'Queue', label: 'Pause Queue', action: 'pause-queue', variant: 'secondary', confirm: 'Pause the job queue? No new jobs will be processed until resumed.' },
  { group: 'Queue', label: 'Resume Queue', action: 'resume-queue', variant: 'primary', confirm: 'Resume the job queue?' },
  { group: 'Queue', label: 'Retry All Failed', action: 'flush-dlq', variant: 'danger', confirm: 'Retry all failed jobs in the dead letter queue?' },
  { group: 'Database', label: 'Cleanup Tokens', action: 'cleanup-tokens', variant: 'secondary', confirm: 'Delete expired refresh tokens and rate limit entries?' },
  { group: 'Database', label: 'Clear Rate Limits', action: 'clear-rate-limits', variant: 'secondary', confirm: 'Clear all rate limit entries? This will reset login attempt tracking.' },
];

interface ActionsPanelProps {
  showToast: (msg: string, type: 'success' | 'error') => void;
  confirmAction: (title: string, message: string, isDanger: boolean) => Promise<boolean>;
}

function ActionsPanel({ showToast, confirmAction }: Readonly<ActionsPanelProps>) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const handleAction = async (def: ActionDef) => {
    const ok = await confirmAction(def.label, def.confirm, def.variant === 'danger');
    if (!ok) return;

    const key = def.body ? `${def.action}-${JSON.stringify(def.body)}` : def.action;
    setLoading(key);
    try {
      const result = await apiClient.healthAction(def.action, def.body);
      showToast(result.message, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Action failed', 'error');
    } finally {
      setLoading(null);
    }
  };

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <Card className="p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <h3 className="text-sm font-semibold text-ink">Actions</h3>
        <svg
          // eslint-disable-next-line no-restricted-syntax -- decorative icon, aria-hidden
          className={`h-4 w-4 text-ink-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <div key={group}>
              <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">{group}</p>
              <div className="flex flex-wrap gap-2">
                {ACTIONS.filter((a) => a.group === group).map((def) => {
                  const key = def.body ? `${def.action}-${JSON.stringify(def.body)}` : def.action;
                  const variantMap = { danger: 'danger', primary: 'primary' } as const;
                  const resolvedVariant = (def.variant && variantMap[def.variant as keyof typeof variantMap]) || 'secondary';
                  return (
                    <Button
                      key={key}
                      size="sm"
                      variant={resolvedVariant}
                      disabled={loading !== null}
                      onClick={() => handleAction(def)}
                    >
                      {loading === key ? 'Running...' : def.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function AdminHealthPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();
  const { confirm, ConfirmDialogHost } = useConfirm();

  const confirmAction = useCallback(
    (title: string, message: string, isDanger: boolean) =>
      confirm({
        title,
        message,
        confirmLabel: isDanger ? 'Confirm' : 'Run',
        confirmVariant: isDanger ? 'danger' : 'primary',
      }),
    [confirm],
  );

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [snapshots, setSnapshots] = useState<HealthSnapshot[]>([]);
  const [range, setRange] = useState<HealthRange>('24h');
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Live health: SSE, falling back to 5s polling (e.g. a self-signed cert) ──
  // The stream fails over on any error (tickets are single-use, so it is never
  // replayed) or when no `health` event arrives within 3s.
  const [polling, setPolling] = useState(false);
  const streamDeliveredRef = useRef(false);
  useTicketedEventSource(authChecked && !polling ? '/admin/health/stream' : null, {
    events: {
      health: (data) => {
        streamDeliveredRef.current = true;
        setHealth(data as HealthReport);
      },
    },
    onError: () => setPolling(true),
  });
  useEffect(() => {
    if (!authChecked || polling) return;
    const timer = setTimeout(() => {
      if (!streamDeliveredRef.current) setPolling(true);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [authChecked, polling]);

  const pollHealth = useCallback(async () => {
    try {
      setHealth(await apiClient.healthPoll());
    } catch {
      // Silently retry on the next tick.
    }
  }, []);
  useEffect(() => {
    if (polling) void pollHealth();
  }, [polling, pollHealth]);
  usePolling(pollHealth, polling ? 5_000 : null);

  // ── Load History ──
  const loadHistory = useCallback(async (r: HealthRange) => {
    setHistoryLoading(true);
    try {
      const res = await apiClient.getHealthHistory(r);
      setSnapshots(res.snapshots);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load history', 'error');
    } finally {
      setHistoryLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (authChecked) loadHistory(range);
  }, [authChecked, range, loadHistory]);

  const handleRangeChange = (r: HealthRange) => {
    setRange(r);
  };

  // ── Loading State ──
  if (!authChecked) {
    return (
      <div className="min-h-dvh bg-surface-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto" />
      </div>
    );
  }

  return (
    <MainLayout>
      <ConfirmDialogHost />
      <Breadcrumbs
        items={crumbs('/admin/health')}
      />
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-ink">System Health</h1>
          <p className="text-sm text-ink-muted mt-1">Real-time infrastructure monitoring and admin actions</p>
        </div>

        {/* Status Banner */}
        <StatusBanner health={health} />

        {/* Service Cards */}
        <ServiceCards health={health} />

        {/* Actions Panel */}
        <ActionsPanel showToast={showToast} confirmAction={confirmAction} />

        {/* Catalog Cache inventory + purge */}
        <CatalogCachePanel showToast={showToast} confirmAction={confirmAction} />

        {/* Historical Trends — recharts is loaded on demand */}
        <HealthHistoryCharts
          snapshots={snapshots}
          range={range}
          onRangeChange={handleRangeChange}
          loading={historyLoading}
        />
      </div>
    </MainLayout>
  );
}
