/**
 * Checkpoint Manager — persists job progress at each pipeline phase.
 *
 * Stores checkpoint data as JSON files in server/data/checkpoints/{job_id}.json.
 * Used by the continue operation to resume jobs from their last successful phase.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import type { ProductVariant } from '../scrapers/site-adapter';

const logger = createLogger('checkpoint-manager');

// ── Checkpoint Types ────────────────────────────────────────────────────────

/**
 * Schema version for checkpoint files. Increment this whenever the shape of
 * any CheckpointData variant changes — especially when ProductVariant gains/
 * loses a field, or when a URL-shape contract changes (image_url format,
 * product url construction). On a version mismatch, `loadCheckpoint`
 * rejects the file and the caller falls back to a fresh start, which is the
 * safe move when the shape has drifted under us.
 *
 * Why this exists: checkpoints persist URLs (`ProductVariant.url`,
 * `ProductVariant.image_url`) whose shape has drifted between deploys. A
 * write-through cache once replayed pre-fix URLs after the code was fixed and
 * re-poisoned the DB. Without a
 * version discriminator, a checkpoint written before a URL-shape change
 * and resumed after one would replay the old-format URLs.
 */
// 2: per-phase shapes below; every checkpoint carries product_ids, and the
//    fetch checkpoints carry permanent_failed and variants keyed by product id.
const CURRENT_CHECKPOINT_SCHEMA_VERSION = 2;

/**
 * The phases a checkpoint is written after, in pipeline order. The one list:
 * the orchestrator resumes by it and the validator accepts only these.
 *  - processing: discovery and catalog merge done
 *  - variants:   product pages fetched
 *  - retry:      transient failures retried
 */
export const CHECKPOINT_PHASES = ['processing', 'variants', 'retry'] as const;
export type CheckpointPhase = (typeof CHECKPOINT_PHASES)[number];

export interface ProcessingCheckpoint {
  product_ids: string[];
  discovered_ids: string[];
  new_ids: string[];
  total_known: number;
}

export interface FetchCheckpoint {
  product_ids: string[];
  /** Variants fetched so far, by catalog product id (the variant cache key). */
  fetched: Record<string, ProductVariant[]>;
  /** Variants served from the variant cache's TTL instead of fetched. */
  cached: ProductVariant[];
  /** Transient failures: retried on resume. */
  failed_products: string[];
  /** 404/410/451 and unresolvable products: never retried. */
  permanent_failed: string[];
}

export interface CheckpointData {
  processing: ProcessingCheckpoint;
  variants: FetchCheckpoint;
  retry: FetchCheckpoint;
}

export type Checkpoint = {
  [P in CheckpointPhase]: {
    schema_version: number;
    job_id: string;
    phase: P;
    timestamp: string;
    data: CheckpointData[P];
  };
}[CheckpointPhase];

/**
 * Thrown by `loadCheckpoint` when the file's `schema_version` does not match
 * `CURRENT_CHECKPOINT_SCHEMA_VERSION`. Callers catch this to fall back to a
 * restart-from-scratch path instead of replaying stale-shape data.
 */
