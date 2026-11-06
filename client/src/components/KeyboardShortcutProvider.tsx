'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { CommandPalette } from './CommandPalette';
import { useSession } from '@/providers/SessionProvider';
import { NEW_JOB_HREF } from '@/lib/routes';

interface KeyboardShortcutProviderProps {
  children: React.ReactNode;
}

export function KeyboardShortcutProvider({ children }: Readonly<KeyboardShortcutProviderProps>) {
  const router = useRouter();
  const { session } = useSession();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const userRole = session?.user.role;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+K — toggle command palette
    if (meta && e.key === 'k') {
      e.preventDefault();
      setPaletteOpen((v) => !v);
      return;
    }

    // Cmd/Ctrl+N — new job (skip when focused on input/textarea)
    if (meta && e.key === 'n') {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      router.push(NEW_JOB_HREF);
    }
  }, [router]);

  useEffect(() => {
    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => globalThis.window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      {children}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        userRole={userRole}
      />
    </>
  );
}
