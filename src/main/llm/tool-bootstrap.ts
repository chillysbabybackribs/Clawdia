/**
 * Tool Bootstrap — one-time detection of fast-path CLI tools.
 *
 * Runs at app startup (fire-and-forget) to check whether tools like
 * yt-dlp and wget are installed. Results are cached in memory and
 * persisted to electron-store so subsequent launches are instant.
 */

import { execFile } from 'child_process';
import { store, type ClawdiaStoreSchema } from '../store';
import { createLogger } from '../logger';

const log = createLogger('tool-bootstrap');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolStatus {
  id: string;
  available: boolean;
  version?: string;
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const toolCache = new Map<string, ToolStatus>();
let detected = false;

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Check if a binary exists on PATH using `which`. */
function checkBinary(binary: string): Promise<{ available: boolean; path?: string }> {
  return new Promise((resolve) => {
    execFile('which', [binary], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false });
      } else {
        resolve({ available: true, path: stdout.trim() });
      }
    });
  });
}

/** Try to get version string from a binary. */
function getVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(undefined);
        return;
      }
      // First line of stdout or stderr usually has the version
      const line = (stdout || stderr || '').split('\n')[0]?.trim();
      resolve(line || undefined);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry — tools we want to detect
// ---------------------------------------------------------------------------

const TOOLS_TO_DETECT = ['yt-dlp', 'wget', 'curl', 'ffmpeg'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check all fast-path tools once. Cache results in memory + store.
 * Called from main.ts on app-ready (fire-and-forget).
 */
export async function detectFastPathTools(): Promise<Map<string, ToolStatus>> {
  if (detected) return toolCache;

  const start = performance.now();

  // Load persisted status first — avoids re-checking on every launch
  const persisted = store.get('fastPathToolStatus' as keyof ClawdiaStoreSchema) as
    | Record<string, ToolStatus>
    | undefined;

  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  const checks = TOOLS_TO_DETECT.map(async (id) => {
    // Use persisted result if fresh enough
    const cached = persisted?.[id];
    if (cached && now - cached.checkedAt < MAX_AGE_MS) {
      toolCache.set(id, cached);
      return;
    }

    const { available } = await checkBinary(id);
    let version: string | undefined;
    if (available) {
      version = await getVersion(id);
    }

    const status: ToolStatus = {
      id,
      available,
      version,
      checkedAt: now,
    };
    toolCache.set(id, status);
  });

  await Promise.allSettled(checks);
  detected = true;

  // Persist to store
  const toStore: Record<string, ToolStatus> = {};
  for (const [id, status] of toolCache) {
    toStore[id] = status;
  }
  store.set('fastPathToolStatus' as keyof ClawdiaStoreSchema, toStore as any);

  const elapsed = performance.now() - start;
  const available = [...toolCache.values()].filter((s) => s.available).map((s) => s.id);
  log.info(`Tool detection complete in ${elapsed.toFixed(0)}ms: available=[${available.join(', ')}]`);

  return toolCache;
}

/**
 * Check a single tool (sync, reads from cache).
 * Returns false if detection hasn't run yet or tool is missing.
 */
export function isToolAvailable(toolId: string): boolean {
  const cached = toolCache.get(toolId);
  if (cached) return cached.available;

  // Check persisted store as fallback
  const persisted = store.get('fastPathToolStatus' as keyof ClawdiaStoreSchema) as
    | Record<string, ToolStatus>
    | undefined;
  if (persisted?.[toolId]) {
    toolCache.set(toolId, persisted[toolId]);
    return persisted[toolId].available;
  }

  return false;
}

/**
 * Get list of missing tools the user might want to install.
 */
export function getMissingTools(): ToolStatus[] {
  return [...toolCache.values()].filter((s) => !s.available);
}

/**
 * Get all detected tool statuses.
 */
export function getAllToolStatuses(): ToolStatus[] {
  return [...toolCache.values()];
}
