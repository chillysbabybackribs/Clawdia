import { exec } from 'child_process';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { createDocument, type LlmGenerationMetrics } from '../documents/creator';
import type { DocProgressEvent } from '../../shared/types';

const execAsync = promisify(exec);

export interface LocalToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LocalToolExecutionContext {
  conversationId?: string;
  messageId?: string;
  llmMetrics?: LlmGenerationMetrics;
  onDocProgress?: (event: DocProgressEvent) => void;
}

export const LOCAL_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  {
    name: 'shell_exec',
    description:
      'Execute a shell command on the local system. Has full access to filesystem, network, installed programs, and system utilities.',
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
];

export async function executeLocalTool(
  toolName: string,
  input: any,
  context?: LocalToolExecutionContext,
): Promise<string> {
  switch (toolName) {
    case 'shell_exec':
      return toolShellExec(input);
    case 'file_read':
      return toolFileRead(input);
    case 'file_write':
      return toolFileWrite(input);
    case 'file_edit':
      return toolFileEdit(input);
    case 'directory_tree':
      return toolDirectoryTree(input);
    case 'process_manager':
      return toolProcessManager(input);
    case 'create_document':
      return toolCreateDocument(input, context);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

async function toolShellExec(input: {
  command: string;
  working_directory?: string;
  timeout?: number;
}): Promise<string> {
  const cwd = input?.working_directory || homedir();
  const timeoutMs = input?.timeout === 0 ? 0 : (input?.timeout || 30) * 1000;

  try {
    const { stdout, stderr } = await execAsync(String(input?.command || ''), {
      cwd,
      timeout: timeoutMs || undefined,
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/bash',
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: process.env.PATH,
        TERM: 'xterm-256color',
      },
    });

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

    return output;
  } catch (err: any) {
    let output = '';
    if (err?.stdout) output += err.stdout;
    if (err?.stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + err.stderr;

    if (err?.killed) {
      output += `\n\n[Process killed - timeout after ${input?.timeout || 30}s]`;
    } else if (typeof err?.code !== 'undefined') {
      output += `\n\n[Exit code: ${err.code}]`;
    } else {
      output += `\n\n[Error: ${err?.message || 'unknown error'}]`;
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

async function toolFileWrite(input: {
  path: string;
  content: string;
  mode?: 'overwrite' | 'append';
}): Promise<string> {
  const filePath = resolvePath(String(input?.path || ''));
  if (!filePath) return '[Error: path is required]';
  const content = String(input?.content ?? '');
  const mode = input?.mode || 'overwrite';

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (mode === 'append') {
      await fs.appendFile(filePath, content);
      return `[Appended ${content.length} characters to ${filePath}]`;
    }
    await fs.writeFile(filePath, content);
    return `[Wrote ${content.length} characters to ${filePath}]`;
  } catch (err: any) {
    return `[Error writing ${filePath}: ${err?.message || 'unknown error'}]`;
  }
}

async function toolFileEdit(input: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<string> {
  const filePath = resolvePath(String(input?.path || ''));
  if (!filePath) return '[Error: path is required]';

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const oldString = String(input?.old_string ?? '');
    const newString = String(input?.new_string ?? '');
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return `[Error: "${short(oldString, 80)}" not found in ${filePath}]`;
    }
    if (occurrences > 1) {
      return `[Error: "${short(oldString, 80)}" found ${occurrences} times in ${filePath}. Must be unique.]`;
    }

    const nextContent = content.replace(oldString, newString);
    await fs.writeFile(filePath, nextContent);
    return `[Replaced in ${filePath}. File is now ${nextContent.split('\n').length} lines.]`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return `[File not found: ${filePath}]`;
    return `[Error editing ${filePath}: ${err?.message || 'unknown error'}]`;
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

  return lines.join('\n');
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
