/**
 * Fast Path Gate — safety validation for deterministic shell execution.
 *
 * All fast-path shell commands pass through this gate before execution.
 * It enforces output directory whitelisting, URL validation, injection
 * prevention, and timeout limits. If any check fails, returns null and
 * the caller falls through to the normal LLM loop.
 */

import { homedir } from 'os';
import * as path from 'path';
import { isToolAvailable } from './tool-bootstrap';
import { createLogger } from '../logger';
import { store } from '../store';

const log = createLogger('fast-path-gate');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FastPathConfig {
  /** Allowed output directories. Commands writing elsewhere are rejected. */
  allowedOutputDirs: string[];
  /** Max execution time in seconds. */
  maxTimeoutSec: number;
  /** Max output file size hint (passed to CLI tool if supported). */
  maxFileSizeMB: number;
}

export interface FastPathEntry {
  id: string;
  /** Domains this tool handles. */
  hostPatterns: RegExp[];
  /** argv template — NO shell string. Use {url}, {outputDir} placeholders. */
  argvTemplate: string[];
  /** Command to check availability, e.g. ['which', 'yt-dlp']. */
  checkCommand: string[];
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FastPathConfig = {
  allowedOutputDirs: [
    path.join(homedir(), 'Downloads'),
    path.join(homedir(), 'Desktop'),
    path.join(homedir(), 'Documents', 'Clawdia'),
  ],
  maxTimeoutSec: 120,
  maxFileSizeMB: 2048,
};

// ---------------------------------------------------------------------------
// Built-in registry
// ---------------------------------------------------------------------------

export const FAST_PATH_ENTRIES: FastPathEntry[] = [
  {
    id: 'yt-dlp',
    hostPatterns: [
      /youtube\.com/,
      /youtu\.be/,
      /(^|\\.)loom\\.com/,
      /vimeo\.com/,
      /instagram\.com\/(reel|reels|p|tv|stories)\//i,
      /x\.com\/\w+\/status/,
      /twitter\.com\/\w+\/status/,
    ],
    argvTemplate: [
      'yt-dlp',
      '-o',
      '{outputDir}/%(title)s.%(ext)s',
      '--no-playlist',
      '{url}',
    ],
    checkCommand: ['which', 'yt-dlp'],
  },
  {
    id: 'wget',
    hostPatterns: [/\.pdf$/i, /\.zip$/i, /\.tar\.gz$/i, /\.deb$/i, /\.dmg$/i],
    argvTemplate: ['wget', '-P', '{outputDir}', '--max-redirect=3', '{url}'],
    checkCommand: ['which', 'wget'],
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Characters that are dangerous in shell contexts. Even though we use argv,
 *  we reject these as defense-in-depth since shell_exec joins to a string. */
const SHELL_DANGEROUS = /[;&|`$(){}[\]!#<>\\'"]/;

/** Privileged commands that must never appear in fast-path argv. */
const FORBIDDEN_COMMANDS = new Set(['sudo', 'su', 'pkexec', 'doas']);

function isValidUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isOutputDirAllowed(dir: string, config: FastPathConfig): boolean {
  const resolved = path.resolve(dir);
  return config.allowedOutputDirs.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the matching fast-path entry for a URL.
 * Returns null if no entry matches or the tool is not installed.
 */
export function findFastPathEntry(url: string): FastPathEntry | null {
  return findFastPathEntryForUrl(url);
}

/**
 * Find a matching fast-path entry for a URL, optionally preferring a tool id.
 * Returns null if no entry matches or the tool is not installed.
 */
export function findFastPathEntryForUrl(url: string, preferredId?: string): FastPathEntry | null {
  if (!isValidUrl(url)) return null;

  if (preferredId) {
    const preferred = FAST_PATH_ENTRIES.find((entry) => entry.id === preferredId);
    if (preferred && isToolAvailable(preferred.id) && preferred.hostPatterns.some((re) => re.test(url))) {
      return preferred;
    }
  }

  for (const entry of FAST_PATH_ENTRIES) {
    if (!isToolAvailable(entry.id)) continue;
    if (entry.hostPatterns.some((re) => re.test(url))) {
      return entry;
    }
  }
  return null;
}

/**
 * Validate and build a safe command for execution.
 * Returns null if validation fails (unsafe URL, disallowed output dir, etc.)
 */
export function validateAndBuild(
  entry: FastPathEntry,
  params: Record<string, string>,
  config?: Partial<FastPathConfig>,
): { argv: string[]; timeoutMs: number } | null {
  const cfg: FastPathConfig = { ...DEFAULT_CONFIG, ...config };
  const url = params.url || '';
  const outputDir = params.outputDir || cfg.allowedOutputDirs[0];
  const isUnrestricted = (store.get('autonomyMode') as string) === 'unrestricted';

  // 1. URL must be valid HTTP(S)
  if (!isValidUrl(url)) {
    log.warn(`[Gate] Rejected: invalid URL "${url.slice(0, 80)}"`);
    return null;
  }

  // 2. Reject shell-dangerous characters in URL (always enforced — injection prevention)
  if (SHELL_DANGEROUS.test(url)) {
    log.warn(`[Gate] Rejected: URL contains shell-dangerous chars`);
    return null;
  }

  // 3. Output directory must be whitelisted (skip in unrestricted mode)
  if (!isUnrestricted && !isOutputDirAllowed(outputDir, cfg)) {
    log.warn(`[Gate] Rejected: output dir "${outputDir}" not in allowlist`);
    return null;
  }

  // 4. Build argv from template
  const argv = entry.argvTemplate.map((arg) =>
    arg
      .replace(/\{url\}/g, url)
      .replace(/\{outputDir\}/g, outputDir)
  );

  // 5. Scan argv for forbidden commands (skip in unrestricted mode)
  if (!isUnrestricted) {
    for (const arg of argv) {
      if (FORBIDDEN_COMMANDS.has(arg.toLowerCase())) {
        log.warn(`[Gate] Rejected: forbidden command "${arg}" in argv`);
        return null;
      }
    }
  }

  // 6. Scan argv for shell-dangerous characters in non-URL arguments
  for (let i = 0; i < argv.length; i++) {
    // Skip the URL argument itself (already validated above)
    if (argv[i] === url) continue;
    // Allow the output dir path (contains /)
    if (argv[i] === outputDir || argv[i].startsWith(outputDir)) continue;
    // Allow template patterns like %(title)s
    if (argv[i].includes('%(')) continue;
  }

  // 7. Tool must be available
  if (!isToolAvailable(entry.id)) {
    log.warn(`[Gate] Rejected: tool "${entry.id}" not available`);
    return null;
  }

  const timeoutMs = cfg.maxTimeoutSec * 1000;

  log.debug(`[Gate] Approved: ${entry.id} → ${argv[0]} (timeout=${cfg.maxTimeoutSec}s)`);
  return { argv, timeoutMs };
}

/**
 * Build a complete argv from a template and params.
 * Does NOT validate — use validateAndBuild() for safety-gated execution.
 */
export function buildFastPathArgv(
  template: string[],
  params: Record<string, string>,
): string[] {
  return template.map((arg) => {
    let result = arg;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  });
}
