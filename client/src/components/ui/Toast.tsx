'use client';

import React, { useState, useCallback, createContext, useContext, useMemo } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export const useToast = () => useContext(ToastContext);

let nextId = 0;

// Module-level helper extracted to avoid nesting > 4 levels (sonarjs/no-nested-functions).
function filterOutId(toasts: ToastMessage[], id: number): ToastMessage[] {
  return toasts.filter((t) => t.id !== id);
}

// Error toasts stay on screen longer so users have time to read + act.
// WCAG 2.2.1 Timing Adjustable concerns status messages; 10s is below
// the 20s lower bound for critical status but a reasonable compromise
// for a non-blocking toast — complemented by the manual dismiss button.
const TOAST_TTL_MS: Record<ToastType, number> = {
  success: 4000,
  info: 4000,
  error: 10000,
};

// CSS variables (defined in globals.css @theme) keep Toast accent colors in
// sync with the rest of the design system and simplify dark-mode theming.
const accentColors: Record<ToastType, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-error)',
  info: 'var(--color-accent)',
};

const progressBarColors: Record<ToastType, string> = {
  success: 'bg-success/30',
  error: 'bg-error/30',
  info: 'bg-accent/30',
};

function ToastIcon({ type }: Readonly<{ type: ToastType }>) {
  if (type === 'success') {
    return (
      <svg className="h-5 w-5 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
      </svg>
    );
  }
  if (type === 'error') {
    return (
      <svg className="h-5 w-5 shrink-0 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 9l-6 6M9 9l6 6" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info', action?: ToastAction) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, type, message, action }]);
    // Delegate the deepest layer (filter predicate) to the module-level
    // filterOutId helper so the inner arrow isn't a 5th-level nested function
    // (sonarjs/no-nested-functions / S2004).
    setTimeout(() => setToasts((prev) => filterOutId(prev, id)), TOAST_TTL_MS[type]);
  }, []);

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const { errorToasts, statusToasts } = useMemo(() => {
    const errorToasts: ToastMessage[] = [];
    const statusToasts: ToastMessage[] = [];

    for (const t of toasts) {
      if (t.type === 'error') {
        errorToasts.push(t);
      } else {
        statusToasts.push(t);
      }
    }

    return { errorToasts, statusToasts };
  }, [toasts]);

  const renderToast = (t: ToastMessage) => (
    <div
      key={t.id}
      // Full-width minus 2rem on mobile so the toast doesn't clip the viewport
      // edges; natural width (280–448px) on sm+.
      className="bg-surface rounded-xl shadow-premium-lg border border-hairline w-[calc(100vw-2rem)] sm:w-auto sm:min-w-[280px] max-w-md animate-[slideIn_0.2s_ease-out] overflow-hidden"
      style={{ borderLeft: `4px solid ${accentColors[t.type]}` }}
      data-variant={t.type}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <ToastIcon type={t.type} />
        <span className="flex-1 text-sm text-ink">{t.message}</span>
        {t.action && (
          <button
            onClick={() => { t.action!.onClick(); dismiss(t.id); }}
            className="text-accent font-medium text-sm hover:text-accent-dark shrink-0"
          >
            {t.action.label}
          </button>
        )}
        <button
          onClick={() => dismiss(t.id)}
          className="text-ink-muted hover:text-ink rounded-md hover:bg-surface-secondary p-1 leading-none"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className={`h-0.5 ${progressBarColors[t.type]} toast-progress`} />
    </div>
  );

  // Memoize the context value so ToastProvider — which wraps the whole app and
  // re-renders on every toast shown/dismissed — doesn't hand every useToast()
  // consumer a fresh object each render, forcing them all to re-render.
  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Error toasts — role="alert" + aria-live="assertive" so SR users
          are interrupted with failure/error messages (WCAG 4.1.3). */}
      <div
        className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 z-[100] space-y-2"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        role="alert"
        aria-live="assertive"
      >
        {errorToasts.map(renderToast)}
      </div>
      {/* Success / info toasts — polite region so they wait for idle. */}
      <div
        className="fixed bottom-24 left-4 right-4 sm:left-auto sm:right-4 z-[100] space-y-2"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        role="status"
        aria-live="polite"
      >
        {statusToasts.map(renderToast)}
      </div>
    </ToastContext.Provider>
  );
};
