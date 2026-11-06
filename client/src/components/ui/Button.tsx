import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  /**
   * When true, renders a leading spinner, sets `aria-busy="true"`, and forces
   * `disabled`. Consumers control the visible label themselves (e.g. swap
   * "Save" → "Saving…") — this prop only automates the busy semantics.
   */
  loading?: boolean;
  children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  disabled,
  loading = false,
  type = 'button',
  ...props
}) => {
  const baseStyles =
    'font-medium rounded-lg transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';

  const variantStyles = {
    primary:
      'bg-gradient-premium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] hover:bg-gradient-premium-hover hover:shadow-glow-accent',
    secondary:
      'bg-surface-secondary text-ink hover:bg-surface-tertiary',
    outline:
      'border border-hairline text-ink hover:bg-surface-secondary hover:border-hairline',
    danger:
      'bg-error/10 text-error hover:bg-error hover:text-white',
    warning:
      'bg-amber-100 text-amber-800 hover:bg-amber-500 hover:text-white',
  };

  const sizeStyles = {
    // sm is py-2 (~36px) to meet the WCAG 2.2 SC 2.5.8 target-spacing rule
    // when placed in action rows.
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  };

  // `loading` forces disabled (a busy button must not be activated again).
  // Spinner respects prefers-reduced-motion globally via the reduced-motion
  // rule in globals.css that silences animate-spin.
  const isDisabled = disabled || loading;

  return (
    <button
      // Default to type="button" so Buttons inside a <form> don't implicitly submit.
      // Callers that want a submit button must pass type="submit" explicitly.
      type={type}
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      data-variant={variant}
      data-size={size}
      {...props}
      disabled={isDisabled}
      aria-busy={loading || undefined}
    >
      {loading && (
        <span
          data-testid="button-spinner"
          className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-current align-middle mr-2"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
};