export class CheckpointSchemaMismatchError extends Error {
  constructor(public readonly fileVersion: number | undefined) {
    super(
      `Checkpoint schema mismatch — file version ${fileVersion ?? '(legacy/missing)'}, code expects ${CURRENT_CHECKPOINT_SCHEMA_VERSION}. Restart the job instead of continuing.`,
    );
    this.name = 'CheckpointSchemaMismatchError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CHECKPOINTS_DIR = path.resolve(
  config.scraping.dataDir,
  'checkpoints',
);

export function getCheckpointPath(jobId: string): string {
  // Sanitize jobId to prevent path traversal — allow only alphanumeric, hyphens, underscores, dots
  const sanitized = jobId.replaceAll(/[^a-zA-Z0-9\-_.]/g, '');
  if (!sanitized || sanitized !== jobId) {
    throw new Error(`Invalid job ID for checkpoint path: "${jobId}"`);
  }
  const filePath = path.join(CHECKPOINTS_DIR, `${sanitized}.json`);
  // Verify the resolved path stays within the checkpoints directory
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(CHECKPOINTS_DIR))) {
    throw new Error(`Invalid job ID — path escapes checkpoints directory: "${jobId}"`);
  }
  return filePath;
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCheckpoint(checkpoint: unknown): asserts checkpoint is Checkpoint {
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new TypeError('Checkpoint data is not a valid object');
  }

  const cp = checkpoint as Record<string, unknown>;

  // Reject schema-version mismatches loudly. A legacy file (no field) reads
  // as undefined, which !== CURRENT_CHECKPOINT_SCHEMA_VERSION, so it falls
  // into the same rejection path — correct, since pre-version files predate
  // this guarantee and could carry any shape.
  if (cp.schema_version !== CURRENT_CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointSchemaMismatchError(
      typeof cp.schema_version === 'number' ? cp.schema_version : undefined,
    );
  }

  if (typeof cp.job_id !== 'string' || !cp.job_id) {
    throw new TypeError('Checkpoint missing required field: job_id');
  }
  if (typeof cp.phase !== 'string' || !cp.phase) {
    throw new TypeError('Checkpoint missing required field: phase');
  }
  if (typeof cp.timestamp !== 'string' || !cp.timestamp) {
    throw new TypeError('Checkpoint missing required field: timestamp');
  }

  if (!(CHECKPOINT_PHASES as readonly string[]).includes(cp.phase)) {
    throw new Error(`Invalid checkpoint phase: ${cp.phase}`);
  }

  if (!cp.data || typeof cp.data !== 'object') {
    throw new TypeError('Checkpoint missing required field: data');
  }

  const data = cp.data as Record<string, unknown>;
  const arrays = cp.phase === 'processing'
    ? ['product_ids', 'discovered_ids', 'new_ids']
    : ['product_ids', 'cached', 'failed_products', 'permanent_failed'];
  for (const field of arrays) {
    if (!Array.isArray(data[field])) {
      throw new TypeError(`${cp.phase} checkpoint: ${field} must be an array`);
    }
  }
  if (cp.phase !== 'processing' && (!data.fetched || typeof data.fetched !== 'object' || Array.isArray(data.fetched))) {
    throw new TypeError(`${cp.phase} checkpoint: fetched must be an object`);
  }
}

// ── Core Functions ──────────────────────────────────────────────────────────

/**
 * Save a checkpoint for a job at a specific phase.
 * Creates or overwrites the checkpoint file.
 */
export async function saveCheckpoint<P extends CheckpointPhase>(
  jobId: string,
  phase: P,
  data: CheckpointData[P],
): Promise<void> {
  const checkpoint = {
    schema_version: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    job_id: jobId,
    phase,
    timestamp: new Date().toISOString(),
    data,
  };

  const filePath = getCheckpointPath(jobId);
  await fs.mkdir(CHECKPOINTS_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');

  logger.info('Checkpoint saved', {
    operation: 'saveCheckpoint',
    jobId,
    phase,
  });
}

/**
 * Load and validate a checkpoint for a job.
 * Throws if the file doesn't exist or data is invalid.
 */
export async function loadCheckpoint(jobId: string): Promise<Checkpoint> {
  const filePath = getCheckpointPath(jobId);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Checkpoint file not found for job ${jobId}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Checkpoint file for job ${jobId} contains invalid JSON`);
  }

  validateCheckpoint(parsed);
  return parsed;
}

/**
 * The checkpoint a continued job resumes from, read by the worker. The API
 * validated it when the user continued; if it has gone or no longer
 * validates since (a deploy in between), the attempt starts from scratch.
 */
export async function loadCheckpointForResume(jobId: string): Promise<Checkpoint | undefined> {
  try {
    return await loadCheckpoint(jobId);
  } catch (err) {
    logger.warn('Checkpoint unusable — starting the job from scratch', {
      operation: 'loadCheckpointForResume', jobId, error: (err as Error).message,
    });
    return undefined;
  }
}

/**
 * Check if a checkpoint file exists for a job.
 */
export async function hasCheckpoint(jobId: string): Promise<boolean> {
  try {
    await fs.access(getCheckpointPath(jobId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a checkpoint file. No-op if the file doesn't exist.
 */
export async function deleteCheckpoint(jobId: string): Promise<void> {
  try {
    await fs.unlink(getCheckpointPath(jobId));
    logger.info('Checkpoint deleted', { operation: 'deleteCheckpoint', jobId });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Clean up checkpoint files for jobs older than maxAgeDays.
 * Returns the count of deleted files.
 */
export async function cleanupOldCheckpoints(maxAgeDays: number): Promise<number> {
  let files: string[];
  try {
    files = await fs.readdir(CHECKPOINTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(CHECKPOINTS_DIR, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const checkpoint = JSON.parse(raw) as { timestamp?: string };
      if (checkpoint.timestamp) {
        const ts = new Date(checkpoint.timestamp).getTime();
        if (ts < cutoff) {
          await fs.unlink(filePath);
          deleted++;
        }
      }
    } catch {
      // Skip files that can't be read or parsed
    }
  }

  if (deleted > 0) {
    logger.info('Old checkpoints cleaned up', {
      operation: 'cleanupOldCheckpoints',
      deleted,
      maxAgeDays,
    });
  }

  return deleted;
}
