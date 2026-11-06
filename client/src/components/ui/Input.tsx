import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

/**
 * Input primitive with WCAG 3.3.1 / 4.1.2 compliant error handling.
 *
 * When `error` is truthy the underlying `<input>` gains `aria-invalid`,
 * `aria-describedby`, and `aria-errormessage` pointing at the error
 * message paragraph (which carries `role="alert"` so screen readers
 * announce it on blur). The `text-rose-600` error token meets WCAG
 * 1.4.3 body-text contrast (>= 4.5:1) on white.
 */
export const Input: React.FC<InputProps> = ({
  label,
  error,
  className = '',
  id,
  disabled,
  required,
  ...props
}) => {
  const autoId = useId();
  const inputId = id || label?.toLowerCase().replaceAll(/\s+/g, '-') || `input-${autoId}`;
  const errorId = `${inputId}-error`;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-ink mb-1.5">
          {label}
          {required && (
            <>
              <span aria-hidden="true" className="text-rose-600 ml-0.5">*</span>
              <span className="sr-only"> required</span>
            </>
          )}
        </label>
      )}
      <input
        id={inputId}
        disabled={disabled}
        required={required}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-errormessage={error ? errorId : undefined}
        // text-base on mobile, text-sm on desktop — prevents iOS Safari's
        // auto-zoom-on-focus which triggers whenever the effective font size
        // is < 16px and never zooms back out. focus-visible ring
        // rather than focus ring so mouse users don't see the ring on click
        // but keyboard users still do.
        // eslint-disable-next-line no-restricted-syntax -- placeholder per UI/UX Pro Max ruleset
        className={`w-full px-3 py-2 text-base sm:text-sm border bg-surface rounded-lg shadow-premium-sm placeholder:text-ink-muted transition-all duration-150 focus:outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 ${
          error ? 'border-rose-300 focus-visible:ring-rose-200' : 'border-hairline'
        } ${disabled ? 'bg-surface-secondary text-ink-muted' : ''} ${className}`}
        {...props}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
};
