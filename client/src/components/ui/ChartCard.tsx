'use client';

import React, { useId } from 'react';
import { InfoTooltip } from './InfoTooltip';

interface ChartCardProps {
  title: string;
  tooltip: string;
  /** Title-row classes. Defaults to the muted admin-panel style; job-analytics
   *  panels override with a semibold-ink variant. */
  titleClassName?: string;
  loading?: boolean;
  /** Skeleton shown while loading. Required only if `loading` can be true. */
  loadingSkeleton?: React.ReactNode;
  /** When true (and not loading), renders the no-data fallback. */
  isEmpty?: boolean;
  emptyMessage?: string;
  emptyClassName?: string;
  /** Screen-reader-only one-line summary of the populated chart. */
  summary: React.ReactNode;
  /** Screen-reader-only `<thead>`+`<tbody>` mirroring the chart data. The
   *  `<table>` wrapper, `id`, and caption are supplied here so the card's
   *  `aria-describedby` stays wired to the table. */
  tableContent: React.ReactNode;
  children: React.ReactNode;
}

const CARD_CLASS = 'bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm';
const TITLE_DEFAULT = 'text-sm font-medium text-ink-muted mb-3 flex items-center gap-1.5';
const EMPTY_DEFAULT = 'text-sm text-ink-muted text-center py-4';

export const ChartCard: React.FC<ChartCardProps> = ({
  title,
  tooltip,
  titleClassName = TITLE_DEFAULT,
  loading = false,
  loadingSkeleton,
  isEmpty = false,
  emptyMessage = 'No data available',
  emptyClassName = EMPTY_DEFAULT,
  summary,
  tableContent,
  children,
}) => {
  const titleId = useId();
  const summaryId = useId();
  const tableId = useId();

  const header = (
    <div id={titleId} className={titleClassName}>
      {title} <InfoTooltip text={tooltip} />
    </div>
  );

  // S6819 rationale (applied to each <div role="group"> below):
  // role="group" + aria-labelledby/aria-describedby is the labeled-group
  // semantic for this chart-card scaffold. <fieldset> would require
  // neutralizing every UA default (border, padding, min-width:min-content,
  // <legend> float quirks) on every render path, defeating the semantic
  // improvement — and the header includes an interactive <InfoTooltip>
  // trigger that fights <legend>'s inline-flow contract across screen
  // readers. <details>/<optgroup>/<address> don't fit (no disclosure
  // interaction; not select-options; not author/contact info).
  if (loading) {
    return (
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      <div className={CARD_CLASS} role="group" aria-labelledby={titleId}>
        {header}
        <div role="img" aria-label={`Chart: ${title} (loading)`}>{loadingSkeleton}</div>
      </div>
    );
  }

  if (isEmpty) {
    return (
      // NOSONAR(typescript:S6819): see S6819 rationale above.
      <div className={CARD_CLASS} role="group" aria-labelledby={titleId}>
        {header}
        <div role="img" aria-label={`Chart: ${title} (no data available)`}>
          <p className={emptyClassName}>{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    // NOSONAR(typescript:S6819): see S6819 rationale above.
    <div className={CARD_CLASS} role="group" aria-labelledby={titleId} aria-describedby={tableId}>
      {header}
      <div role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
        <span id={summaryId} className="sr-only">
          {summary}
        </span>
        {children}
      </div>
      <table id={tableId} className="sr-only">
        <caption>{title} — tabular data</caption>
        {tableContent}
      </table>
    </div>
  );
};
