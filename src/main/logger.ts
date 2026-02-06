import { app } from 'electron';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEY_PATTERN = /^(key|apiKey|api_key|token|secret|password|authorization|x-api-key)$/i;
const MESSAGE_KEY_PATTERN = /(message|prompt|content|response|text)/i;
const TOOL_IO_KEY_PATTERN = /(input|output|tool|result|payload|stdout|stderr)/i;

const API_KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /serper_[A-Za-z0-9_-]{12,}/gi,
  /brave_[A-Za-z0-9_-]{12,}/gi,
  /serpapi_[A-Za-z0-9_-]{12,}/gi,
  /bing_[A-Za-z0-9_-]{12,}/gi,
  /(?:x-api-key|authorization)\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];

function defaultLogLevel(): LogLevel {
  if (process.env.NODE_ENV === 'production') return 'info';
  try {
    return app?.isPackaged ? 'info' : 'debug';
  } catch {
    return 'debug';
  }
}

let currentLevel: LogLevel = defaultLogLevel();

export function setLogLevel(level: LogLevel): void {
  if (!(level in LEVEL_PRIORITY)) return;
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function redactionTag(value: string): string {
  if (value.length <= 4) return '[REDACTED]';
  return `[REDACTED:${value.slice(0, 4)}...]`;
}

function redactString(input: string): string {
  let out = input;
  for (const pattern of API_KEY_PATTERNS) {
    out = out.replace(pattern, (match) => redactionTag(match));
  }
  return out;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        const asString = typeof raw === 'string' ? raw : String(raw ?? '');
        out[key] = redactionTag(asString);
        continue;
      }
      out[key] = sanitizeValue(raw, seen);
    }
    return out;
  }

  return String(value);
}

export function sanitize(data: unknown): unknown {
  return sanitizeValue(data, new WeakSet<object>());
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [${value.length} chars]`;
}

function truncateByContext(value: unknown, level: LogLevel, keyHint?: string): unknown {
  if (level === 'debug') return value;

  if (typeof value === 'string') {
    const limit = keyHint && MESSAGE_KEY_PATTERN.test(keyHint)
      ? 200
      : keyHint && TOOL_IO_KEY_PATTERN.test(keyHint)
        ? 500
        : 500;
    return truncate(value, limit);
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateByContext(item, level, keyHint));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = truncateByContext(item, level, key);
    }
    return out;
  }

  return value;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeLine(level: LogLevel, line: string): void {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(moduleName: string): Logger {
  const shouldLog = (level: LogLevel): boolean => LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];

  const log = (level: LogLevel, message: string, args: unknown[]): void => {
    if (!shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const messageSanitized = redactString(message);
    const messageFormatted = level === 'debug' ? messageSanitized : truncate(messageSanitized, 200);

    const formattedArgs = args
      .map((arg) => truncateByContext(sanitize(arg), level))
      .map((arg) => safeStringify(arg))
      .join(' ');

    const line = formattedArgs
      ? `[${timestamp}] [${level.toUpperCase()}] [${moduleName}] ${messageFormatted} ${formattedArgs}`
      : `[${timestamp}] [${level.toUpperCase()}] [${moduleName}] ${messageFormatted}`;

    writeLine(level, line);
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, args),
    info: (message: string, ...args: unknown[]) => log('info', message, args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, args),
    error: (message: string, ...args: unknown[]) => log('error', message, args),
  };
}
