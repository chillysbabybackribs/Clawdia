#!/usr/bin/env node
// scripts/secrets-scan.mjs — Scan bundles for leaked secrets
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

let failures = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; }

console.log('\n\x1b[1m[secrets:scan]\x1b[0m Scanning for leaked secrets...\n');

// Patterns that should never appear in built output
const PATTERNS = [
  { name: 'Anthropic API key', regex: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: 'Serper API key literal', regex: /SERPER_API_KEY\s*[:=]\s*['"][^'"]{10,}['"]/ },
  { name: 'Anthropic key literal', regex: /ANTHROPIC_API_KEY\s*[:=]\s*['"][^'"]{10,}['"]/ },
  { name: 'Generic API key assignment', regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/i },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', regex: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'Private key block', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'Hardcoded password', regex: /(?:password|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

// Directories to scan
const SCAN_DIRS = [
  join(ROOT, 'dist'),
  join(ROOT, 'release'),
];

// File extensions to scan (skip binaries, images, videos)
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.json', '.yml', '.yaml', '.xml', '.txt', '.map']);
const SKIP_DIRS = new Set(['node_modules', 'linux-unpacked', 'squashfs-root', '.git']);

function walkDir(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      // Scan text files, plus anything without extension that's small enough
      if (TEXT_EXTS.has(ext) || (ext === '' && statSync(full).size < 1024 * 1024)) {
        results.push(full);
      }
    }
  }
  return results;
}

let scannedCount = 0;

for (const dir of SCAN_DIRS) {
  if (!existsSync(dir)) {
    console.log(`  \x1b[33m⚠\x1b[0m ${dir.replace(ROOT + '/', '')}/ not found — skipping`);
    continue;
  }

  const files = walkDir(dir);
  for (const file of files) {
    scannedCount++;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable
    }
    const rel = file.replace(ROOT + '/', '');
    for (const { name, regex } of PATTERNS) {
      if (regex.test(content)) {
        fail(`${rel} — contains ${name}`);
      }
    }
  }
}

pass(`Scanned ${scannedCount} files across ${SCAN_DIRS.map(d => d.replace(ROOT + '/', '')).join(', ')}`);

// ── Summary ──
console.log('');
if (failures > 0) {
  console.log(`\x1b[31m${failures} secret(s) found! Fix before release.\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[32mNo secrets detected.\x1b[0m');
}
