import * as path from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger';
import type { PolicyDecision } from './contracts';
import { splitCommandSegments, tokenizeSegment, extractExecutable } from './command-analyzer';

const log = createLogger('policy-engine');

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+-rf\s+\/$/i,
  /(^|\s)rm\s+-rf\s+\/\s*[;&|]/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  /\bmkfs\.[a-z0-9]+\b/i,
  /\bdd\s+if=.*\sof=\/dev\/(sd[a-z]|nvme\d+n\d+|vd[a-z])/i,
  /\bshutdown\b\s+-h\s+now/i,
  /\breboot\b/i,
];

const DESTRUCTIVE_COMMANDS = new Set(['rm', 'mv', 'cp', 'chmod', 'chown', 'dd', 'truncate', 'ln']);
const SYSTEM_ROOTS = ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/root', '/opt'];

function normalize(inputPath: string, cwd: string): string {
  if (!inputPath) return cwd;
  if (inputPath.startsWith('~')) return path.resolve(path.join(homedir(), inputPath.slice(1)));
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  return path.resolve(cwd, inputPath);
}

function isPathToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith('-')) return false;
  return token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~');
}

function findUnsafePathMutation(command: string, cwd: string, allowedRoots: string[]): string | null {
  const normalizedAllowed = allowedRoots.map((root) => path.resolve(root));
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    const executable = extractExecutable(segment);
    if (!executable || !DESTRUCTIVE_COMMANDS.has(executable)) continue;

    const tokens = tokenizeSegment(segment);
    for (const token of tokens) {
      if (!isPathToken(token)) continue;
      const resolved = normalize(token, cwd);

      const inAllowed = normalizedAllowed.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      if (inAllowed) continue;

      const inSystem = SYSTEM_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      if (inSystem || resolved === '/') {
        return `${executable} on protected path ${resolved}`;
      }
    }
  }

  return null;
}

function applyNonBlockingRewrites(command: string): PolicyDecision | null {
  let rewritten = command;

  if (/\bsudo\s+apt-get\s+install\b/.test(rewritten) && !/sudo\s+-n\s+apt-get\s+install/.test(rewritten)) {
    rewritten = rewritten.replace(/sudo\s+apt-get\s+install/g, 'DEBIAN_FRONTEND=noninteractive sudo -n apt-get install');
  }

  if (/\bapt-get\s+install\b/.test(rewritten) && !/DEBIAN_FRONTEND=noninteractive/.test(rewritten)) {
    rewritten = `DEBIAN_FRONTEND=noninteractive ${rewritten}`;
  }

  if (/\bpip\s+install\b/.test(rewritten)) {
    rewritten = rewritten.replace(/\bpip\s+install\b/g, 'python3 -m pip install');
  }

  if (rewritten !== command) {
    return {
      action: 'rewrite',
      reason: 'Applied non-blocking command rewrite for unattended execution.',
      command: rewritten,
    };
  }

  return null;
}

export interface EvaluatePolicyOptions {
  cwd?: string;
  allowedRoots?: string[];
}

export function evaluateCommandPolicy(command: string, options?: EvaluatePolicyOptions): PolicyDecision {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { action: 'deny', reason: 'Empty command is not executable.' };
  }

  for (const pattern of CATASTROPHIC_PATTERNS) {
    if (pattern.test(trimmed)) {
      const reason = 'Command matches catastrophic denylist pattern.';
      log.warn(`[Policy] Blocked catastrophic command: ${trimmed}`);
      return { action: 'deny', reason, detail: 'Hard safety invariant.' };
    }
  }

  const cwd = options?.cwd || homedir();
  const allowedRoots = options?.allowedRoots || [homedir(), '/tmp'];
  const unsafe = findUnsafePathMutation(trimmed, cwd, allowedRoots);
  if (unsafe) {
    return {
      action: 'deny',
      reason: `Blocked destructive operation outside allowed roots: ${unsafe}`,
      detail: `Allowed roots: ${allowedRoots.join(', ')}`,
    };
  }

  const rewritten = applyNonBlockingRewrites(trimmed);
  if (rewritten) return rewritten;

  return { action: 'allow', reason: 'Command allowed by policy.' };
}
