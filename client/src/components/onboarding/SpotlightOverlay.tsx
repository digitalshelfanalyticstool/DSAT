'use client';

import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

export interface SpotlightStep {
  target: string;
  title: string;
  description: string;
}

interface SpotlightOverlayProps {
  steps: SpotlightStep[];
  onComplete: () => void;
  onSkip: () => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 10;
const TOOLTIP_GAP = 14;

export const SpotlightOverlay: React.FC<SpotlightOverlayProps> = ({
  steps,
  onComplete,
  onSkip,
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<'bottom' | 'top'>('bottom');
  const [transitioning, setTransitioning] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const skipButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // ARIA ids for dialog labelling/description.
  const titleId = useId();
  const descId = useId();

  // Ref-counted body scroll lock so concurrent overlays don't clobber
  // each other's unlock. Replaces direct `document.body.style.overflow` mutation.
  useBodyScrollLock(true);

  const step = steps[currentStep];
  const isLast = currentStep === steps.length - 1;

  const measureTarget = useCallback(() => {
    const selector = `[data-onboarding="${step.target}"]`;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({
      top: r.top - PADDING + globalThis.window.scrollY,
      left: r.left - PADDING + globalThis.window.scrollX,
      width: r.width + PADDING * 2,
      height: r.height + PADDING * 2,
    });

    // Determine placement
    const spaceBelow = globalThis.window.innerHeight - r.bottom;
    setTooltipPlacement(spaceBelow > 220 ? 'bottom' : 'top');
  }, [step.target]);

  // Measure on step change and on resize/scroll
  useEffect(() => {
    measureTarget();
    const handleResize = () => measureTarget();
    globalThis.window.addEventListener('resize', handleResize);
    globalThis.window.addEventListener('scroll', handleResize, true);
    return () => {
      globalThis.window.removeEventListener('resize', handleResize);
      globalThis.window.removeEventListener('scroll', handleResize, true);
    };
  }, [measureTarget]);

  // Wait for the target element via MutationObserver (robust for async-mounted targets).
  // Gives up silently after 2s so we never crash if the selector never resolves.
  useEffect(() => {
    if (rect) return;

    const selector = `[data-onboarding="${step.target}"]`;

    let observer: MutationObserver | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;
    let settled = false;

    const cleanup = () => {
      if (observer) observer.disconnect();
      if (timeoutId) clearTimeout(timeoutId);
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer = null;
      timeoutId = null;
      rafId = null;
    };

    const attemptResolve = () => {
      if (settled) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return;
      settled = true;
      cleanup();

      // Scroll the target into view, then measure on the next frame so the
      // rect reflects the post-scroll position.
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        // scrollIntoView with options can be missing in very old envs; ignore.
      }
      rafId = requestAnimationFrame(() => {
        measureTarget();
      });
    };

    // Try immediately, then observe the DOM for additions up to 2s.
    attemptResolve();
    if (!settled) {
      observer = new MutationObserver(() => attemptResolve());
      observer.observe(document.body, { childList: true, subtree: true });
      timeoutId = setTimeout(() => {
        // Silent no-op: keep the plain overlay; don't crash.
        settled = true;
        cleanup();
      }, 2000);
    }

    return cleanup;
  }, [rect, step.target, measureTarget]);

  // Escape to dismiss
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onSkip]);

  // Capture previously-focused element on mount; restore on unmount.
  // Focus the Next button via rAF once it's in the DOM (after rect resolves).
  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, []);

  // Focus Next button after the tooltip mounts (rect must be truthy).
  useEffect(() => {
    if (!rect) return;
    const raf = requestAnimationFrame(() => {
      nextButtonRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [rect, currentStep]);

  // Trap Tab between Skip and Next.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const skip = skipButtonRef.current;
    const next = nextButtonRef.current;
    if (!skip || !next) return;
    const active = document.activeElement;

    e.preventDefault();
    if (e.shiftKey) {
      // Going backwards: from Skip → Next, from Next → Skip.
      if (active === skip) {
        next.focus();
      } else {
        skip.focus();
      }
    } else if (active === skip) {
      // Forward: Skip → Next.
      next.focus();
    } else {
      // Forward from Next (or anywhere else) → Skip.
      skip.focus();
    }
  };

  const goNext = () => {
    if (isLast) {
      onComplete();
      return;
    }
    setTransitioning(true);
    setTimeout(() => {
      setCurrentStep((s) => s + 1);
      setRect(null);
      setTransitioning(false);
    }, 200);
  };

  if (!rect) {
    return createPortal(
      <div className="fixed inset-0 z-[var(--z-overlay)] bg-black/60" />,
      document.body,
    );
  }

  // Tooltip position
  const tooltipStyle: React.CSSProperties = {
    position: 'absolute',
    left: rect.left,
    width: Math.max(rect.width, 340),
    ...(tooltipPlacement === 'bottom'
      ? { top: rect.top + rect.height + TOOLTIP_GAP }
      : { bottom: globalThis.window.innerHeight - rect.top + TOOLTIP_GAP + globalThis.window.scrollY }),
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-overlay)]" style={{ pointerEvents: 'none' }}>
      {/* Spotlight highlight with massive box-shadow overlay */}
      <div
        className="absolute rounded-xl transition-all duration-300"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
          border: '2px solid rgba(99, 102, 241, 0.5)',
          pointerEvents: 'none',
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />

      {/* Accent glow ring */}
      <div
        className="absolute rounded-xl pointer-events-none"
        style={{
          top: rect.top - 2,
          left: rect.left - 2,
          width: rect.width + 4,
          height: rect.height + 4,
          boxShadow: '0 0 24px 4px rgba(99, 102, 241, 0.2)',
        }}
      />

      {/* Tooltip with dialog semantics. */}
      <div
        ref={tooltipRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={handleKeyDown}
        className={`transition-all duration-300 ${transitioning ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'}`}
        style={{ ...tooltipStyle, pointerEvents: 'auto', transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        {/* Arrow */}
        <div
          className="absolute w-3 h-3 bg-ink rotate-45"
          style={tooltipPlacement === 'bottom'
            ? { top: -6, left: 32 }
            : { bottom: -6, left: 32 }
          }
        />

        <div className="relative bg-ink border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          {/* Step content */}
          <div className="px-5 pt-5 pb-4">
            <h3 id={titleId} className="font-display text-base font-semibold text-white mb-1.5">
              {step.title}
            </h3>
            <p id={descId} className="text-sm text-gray-300 leading-relaxed">
              {step.description}
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 pb-4 pt-1">
            {/* Step dots */}
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {steps.map((s, i) => {
                let dotClass = 'w-1.5 h-1.5 bg-gray-600';
                if (i === currentStep) dotClass = 'w-5 h-1.5 bg-accent';
                else if (i < currentStep) dotClass = 'w-1.5 h-1.5 bg-accent/40';
                return (
                  <div
                    key={s.target}
                    className={`rounded-full transition-all duration-300 ${dotClass}`}
                  />
                );
              })}
            </div>
            {/* SR-only step counter mirrors the dot indicator. */}
            <span className="sr-only">
              Step {currentStep + 1} of {steps.length}
            </span>

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button
                ref={skipButtonRef}
                type="button"
                onClick={onSkip}
                // eslint-disable-next-line no-restricted-syntax -- contrast OK on dark surface (gray-400 on gray-900 = 5.78:1)
                className="text-sm text-gray-300 hover:text-gray-200 transition-colors"
              >
                Skip
              </button>
              <button
                ref={nextButtonRef}
                type="button"
                onClick={goNext}
                className="px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-dark text-white text-sm font-medium transition-colors"
              >
                {isLast ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
