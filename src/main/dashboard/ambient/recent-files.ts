import { homedir, platform } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../../logger';

const log = createLogger('ambient-files');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecentFile {
  filePath: string;
  fileName: string;
  modifiedMs: number;
  appName: string;
}

export interface RecentFilesResult {
  files: RecentFile[];
  scanDurationMs: number;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const SKIP_PATH_SEGMENTS = [
  '/.git/',
  '/node_modules/',
  '/.cache/',
  '/.local/share/Trash/',
];

function shouldSkip(filePath: string): boolean {
  return SKIP_PATH_SEGMENTS.some(seg => filePath.includes(seg));
}

// ---------------------------------------------------------------------------
// Parser — regex-based, no XML library needed
// ---------------------------------------------------------------------------

// Each <bookmark> block contains href, modified, and nested <app:application>
// We capture them with a lenient regex that handles multiline blocks.
const BOOKMARK_RE = /<bookmark\s+href="file:\/\/([^"]+)"[^>]*modified="([^"]+)"[^>]*>([\s\S]*?)<\/bookmark>/g;
const APP_NAME_RE = /<bookmark:application[^>]*name="([^"]+)"/;

function parseXbel(content: string, cutoffMs: number): RecentFile[] {
  const results: RecentFile[] = [];
  let match: RegExpExecArray | null;

  while ((match = BOOKMARK_RE.exec(content)) !== null) {
    const rawPath = decodeURIComponent(match[1]);
    const modified = match[2];
    const inner = match[3];

    // Parse timestamp — ISO 8601 format (e.g. 2026-02-10T14:30:00Z)
    const modifiedMs = new Date(modified).getTime();
    if (isNaN(modifiedMs) || modifiedMs < cutoffMs) continue;

    if (shouldSkip(rawPath)) continue;

    // Extract application name
    const appMatch = inner.match(APP_NAME_RE);
    const appName = appMatch ? appMatch[1] : 'Unknown';

    results.push({
      filePath: rawPath,
      fileName: path.basename(rawPath),
      modifiedMs,
      appName,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const XBEL_PATH = path.join(
  homedir(),
  '.local',
  'share',
  'recently-used.xbel',
);

const MAX_FILES = 30;
const CUTOFF_HOURS = 48;

export function scanRecentFiles(): RecentFilesResult | null {
  if (platform() !== 'linux') {
    log.info('[Ambient:Files] Not Linux, skipping recent files scan');
    return null;
  }

  const t0 = Date.now();

  if (!fs.existsSync(XBEL_PATH)) {
    log.info(`[Ambient:Files] ${XBEL_PATH} not found, skipping`);
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(XBEL_PATH, 'utf-8');
  } catch (err: any) {
    log.warn(`[Ambient:Files] Failed to read xbel: ${err?.message || err}`);
    return null;
  }

  const cutoffMs = Date.now() - CUTOFF_HOURS * 60 * 60 * 1000;
  const files = parseXbel(content, cutoffMs);

  // Sort by most recent first, take top N
  files.sort((a, b) => b.modifiedMs - a.modifiedMs);
  const top = files.slice(0, MAX_FILES);

  const elapsed = Date.now() - t0;
  log.info(`[Ambient:Files] Scan complete in ${elapsed}ms — ${top.length} recent files (${files.length} total in last ${CUTOFF_HOURS}h)`);
  for (const f of top.slice(0, 5)) {
    log.info(`[Ambient:Files]   ${f.fileName} — ${f.appName}`);
  }

  return { files: top, scanDurationMs: elapsed };
}

// ---------------------------------------------------------------------------
// Formatter — groups files by application
// ---------------------------------------------------------------------------

export function formatRecentFiles(result: RecentFilesResult | null): string {
  if (!result || result.files.length === 0) return '';

  // Group by appName
  const byApp = new Map<string, string[]>();
  for (const f of result.files) {
    const existing = byApp.get(f.appName) || [];
    existing.push(f.fileName);
    byApp.set(f.appName, existing);
  }

  // Format: "file1, file2, file3 — AppName"
  const lines: string[] = [];
  for (const [app, fileNames] of byApp) {
    // Deduplicate file names
    const unique = [...new Set(fileNames)];
    const display = unique.slice(0, 5).join(', ');
    const extra = unique.length > 5 ? ` +${unique.length - 5} more` : '';
    lines.push(`${display}${extra} — ${app}`);
  }

  const block = `<recent_files_last_48h>\n${lines.join('\n')}\n</recent_files_last_48h>`;
  return block.slice(0, 500);
}
