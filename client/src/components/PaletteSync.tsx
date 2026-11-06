'use client';

import { useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import { applyPalette } from '@/lib/palettes';

/** Applies the site palette from the API once per page load; the layout script has already applied the cached one. */
export function PaletteSync() {
  useEffect(() => {
    apiClient.getAppearance().then((r) => applyPalette(r.palette)).catch(() => {
      // Keep whatever is showing: the cached palette or the light-blue default.
    });
  }, []);
  return null;
}
