'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card, Button, Badge, Select, Input, Pagination } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { apiClient } from '@/lib/api-client';
import type { SiteMonitorRun, SiteMonitorChange, SiteMonitorRetailerSummary, MonitorProgressEvent, MonitorSchedule } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useTicketedEventSource } from '@/hooks/useTicketedEventSource';
import { appendBoundedEvents, MAX_LOG_EVENTS } from '@/lib/bounded-event-log';
import { formatDateTime, formatTime } from '@/lib/format';
import { useSiteLabel, useSiteNames } from '@/providers/ConfigProvider';
import { DAY_LABELS, SCHEDULE_TZ_LABEL } from '@/lib/schedule';

const SEVERITY_BADGE: Record<string, 'error' | 'warning' | 'info'> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};


const STATUS_BADGE: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  completed: 'success',
  running: 'warning',
  failed: 'error',
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return formatDateTime(dateStr);
}

function getEventColor(type: string): string {
  if (type === 'run_error' || type === 'product_fetch_error' || type === 'product_error') return 'text-red-500';
  if (type === 'run_complete') return 'text-green-600';
  if (type === 'retailer_start' || type === 'retailer_complete' || type === 'retailer_no_products') return 'text-accent';
  return 'text-ink-muted';
}

export default function SiteMonitorPage() {
  const { authChecked } = useRequireAuth({ role: 'admin' });
  const { showToast } = useToast();

  // Data
  const [summaries, setSummaries] = useState<SiteMonitorRetailerSummary[]>([]);
  const [runs, setRuns] = useState<SiteMonitorRun[]>([]);
  const [changes, setChanges] = useState<SiteMonitorChange[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0 });

  // UI state
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [filterRetailer, setFilterRetailer] = useState('');
  const siteNames = useSiteNames();
  const siteLabel = useSiteLabel();
  const [filterSeverity, setFilterSeverity] = useState('');

  // Schedule state
  const [schedule, setSchedule] = useState<MonitorSchedule>({ enabled: true, schedule_time: '02:00', schedule_days: [0] });
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Live progress state
  const [progressEvents, setProgressEvents] = useState<MonitorProgressEvent[]>([]);
  // The run whose live progress stream is open, or null.
  const [streamRunId, setStreamRunId] = useState<number | null>(null);
  const isStreaming = streamRunId !== null;
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const changesRef = useRef<HTMLDivElement | null>(null);

  // Load summary + runs + schedule
  const loadData = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const [summaryRes, runsRes, scheduleRes] = await Promise.all([
        apiClient.getSiteMonitorSummary(),
        apiClient.getSiteMonitorRuns(page),
        apiClient.getSiteMonitorSchedule(),
      ]);
      setSummaries(summaryRes.retailers);
      setRuns(runsRes.runs);
      setPagination(runsRes.pagination);
      setSchedule(scheduleRes.schedule);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load data', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const handleSaveSchedule = async () => {
    setSavingSchedule(true);
    try {
      const res = await apiClient.updateSiteMonitorSchedule(schedule);
      setSchedule(res.schedule);
      showToast('Schedule saved', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save schedule', 'error');
    } finally {
      setSavingSchedule(false);
    }
  };

  const toggleDay = (day: number) => {
    setSchedule(prev => ({
      ...prev,
      schedule_days: prev.schedule_days.includes(day)
        ? prev.schedule_days.filter(d => d !== day)
        : [...prev.schedule_days, day].sort((a, b) => a - b),
    }));
  };

  // Load changes for selected run
  const loadChanges = useCallback(async (runId: number, retailer?: string, severity?: string) => {
    try {
      const res = await apiClient.getSiteMonitorRunChanges(
        runId,
        retailer || undefined,
        severity || undefined,
      );
      setChanges(res.changes);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load changes', 'error');
    }
  }, [showToast]);

  // Live progress for a running monitor. Completion or failure closes the
  // stream and reloads the run list to show the final results.
  const finishStream = () => {
    setStreamRunId(null);
    loadData(pagination.page);
  };
  useTicketedEventSource(streamRunId === null ? null : `/site-monitor/runs/${streamRunId}/stream`, {
    events: {
      // The live log is capped at MAX_LOG_EVENTS so a chatty run
      // doesn't grow the buffer unboundedly; the card shows a notice at the cap.
      progress: (event) => setProgressEvents((prev) => appendBoundedEvents(prev, event as MonitorProgressEvent)),
      completed: finishStream,
      failed: finishStream,
    },
    onError: () => setStreamRunId(null),
  });

  const watchRun = (runId: number) => {
    setProgressEvents([]);
    setStreamRunId(runId);
  };

  // Auto-scroll log panel
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [progressEvents]);

  useEffect(() => {
    if (authChecked) loadData();
  }, [authChecked, loadData]);

  useEffect(() => {
    if (selectedRunId) {
      loadChanges(selectedRunId, filterRetailer, filterSeverity);
    }
  }, [selectedRunId, filterRetailer, filterSeverity, loadChanges]);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const res = await apiClient.triggerSiteMonitorRun();
      showToast('Monitor run started', 'success');
      setSelectedRunId(res.run_id);
      setFilterRetailer('');
      setFilterSeverity('');
      setChanges([]);
      watchRun(res.run_id);
      setTimeout(() => loadData(pagination.page), 1000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to trigger run', 'error');
    } finally {
      setTriggering(false);
    }
  };

  const handleRunClick = (runId: number) => {
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setChanges([]);
      setProgressEvents([]);
      setStreamRunId(null);
    } else {
      setSelectedRunId(runId);
      setFilterRetailer('');
      setFilterSeverity('');
      // If the run is currently running, connect SSE for live progress
      const run = runs.find(r => r.id === runId);
      if (run?.status === 'running') {
        watchRun(runId);
      } else {
        setProgressEvents([]);
        setStreamRunId(null);
      }
      // Scroll to the changes section after React renders it
      setTimeout(() => {
        changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  };

  if (!authChecked) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <MainLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Header */}
        <div className="animate-in flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-ink">Site Change Monitor</h1>
            <p className="mt-1 text-ink-muted">
              Detect structural changes on retailer PDP pages before scrapers break.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? 'Starting...' : 'Run Monitor Now'}
          </Button>
        </div>

        {/* Schedule Configuration */}
        <Card className="animate-in-delay" style={{ '--stagger': 1 } as React.CSSProperties}>
          <div className="p-4">
            <h2 className="text-lg font-semibold text-ink mb-4">Schedule</h2>
            <div className="flex flex-wrap items-end gap-6">
              {/* Enabled toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={(e) => setSchedule(prev => ({ ...prev, enabled: e.target.checked }))}
                  className="h-4 w-4 rounded border-hairline text-accent focus:ring-accent"
                />
                <span className="text-sm font-medium text-ink">Enabled</span>
              </label>

              {/* Time picker */}
              <div className="w-36">
                <Input
                  label="Time (ET)"
                  type="time"
                  value={schedule.schedule_time}
                  onChange={(e) => setSchedule(prev => ({ ...prev, schedule_time: e.target.value }))}
                />
              </div>

              {/* Day selector */}
              <div>
                <span className="block text-sm font-medium text-ink mb-1">Days</span>
                <div className="flex gap-1">
                  {DAY_LABELS.map((label, idx) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleDay(idx)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                        schedule.schedule_days.includes(idx)
                          ? 'bg-accent text-white border-accent'
                          : 'bg-white text-ink border-hairline hover:bg-surface-secondary'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Save button */}
              <Button
                variant="primary"
                onClick={handleSaveSchedule}
                disabled={savingSchedule}
              >
                {savingSchedule ? 'Saving...' : 'Save Schedule'}
              </Button>
            </div>

            {/* Summary text */}
            <p className="mt-3 text-sm text-ink-muted">
              {schedule.enabled
                ? `Runs every ${schedule.schedule_days.map(d => DAY_LABELS[d]).join(', ') || '(no days selected)'} at ${schedule.schedule_time} ${SCHEDULE_TZ_LABEL}`
                : 'Automatic monitoring is disabled'}
            </p>
          </div>
        </Card>

        {/* Retailer Summary Cards */}
        <div className="animate-in-delay grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" style={{ '--stagger': 2 } as React.CSSProperties}>
          {loading && summaries.length === 0 ? (
            [0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-28 rounded-lg" />
            ))
          ) : summaries.map((s) => (
            <Card key={s.retailer}>
              <div className="p-4">
                <h3 className="text-sm font-semibold text-ink-muted uppercase tracking-wide">
                  {s.retailer}
                </h3>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-2xl font-bold tabular-nums text-ink">
                    {s.change_count}
                  </span>
                  {s.highest_severity && (
                    <Badge variant={SEVERITY_BADGE[s.highest_severity] ?? 'default'}>
                      {s.highest_severity}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {s.last_check_date ? `Last checked: ${formatDate(s.last_check_date)}` : 'No checks yet'}
                </p>
              </div>
            </Card>
          ))}
        </div>

        {/* Runs Table */}
        <Card className="animate-in-delay" style={{ '--stagger': 3 } as React.CSSProperties}>
          <div className="p-4">
            <h2 className="text-lg font-semibold text-ink mb-4">Recent Runs</h2>
            {loading && (
              <div className="space-y-2 py-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-12 w-full rounded" />
                ))}
              </div>
            )}
            {!loading && runs.length === 0 && (
              <p className="text-ink-muted text-center py-8">No monitor runs yet. Click &quot;Run Monitor Now&quot; to start.</p>
            )}
            {!loading && runs.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-hairline">
                    <thead className="bg-surface-secondary">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Run</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Started</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Retailers</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Changes</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Critical</th>
                      </tr>
                    </thead>
                    <tbody className="bg-surface divide-y divide-hairline">
                      {runs.map((run) => (
                        <tr
                          key={run.id}
                          onClick={() => handleRunClick(run.id)}
                          className={`cursor-pointer transition-colors ${
                            selectedRunId === run.id ? 'bg-accent-50' : 'hover:bg-surface-secondary'
                          }`}
                        >
                          <td className="px-4 py-3 text-sm font-medium text-ink">#{run.id}</td>
                          <td className="px-4 py-3 text-sm text-ink-muted">{formatDate(run.started_at)}</td>
                          <td className="px-4 py-3 text-sm">
                            <Badge variant={STATUS_BADGE[run.status] ?? 'default'}>{run.status}</Badge>
                          </td>
                          <td className="px-4 py-3 text-sm tabular-nums text-ink-muted">{run.retailers_checked}</td>
                          <td className="px-4 py-3 text-sm tabular-nums text-ink-muted">{run.total_changes_detected}</td>
                          <td className="px-4 py-3 text-sm tabular-nums">
                            {run.critical_changes > 0 ? (
                              <Badge variant="error">{run.critical_changes}</Badge>
                            ) : (
                              <span className="text-ink-muted">0</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="mt-4">
                    <Pagination
                      currentPage={pagination.page}
                      totalPages={totalPages}
                      onPageChange={(p) => loadData(p)}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        {/* Live Progress Log */}
        {selectedRunId && (isStreaming || progressEvents.length > 0) && (
          <Card>
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-ink flex items-center gap-2">
                  Live Progress
                  {isStreaming && (
                    <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  )}
                </h2>
                {!isStreaming && progressEvents.length > 0 && (
                  <span className="text-xs text-ink-muted">Stream ended</span>
                )}
              </div>
              {/* Surface the cap so operators understand they're
                  seeing the tail, not the whole run. Equality is the
                  trigger because appendBoundedEvents floors at MAX_LOG_EVENTS. */}
              {progressEvents.length >= MAX_LOG_EVENTS && (
                <div className="mb-2 text-xs text-ink-muted italic">
                  Displaying most recent {MAX_LOG_EVENTS} events
                </div>
              )}
              <div className="bg-ink rounded-lg p-4 max-h-80 overflow-y-auto font-mono text-sm">
                {progressEvents.map((evt) => (
                  <div key={evt.timestamp + ':' + evt.type + ':' + (evt.product_id ?? '')} className={`${getEventColor(evt.type)} leading-relaxed`}>
                    <span className="text-ink-muted">[{formatTime(evt.timestamp)}]</span>{' '}
                    {evt.message}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          </Card>
        )}

        {/* Change Details */}
        {selectedRunId && (
          <div ref={changesRef}>
          <Card>
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-ink">
                  Changes for Run #{selectedRunId}
                </h2>
                <div className="flex gap-3">
                  <Select
                    value={filterRetailer}
                    onChange={(e) => setFilterRetailer(e.target.value)}
                    options={[
                      { value: '', label: 'All retailers' },
                      ...siteNames.map((name) => ({ value: name, label: siteLabel(name) })),
                    ]}
                  />
                  <Select
                    value={filterSeverity}
                    onChange={(e) => setFilterSeverity(e.target.value)}
                    options={[
                      { value: '', label: 'All severities' },
                      { value: 'critical', label: 'Critical' },
                      { value: 'warning', label: 'Warning' },
                      { value: 'info', label: 'Info' },
                    ]}
                  />
                </div>
              </div>

              {changes.length === 0 ? (
                <p className="text-ink-muted text-center py-6">No changes detected in this run.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-hairline">
                    <thead className="bg-surface-secondary">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Retailer</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Type</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Field</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Severity</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Description</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase">Detected</th>
                      </tr>
                    </thead>
                    <tbody className="bg-surface divide-y divide-hairline">
                      {changes.map((c) => (
                        <tr key={c.id} className="hover:bg-surface-secondary">
                          <td className="px-4 py-3 text-sm font-medium text-ink">{c.retailer}</td>
                          <td className="px-4 py-3 text-sm text-ink-muted">
                            <code className="text-xs bg-surface-tertiary px-1.5 py-0.5 rounded">{c.change_type}</code>
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-muted">
                            <code className="text-xs bg-surface-tertiary px-1.5 py-0.5 rounded">{c.selector_or_field}</code>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <Badge variant={SEVERITY_BADGE[c.severity] ?? 'default'}>
                              {c.severity}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-muted max-w-md truncate" title={c.description}>
                            {c.description}
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-muted whitespace-nowrap">
                            {formatDate(c.detected_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
