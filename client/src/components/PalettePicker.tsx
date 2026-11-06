'use client';

import { PALETTES, type PaletteId } from '@/lib/palettes';

/** Radio group of the site palettes, each shown as a row of swatches. */
export function PalettePicker({ value, onChange, disabled }: Readonly<{
  value: PaletteId;
  onChange: (id: PaletteId) => void;
  disabled?: boolean;
}>) {
  return (
    <fieldset disabled={disabled}>
      <legend className="block text-sm font-medium text-ink mb-2">Colour palette</legend>
      <div className="grid grid-cols-2 gap-2">
        {PALETTES.map((p) => (
          <label
            key={p.id}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm text-ink transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
              value === p.id ? 'border-accent bg-accent-50' : 'border-hairline hover:bg-surface-secondary'
            }`}
          >
            <input
              type="radio"
              name="palette"
              value={p.id}
              checked={value === p.id}
              onChange={() => onChange(p.id)}
              className="sr-only"
            />
            <span className="flex overflow-hidden rounded border border-hairline" aria-hidden="true">
              {p.swatches.map((c) => <span key={c} className="h-6 w-4" style={{ backgroundColor: c }} />)}
            </span>
            {p.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
