'use client';

import React, { useState } from 'react';

interface InfoTooltipProps {
  text: string;
}

export const InfoTooltip: React.FC<InfoTooltipProps> = ({ text }) => {
  const [visible, setVisible] = useState(false);

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface-tertiary text-ink-muted hover:bg-surface-tertiary cursor-default text-xs font-semibold leading-none select-none"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        aria-label="More info"
      >
        i
      </button>
      {visible && (
        <span className="absolute left-5 top-0 z-50 w-56 rounded-lg bg-ink px-3 py-2 text-xs text-white shadow-lg whitespace-normal pointer-events-none">
          {text}
          <span className="absolute -left-1 top-2 w-2 h-2 bg-ink rotate-45" />
        </span>
      )}
    </span>
  );
};
