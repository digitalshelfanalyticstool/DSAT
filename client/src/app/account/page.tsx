'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/MainLayout';
import { Card } from '@/components/ui/Card';
import { apiClient, AdminUser } from '@/lib/api-client';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';

// Fixed codes from server/src/routes/auth-sso.ts; anything else shows the generic message.
const SSO_RESULT: Record<string, string> = {
  already_linked: 'That single sign-on identity is already connected to another account.',
  disabled: 'Single sign-on is turned off.',
};
const SSO_FAILED = 'Single sign-on could not be connected. Please try again.';

export default function AccountPage() {
  const router = useRouter();
  const { authChecked } = useRequireAuth();
  const [profile, setProfile] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sso, setSso] = useState<{ enabled: boolean; label: string } | null>(null);
  const [ssoLinked, setSsoLinked] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoMessage, setSsoMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    const code = params.get('sso_error');
    if (code) setSsoMessage(SSO_RESULT[code] ?? SSO_FAILED);
    else if (params.get('sso_linked') === '1') setSsoMessage('Single sign-on is connected.');
    apiClient.getSsoConfig().then(setSso).catch(() => { /* section stays hidden */ });
  }, []);

  const connectSso = async () => {
    setSsoBusy(true);
    try {
      const { ticket } = await apiClient.getSsoLinkTicket();
      globalThis.location.href = `${apiClient.getBaseUrl()}/auth/sso/start?link=${encodeURIComponent(ticket)}`;
    } catch {
      setSsoMessage(SSO_FAILED);
      setSsoBusy(false);
    }
  };

  const disconnectSso = async () => {
    setSsoBusy(true);
    try {
      await apiClient.disconnectSso();
      setSsoLinked(false);
      setSsoMessage('Single sign-on is disconnected.');
    } catch {
      setSsoMessage('Single sign-on could not be disconnected. Please try again.');
    } finally {
      setSsoBusy(false);
    }
  };

  useEffect(() => {
    if (!authChecked) return;
    apiClient
      .getAccount()
      .then((account) => {
        setProfile(account.user);
        setSsoLinked(account.ssoLinked);
      })
      .catch(() => router.push('/login'))
      .finally(() => setLoading(false));
  }, [authChecked, router]);

  if (loading) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-accent" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="animate-in">
          <h1 className="font-display text-2xl font-bold text-ink">Account Settings</h1>
          <p className="mt-1 text-sm text-ink-muted">Your profile and sign-in</p>
        </div>

        <Card className="animate-in-delay" style={{ '--stagger': 1 } as React.CSSProperties}>
          <div className="mb-4">
            <h2 className="font-display text-lg font-semibold text-ink">Profile</h2>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-hairline">
              <span className="text-sm text-ink-muted">Username</span>
              <span className="text-sm font-medium text-ink">{profile?.username}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-hairline">
              <span className="text-sm text-ink-muted">Email</span>
              <span className="text-sm font-medium text-ink">{profile?.email}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-hairline">
              <span className="text-sm text-ink-muted">Role</span>
              <span className="text-sm font-medium text-ink capitalize">{profile?.role}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-ink-muted">Member since</span>
              <span className="text-sm font-medium text-ink">
                {profile?.created_at ? formatDate(profile.created_at) : '\u2014'}
              </span>
            </div>
          </div>
          <p className="mt-4 text-xs text-ink-muted">
            Contact an administrator to change your role or access.
          </p>
        </Card>

        {(sso?.enabled || ssoMessage) && (
          <Card className="animate-in-delay" style={{ '--stagger': 2 } as React.CSSProperties}>
            <h2 className="mb-2 font-display text-lg font-semibold text-ink">Single sign-on</h2>
            {ssoMessage && <p role="status" className="mb-3 text-sm text-ink">{ssoMessage}</p>}
            {sso?.enabled && (ssoLinked ? (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-ink-muted">You can sign in with {sso.label}.</p>
                <Button variant="outline" size="sm" disabled={ssoBusy} onClick={() => { void disconnectSso(); }}>Disconnect</Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-ink-muted">Connect {sso.label} to sign in without your password.</p>
                <Button variant="primary" size="sm" disabled={ssoBusy} onClick={() => { void connectSso(); }}>Connect single sign-on</Button>
              </div>
            ))}
          </Card>
        )}
      </div>
    </MainLayout>
  );
}
