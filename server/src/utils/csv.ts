/**
 * One CSV row. Strings starting with = + - @ tab or CR get a leading `'` so
 * spreadsheets show them as text instead of running them as formulas;
 * cells with a comma, quote or line break are quoted.
 */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
