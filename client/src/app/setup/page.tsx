'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/lib/api-client';
import { PalettePicker } from '@/components/PalettePicker';
import { DEFAULT_PALETTE, applyPalette, type PaletteId } from '@/lib/palettes';

/** One-time "Create admin account" screen for a fresh install. */
export default function SetupPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [palette, setPalette] = useState<PaletteId>(DEFAULT_PALETTE);

  const choosePalette = (id: PaletteId) => {
    setPalette(id);
    applyPalette(id);
  };

  useEffect(() => {
    apiClient.getSetupStatus()
      .then(({ needsSetup }) => (needsSetup ? setReady(true) : router.replace('/login')))
      .catch(() => router.replace('/login'));
  }, [router]);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!setupCode.trim() || !username.trim() || !email.trim() || !password) {
      setError('All fields are required');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await apiClient.completeSetup({ setupCode: setupCode.trim(), username: username.trim(), email: email.trim(), password, palette });
      globalThis.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
      setSaving(false);
    }
  };

  if (!ready) {
    return <main className="min-h-dvh flex items-center justify-center text-ink-muted">Loading…</main>;
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md">
        <h1 className="font-display text-2xl font-bold text-ink">Create admin account</h1>
        <p className="mt-1 mb-6 text-sm text-ink-muted">
          This is a new install. The account you create here is the administrator.
          The setup code is printed in the API server log when it starts.
        </p>
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {error && (
            <div role="alert" className="rounded-xl border border-error-light bg-error-light/30 p-4 text-sm text-error-dark">{error}</div>
          )}
          <Input label="Setup code" name="setup-code" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" disabled={saving} autoFocus />
          <Input label="Username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" disabled={saving} />
          <Input label="Email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={saving} />
          <Input label="Password" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={saving} />
          <Input label="Confirm password" name="confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={saving} />
          <p className="text-xs text-ink-muted">At least 12 characters, with upper- and lower-case letters, a digit and a symbol.</p>
          <PalettePicker value={palette} onChange={choosePalette} disabled={saving} />
          <p className="text-xs text-ink-muted">Applies to everyone. Admins can change it later under Config → Appearance.</p>
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={saving}>
            {saving ? 'Creating…' : 'Create admin account'}
          </Button>
        </form>
      </div>
    </main>
  );
}
