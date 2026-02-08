#!/usr/bin/env node
// scripts/checksums-gen.mjs — Generate SHA-256 checksums for release artifacts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const RELEASE = join(ROOT, 'release');

console.log('\n\x1b[1m[checksums:gen]\x1b[0m Generating SHA-256 checksums...\n');

if (!existsSync(RELEASE)) {
  console.log('  \x1b[33m⚠\x1b[0m release/ directory not found — nothing to checksum');
  process.exit(0);
}

const SKIP = new Set(['builder-debug.yml', 'builder-effective-config.yaml', 'checksums.txt', 'linux-unpacked', 'squashfs-root']);
const files = readdirSync(RELEASE).filter(f => {
  if (SKIP.has(f)) return false;
  const stat = statSync(join(RELEASE, f));
  return stat.isFile();
});

if (files.length === 0) {
  console.log('  \x1b[33m⚠\x1b[0m No release files to checksum');
  process.exit(0);
}

const lines = [];
for (const f of files.sort()) {
  const data = readFileSync(join(RELEASE, f));
  const hash = createHash('sha256').update(data).digest('hex');
  const sizeMB = (data.length / 1024 / 1024).toFixed(1);
  lines.push(`${hash}  ${f}`);
  console.log(`  \x1b[32m✓\x1b[0m ${hash}  ${f} (${sizeMB} MB)`);
}

const outPath = join(RELEASE, 'checksums.txt');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`\n  Written to ${outPath}`);
console.log('\x1b[32mChecksums generated.\x1b[0m');
