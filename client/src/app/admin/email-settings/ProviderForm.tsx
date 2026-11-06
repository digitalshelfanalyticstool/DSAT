'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, Button, Input, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { apiClient, type EmailSettings, type EmailSettingsInput } from '@/lib/api-client';

type Provider = 'disabled' | 'smtp';

function testResultClasses(status: 'sent' | 'skipped' | 'failed'): string {
  if (status === 'sent') return 'bg-green-50 text-green-700 border border-green-200';
  if (status === 'failed') return 'bg-red-50 text-red-700 border border-red-200';
  return 'bg-amber-50 text-amber-700 border border-amber-200';
}

interface FormData {
  provider: Provider;
  from_address: string;
  from_name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password: string;
  smtp_require_tls: boolean;
  is_enabled: boolean;
}

export function ProviderForm() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [testingSending, setTestingSending] = useState(false);
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [formData, setFormData] = useState<FormData>({
    provider: 'disabled',
    from_address: '',
    from_name: '',
    smtp_host: '',
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: '',
    smtp_password: '',
    smtp_require_tls: false,
    is_enabled: false,
  });

  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState<{ status: 'sent' | 'skipped' | 'failed'; error?: string; messageId?: string } | null>(null);
  const [testError, setTestError] = useState('');
  const [showTestSection, setShowTestSection] = useState(false);

  // Credentials state: only visible for SMTP, gated by checkbox
  const [replaceSmtpCredentials, setReplaceSmtpCredentials] = useState(false);

  // Load settings
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.getEmailSettings();
      if (response.success && response.settings) {
        const s = response.settings;
        setSettings(s);
        setFormData((prev) => ({
          ...prev,
          provider: s.provider,
          from_address: s.from_address ?? '',
          from_name: s.from_name ?? '',
          is_enabled: s.is_enabled,
        }));
        setReplaceSmtpCredentials(false);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load settings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async () => {
    setSubmitting(true);
    try {
      const input: EmailSettingsInput = {
        provider: formData.provider,
        from_address: formData.from_address || null,
        from_name: formData.from_name || null,
        is_enabled: formData.is_enabled,
      };

      if (formData.provider === 'smtp') {
        // Send credentials when either: (a) no existing credentials are stored
        // (first-time save — the "Replace credentials" checkbox isn't rendered
        // in that case, so replaceSmtpCredentials stays false even though the
        // password field is visible and the user typed into it), or (b) the
        // user explicitly ticked the Replace checkbox to overwrite existing
        // credentials. Without the (a) clause the first save persists every
        // non-credential field but writes encrypted_credentials = NULL,
        // leaving the service to fall through to NullProvider.
        const sendCreds = !settings?.has_credentials || replaceSmtpCredentials;
        if (sendCreds && formData.smtp_password) {
          input.smtp_credentials = {
            host: formData.smtp_host,
            port: formData.smtp_port,
            secure: formData.smtp_secure,
            user: formData.smtp_user || undefined,
            password: formData.smtp_password,
            requireTls: formData.smtp_require_tls || undefined,
          };
        }
      }

      const response = await apiClient.updateEmailSettings(input);
      if (response.success) {
        showToast('Settings saved', 'success');
        setSettings(response.settings);
        setReplaceSmtpCredentials(false);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendTest = async () => {
    if (!testEmail) {
      setTestError('Email is required');
      return;
    }
    setTestingSending(true);
    setTestError('');
    setTestResult(null);
    try {
      const response = await apiClient.sendTestEmail(testEmail);
      if (response.success) {
        setTestResult(response.result);
        if (response.result.status === 'sent') {
          showToast('Test email sent', 'success');
        } else if (response.result.status === 'failed') {
          showToast(`Test email failed: ${response.result.error ?? 'unknown error'}`, 'error');
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to send test email';
      if (errMsg.includes('rate limit') || errMsg.includes('429')) {
        showToast('Rate limited. Please wait before trying again.', 'error');
      } else {
        showToast(errMsg, 'error');
      }
    } finally {
      setTestingSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-6">
          {/* Provider selection */}
          <fieldset className="border-0 p-0 m-0">
            <legend className="block text-sm font-medium text-ink mb-3">Email Provider</legend>
            <div className="space-y-2">
              {(['disabled', 'smtp'] as const).map((p) => (
                <label key={p} className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-hairline hover:bg-surface-secondary/50 transition-colors">
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={formData.provider === p}
                    onChange={(e) => setFormData((prev) => ({ ...prev, provider: e.target.value as Provider }))}
                    className="text-accent focus:ring-accent/30"
                  />
                  <span className="text-sm font-medium text-ink capitalize">{p}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Common fields */}
          {formData.provider !== 'disabled' && (
            <div className="space-y-4 pt-4 border-t border-hairline">
              <Input
                label="From Address"
                type="email"
                placeholder="noreply@example.com"
                value={formData.from_address}
                onChange={(e) => setFormData((prev) => ({ ...prev, from_address: e.target.value }))}
                aria-required="true"
              />
              <Input
                label="From Name"
                placeholder="Example Support"
                value={formData.from_name}
                onChange={(e) => setFormData((prev) => ({ ...prev, from_name: e.target.value }))}
              />
            </div>
          )}

          {/* SMTP-specific fields */}
          {formData.provider === 'smtp' && (
            <div className="space-y-4 pt-4 border-t border-hairline">
              <Input
                label="SMTP Host"
                placeholder="smtp.gmail.com"
                value={formData.smtp_host}
                onChange={(e) => setFormData((prev) => ({ ...prev, smtp_host: e.target.value }))}
                aria-required="true"
              />
              <Input
                label="SMTP Port"
                type="number"
                placeholder="587"
                value={formData.smtp_port}
                onChange={(e) => setFormData((prev) => ({ ...prev, smtp_port: Number(e.target.value) }))}
                aria-required="true"
              />
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.smtp_secure}
                  onChange={(e) => setFormData((prev) => ({ ...prev, smtp_secure: e.target.checked }))}
                  className="text-accent focus:ring-accent/30"
                />
                <span className="text-sm font-medium text-ink">Use TLS encryption</span>
              </label>
              <Input
                label="SMTP Username"
                placeholder="your-email@gmail.com"
                value={formData.smtp_user}
                onChange={(e) => setFormData((prev) => ({ ...prev, smtp_user: e.target.value }))}
              />

              {/* Password field - gated by replace checkbox */}
              {settings?.has_credentials ? (
                <div className="space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={replaceSmtpCredentials}
                      onChange={(e) => setReplaceSmtpCredentials(e.target.checked)}
                      className="text-accent focus:ring-accent/30"
                    />
                    <span className="text-sm font-medium text-ink">Replace credentials</span>
                  </label>
                  {replaceSmtpCredentials && (
                    <Input
                      label="SMTP Password"
                      type="password"
                      placeholder="Your password"
                      value={formData.smtp_password}
                      onChange={(e) => setFormData((prev) => ({ ...prev, smtp_password: e.target.value }))}
                      aria-required="true"
                    />
                  )}
                </div>
              ) : (
                <Input
                  label="SMTP Password"
                  type="password"
                  placeholder="Your password"
                  value={formData.smtp_password}
                  onChange={(e) => setFormData((prev) => ({ ...prev, smtp_password: e.target.value }))}
                  aria-required="true"
                />
              )}

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.smtp_require_tls}
                  onChange={(e) => setFormData((prev) => ({ ...prev, smtp_require_tls: e.target.checked }))}
                  className="text-accent focus:ring-accent/30"
                />
                <span className="text-sm font-medium text-ink">Require TLS</span>
              </label>
            </div>
          )}

          {/* Enable toggle */}
          <div className="pt-4 border-t border-hairline">
            <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-hairline hover:bg-surface-secondary/50 transition-colors">
              <input
                type="checkbox"
                checked={formData.is_enabled}
                onChange={(e) => setFormData((prev) => ({ ...prev, is_enabled: e.target.checked }))}
                disabled={formData.provider === 'disabled'}
                className="text-accent focus:ring-accent/30 disabled:opacity-50"
              />
              <span className="text-sm font-medium text-ink">Enable email sending</span>
              {!formData.is_enabled && formData.provider !== 'disabled' && (
                <Badge variant="warning" className="ml-auto text-xs">Disabled</Badge>
              )}
            </label>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-2">
            <Button variant="primary" onClick={handleSave} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Test Email Section */}
      <Card>
        <div className="space-y-4">
          <h3 className="font-medium text-ink">Send Test Email</h3>
          {showTestSection ? (
            <div className="space-y-4">
              <Input
                label="Recipient Email"
                type="email"
                placeholder="test@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                error={testError}
                aria-required="true"
              />
              <div className="flex gap-2">
                <Button variant="primary" onClick={handleSendTest} disabled={testingSending || !testEmail}>
                  {testingSending ? 'Sending...' : 'Send'}
                </Button>
                <Button variant="outline" onClick={() => { setShowTestSection(false); setTestResult(null); setTestEmail(''); setTestError(''); }}>
                  Cancel
                </Button>
              </div>
              {testResult && (
                <div className={`rounded-lg p-3 text-sm ${testResultClasses(testResult.status)}`}>
                  <strong>Status:</strong> {testResult.status}
                  {testResult.messageId && <p className="mt-1 text-xs">Message ID: {testResult.messageId}</p>}
                  {testResult.error && <p className="mt-1 text-xs">Error: {testResult.error}</p>}
                </div>
              )}
            </div>
          ) : (
            <Button variant="outline" onClick={() => setShowTestSection(true)}>
              Send Test Email
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
