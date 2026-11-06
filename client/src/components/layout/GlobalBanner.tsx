'use client';

import React, { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import type { GlobalMessage } from '@/lib/api-client';

export const GlobalBanner: React.FC = () => {
  const [message, setMessage] = useState<GlobalMessage | null>(null);

  useEffect(() => {
    apiClient.getActiveMessages()
      .then((res) => {
        if (res.messages.length > 0) {
          setMessage(res.messages[0]);
        }
      })
      .catch(() => { /* silently fail — banner is non-critical */ });
  }, []);

  if (!message) return null;

  return (
    <div
      className="border-b border-amber-200 bg-amber-50 px-4 py-3"
      role="alert"
    >
      <div className="max-w-[1400px] mx-auto flex items-center justify-center gap-2">
        <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.962-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <p className="text-sm font-medium text-amber-800">
          {message.title && <span className="mr-1.5">{message.title}:</span>}
          <span>{message.message}</span>
        </p>
      </div>
    </div>
  );
};
