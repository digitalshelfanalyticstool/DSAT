'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PalettePicker } from '@/components/PalettePicker';
import { apiClient } from '@/lib/api-client';
import { DEFAULT_PALETTE, applyPalette, type PaletteId } from '@/lib/palettes';

/** Site-wide colour palette. Choosing one previews it; Save applies it for everyone. */
export function AppearancePanel() {
  const [saved, setSaved] = useState<PaletteId>(DEFAULT_PALETTE);
  const [palette, setPalette] = useState<PaletteId>(DEFAULT_PALETTE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient.getAppearance()
      .then((r) => { setSaved(r.palette); setPalette(r.palette); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load the palette'))
      .finally(() => setLoading(false));
  }, []);

  // Leaving the tab without saving drops the preview. Unmount only, reading
  // the latest saved palette: a cleanup keyed on `saved` would run on every
  // save and re-apply the palette that was just replaced.
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  useEffect(() => () => applyPalette(savedRef.current), []);

  const choose = (id: PaletteId) => {
    setPalette(id);
    setMessage('');
    applyPalette(id);
  };

  const save = async () => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await apiClient.setAppearance(palette);
      setSaved(palette);
      applyPalette(palette);
      setMessage('Palette saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the palette');
      setPalette(saved);
      applyPalette(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <h2 className="font-display text-lg font-semibold text-ink">Appearance</h2>
      <p className="mt-1 mb-4 text-sm text-ink-muted">The colour palette for everyone who uses this install.</p>
      {loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4 max-w-md">
          <PalettePicker value={palette} onChange={choose} disabled={saving} />
          {error && <p role="alert" className="text-sm text-error-dark">{error}</p>}
          {message && <p role="status" className="text-sm text-success-dark">{message}</p>}
          <Button onClick={save} disabled={saving || palette === saved}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    </Card>
  );
}
