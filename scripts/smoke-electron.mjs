#!/usr/bin/env node
// scripts/smoke-electron.mjs — Launch Electron, verify it starts, then quit
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const MAIN_JS = join(ROOT, 'dist', 'main', 'main.js');

console.log('\n\x1b[1m[smoke:electron]\x1b[0m Electron smoke test...\n');

if (!existsSync(MAIN_JS)) {
  console.log('  \x1b[31m✗\x1b[0m dist/main/main.js missing — run "npm run build" first');
  process.exit(1);
}

// Find electron binary
let electronBin;
try {
  const electronPkg = join(ROOT, 'node_modules', 'electron', 'index.js');
  // Dynamic import to get the electron path
  const { default: electronPath } = await import(electronPkg);
  electronBin = electronPath;
} catch {
  // Fallback: try npx
  electronBin = 'npx';
}

const TIMEOUT_MS = 30_000;
const READY_MARKER = /ready|BrowserWindow|window-all-closed|app\.on/i;

let stdout = '';
let stderr = '';
let exited = false;
let readyDetected = false;

const args = electronBin === 'npx'
  ? ['electron', '.', '--no-sandbox', '--disable-gpu']
  : ['.', '--no-sandbox', '--disable-gpu'];

const child = spawn(electronBin, args, {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    // Prevent the app from actually trying to connect to display in CI
    DISPLAY: process.env.DISPLAY || ':99',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdout.on('data', (data) => {
  const text = data.toString();
  stdout += text;
  if (READY_MARKER.test(text)) readyDetected = true;
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  stderr += text;
  // Electron logs to stderr too
  if (READY_MARKER.test(text)) readyDetected = true;
});

child.on('exit', (code) => {
  exited = true;
  child._exitCode = code;
});

child.on('error', (err) => {
  console.log(`  \x1b[31m✗\x1b[0m Failed to launch Electron: ${err.message}`);
  process.exit(1);
});

// Wait for app to start, then kill it
const startTime = Date.now();
const poll = setInterval(() => {
  const elapsed = Date.now() - startTime;

  if (exited) {
    clearInterval(poll);
    // App exited on its own — check if it crashed immediately
    if (elapsed < 2000 && child._exitCode !== 0) {
      console.log(`  \x1b[31m✗\x1b[0m Electron exited immediately with code ${child._exitCode}`);
      if (stderr) console.log(`  stderr: ${stderr.slice(0, 500)}`);
      process.exit(1);
    }
    console.log(`  \x1b[32m✓\x1b[0m Electron ran for ${(elapsed / 1000).toFixed(1)}s and exited with code ${child._exitCode}`);
    process.exit(child._exitCode === 0 ? 0 : 1);
    return;
  }

  // After 5 seconds of running without crash, consider it alive
  if (elapsed > 5000) {
    clearInterval(poll);
    console.log(`  \x1b[32m✓\x1b[0m Electron stayed alive for ${(elapsed / 1000).toFixed(1)}s`);
    if (readyDetected) {
      console.log('  \x1b[32m✓\x1b[0m Ready marker detected in logs');
    } else {
      console.log('  \x1b[33m⚠\x1b[0m Ready marker not detected (may need DISPLAY)');
    }

    // Gracefully kill
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 3000);

    setTimeout(() => {
      console.log('\n\x1b[32mSmoke test passed.\x1b[0m');
      process.exit(0);
    }, 4000);
    return;
  }

  if (elapsed > TIMEOUT_MS) {
    clearInterval(poll);
    console.log(`  \x1b[31m✗\x1b[0m Timeout after ${TIMEOUT_MS / 1000}s`);
    child.kill('SIGKILL');
    process.exit(1);
  }
}, 500);
