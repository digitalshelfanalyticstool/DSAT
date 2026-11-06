'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/lib/api-client';

export function PasswordSignInForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiClient.login(username.trim(), password);
      const onboarding = res.user.role !== 'admin' && res.user.has_completed_onboarding === false;
      // A real navigation, so the browser offers to save the password.
      globalThis.location.href = res.must_change_password ? '/change-password' : onboarding ? '/jobs/create' : '/';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed.';
      setError(message);
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="on" className="space-y-5" noValidate>
      {error && (
        <div role="alert" className="rounded-xl border border-error-light bg-error-light/30 p-4 text-sm text-error-dark">{error}</div>
      )}
      <Input
        label="Username"
        name="username"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        disabled={loading}
        autoFocus
      />
      <Input
        label="Password"
        name="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        disabled={loading}
      />
      <Button type="submit" variant="primary" size="lg" className="w-full mt-2" disabled={loading}>
        {loading ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
