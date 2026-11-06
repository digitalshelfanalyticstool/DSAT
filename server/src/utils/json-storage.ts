import { promises as fs } from 'node:fs';
import path from 'node:path';

// Simple in-memory file locking
const locks = new Map<string, Promise<void>>();

async function acquireLock(filePath: string): Promise<() => void> {
  const key = path.resolve(filePath);

  while (locks.has(key)) {
    await locks.get(key);
  }

  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(key, lockPromise);

  return () => {
    locks.delete(key);
    releaseLock!();
  };
}

async function ensureFileExists(filePath: string, defaultContent: string = '[]'): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, defaultContent, 'utf-8');
  }
}

// ─── In-Memory Read Cache ───────────────────────────────────────────────────────
// Write-through cache: reads are served from memory, writes update both cache and disk.
// Cache entries are keyed by resolved file path.

interface CacheEntry {
  data: unknown;
  /** Timestamp of last write (for staleness checks if needed later) */
  updatedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Invalidate the cache entry for a specific file.
 * Call this if you know the file was modified externally.
 */
export function invalidateCache(filePath: string): void {
  cache.delete(path.resolve(filePath));
}

export async function readJSON<T>(filePath: string): Promise<T> {
  const key = path.resolve(filePath);

  // Serve from cache if available
  const cached = cache.get(key);
  if (cached) {
    // Return a deep clone so callers can't mutate the cache
    return structuredClone(cached.data) as T;
  }

  await ensureFileExists(filePath);
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content) as T;

  // Populate cache
  cache.set(key, { data: structuredClone(data), updatedAt: Date.now() });

  return data;
}

export async function writeJSON<T>(filePath: string, data: T): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tmpFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${Date.now()}.tmp`
  );

  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpFile, json, 'utf-8');
  await fs.rename(tmpFile, filePath);

  // Update cache (write-through)
  const key = path.resolve(filePath);
  cache.set(key, { data: JSON.parse(json), updatedAt: Date.now() });
}


export async function appendToArray<T>(filePath: string, item: T): Promise<void> {
  const release = await acquireLock(filePath);
  try {
    const data = await readJSON<T[]>(filePath);
    data.push(item);
    await writeJSON(filePath, data);
  } finally {
    release();
  }
}

/** Drop the items matching the predicate; returns how many were removed. */
export async function removeFromArray<T>(filePath: string, predicate: (item: T) => boolean): Promise<number> {
  const release = await acquireLock(filePath);
  try {
    const data = await readJSON<T[]>(filePath);
    const kept = data.filter((item) => !predicate(item));
    if (kept.length !== data.length) await writeJSON(filePath, kept);
    return data.length - kept.length;
  } finally {
    release();
  }
}

export async function updateItem<T>(
  filePath: string,
  predicate: (item: T) => boolean,
  updater: (item: T) => T
): Promise<void> {
  const release = await acquireLock(filePath);
  try {
    const data = await readJSON<T[]>(filePath);
    const updated = data.map((item) => (predicate(item) ? updater(item) : item));
    await writeJSON(filePath, updated);
  } finally {
    release();
  }
}
