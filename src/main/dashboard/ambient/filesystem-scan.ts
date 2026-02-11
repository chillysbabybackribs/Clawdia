import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { createLogger } from '../../logger';

const log = createLogger('ambient-fs');

/** Directories under $HOME to scan for project folders. */
const SCAN_ROOTS = ['Desktop', 'Documents', 'Projects', 'repos', 'code', 'dev'];

/** Skip these directory names at the top level inside each root. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.local', '__pycache__', 'dist', 'build', '.npm', '.nvm']);

const SHELL_TIMEOUT_MS = 5_000;
const MAX_PROJECTS = 20;

export interface ProjectActivity {
  name: string;
  fullPath: string;
  lastModifiedMs: number;
  filesChangedLast24h: number;
  hasGit: boolean;
  heatScore: number; // 0-100
}

export interface FilesystemScanResult {
  projects: ProjectActivity[];
  scanDurationMs: number;
  errors: string[];
}

/**
 * Compute heat score: 60% recency + 40% churn.
 *
 * Recency: linear decay over ~50 hours.  Modified just now → 60.  Modified 50h ago → 0.
 * Churn:   files changed in last 24h, capped at 50 for the max 40 points.
 */
function computeHeatScore(lastModifiedMs: number, filesChanged24h: number): number {
  const hoursAgo = (Date.now() - lastModifiedMs) / (1000 * 60 * 60);
  const recency = Math.max(0, 1 - hoursAgo / 50) * 60;
  const churn = Math.min(filesChanged24h / 50, 1) * 40;
  return Math.round(recency + churn);
}

// ---------------------------------------------------------------------------
// Platform-specific helpers
// ---------------------------------------------------------------------------

async function shellExec(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn('/bin/bash', ['-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SHELL_TIMEOUT_MS,
    });
    proc.stdout!.on('data', d => stdout += d.toString());
    proc.on('close', () => resolve(stdout.trim() || null));
    proc.on('error', () => resolve(null));
  });
}

/** Get the most recent mtime of any file under `dir` (unix: find + stat). */
async function getLastModifiedUnix(dir: string): Promise<number | null> {
  // find the single most recently modified file and print its epoch mtime
  const out = await shellExec(
    `find ${JSON.stringify(dir)} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -type f -printf '%T@\\n' 2>/dev/null | sort -rn | head -1`
  );
  if (!out) return null;
  const epoch = parseFloat(out);
  return isFinite(epoch) ? epoch * 1000 : null;
}

/** Count files modified in the last 24 hours under `dir` (unix: find -mtime). */
async function getChurn24hUnix(dir: string): Promise<number | null> {
  const out = await shellExec(
    `find ${JSON.stringify(dir)} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -type f -mtime -1 2>/dev/null | wc -l`
  );
  if (out === null) return null;
  const n = parseInt(out, 10);
  return isFinite(n) ? n : null;
}

/** Pure Node fallback: walk up to `maxDepth` levels, collect mtimes. */
async function walkStats(dir: string, maxDepth: number): Promise<{ latestMs: number; count24h: number }> {
  let latestMs = 0;
  let count24h = 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          const mt = stat.mtimeMs;
          if (mt > latestMs) latestMs = mt;
          if (mt > cutoff) count24h++;
        } catch { /* permission denied, etc */ }
      }
    }
  }

  await walk(dir, 0);
  return { latestMs, count24h };
}

/** Check if a .git directory exists. */
async function hasGitDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, '.git'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

async function scanProject(projectPath: string, useShell: boolean): Promise<ProjectActivity | null> {
  const name = path.basename(projectPath);

  let lastModifiedMs: number;
  let filesChangedLast24h: number;

  if (useShell) {
    const lm = await getLastModifiedUnix(projectPath);
    const churn = await getChurn24hUnix(projectPath);
    // If shell failed, fall back to Node for this project
    if (lm === null || churn === null) {
      const stats = await walkStats(projectPath, 3);
      lastModifiedMs = stats.latestMs || 0;
      filesChangedLast24h = stats.count24h;
    } else {
      lastModifiedMs = lm;
      filesChangedLast24h = churn;
    }
  } else {
    const stats = await walkStats(projectPath, 3);
    lastModifiedMs = stats.latestMs || 0;
    filesChangedLast24h = stats.count24h;
  }

  if (lastModifiedMs === 0) return null; // empty/inaccessible

  const git = await hasGitDir(projectPath);
  const heatScore = computeHeatScore(lastModifiedMs, filesChangedLast24h);

  return {
    name,
    fullPath: projectPath,
    lastModifiedMs,
    filesChangedLast24h,
    hasGit: git,
    heatScore,
  };
}

/**
 * Resolve a scan root like "~/Projects" to an absolute path.
 */
function resolveScanRoot(root: string): string {
  const home = homedir();
  if (root.startsWith('~/')) return path.join(home, root.slice(2));
  if (root.startsWith('~')) return path.join(home, root.slice(1));
  return root;
}

export async function scanFilesystemActivity(customRoots?: string[]): Promise<FilesystemScanResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const home = homedir();
  const useShell = process.platform === 'linux' || process.platform === 'darwin';

  // Resolve scan roots: use custom roots if provided, otherwise default
  const resolvedRoots: string[] = customRoots
    ? customRoots.map(resolveScanRoot)
    : SCAN_ROOTS.map(r => path.join(home, r));

  // Discover candidate project directories (one level deep inside each root)
  const candidates: string[] = [];
  for (const rootPath of resolvedRoots) {
    const rootLabel = rootPath.replace(home, '~');
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        candidates.push(path.join(rootPath, entry.name));
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        errors.push(`${rootLabel}: ${err?.message || err}`);
      }
      // ENOENT is expected — not every machine has ~/Projects etc.
    }
  }

  log.info(`[Ambient:FS] Found ${candidates.length} candidate directories across ${resolvedRoots.length} roots`);

  // Scan each candidate in parallel (bounded)
  const CONCURRENCY = 6;
  const projects: ProjectActivity[] = [];

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(p => scanProject(p, useShell))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled' && r.value) {
        projects.push(r.value);
      } else if (r.status === 'rejected') {
        errors.push(`${batch[j]}: ${r.reason?.message || r.reason}`);
      }
    }
  }

  // Sort by heat score descending, keep top N
  projects.sort((a, b) => b.heatScore - a.heatScore);
  const top = projects.slice(0, MAX_PROJECTS);

  const elapsed = Date.now() - t0;
  log.info(`[Ambient:FS] Scan complete in ${elapsed}ms — ${top.length} projects (${errors.length} errors)`);
  for (const p of top.slice(0, 8)) {
    log.info(`[Ambient:FS]   heat=${p.heatScore} git=${p.hasGit} churn24h=${p.filesChangedLast24h} ${p.name}`);
  }

  return { projects: top, scanDurationMs: elapsed, errors };
}

/**
 * Format scan results as a compact string for injection into the Haiku prompt.
 * Max ~500 chars.
 */
export function formatProjectActivity(result: FilesystemScanResult): string {
  if (result.projects.length === 0) return '';

  const lines = result.projects.slice(0, 6).map(p => {
    const ago = Math.round((Date.now() - p.lastModifiedMs) / (1000 * 60 * 60));
    const agoStr = ago < 1 ? '<1h ago' : `${ago}h ago`;
    return `${p.name}: heat=${p.heatScore}${p.hasGit ? ' git' : ''} churn=${p.filesChangedLast24h} ${agoStr}`;
  });

  const block = `<project_activity>\n${lines.join('\n')}\n</project_activity>`;
  return block.slice(0, 500);
}
