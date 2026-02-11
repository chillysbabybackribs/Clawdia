import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../../logger';

const log = createLogger('ambient-shell');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellCommand {
  command: string;
  timestamp: number | null; // null if history has no timestamps
}

export interface ShellHistoryResult {
  recentCommands: ShellCommand[];
  topPrefixes: Array<{ prefix: string; count: number }>;
  workingDirs: string[];
  source: string; // 'zsh' | 'bash'
  scanDurationMs: number;
}

// ---------------------------------------------------------------------------
// Sensitive command filters
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /\btoken\b/i,
  /\bkey=/i,
  // export of sensitive env vars
  /export\s+\w*(API|SECRET|PASSWORD|TOKEN|KEY)\w*\s*=/i,
  // curl with auth
  /curl\b.*\s(-u|--user)\s/i,
  /curl\b.*Authorization/i,
  // Clawdia internal markers and echo wrappers
  /__CLAWDIA_/,
  /^echo\s+["']__CLAWDIA_/,
];

function isSensitiveCommand(cmd: string): boolean {
  return SENSITIVE_PATTERNS.some(re => re.test(cmd));
}

// ---------------------------------------------------------------------------
// History file discovery
// ---------------------------------------------------------------------------

function findHistoryFile(): { path: string; type: 'zsh' | 'bash' } | null {
  const home = homedir();
  const candidates: Array<{ path: string; type: 'zsh' | 'bash' }> = [
    { path: path.join(home, '.zsh_history'), type: 'zsh' },
    { path: path.join(home, '.bash_history'), type: 'bash' },
  ];

  for (const c of candidates) {
    try {
      fs.accessSync(c.path, fs.constants.R_OK);
      return c;
    } catch { /* not accessible */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse zsh extended history format: ": timestamp:0;command"
 * Falls back to plain line if format doesn't match.
 */
function parseZshLine(line: string): ShellCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^:\s*(\d+):\d+;(.+)$/);
  if (match) {
    return {
      command: match[2].trim(),
      timestamp: parseInt(match[1], 10) * 1000,
    };
  }
  // Plain line (non-extended zsh history)
  return { command: trimmed, timestamp: null };
}

function parseBashLine(line: string): ShellCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return { command: trimmed, timestamp: null };
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

const TAIL_LINES = 100;

export function scanShellHistory(): ShellHistoryResult | null {
  const t0 = Date.now();

  const histFile = findHistoryFile();
  if (!histFile) {
    log.info('[Ambient:Shell] No shell history file found');
    return null;
  }
  log.info(`[Ambient:Shell] Found ${histFile.type} history at ${histFile.path}`);

  let rawLines: string[];
  try {
    const content = fs.readFileSync(histFile.path, 'utf-8');
    const allLines = content.split('\n');
    rawLines = allLines.slice(-TAIL_LINES);
  } catch (err: any) {
    log.warn(`[Ambient:Shell] Failed to read history: ${err?.message || err}`);
    return null;
  }

  const parser = histFile.type === 'zsh' ? parseZshLine : parseBashLine;

  // Clawdia injects commands as: cd '/home/...' 2>/dev/null; actual_command
  const CLAWDIA_CD_PREFIX = /^cd\s+'[^']*'\s*2>\/dev\/null;\s*/;

  // Parse and filter
  const commands: ShellCommand[] = [];
  for (const line of rawLines) {
    const parsed = parser(line);
    if (!parsed) continue;
    // Strip Clawdia-injected cd prefix so downstream sees the real command
    parsed.command = parsed.command.replace(CLAWDIA_CD_PREFIX, '');
    if (!parsed.command) continue;
    if (isSensitiveCommand(parsed.command)) continue;
    commands.push(parsed);
  }

  // Recent 20 (most recent last → reverse for display)
  const recentCommands = commands.slice(-20);

  // Top 10 command prefixes
  const prefixCounts = new Map<string, number>();
  for (const cmd of commands) {
    let effective = cmd.command;
    // If command starts with cd ... &&, count the chained command instead
    const cdChain = effective.match(/^cd\s+[^&]+&&\s*(.+)/);
    if (cdChain) effective = cdChain[1];
    const firstWord = effective.split(/\s+/)[0];
    if (!firstWord || firstWord.length <= 1) continue;
    // Normalize: strip leading path (e.g. /usr/bin/git → git)
    const base = firstWord.split('/').pop() || firstWord;
    if (!base || base.length <= 1) continue;
    prefixCounts.set(base, (prefixCounts.get(base) || 0) + 1);
  }

  const topPrefixes = Array.from(prefixCounts.entries())
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Working directories from cd commands
  const cdDirs = new Set<string>();
  for (const cmd of commands) {
    // Match cd at start, capture path up to && ; | or end
    const cdMatch = cmd.command.match(/^cd\s+([^;&|]+)/);
    if (!cdMatch) continue;
    let dir = cdMatch[1].trim();
    // Strip quotes
    dir = dir.replace(/^['"]|['"]$/g, '');
    // Skip Clawdia's own cd prefixes
    if (dir.includes('2>/dev/null')) continue;
    // Skip bare navigation (., .., -, ~)
    if (/^[.~-]{1,2}$/.test(dir)) continue;
    if (dir) cdDirs.add(dir);
  }
  const workingDirs = Array.from(cdDirs).slice(-10);

  const elapsed = Date.now() - t0;
  log.info(`[Ambient:Shell] Scan complete in ${elapsed}ms — ${commands.length} commands, ${topPrefixes.length} prefixes, ${workingDirs.length} dirs`);
  for (const p of topPrefixes.slice(0, 5)) {
    log.info(`[Ambient:Shell]   ${p.prefix}: ${p.count}x`);
  }

  return {
    recentCommands,
    topPrefixes,
    workingDirs,
    source: histFile.type,
    scanDurationMs: elapsed,
  };
}

/**
 * Format shell history as a compact string for injection into the Haiku prompt.
 * Max ~400 chars.
 */
export function formatShellActivity(result: ShellHistoryResult | null): string {
  if (!result || result.recentCommands.length === 0) return '';

  const parts: string[] = [];

  // Top tools
  if (result.topPrefixes.length > 0) {
    const tools = result.topPrefixes.slice(0, 6).map(p => `${p.prefix}(${p.count})`).join(' ');
    parts.push(`tools: ${tools}`);
  }

  // Recent unique commands (last 5, deduplicated)
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let i = result.recentCommands.length - 1; i >= 0 && recent.length < 5; i--) {
    const cmd = result.recentCommands[i].command.slice(0, 60);
    if (!seen.has(cmd)) {
      seen.add(cmd);
      recent.push(cmd);
    }
  }
  if (recent.length > 0) {
    parts.push(`recent: ${recent.join('; ')}`);
  }

  // Working dirs
  if (result.workingDirs.length > 0) {
    parts.push(`dirs: ${result.workingDirs.slice(-3).join(', ')}`);
  }

  const block = `<shell_activity>\n${parts.join('\n')}\n</shell_activity>`;
  return block.slice(0, 400);
}
