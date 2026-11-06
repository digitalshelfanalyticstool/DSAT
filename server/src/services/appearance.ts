/**
 * Site-wide colour palette, chosen at first-run setup and changeable by admins.
 * Stored in app_settings under the `palette` key; the ids match the
 * `data-palette` blocks in client/src/app/globals.css.
 */

import type { DatabaseService } from './database';

export const PALETTE_IDS = ['light-blue', 'classic', 'green', 'slate'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export const DEFAULT_PALETTE: PaletteId = 'light-blue';

const KEY = 'palette';

function isPaletteId(value: unknown): value is PaletteId {
  return (PALETTE_IDS as readonly unknown[]).includes(value);
}

export async function getPalette(db: DatabaseService): Promise<PaletteId> {
  const row = await db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', KEY);
  return isPaletteId(row?.value) ? row.value : DEFAULT_PALETTE;
}

export async function setPalette(db: DatabaseService, palette: PaletteId, userId: number): Promise<void> {
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    KEY,
    palette,
    Math.floor(Date.now() / 1000),
    userId,
  );
}
