'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/lib/api-client';
import { useSession } from '@/providers/SessionProvider';
import { useRequireAuth } from '@/hooks/useRequireAuth';

export default function ChangePasswordPage() {
  const router = useRouter();
  // Forced-password-change is a one-shot flow, but going through SessionProvider keeps the cache hot for the redirect home.
  const { authChecked } = useRequireAuth();
  const { session } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!authChecked) return;
    if (session?.user.must_change_password) {
      setChecking(false);
    } else {
      // User doesn't need to change password — send them home
      router.push('/');
    }
  }, [authChecked, session?.user.must_change_password, router]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    if (!currentPassword) {
      setError('Current password is required');
      return;
    }
    if (!newPassword || newPassword.length < 12) {
      setError('New password must be at least 12 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (currentPassword === newPassword) {
      setError('New password must be different from current password');
      return;
    }

    setLoading(true);
    try {
      await apiClient.changePassword(currentPassword, newPassword);
      // Password changed — token is revoked, redirect to login
      apiClient.setToken(null);
      globalThis.location.href = '/login';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
      </div>
    );
  }

  return (
    <main className="min-h-dvh bg-surface-secondary/50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-accent to-violet mb-4">
            <span className="text-lg font-display font-bold text-white">P</span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink mb-1">Product Scraper</h1>
          <p className="text-sm text-ink-muted">Enterprise Web Scraper</p>
        </div>

        <div className="bg-surface rounded-2xl shadow-premium-lg border border-hairline/60 p-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <h2 className="font-display text-xl font-bold text-ink mb-1">Change Your Password</h2>
              <p className="text-sm text-ink-muted">
                You must set a new password before continuing.
              </p>

              {error && (
                <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200">
                  <p className="text-sm text-rose-700">{error}</p>
                </div>
              )}
            </div>

            <Input
              label="Current Password"
              name="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter your current password"
              autoComplete="current-password"
              disabled={loading}
            />

            <Input
              label="New Password"
              name="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter a new password (min 8 characters)"
              autoComplete="new-password"
              disabled={loading}
            />

            <Input
              label="Confirm New Password"
              name="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your new password"
              autoComplete="new-password"
              disabled={loading}
            />

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={loading}
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />{' '}
                  <span>Changing Password...</span>
                </span>
              ) : (
                'Change Password'
              )}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
