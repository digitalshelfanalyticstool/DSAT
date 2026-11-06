/**
 * One settings table holding a single row (id = 1), such as the SSO, scraping
 * provider and email settings. Credentials in it are encrypted by the caller
 * with secrets.ts; this class only reads, caches and upserts the row.
 *
 * The cache lives on the instance. A read within `ttlMs` of the last one is
 * served from it, concurrent reads share one query, and with
 * `serveStaleOnError` a failed read serves the last good value.
 */

import type { DatabaseService } from './database';

const IDENTIFIER = /^[a-z_]+$/;

export interface SettingsStoreOptions<Row, T> {
  /** How long a read is reused; 0 (default) re-reads every time. */
  ttlMs?: () => number;
  /** Turns the row (undefined when none is saved) into the value callers get. */
  parse: (row: Row | undefined) => T;
  /** On a failed read, answer with the last good value (when there is one) instead of throwing. */
  serveStaleOnError?: boolean;
  /** Told about every failed read, including those answered with the last good value. */
  onReadError?: (err: unknown) => void;
}

export class SettingsStore<Row extends object, T = Row | undefined> {
  private cached: { value: T; expiresAt: number } | null = null;
  private lastGood: { value: T } | null = null;
  private inflight: Promise<T> | null = null;

  constructor(
    private readonly table: string,
    private readonly columns: readonly (keyof Row & string)[],
    private readonly options: SettingsStoreOptions<Row, T>,
  ) {
    // Identifiers can't be parameterized: allow only plain lowercase names.
    for (const name of [table, ...columns]) {
      if (!IDENTIFIER.test(name)) throw new Error(`Invalid settings identifier: ${name}`);
    }
  }

  async read(db: DatabaseService): Promise<T> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.value;
    this.inflight ??= this.load(db).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(db: DatabaseService): Promise<T> {
    let value: T;
    try {
      const row = await db.get<Row>(`SELECT ${this.columns.join(', ')} FROM ${this.table} WHERE id = 1`);
      value = this.options.parse(row);
      this.lastGood = { value };
    } catch (err) {
      this.options.onReadError?.(err);
      if (!this.options.serveStaleOnError || !this.lastGood) throw err;
      value = this.lastGood.value;
    }
    this.cached = { value, expiresAt: Date.now() + (this.options.ttlMs?.() ?? 0) };
    return value;
  }

  /**
   * Upsert row 1. Columns whose value is undefined keep their stored value.
   * `updated_by` and `updated_at` are set on every write.
   */
  async write(db: DatabaseService, values: Partial<Record<keyof Row & string, unknown>>, updatedBy: number | null): Promise<void> {
    const cols = this.columns.filter((c) => values[c] !== undefined);
    const params = [...cols.map((c) => values[c]), updatedBy];
    const placeholders = params.map((_, i) => `$${i + 1}`);
    const assignments = [...cols, 'updated_by'].map((c) => `${c} = EXCLUDED.${c}`);
    await db.run(
      `INSERT INTO ${this.table} (id, ${[...cols, 'updated_by'].join(', ')}, updated_at)
       VALUES (1, ${placeholders.join(', ')}, NOW())
       ON CONFLICT (id) DO UPDATE SET ${assignments.join(', ')}, updated_at = NOW()`,
      ...params,
    );
    this.invalidate();
  }

  /** Make the next read query the database. */
  invalidate(): void {
    this.cached = null;
  }

  /** Forget everything, including the last good value. */
  reset(): void {
    this.cached = null;
    this.lastGood = null;
  }
}
