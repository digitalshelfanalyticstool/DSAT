import React from 'react';

type HeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  /**
   * Heading level for `title`. Defaults to `h3` (matches legacy behaviour).
   * Callers should pick the level that keeps the document outline gap-free —
   * e.g. a Card nested directly under the page `<h1>` should use `titleAs="h2"`
   * to avoid a skipped level (WCAG 1.3.1).
   */
  titleAs?: HeadingLevel;
  style?: React.CSSProperties;
}

export const Card: React.FC<CardProps> = ({
  children,
  className = '',
  title,
  titleAs = 'h3',
  style,
}) => {
  const HeadingTag = titleAs;
  return (
    <div
      className={`bg-surface rounded-xl shadow-premium border border-hairline transition-shadow duration-150 ${className}`}
      style={style}
    >
      {title && (
        <div className="px-6 py-4 border-b border-hairline">
          <HeadingTag className="text-lg font-display font-semibold text-ink">
            {title}
          </HeadingTag>
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
};
