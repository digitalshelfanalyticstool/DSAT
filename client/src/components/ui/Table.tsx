import React from 'react';

interface Column<T> {
  header: string;
  accessor: keyof T;
  render?: (item: T) => React.ReactNode;
  headerRender?: () => React.ReactNode;
  /**
   * Per-column opt-out for the mobile-sticky-first-column behavior.
   * Default: true. Only meaningful on the first column — the sticky treatment
   * is first-column-only and setting this on a non-first column has no effect.
   * Set to `false` when the first column carries no row-identity meaning
   * (e.g. a thumbnail), where pinning it inverts the a11y intent.
   */
  stickyOnMobile?: boolean;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  /**
   * @deprecated Prefer rendering a `<Link>` inside the first column's
   * `render` function over a row-level click handler. Row-as-button
   * semantics (role="button" on a `<tr>`) confuse screen readers —
   * they announce rows as "button, row 1" and the table structure is
   * obscured. Kept for backward compatibility.
   */
  onRowClick?: (item: T) => void;
  /**
   * Return a stable, content-derived React key for each row. Strongly
   * recommended when the data is reorderable, paginated, or otherwise
   * mutable between renders (sonarjs/no-array-index-key / S6479).
   * Defaults to the array index for backward compatibility; callers that
   * pass sortable/filterable data should always provide this.
   */
  getRowKey?: (item: T, index: number) => React.Key;
  className?: string;
}

export function Table<T extends Record<string, any>>({
  columns,
  data,
  onRowClick, // NOSONAR(typescript:S1874): intentional self-deprecation via JSDoc; kept for backward compat. Destructuring the field is the only way to honor the prop while warning callers.
  getRowKey,
  className = '',
}: Readonly<TableProps<T>>) {
  if (process.env.NODE_ENV !== 'production' && onRowClick) {
    console.warn(
      '[Table] `onRowClick` is deprecated — wrap the first column in a <Link> or <button> instead.',
    );
  }
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table role="table" className="min-w-full divide-y divide-hairline">
        <thead className="bg-surface-secondary">
          <tr>
            {columns.map((column, idx) => (
              <th
                key={`${String(column.accessor)}-${idx}`}
                // First column sticks to the left on mobile so row identity stays
                // visible during horizontal scroll. Shadow on the sticky
                // edge signals the horizontally-scrollable region to the user.
                // `stickyOnMobile: false` opts out for first columns with no
                // row-identity meaning (e.g. a thumbnail).
                data-sticky={(idx === 0 && column.stickyOnMobile !== false) || undefined}
                className={`px-3 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wider ${
                  idx === 0 && column.stickyOnMobile !== false
                    ? 'sticky left-0 z-10 bg-surface-secondary shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]'
                    : ''
                }`}
              >
                {column.headerRender?.() ?? column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface divide-y divide-surface-secondary">
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-6 py-12 text-center"
              >
                <div className="flex flex-col items-center gap-2">
                  <svg
                    className="h-10 w-10 text-ink-muted"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                    />
                  </svg>
                  <p className="text-sm font-medium text-ink-muted">No data available</p>
                </div>
              </td>
            </tr>
          ) : (
            data.map((item, index) => (
              // NOSONAR(typescript:S6850): a clickable <tr> cannot be wrapped in a single <button> without breaking table semantics; role="button" + tabIndex + onKeyDown implements the AT-accessible equivalent.
              <tr
                key={getRowKey ? getRowKey(item, index) : index}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(item);
                        }
                      }
                    : undefined
                }
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={
                  onRowClick
                    ? 'cursor-pointer hover:bg-surface-secondary/50 transition-colors duration-150 focus:outline-none focus:bg-surface-secondary focus:ring-2 focus:ring-inset focus:ring-accent/30'
                    : ''
                }
              >
                {columns.map((column, colIdx) => (
                  <td
                    key={`${String(column.accessor)}-${colIdx}`}
                    // Sticky first column keeps row identity visible during mobile
                    // horizontal scroll. `bg-surface` on td so content
                    // underneath doesn't bleed through during scroll-under.
                    // `stickyOnMobile: false` opts out.
                    data-sticky={(colIdx === 0 && column.stickyOnMobile !== false) || undefined}
                    className={`px-3 py-4 whitespace-nowrap text-sm text-ink tabular-nums ${
                      colIdx === 0 && column.stickyOnMobile !== false
                        ? 'sticky left-0 z-10 bg-surface shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)]'
                        : ''
                    }`}
                  >
                    {column.render ? column.render(item) : item[column.accessor]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
