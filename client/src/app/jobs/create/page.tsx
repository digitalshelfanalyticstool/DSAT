'use client';

import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiClient } from '@/lib/api-client';
import { useConfig } from '@/providers/ConfigProvider';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { MainLayout } from '@/components/layout/MainLayout';
import { useToast } from '@/components/ui/Toast';
import { OnboardingController } from '@/components/onboarding/OnboardingController';
import type { ScheduledJobEntry } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { DAY_LABELS, SCHEDULE_TZ_LABEL, parseDays } from '@/lib/schedule';


function CreateJobPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const { sites: allSites, brands: allBrands } = useConfig();
  const sites = allSites.filter((s) => s.enabled);
  const brands = allBrands.filter((b) => b.enabled);
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validationErrors, setValidationErrors] = useState<{
    site?: string;
    brand?: string;
  }>({});
  // Retailer options depend on the selected brand: a brand with allowed_retailers
  // can only run on those retailers; brands without it run anywhere.
  const selectedBrandConfig = brands.find((b) => b.name === selectedBrand);
  const availableSites = selectedBrandConfig?.allowed_retailers?.length
    ? sites.filter((s) => selectedBrandConfig.allowed_retailers!.includes(s.name))
    : sites;
  // When "Run Again" arrives with site+brand+quick_rerun,
  // we auto-submit on mount and show a brief "Submitting..." overlay so the
  // form flashes for a fraction of a second instead of looking inert. The
  // ref guards against firing twice if React StrictMode re-runs effects.
  const [quickRerunSubmitting, setQuickRerunSubmitting] = useState(false);
  const quickRerunFiredRef = useRef(false);

  // Schedule state
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [maxRetries, setMaxRetries] = useState(3);
  const [retryDelayMinutes, setRetryDelayMinutes] = useState(15);

  // Existing schedules
  const [schedules, setSchedules] = useState<ScheduledJobEntry[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(true);

  // Analytics refs for abandonment tracking

  useEffect(() => {
    loadSchedules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefill from URL params (e.g., /jobs/create?site=exampleshop&brand=Example%20Brand)
  useEffect(() => {
    const site = searchParams.get('site');
    const brand = searchParams.get('brand');
    if (site) setSelectedSite(site);
    if (brand) setSelectedBrand(brand);
  }, [searchParams]);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const res = await apiClient.getSchedules();
      setSchedules(res.schedules);
    } catch {
      // Silently fail — schedules are supplementary
    } finally {
      setSchedulesLoading(false);
    }
  }, []);

  const validateForm = (): boolean => {
    const errors: { site?: string; brand?: string } = {};
    if (!selectedSite) errors.site = 'Please select a retailer';
    if (!selectedBrand) errors.brand = 'Please select a brand';
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submitJob = useCallback(async (siteName: string, brandName: string) => {
    setError('');
    setLoading(true);
    try {
      const response = await apiClient.createJob(siteName, brandName);
      router.push(`/jobs/${response.job.job_id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create job';
      setError(message);
      setLoading(false);
      setQuickRerunSubmitting(false);
    }
  }, [router]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setValidationErrors({});
    if (!validateForm()) return;
    await submitJob(selectedSite, selectedBrand);
  };

  // Auto-submit when arriving with ?site=&brand=&quick_rerun=true.
  // Only fires once and only when both selections are populated (which the
  // prefill effect handles synchronously above).
  useEffect(() => {
    if (quickRerunFiredRef.current) return;
    if (searchParams.get('quick_rerun') !== 'true') return;
    if (!selectedSite || !selectedBrand) return;
    quickRerunFiredRef.current = true;
    setQuickRerunSubmitting(true);
    void submitJob(selectedSite, selectedBrand);
  }, [selectedSite, selectedBrand, searchParams, submitJob]);

  const toggleDay = (day: number) => {
    setScheduleDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const handleCreateSchedule = async () => {
    if (!selectedSite || !selectedBrand) {
      setError('Please select a retailer and brand before scheduling.');
      return;
    }
    if (scheduleDays.length === 0) {
      setError('Please select at least one day.');
      return;
    }
    setScheduleSaving(true);
    setError('');
    try {
      await apiClient.createSchedule({
        site: selectedSite,
        brand: selectedBrand,
        schedule_time: scheduleTime,
        schedule_days: scheduleDays,
        ...(retryEnabled ? { max_retries: maxRetries, retry_delay_minutes: retryDelayMinutes } : {}),
      });
      showToast('Schedule created', 'success');
      setShowSchedule(false);
      await loadSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setScheduleSaving(false);
    }
  };

  const handleToggleSchedule = async (schedule: ScheduledJobEntry) => {
    try {
      await apiClient.updateSchedule(schedule.id, { enabled: !schedule.enabled });
      await loadSchedules();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update schedule', 'error');
    }
  };

  const handleDeleteSchedule = async (scheduleId: number) => {
    try {
      await apiClient.deleteSchedule(scheduleId);
      showToast('Schedule deleted', 'success');
      await loadSchedules();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete schedule', 'error');
    }
  };


  return (
    <MainLayout>
      <OnboardingController />
      <div className="max-w-2xl mx-auto">
        <div className="animate-in mb-6">
          <h1 className="font-display text-2xl font-bold text-ink">Create New Scraping Job</h1>
          <p className="mt-2 text-ink-muted">
            Run a job now or schedule it for later
          </p>
        </div>

        <Card className="animate-in-delay relative z-10" style={{ '--stagger': 1 } as React.CSSProperties}>
          {/* Brief "Submitting..." overlay while the auto-submit
              kicks off. Renders above the form but inside the same Card so
              it doesn't shift layout. */}
          {quickRerunSubmitting && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-surface/80 backdrop-blur-sm"
              role="status"
              aria-live="polite"
              data-testid="quick-rerun-overlay"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-ink">
                <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent" aria-hidden="true" />
                Submitting...
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="flex items-center gap-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3">
                <svg className="w-5 h-5 shrink-0 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm">{error}</span>
              </div>
            )}

            <div data-onboarding="retailer-brand" className="space-y-6">
              <Select
                label="Brand"
                placeholder="Select a brand"
                value={selectedBrand}
                onChange={(e) => {
                  const newBrand = e.target.value;
                  setSelectedBrand(newBrand);
                  if (validationErrors.brand) setValidationErrors((prev) => ({ ...prev, brand: undefined }));
                  // Retailer options depend on the brand — drop a now-invalid retailer.
                  if (selectedSite) {
                    const bc = brands.find((b) => b.name === newBrand);
                    const stillOk = !bc?.allowed_retailers?.length || bc.allowed_retailers.includes(selectedSite);
                    if (!stillOk) setSelectedSite('');
                  }
                }}
                onBlur={() => {
                  if (!selectedBrand) setValidationErrors((prev) => ({ ...prev, brand: 'Please select a brand' }));
                }}
                options={brands.map((brand) => ({
                  value: brand.name,
                  label: brand.display_name || brand.name,
                }))}
                error={validationErrors.brand}
                required
                autoFocus
              />

              <Select
                label="Retailer"
                placeholder={selectedBrand ? 'Select a retailer' : 'Select a brand first'}
                value={selectedSite}
                onChange={(e) => {
                  setSelectedSite(e.target.value);
                  if (validationErrors.site) setValidationErrors((prev) => ({ ...prev, site: undefined }));
                }}
                onBlur={() => {
                  if (!selectedSite) setValidationErrors((prev) => ({ ...prev, site: 'Please select a retailer' }));
                }}
                options={availableSites.map((site) => ({
                  value: site.name,
                  label: site.display_name || site.name,
                }))}
                error={validationErrors.site}
                required
              />
            </div>

            <div className="flex gap-4">
              <div data-onboarding="run-now" className="flex-1">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Creating Job...' : 'Run Now'}
                </Button>
              </div>
              <div data-onboarding="schedule">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSchedule(!showSchedule)}
                >
                  {showSchedule ? 'Cancel Schedule' : 'Schedule'}
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push('/')}
                disabled={loading}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>

        {/* Schedule Form */}
        {showSchedule && (
          <Card className="mt-6">
            <h2 className="font-display text-lg font-bold text-ink mb-4">Schedule Recurring Job</h2>
            <div className="space-y-4">
              <Input
                label="Time (ET)"
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
              />

              <fieldset>
                <legend className="block text-sm font-medium text-ink mb-2">
                  Days of the Week
                </legend>
                <div className="flex gap-2">
                  {DAY_LABELS.map((label, idx) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleDay(idx)}
                      aria-label={`Toggle ${label}`}
                      aria-pressed={scheduleDays.includes(idx)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                        scheduleDays.includes(idx)
                          ? 'bg-accent text-white'
                          : 'bg-surface-tertiary text-ink-muted hover:bg-surface-tertiary'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={retryEnabled}
                    onChange={(e) => setRetryEnabled(e.target.checked)}
                    className="rounded border-hairline"
                  />
                  <span className="text-sm font-medium text-ink">Auto-retry on failure</span>
                </label>
                {retryEnabled && (
                  <div className="mt-3 grid grid-cols-2 gap-4 pl-6">
                    <Input
                      label="Max retries (1-5)"
                      type="number"
                      value={String(maxRetries)}
                      onChange={(e) => setMaxRetries(Math.min(5, Math.max(1, Number(e.target.value))))}
                    />
                    <Input
                      label="Delay (5-60 min)"
                      type="number"
                      value={String(retryDelayMinutes)}
                      onChange={(e) => setRetryDelayMinutes(Math.min(60, Math.max(5, Number(e.target.value))))}
                    />
                  </div>
                )}
              </div>

              <p className="text-sm text-ink-muted">
                The job will automatically run at {scheduleTime || '--:--'} ET on selected days
                for <span className="font-medium">{selectedSite || '(select retailer)'}</span> / <span className="font-medium">{selectedBrand || '(select brand)'}</span>.
              </p>

              <div className="flex justify-end">
                <Button
                  variant="primary"
                  onClick={handleCreateSchedule}
                  disabled={scheduleSaving || !selectedSite || !selectedBrand || scheduleDays.length === 0}
                >
                  {scheduleSaving ? 'Saving...' : 'Create Schedule'}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Existing Schedules */}
        {!schedulesLoading && schedules.length > 0 && (
          <Card className="mt-6">
            {/* Collapsed by default so a long schedule list doesn't push the job
                form off-screen. The summary carries the counts so nothing is
                lost while closed. */}
            <details className="group">
              <summary className="flex items-center gap-2 cursor-pointer list-none rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                <span aria-hidden="true" className="text-ink-muted transition-transform group-open:rotate-90">›</span>
                <h2 className="font-display text-lg font-bold text-ink">Your Scheduled Jobs</h2>
                <span className="text-sm text-ink-muted tabular-nums">
                  {schedules.length} total · {schedules.filter((s) => s.enabled).length} active
                </span>
              </summary>
            <div className="space-y-3 mt-4">
              {schedules.map((s) => {
                const days = parseDays(s.schedule_days);
                return (
                  <div
                    key={s.id}
                    className="flex items-center justify-between p-3 bg-surface-secondary/50 rounded-xl border border-hairline hover:bg-surface-secondary transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-ink text-sm">
                          {s.site} / {s.brand}
                        </span>
                        <Badge variant={s.enabled ? 'success' : 'default'}>
                          {s.enabled ? 'Active' : 'Paused'}
                        </Badge>
                      </div>
                      <div className="text-sm text-ink-muted">
                        {s.schedule_time} {SCHEDULE_TZ_LABEL} — {days.map((d) => DAY_LABELS[d]).join(', ')}
                      </div>
                      {s.last_run_at && (
                        <div className="text-xs text-ink-muted mt-1">
                          Last run: {formatDateTime(s.last_run_at * 1000)}
                        </div>
                      )}
                      {s.max_retries > 0 && (
                        <div className="text-xs text-ink-muted mt-1">
                          Retry: {s.current_retry_count}/{s.max_retries}
                          {s.last_failure_reason && (
                            <span className="text-rose-600 ml-1">
                              (failed)
                              <span className="sr-only">: {s.last_failure_reason}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 ml-4">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleToggleSchedule(s)}
                      >
                        {s.enabled ? 'Pause' : 'Resume'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDeleteSchedule(s.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            </details>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}

export default function CreateJobPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-surface-secondary flex items-center justify-center"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" /></div>}>
      <CreateJobPageInner />
    </Suspense>
  );
}
