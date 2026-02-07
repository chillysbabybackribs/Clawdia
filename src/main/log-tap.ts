/**
 * Log Tap — Intercepts all stdout/stderr from the Electron main process
 * and mirrors them to ~/.clawdia-live.log (ring buffer, max 500 lines).
 * 
 * Import this ONCE at the top of main.ts, before anything else:
 *   import './log-tap';
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const LOG_PATH = path.join(homedir(), '.clawdia-live.log');
const MAX_LINES = 500;
const TRIM_TO = 300;

// Wipe on startup
try { fs.writeFileSync(LOG_PATH, `[LOG-TAP] Started at ${new Date().toISOString()}\n`); } catch { /* ignore */ }

let lineCount = 1;

function appendToLog(data: string): void {
  try {
    // Trim if over max
    if (lineCount >= MAX_LINES) {
      const existing = fs.readFileSync(LOG_PATH, 'utf-8').split('\n');
      const keep = existing.slice(-TRIM_TO).join('\n') + '\n';
      fs.writeFileSync(LOG_PATH, keep);
      lineCount = TRIM_TO;
    }
    fs.appendFileSync(LOG_PATH, data);
    // Count newlines in data
    const newlines = (data.match(/\n/g) || []).length;
    lineCount += newlines;
  } catch { /* ignore */ }
}

// Guard against recursive EPIPE death spiral:
// stderr.write EPIPE → uncaughtException → logger → stderr.write EPIPE → ∞
let insideWrite = false;

// Monkey-patch stdout.write and stderr.write
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = function (chunk: any, ...args: any[]): boolean {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  appendToLog(str);
  if (insideWrite) return true;
  insideWrite = true;
  try { return origStdoutWrite(chunk, ...args); } catch { return true; } finally { insideWrite = false; }
} as any;

process.stderr.write = function (chunk: any, ...args: any[]): boolean {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  appendToLog(`[STDERR] ${str}`);
  if (insideWrite) return true;
  insideWrite = true;
  try { return origStderrWrite(chunk, ...args); } catch { return true; } finally { insideWrite = false; }
} as any;

// Also capture uncaught exceptions
process.on('uncaughtException', (err) => {
  // Silently swallow EPIPE — the pipe is dead, nothing to do
  if (err && (err as any).code === 'EPIPE') {
    appendToLog(`[UNCAUGHT] EPIPE (suppressed)\n`);
    return;
  }
  appendToLog(`[UNCAUGHT] ${err.stack || err.message}\n`);
});

process.on('unhandledRejection', (reason) => {
  appendToLog(`[UNHANDLED-REJECTION] ${String(reason)}\n`);
});

console.log('[LOG-TAP] Log tap active — writing to ~/.clawdia-live.log');
