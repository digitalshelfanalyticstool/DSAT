import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

const getFocusableElements = (container: HTMLElement | null): HTMLElement[] => {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
  );
};

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  className = '',
  initialFocusRef,
}) => {
  const overlayRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Ref-counted body scroll lock so concurrent Modal + Sidebar don't clobber
  // each other's unlock. Native <dialog>.showModal() also locks
  // scroll, but the hook keeps semantics consistent with Sidebar.
  useBodyScrollLock(open);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  // Drive the native <dialog> imperatively so we get the real ::backdrop
  // pseudo-element (better contrast control, real top-layer painting,
  // Esc handled by the platform). We still keep our own focus-trap +
  // initial-focus + restore logic because showModal()'s default focus
  // is the first focusable, and our impl wants `initialFocusRef` to win.
  useLayoutEffect(() => {
    const dialog = overlayRef.current;
    if (!dialog) return;

    if (open) {
      previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
      // Guard: showModal throws if already open (e.g. StrictMode double-invoke).
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          // jsdom and very old browsers can throw "Not implemented" — harmless;
          // tests stub this method, real browsers >=Chrome 37 / Safari 15.4 implement it.
        }
      }

      const focusTarget =
        initialFocusRef?.current ?? getFocusableElements(contentRef.current)[0] ?? null;

      // Focus after paint so content is mounted and measurable
      const raf = requestAnimationFrame(() => {
        focusTarget?.focus();
      });

      return () => {
        cancelAnimationFrame(raf);
        const prev = previouslyFocusedRef.current;
        if (prev && typeof prev.focus === 'function') {
          // Restore focus after close
          prev.focus();
        }
      };
    }
  }, [open, initialFocusRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(contentRef.current);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey) {
      if (active === first || !contentRef.current?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !contentRef.current?.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <dialog
      ref={overlayRef}
      // No `open` attribute — showModal() owns the open state and adds the
      // top-layer styling + ::backdrop. Setting `open` declaratively would
      // bypass top-layer and break native ::backdrop rendering.
      className={`modal-dialog fixed inset-0 z-50 flex items-center justify-center animate-fade-in w-full h-full max-w-none max-h-none p-0 m-0 bg-transparent`}
      onClick={(e) => {
        // Click on the dialog background (not its child content) closes.
        // This still works with native ::backdrop because backdrop clicks
        // bubble to the dialog element with target === dialog.
        if (e.target === overlayRef.current) onClose();
      }}
      onKeyDown={handleKeyDown}
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={contentRef}
        className={`bg-surface rounded-2xl shadow-premium-xl border border-hairline w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto animate-scale-in ${className}`}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-hairline">
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-secondary transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </dialog>
  );
};
