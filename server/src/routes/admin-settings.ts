/**
 * Admin Settings Routes — disk space.
 *
 * Mounted without a prefix at /api/admin by the parent hub router.
 * Auth middleware (authMiddleware + requireRole('admin')) is applied by the parent.
 *
 * Endpoints:
 *   - GET  /api/admin/disk-space          — get disk usage info
 */

import path from 'node:path';
import { homedir } from 'node:os';
import { Router } from 'express';
import { errorResponse } from '../utils/error-response';
import { asyncHandler } from '../utils/async-handler';
import { config } from '../config';
import type { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// Disk Space
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /admin/disk-space:
 *   get:
 *     summary: Get disk usage info for the storage volume
 *     tags: [Admin - Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Disk usage info with warning flag when below 25% available
 */
/**
 * Categories the disk widget can attribute usage to. Static map so the
 * response shape is stable; if a path doesn't exist on this machine,
 * `du` returns ENOENT and we report bytes=0 (not an error).
 *
 * `excels` is actionable from the admin reports table.
 * `variant_cache` is auto-cleared by VARIANT_CACHE_TTL_HOURS (informational).
 * `logs` is operator-managed (PM2 rotation).
 * `other` is implicit (used - sum(tracked)).
 */
function getDiskCategoryPaths(): Array<{ name: 'excels' | 'variant_cache' | 'logs'; label: string; path: string }> {
  const home = homedir();
  return [
    { name: 'excels',        label: 'Excel reports',      path: path.resolve(config.scraping.storageDir) },
    { name: 'variant_cache', label: 'Variant cache',      path: path.resolve(config.scraping.dataDir, 'catalogs') },
    { name: 'logs',          label: 'Application logs',   path: path.resolve(home, '.pm2', 'logs') },
  ];
}

/**
 * Run `du -sb` for one directory. Returns 0 if the path doesn't exist or `du`
 * is unavailable; we treat per-category sizing as best-effort, not load-bearing.
 */
async function duBytes(targetPath: string): Promise<number> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('du', ['-sb', targetPath], { timeout: 15_000 });
    const bytes = Number.parseInt(stdout.split(/\s+/)[0], 10);
    return Number.isFinite(bytes) ? bytes : 0;
  } catch {
    return 0;
  }
}

/**
 * Count files matching `*.xlsx` under a directory tree, for the excels category
 * file-count display. Bounded by `find -name`; returns 0 on any error so the
 * widget degrades to size-only.
 */
async function countXlsx(targetPath: string): Promise<number> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('find', [targetPath, '-type', 'f', '-name', '*.xlsx'], { timeout: 15_000, maxBuffer: 10_000_000 });
    return stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

router.get('/disk-space', asyncHandler(async (_req: AuthenticatedRequest, res) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  // Determine which filesystem path to check: configurable via STORAGE_PATH, defaulting to root.
  const storagePath = config.scraping.diskSpaceCheckPath;

  // df -P gives POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted
  const { stdout } = await execFileAsync('df', ['-P', storagePath]);
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) {
    res.status(500).json(errorResponse('Unable to parse disk space', 'server_error'));
    return;
  }
  const parts = lines[1].split(/\s+/);
  const totalKb = Number.parseInt(parts[1], 10);
  const usedKb = Number.parseInt(parts[2], 10);
  const availableKb = Number.parseInt(parts[3], 10);
  const totalGb = +(totalKb / 1048576).toFixed(2);
  const usedGb = +(usedKb / 1048576).toFixed(2);
  const availableGb = +(availableKb / 1048576).toFixed(2);
  const usedPercent = +(usedKb / totalKb * 100).toFixed(1);
  const availablePercent = +(availableKb / totalKb * 100).toFixed(1);
  const warning = availablePercent < 25;

  // Per-category sizes — three `du -sb` shell-outs in parallel. Each is
  // bounded by a 15s timeout so a slow scratched disk can't pin the route.
  const usedBytes = usedKb * 1024;
  const cats = getDiskCategoryPaths();
  const sizes = await Promise.all(cats.map((c) => duBytes(c.path)));
  const excelsCount = await countXlsx(cats[0].path);

  const trackedBytes = sizes.reduce((s, b) => s + b, 0);
  const otherBytes = Math.max(0, usedBytes - trackedBytes);

  const categories = [
    ...cats.map((c, i) => ({
      name: c.name,
      label: c.label,
      path: c.path,
      bytes: sizes[i],
      gb: +(sizes[i] / 1_073_741_824).toFixed(2),
      percent_of_used: usedBytes > 0 ? +(sizes[i] / usedBytes * 100).toFixed(1) : 0,
      count: c.name === 'excels' ? excelsCount : undefined,
      actionable: c.name === 'excels',
    })),
    {
      name: 'other' as const,
      label: 'Other / unaccounted',
      path: null,
      bytes: otherBytes,
      gb: +(otherBytes / 1_073_741_824).toFixed(2),
      percent_of_used: usedBytes > 0 ? +(otherBytes / usedBytes * 100).toFixed(1) : 0,
      count: undefined,
      actionable: false,
    },
  ];

  res.json({
    success: true,
    disk: {
      total_gb: totalGb,
      used_gb: usedGb,
      available_gb: availableGb,
      used_percent: usedPercent,
      available_percent: availablePercent,
      warning,
      categories,
    },
  });
}, { operation: 'diskSpace', message: 'Failed to check disk space' }));

export default router;
