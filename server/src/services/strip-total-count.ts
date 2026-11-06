/**
 * Drop the `COUNT(*) OVER() AS total_count` window column from a query row.
 *
 * Paginated SELECTs in this codebase carry the page total on every row via a
 * window function; that column is read once (from `rows[0].total_count`) and
 * must be stripped before the row is returned to callers. Deleting from a
 * shallow copy avoids any discarded destructure binding (SonarJS S1481).
 *
 * Zero project imports by design — safe to import from any layer.
 */
export function stripTotalCount<T extends { total_count?: unknown }>(
  row: T,
): Omit<T, 'total_count'> {
  const rest = { ...row };
  delete (rest as { total_count?: unknown }).total_count;
  return rest;
}
