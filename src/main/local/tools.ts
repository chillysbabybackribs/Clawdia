import { exec, spawn, type ChildProcess } from 'child_process';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger } from '../logger';
import { createDocument, type LlmGenerationMetrics } from '../documents/creator';
import type { DocProgressEvent } from '../../shared/types';
import {
  type CapabilityEvent,
  type TrustPolicy,
  toCapabilityLifecycleEventName,
} from '../capabilities/contracts';
import type { AutonomyMode } from '../../shared/autonomy';
import {
  createFileCheckpoint,
  disposeFileCheckpoint,
  restoreFileCheckpoint,
  type FileCheckpoint,
} from '../capabilities/checkpoint-manager';
import { ensureCommandCapabilities } from '../capabilities/install-orchestrator';
import { getCapabilityPlatformFlags } from '../capabilities/feature-flags';
import { evaluateCommandPolicy } from '../capabilities/policy-engine';
import { initializeCapabilityRegistry, resolveCommandCapabilities } from '../capabilities/registry';

const execAsync = promisify(exec);
const log = createLogger('local-tools');

initializeCapabilityRegistry();

// ---------------------------------------------------------------------------
// Directory tree cache — avoids repeated fs.readdir+stat walks for the same path.
// TTL 60s, invalidated when file_write/file_edit touch a path under a cached dir.
// ---------------------------------------------------------------------------

interface DirTreeCacheEntry {
  result: string;
  timestamp: number;
}

const DIR_TREE_CACHE_TTL_MS = 60_000;
const dirTreeCache = new Map<string, DirTreeCacheEntry>();

function dirTreeCacheKey(dirPath: string, depth: number, showHidden: boolean, ignorePatterns: string[]): string {
  return `${dirPath}|${depth}|${showHidden}|${ignorePatterns.sort().join(',')}`;
}

function invalidateDirTreeCache(filePath: string): void {
  if (dirTreeCache.size === 0) return;
  const dir = path.dirname(filePath);
  for (const key of dirTreeCache.keys()) {
    // Key starts with the cached dirPath before the first '|'
    const cachedDir = key.slice(0, key.indexOf('|'));
    if (dir === cachedDir || dir.startsWith(cachedDir + path.sep)) {
      dirTreeCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent shell session — avoids spawning a new process per command
// ---------------------------------------------------------------------------

const SHELL_SENTINEL = `__CLAWDIA_DONE_${Date.now()}__`;

interface PersistentShell {
  proc: ChildProcess;
  busy: boolean;
  ready: boolean;
}

let persistentShell: PersistentShell | null = null;

function getOrCreateShell(): PersistentShell {
  if (persistentShell?.proc?.exitCode === null && persistentShell.ready) {
    return persistentShell;
  }
  // Kill old shell if it's dead
  if (persistentShell?.proc) {
    try { persistentShell.proc.kill(); } catch { /* ignore */ }
  }

  const proc = spawn('/bin/bash', ['--norc', '--noprofile'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // Start in a new process group
    env: {
      ...process.env,
      HOME: homedir(),
      PATH: process.env.PATH,
      TERM: 'xterm-256color',
      PS1: '',
      PS2: '',
    },
    cwd: homedir(),
  });

  persistentShell = { proc, busy: false, ready: true };

  proc.stdin!.on('error', (err: any) => {
    log.error(`Persistent shell stdin error: ${err.message}`);
    if (persistentShell?.proc === proc) {
      persistentShell = null;
    }
  });

  proc.on('exit', () => {
    if (persistentShell?.proc === proc) {
      persistentShell = null;
    }
  });

  return persistentShell;
}

function runInPersistentShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const shell = getOrCreateShell();

    if (shell.busy) {
      // Fall back to standalone spawn if shell is busy (concurrent calls)
      runStandaloneCommand(command, cwd, timeoutMs, onOutput, signal).then(resolve).catch(reject);
      return;
    }

    shell.busy = true;

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      shell.busy = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (shell.proc.stdout) shell.proc.stdout.removeListener('data', onStdout);
      if (shell.proc.stderr) shell.proc.stderr.removeListener('data', onStderr);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr });
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Kill the shell process group to ensure children are gone
      if (shell.proc.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-shell.proc.pid, 'SIGINT');
          } else {
            shell.proc.kill();
          }
        } catch { /* ignore */ }
      }
      // Force kill shell wrapper to ensure clean slate for next command
      try { process.kill(shell.proc.pid!); } catch { }
      persistentShell = null;
      reject(new Error('Command aborted by user'));
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler);
    }

    const onStdout = (data: Buffer) => {
      const text = data.toString();
      if (onOutput) onOutput(text.replace(SHELL_SENTINEL, ''));

      if (text.includes(SHELL_SENTINEL)) {
        const parts = text.split(SHELL_SENTINEL);
        stdout += parts[0] || '';
        finish();
      } else {
        stdout += text;
      }
    };

    const onStderr = (data: Buffer) => {
      const text = data.toString();
      if (onOutput) onOutput(text);
      stderr += text;
    };

    shell.proc.stdout!.on('data', onStdout);
    shell.proc.stderr!.on('data', onStderr);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          // Kill the shell process group on timeout
          if (shell.proc.pid) {
            try {
              if (process.platform !== 'win32') {
                process.kill(-shell.proc.pid, 'SIGINT');
              } else {
                shell.proc.kill();
              }
            } catch { /* ignore */ }
          }
          // Force new shell
          try { process.kill(shell.proc.pid!); } catch { }
          persistentShell = null;
          reject({ killed: true, stdout, stderr, message: `Timeout after ${timeoutMs}ms` });
        }
      }, timeoutMs);
    }

    // Send command + sentinel marker
    const fullCmd = `cd ${shellSingleQuote(cwd)} 2>/dev/null; ${command}\necho "${SHELL_SENTINEL}"\n`;
    try {
      shell.proc.stdin!.write(fullCmd);
    } catch (err: any) {
      shell.busy = false;
      reject(err);
    }
  });
}

function runStandaloneCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const proc = spawn('/bin/bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: process.env.PATH,
        TERM: 'xterm-256color',
      },
    });

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', abortHandler);
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (proc.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-proc.pid, 'SIGINT');
          } else {
            proc.kill();
          }
        } catch { /* ignore */ }
      }
      reject(new Error('Command aborted by user'));
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          if (proc.pid) {
            try {
              if (process.platform !== 'win32') {
                process.kill(-proc.pid, 'SIGINT');
              } else {
                proc.kill();
              }
            } catch { /* ignore */ }
          }
          reject({ killed: true, stdout, stderr, message: `Timeout after ${timeoutMs}ms` });
        }
      }, timeoutMs);
    }

    proc.stdout!.on('data', (data) => {
      const text = data.toString();
      if (onOutput) onOutput(text);
      stdout += text;
    });

    proc.stderr!.on('data', (data) => {
      const text = data.toString();
      if (onOutput) onOutput(text);
      stderr += text;
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject({ code, stdout, stderr, message: `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject({ stdout, stderr, message: err.message });
    });
  });
}

export interface LocalToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LocalToolExecutionContext {
  conversationId?: string;
  messageId?: string;
  llmMetrics?: LlmGenerationMetrics;
  autonomyMode?: AutonomyMode;
  capabilityTrustPolicy?: TrustPolicy;
  onDocProgress?: (event: DocProgressEvent) => void;
  onOutput?: (chunk: string) => void;
  onCapabilityEvent?: (event: CapabilityEvent) => void;
  signal?: AbortSignal;
}

export function resolveCapabilityTrustPolicy(context?: LocalToolExecutionContext): TrustPolicy {
  if (context?.capabilityTrustPolicy) return context.capabilityTrustPolicy;
  const mode = context?.autonomyMode || 'guided';
  if (mode === 'unrestricted') return 'best_effort';
  if (mode === 'safe') return 'strict_verified';
  return 'verified_fallback';
}

export const LOCAL_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  {
    name: 'shell_exec',
    description:
      'Execute a shell command on the local system. Has full access to filesystem, network, installed programs, and system utilities. Can launch GUI desktop applications (use & to background them). NEVER use this to open URLs — use browser_navigate instead. URLs opened via xdg-open/firefox/chrome will be blocked.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (bash syntax).',
        },
        working_directory: {
          type: 'string',
          description: 'Optional working directory. Defaults to user home.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds. Default 30. Use 0 for no timeout.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description:
      'Read file contents. For large files, returns first/last sections with line count. Use startLine/endLine to read specific sections.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path.' },
        max_lines: { type: 'number', description: 'Optional line count cap.' },
        offset: { type: 'number', description: 'Optional starting line offset (0-based).' },
        startLine: { type: 'number', description: 'Start line (1-indexed, optional). Use to read specific sections of large files.' },
        endLine: { type: 'number', description: 'End line (1-indexed, inclusive, optional).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description:
      'Write content to a file. Creates file and parent directories when missing. Supports overwrite and append.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Content to write.' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Write mode. Defaults to overwrite.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description:
      'Targeted find-and-replace edit. old_string must appear exactly once in the file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        old_string: { type: 'string', description: 'Exact string to replace (must be unique).' },
        new_string: { type: 'string', description: 'Replacement string.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'directory_tree',
    description: 'List directory contents as a tree with configurable depth.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to home.' },
        depth: { type: 'number', description: 'Max recursion depth. Defaults to 2.' },
        show_hidden: { type: 'boolean', description: 'Show dotfiles. Defaults to false.' },
        ignore_patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names to ignore.',
        },
      },
    },
  },
  {
    name: 'process_manager',
    description: 'Manage processes: list, find, kill, or inspect by PID.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'find', 'kill', 'info'],
          description: 'Process action to perform.',
        },
        query: {
          type: 'string',
          description: 'Search term for find, PID string for kill/info.',
        },
        signal: {
          type: 'string',
          description: 'Signal for kill action (default SIGTERM).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'create_document',
    description:
      'Create a downloadable document file. Use this when the user asks to generate a document, report, spreadsheet, or any file they can download. Saves to ~/Documents/Clawdia/. For simple text output or code files, prefer file_write instead.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename with extension (e.g. "report.docx", "data.xlsx", "notes.pdf").',
        },
        format: {
          type: 'string',
          enum: ['docx', 'pdf', 'xlsx', 'txt', 'md', 'csv', 'html', 'json'],
          description: 'Output format. Must match the filename extension.',
        },
        content: {
          type: 'string',
          description: 'Document content. For docx/pdf: use markdown formatting (# headings, **bold**, *italic*, - bullets). For xlsx: use CSV rows or provide structured_data. For txt/md/csv/html/json: raw content.',
        },
        structured_data: {
          type: 'array',
          description: 'Optional structured data for xlsx — array of objects [{col: val}] or array of arrays [[header1, header2], [val1, val2]].',
        },
        title: {
          type: 'string',
          description: 'Optional document title (displayed as header in docx/pdf).',
        },
      },
      required: ['filename', 'format', 'content'],
    },
  },
  {
    name: 'delegate_research',
    description: 'Delegate a focused research task (Topic + Angle) to a specialized sub-agent ("co-worker"). The sub-agent will perform searches and summarize findings. Use this to parallelize research on different aspects of a topic.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The main topic to research.' },
        angle: { type: 'string', description: 'The specific sub-topic or angle to focus on.' },
      },
      required: ['topic', 'angle'],
    },
  },
];

export async function executeLocalTool(
  toolName: string,
  input: any,
  context?: LocalToolExecutionContext,
): Promise<string> {
  switch (toolName) {
    case 'shell_exec':
      return toolShellExec(input, context);
    case 'file_read':
      return toolFileRead(input);
    case 'file_write':
      return toolFileWrite(input, context);
    case 'file_edit':
      return toolFileEdit(input, context);
    case 'directory_tree':
      return toolDirectoryTree(input);
    case 'process_manager':
      return toolProcessManager(input);
    case 'create_document':
      return toolCreateDocument(input, context);
    case 'delegate_research':
      return toolDelegateResearch(input);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

/**
 * Block commands that would open a URL in the system browser.
 * Matches: xdg-open <url>, firefox <url>, google-chrome <url>, open <url> (macOS), etc.
 * Also blocks CLIs known to auto-open browsers (vercel, netlify, gh auth login, npm login, etc.)
 * unless BROWSER=none is set.
 */
const BROWSER_OPEN_RE = /(?:^|\s|&&|\|\||;)\s*(?:xdg-open|sensible-browser|gnome-open|kde-open|x-www-browser)\s+https?:\/\//i;
const BROWSER_BIN_URL_RE = /(?:^|\s|&&|\|\||;)\s*(?:firefox|google-chrome(?:-stable)?|chromium(?:-browser)?|brave-browser|microsoft-edge|opera|safari|open)\s+https?:\/\//i;
// CLIs that auto-open a system browser for OAuth/verification unless we suppress it
const BROWSER_SPAWNING_CMDS = /(?:^|\s|&&|\|\||;)\s*(?:vercel(?:\s|$)|netlify\s+(?:login|init|deploy)|gh\s+auth\s+login|npm\s+login|npm\s+adduser|npx\s+vercel)/i;

function sanitizeShellCommand(command: string): string {
  // Inject BROWSER=none prefix for CLIs that auto-open browsers.
  // This env var is respected by xdg-open, vercel, netlify, gh, etc.
  if (BROWSER_SPAWNING_CMDS.test(command)) {
    return `BROWSER=none ${command}`;
  }
  return command;
}

/** Map common exit codes + stderr patterns to actionable hints for the LLM. */
function diagnoseExitCode(code: number, output: string, command: string): string | null {
  const lower = output.toLowerCase();
  // Exit 127: command not found
  if (code === 127) {
    const cmd = command.trim().split(/\s+/)[0];
    return `"${cmd}" is not installed. Install it first (e.g. sudo apt-get install ${cmd}) or use a different approach.`;
  }
  // Exit 126: permission denied on executable
  if (code === 126) return 'Permission denied — the file is not executable. Try chmod +x or run with bash.';
  // Exit 1: generic — narrow with stderr patterns
  if (code === 1) {
    if (lower.includes('permission denied')) return 'Permission denied. Try with sudo or check file ownership.';
    if (lower.includes('no such file or directory')) return 'Path does not exist. Verify the path with ls first.';
    if (lower.includes('connection refused') || lower.includes('econnrefused')) return 'Connection refused — the service may not be running. Check with systemctl or start the service.';
    if (lower.includes('already exists')) return 'Resource already exists. Check current state before creating/overwriting.';
    if (lower.includes('not found') && lower.includes('npm')) return 'npm package or script not found. Check package.json scripts with cat package.json.';
  }
  // Exit 2: misuse of shell command
  if (code === 2) {
    if (lower.includes('no such file')) return 'File not found. Verify the path exists.';
    return 'Invalid command syntax or missing argument. Check the command usage.';
  }
  // Exit 128+N: killed by signal
  if (code > 128 && code <= 192) {
    const sig = code - 128;
    if (sig === 9) return 'Process was killed (SIGKILL) — likely OOM or manual kill.';
    if (sig === 15) return 'Process was terminated (SIGTERM).';
    if (sig === 11) return 'Segmentation fault (SIGSEGV) — the program crashed.';
  }
  // Network tool specific
  if (lower.includes('could not resolve host') || lower.includes('err_name_not_resolved'))
    return 'Domain not found. Check the URL spelling.';
  if (lower.includes('ssl') && (lower.includes('error') || lower.includes('certificate')))
    return 'SSL/TLS error. The site may have an invalid certificate or require a different protocol.';
  if (lower.includes('401') || lower.includes('unauthorized'))
    return 'Authentication required. You may need to log in or provide credentials.';
  if (lower.includes('403') || lower.includes('forbidden'))
    return 'Access forbidden. The server rejected the request — try a different approach or check permissions.';
  if (lower.includes('404') || lower.includes('not found'))
    return 'Resource not found (404). Verify the URL or path is correct.';
  return null;
}

function isExternalBrowserCommand(command: string): string | null {
  if (BROWSER_OPEN_RE.test(command)) {
    return 'Use browser_navigate instead of xdg-open for URLs. All browsing must stay inside the embedded browser.';
  }
  if (BROWSER_BIN_URL_RE.test(command)) {
    return 'Do not open URLs in external browsers (firefox, chrome, etc.). Use browser_navigate to open URLs inside the app.';
  }
  return null;
}

export async function toolShellExec(input: {
  command: string;
  working_directory?: string;
  timeout?: number;
}, context?: LocalToolExecutionContext): Promise<string> {
  const rawCommand = String(input?.command || '');
  const cwd = input?.working_directory || homedir();
  const timeoutMs = input?.timeout === 0 ? 0 : (input?.timeout || 30) * 1000;

  const emitCapability = (event: CapabilityEvent): void => {
    try {
      if (!event.eventName) {
        event.eventName = toCapabilityLifecycleEventName(event.type);
      }
      context?.onCapabilityEvent?.(event);
    } catch {
      // Ignore capability event callback errors.
    }
  };

  // Block commands that would open a URL in an external browser
  const browserBlock = isExternalBrowserCommand(rawCommand);
  if (browserBlock) {
    emitCapability({
      type: 'policy_blocked',
      message: browserBlock,
      command: rawCommand,
    });
    return `[Blocked] ${browserBlock}`;
  }

  const policyDecision = evaluateCommandPolicy(rawCommand, {
    cwd,
    allowedRoots: [homedir(), '/tmp'],
  });

  if (policyDecision.action === 'deny') {
    emitCapability({
      type: 'policy_blocked',
      message: policyDecision.reason,
      detail: policyDecision.detail,
      command: rawCommand,
    });
    return `[Blocked by policy] ${policyDecision.reason}`;
  }

  let command = rawCommand;
  if (policyDecision.action === 'rewrite' && policyDecision.command) {
    command = policyDecision.command;
    emitCapability({
      type: 'policy_rewrite',
      message: policyDecision.reason,
      detail: policyDecision.detail,
      command,
    });
  }

  // Sanitize commands that spawn browsers for OAuth (add BROWSER=none)
  const sanitizedCommand = sanitizeShellCommand(command);
  if (sanitizedCommand !== command) {
    emitCapability({
      type: 'policy_rewrite',
      message: 'Applied browser-safe rewrite (BROWSER=none).',
      command: sanitizedCommand,
    });
  }
  command = sanitizedCommand;

  let preflightNote = '';

  const resolution = await resolveCommandCapabilities(command);
  if (resolution.missingCapabilities.length > 0) {
    const capabilityFlags = getCapabilityPlatformFlags();
    const trustPolicy = resolveCapabilityTrustPolicy(context);

    emitCapability({
      type: 'capability_missing',
      message: `Missing capabilities detected: ${resolution.missingCapabilities.map((c) => c.id).join(', ')}`,
      command,
    });

    if (!capabilityFlags.installOrchestrator) {
      emitCapability({
        type: 'policy_blocked',
        message: 'Install orchestrator disabled by rollout policy.',
        detail: `cohort=${capabilityFlags.cohort}`,
        command,
      });
      preflightNote = '[Capability install skipped] install orchestrator is disabled by feature flags.';
    } else {
    emitCapability({
      type: 'policy_rewrite',
      message: `Capability install policy: ${trustPolicy}`,
      detail: 'Autonomy-aware capability trust policy applied.',
    });

    const installResult = await ensureCommandCapabilities(command, {
      trustPolicy,
      onEvent: emitCapability,
    });

    if (!installResult.ok) {
      const failed = installResult.failed.map((f) => f.capabilityId).join(', ');
      preflightNote = `[Capability install warning] Could not auto-install: ${failed || 'unknown'}`;
    }
    }
  }

  try {
    const { stdout, stderr } = await runInPersistentShell(
      command,
      cwd,
      timeoutMs,
      context?.onOutput,
      context?.signal,
    );

    let output = '';
    if (stdout) output += stdout;
    if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;
    if (!output.trim()) output = '[Command completed with no output]';

    const maxOutput = 5000;
    if (output.length > maxOutput) {
      const head = output.slice(0, 2000);
      const tail = output.slice(-2000);
      const lineCount = (output.match(/\n/g) || []).length;
      output = `${head}\n\n[... ${output.length - 4000} chars / ~${lineCount} lines truncated ...]\n\n${tail}\n\n[Output truncated — ${output.length} total chars. Redirect to a file for full results.]`;
    }

    if (preflightNote) {
      output += `\n\n${preflightNote}`;
    }

    return output;
  } catch (err: any) {
    let output = '';
    if (err?.stdout) output += err.stdout;
    if (err?.stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + err.stderr;

    if (err?.killed) {
      output += `\n\n[Process killed - timeout after ${input?.timeout || 30}s. Hint: increase timeout param or simplify the command]`;
    } else if (typeof err?.code !== 'undefined') {
      output += `\n\n[Exit code: ${err.code}]`;
      // Add actionable hints for common exit codes
      const hint = diagnoseExitCode(err.code, output, rawCommand);
      if (hint) output += `\n[Hint: ${hint}]`;
    } else {
      output += `\n\n[Error: ${err?.message || 'unknown error'}]`;
    }

    if (preflightNote) {
      output += `\n${preflightNote}`;
    }

    return output || `[Error: ${err?.message || 'unknown error'}]`;
  }
}

const MAX_FILE_READ_CHARS = 8000; // ~2000 tokens — prevents 22K char bombs

async function toolFileRead(input: {
  path: string;
  max_lines?: number;
  offset?: number;
  startLine?: number;
  endLine?: number;
}): Promise<string> {
  const filePath = resolvePath(String(input?.path || ''));
  if (!filePath) return '[Error: path is required]';

  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      return `[File is ${formatBytes(stat.size)} - too large to read directly. Use shell_exec with head/tail for partial reads.]`;
    }

    const content = await fs.readFile(filePath, 'utf-8');
    if (content.includes('\ufffd')) {
      return `[Binary file detected: ${filePath}. Size: ${formatBytes(stat.size)}. Use shell_exec with xxd or file to inspect.]`;
    }

    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // startLine/endLine take precedence (1-indexed, inclusive)
    if (input?.startLine && input.startLine > 0) {
      const start = input.startLine - 1; // convert to 0-indexed
      const end = input?.endLine ? Math.min(input.endLine, totalLines) : totalLines;
      const selected = allLines.slice(start, end);
      return `${selected.join('\n')}\n\n[Showing lines ${start + 1}-${start + selected.length} of ${totalLines} total]`;
    }

    // Legacy offset/max_lines support
    const offset = Math.max(0, input?.offset || 0);
    const maxLines = input?.max_lines && input.max_lines > 0 ? input.max_lines : totalLines;
    const selected = allLines.slice(offset, offset + maxLines);
    let output = selected.join('\n');

    if (offset > 0 || maxLines < totalLines) {
      output += `\n\n[Showing lines ${offset + 1}-${offset + selected.length} of ${totalLines} total]`;
    }

    // Truncate large outputs — show head + tail with omission notice
    if (output.length > MAX_FILE_READ_CHARS) {
      const headLines = allLines.slice(0, 100).join('\n');
      const tailLines = allLines.slice(-50).join('\n');
      output = `${headLines}\n\n[... ${totalLines - 150} lines omitted (${content.length} total chars) — use file_read with startLine/endLine to see specific sections ...]\n\n${tailLines}`;
    }

    return output;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return `[File not found: ${filePath}]`;
    if (err?.code === 'EACCES') return `[Permission denied: ${filePath}]`;
    if (err?.code === 'EISDIR') return `[${filePath} is a directory. Use directory_tree instead.]`;
    return `[Error reading ${filePath}: ${err?.message || 'unknown error'}]`;
  }
}

function shouldCreateCheckpointForPath(filePath: string): boolean {
  // Temporary scratch paths are explicitly exempt from checkpointing.
  return !filePath.startsWith('/tmp/');
}

function emitCapabilityEvent(
  context: LocalToolExecutionContext | undefined,
  event: CapabilityEvent,
): void {
  try {
    if (!event.eventName) {
      event.eventName = toCapabilityLifecycleEventName(event.type);
    }
    context?.onCapabilityEvent?.(event);
  } catch {
    // Ignore callback failures.
  }
}

async function createCheckpointForWrite(
  filePath: string,
  context: LocalToolExecutionContext | undefined,
): Promise<FileCheckpoint | null> {
  const capabilityFlags = getCapabilityPlatformFlags();
  if (!capabilityFlags.checkpointRollback) return null;
  if (!shouldCreateCheckpointForPath(filePath)) return null;

  const checkpoint = await createFileCheckpoint(filePath);
  emitCapabilityEvent(context, {
    type: 'checkpoint_created',
    capabilityId: 'file-checkpoint',
    message: `Checkpoint created for ${filePath}`,
    detail: `checkpoint:${checkpoint.id}`,
  });
  return checkpoint;
}

async function rollbackCheckpoint(
  checkpoint: FileCheckpoint | null,
  filePath: string,
  context: LocalToolExecutionContext | undefined,
): Promise<string> {
  if (!checkpoint) return '';
  const restored = await restoreFileCheckpoint(checkpoint);
  await disposeFileCheckpoint(checkpoint);
  if (restored.ok) {
    emitCapabilityEvent(context, {
      type: 'rollback_applied',
      capabilityId: 'file-checkpoint',
      message: `Rollback applied for ${filePath}`,
      detail: restored.detail,
    });
    return ` Rollback applied.`;
  }

  emitCapabilityEvent(context, {
    type: 'rollback_failed',
    capabilityId: 'file-checkpoint',
    message: `Rollback failed for ${filePath}`,
    detail: restored.detail,
  });
  return ` Rollback failed: ${restored.detail}.`;
}

async function toolFileWrite(input: {
  path: string;
  content: string;
  mode?: 'overwrite' | 'append';
}, context?: LocalToolExecutionContext): Promise<string> {
  const filePath = resolvePath(String(input?.path || ''));
  if (!filePath) return '[Error: path is required]';
  const content = String(input?.content ?? '');
  const mode = input?.mode || 'overwrite';
  let checkpoint: FileCheckpoint | null = null;

  try {
    checkpoint = await createCheckpointForWrite(filePath, context);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (mode === 'append') {
      await fs.appendFile(filePath, content);
      invalidateDirTreeCache(filePath);
      if (checkpoint) await disposeFileCheckpoint(checkpoint);
      return `[Appended ${content.length} characters to ${filePath}]`;
    }
    await fs.writeFile(filePath, content);
    invalidateDirTreeCache(filePath);
    if (checkpoint) await disposeFileCheckpoint(checkpoint);
    return `[Wrote ${content.length} characters to ${filePath}]`;
  } catch (err: any) {
    const rollbackNote = await rollbackCheckpoint(checkpoint, filePath, context);
    return `[Error writing ${filePath}: ${err?.message || 'unknown error'}]${rollbackNote}`;
  }
}

async function toolFileEdit(input: {
  path: string;
  old_string: string;
  new_string: string;
}, context?: LocalToolExecutionContext): Promise<string> {
  const filePath = resolvePath(String(input?.path || ''));
  if (!filePath) return '[Error: path is required]';
  let checkpoint: FileCheckpoint | null = null;

  try {
    checkpoint = await createCheckpointForWrite(filePath, context);
    const content = await fs.readFile(filePath, 'utf-8');
    const oldString = String(input?.old_string ?? '');
    const newString = String(input?.new_string ?? '');
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      if (checkpoint) await disposeFileCheckpoint(checkpoint);
      return `[Error: "${short(oldString, 80)}" not found in ${filePath}]`;
    }
    if (occurrences > 1) {
      if (checkpoint) await disposeFileCheckpoint(checkpoint);
      return `[Error: "${short(oldString, 80)}" found ${occurrences} times in ${filePath}. Must be unique.]`;
    }

    const nextContent = content.replace(oldString, newString);
    await fs.writeFile(filePath, nextContent);
    invalidateDirTreeCache(filePath);
    if (checkpoint) await disposeFileCheckpoint(checkpoint);
    return `[Replaced in ${filePath}. File is now ${nextContent.split('\n').length} lines.]`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      if (checkpoint) await disposeFileCheckpoint(checkpoint);
      return `[File not found: ${filePath}]`;
    }
    const rollbackNote = await rollbackCheckpoint(checkpoint, filePath, context);
    return `[Error editing ${filePath}: ${err?.message || 'unknown error'}]${rollbackNote}`;
  }
}

async function toolDirectoryTree(input: {
  path?: string;
  depth?: number;
  show_hidden?: boolean;
  ignore_patterns?: string[];
}): Promise<string> {
  const dirPath = resolvePath(input?.path || '~');
  const maxDepth = input?.depth ?? 2;
  const showHidden = input?.show_hidden ?? false;
  const ignorePatterns = input?.ignore_patterns ?? [
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    '.cache',
    'dist',
    'build',
    '.next',
    'coverage',
    '.tox',
  ];

  // Check cache
  const cacheKey = dirTreeCacheKey(dirPath, maxDepth, showHidden, ignorePatterns);
  const cached = dirTreeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DIR_TREE_CACHE_TTL_MS) {
    return cached.result;
  }

  const lines: string[] = [dirPath];
  let fileCount = 0;
  let dirCount = 0;
  let truncated = false;
  const maxEntries = 500;

  const walk = async (currentPath: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maxDepth || truncated) return;

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries = entries.filter((entry) => {
      if (!showHidden && entry.name.startsWith('.')) return false;
      if (ignorePatterns.includes(entry.name)) return false;
      return true;
    });

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i += 1) {
      if (fileCount + dirCount > maxEntries) {
        lines.push(`${prefix}... (truncated, too many entries)`);
        truncated = true;
        return;
      }

      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDirectory()) {
        dirCount += 1;
        lines.push(`${prefix}${connector}${entry.name}/`);
        await walk(path.join(currentPath, entry.name), prefix + childPrefix, depth + 1);
      } else {
        fileCount += 1;
        try {
          const stat = await fs.stat(path.join(currentPath, entry.name));
          const size = stat.size > 1024 ? ` (${formatBytes(stat.size)})` : '';
          lines.push(`${prefix}${connector}${entry.name}${size}`);
        } catch {
          lines.push(`${prefix}${connector}${entry.name}`);
        }
      }
    }
  };

  await walk(dirPath, '', 0);
  lines.push(`\n${dirCount} directories, ${fileCount} files`);

  const result = lines.join('\n');
  dirTreeCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

async function toolProcessManager(input: {
  action: 'list' | 'find' | 'kill' | 'info';
  query?: string;
  signal?: string;
}): Promise<string> {
  switch (input?.action) {
    case 'list': {
      const { stdout } = await execAsync('ps aux --sort=-%cpu | head -20', { timeout: 5000 });
      return stdout;
    }

    case 'find': {
      if (!input?.query) return '[Error: query required for find action]';
      const escaped = shellSingleQuote(input.query);
      try {
        const { stdout } = await execAsync(`ps aux | grep -i ${escaped} | grep -v grep`, {
          timeout: 5000,
        });
        return stdout || `[No processes found matching "${input.query}"]`;
      } catch {
        return `[No processes found matching "${input.query}"]`;
      }
    }

    case 'kill': {
      if (!input?.query) return '[Error: PID required for kill action]';
      const pid = Number.parseInt(input.query, 10);
      if (Number.isNaN(pid)) return `[Error: invalid PID "${input.query}"]`;

      // Self-protection: never kill Clawdia's own process tree
      const myPid = process.pid;
      const myPpid = process.ppid;
      if (pid === myPid || pid === myPpid) {
        return `[BLOCKED: PID ${pid} belongs to Clawdia. Refusing to self-terminate.]`;
      }
      // Also check if the target is a parent/ancestor (concurrently, electron, node)
      try {
        const { stdout: cmdline } = await execAsync(`ps -p ${pid} -o command= 2>/dev/null`, { timeout: 3000 });
        const cmd = (cmdline || '').toLowerCase();
        if (cmd.includes('electron') && cmd.includes('clawdia') ||
          cmd.includes('concurrently') ||
          (cmd.includes('node') && cmd.includes('clawdia'))) {
          return `[BLOCKED: PID ${pid} appears to be part of the Clawdia process tree. Refusing to kill.]`;
        }
      } catch {
        // Can't inspect — proceed but with direct PID guard already done
      }

      const signal = (input.signal || 'SIGTERM') as NodeJS.Signals;
      try {
        process.kill(pid, signal);
        return `[Sent ${signal} to PID ${pid}]`;
      } catch (err: any) {
        return `[Error killing PID ${pid}: ${err?.message || 'unknown error'}]`;
      }
    }

    case 'info': {
      if (!input?.query) return '[Error: PID required for info action]';
      const pid = Number.parseInt(input.query, 10);
      if (Number.isNaN(pid)) return `[Error: invalid PID "${input.query}"]`;
      try {
        const { stdout } = await execAsync(
          `ps -p ${pid} -o pid,ppid,user,%cpu,%mem,vsz,rss,tty,stat,start,time,command --no-headers`,
          { timeout: 5000 }
        );
        return stdout || `[Process ${pid} not found]`;
      } catch {
        return `[Process ${pid} not found]`;
      }
    }

    default:
      return `[Unknown action: ${String(input?.action || '')}]`;
  }
}

async function toolCreateDocument(input: {
  filename: string;
  format: string;
  content: string;
  structured_data?: unknown;
  title?: string;
}, context?: LocalToolExecutionContext): Promise<string> {
  const filename = String(input?.filename || 'document.txt');
  const format = String(input?.format || 'txt');
  const content = String(input?.content ?? '');

  try {
    const result = await createDocument(filename, format, content, {
      structuredData: input?.structured_data,
      title: input?.title,
      conversationId: context?.conversationId,
      messageId: context?.messageId,
      llmMetrics: context?.llmMetrics,
      onProgress: context?.onDocProgress,
    });
    // Return JSON with __clawdia_document__ marker so tool-loop can detect it
    return JSON.stringify({
      __clawdia_document__: true,
      filePath: result.filePath,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      format: result.format,
      timing: result.timing,
    });
  } catch (err: any) {
    return `[Error creating document: ${err?.message || 'unknown error'}]`;
  }
}

function resolvePath(inputPath: string): string {
  if (!inputPath) return '';
  if (inputPath.startsWith('~')) {
    return path.join(homedir(), inputPath.slice(1));
  }
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.join(homedir(), inputPath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function short(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function toolDelegateResearch(input: {
  topic?: string;
  angle?: string;
}): Promise<string> {
  const { delegateResearch } = await import('../llm/agents/research-agent');
  return delegateResearch(String(input?.topic || ''), String(input?.angle || ''));
}
