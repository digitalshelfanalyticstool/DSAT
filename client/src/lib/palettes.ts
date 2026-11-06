/**
 * Site colour palettes. Ids match PALETTE_IDS in server/src/services/appearance.ts
 * and the [data-palette] blocks in app/globals.css (light-blue is the @theme
 * default); keep all three in step. The pre-hydration
 * script in app/layout.tsx is built from this list.
 */

export const PALETTES = [
  { id: 'light-blue', name: 'Light blue', swatches: ['#ffffff', '#e0f2fe', '#0369a1', '#0c3354'] },
  { id: 'classic', name: 'Classic', swatches: ['#faf8f4', '#ebe7dd', '#6b5836', '#0f172a'] },
  { id: 'green', name: 'Green', swatches: ['#ffffff', '#dcfce7', '#047857', '#052e24'] },
  { id: 'slate', name: 'Slate', swatches: ['#ffffff', '#f1f5f9', '#475569', '#1e293b'] },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];
export const DEFAULT_PALETTE: PaletteId = 'light-blue';

/** Read by the pre-hydration script in app/layout.tsx so pages paint in the right colours. */
export const PALETTE_STORAGE_KEY = 'palette';

/** Switches the page to `id` and remembers it for the next page load. */
export function applyPalette(id: PaletteId): void {
  document.documentElement.dataset.palette = id;
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, id);
  } catch {
    // Storage blocked: the palette still applies, it just can't skip the first-paint default next time.
  }
}
