'use client';

import React from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import { KeyboardShortcutProvider } from '@/components/KeyboardShortcutProvider';

export const ToastWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <ToastProvider>
      <KeyboardShortcutProvider>
        {children}
      </KeyboardShortcutProvider>
    </ToastProvider>
  );
};
