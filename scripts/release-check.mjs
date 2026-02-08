#!/usr/bin/env node
// scripts/release-check.mjs — Orchestrates all pre-deploy checks
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const CHECKS = [
  { name: 'site:check',      cmd: 'node scripts/site-check.mjs' },
  { name: 'build',            cmd: 'npm run build' },
  { name: 'artifacts:check',  cmd: 'node scripts/artifacts-check.mjs' },
  { name: 'secrets:scan',     cmd: 'node scripts/secrets-scan.mjs' },
  { name: 'checksums:gen',    cmd: 'node scripts/checksums-gen.mjs' },
];

// Smoke test is opt-in via --smoke flag (requires display server)
const runSmoke = process.argv.includes('--smoke');
if (runSmoke) {
  CHECKS.push({ name: 'smoke:electron', cmd: 'node scripts/smoke-electron.mjs' });
}

console.log('\x1b[1m╔══════════════════════════════════════╗\x1b[0m');
console.log('\x1b[1m║   Clawdia Release Readiness Check    ║\x1b[0m');
console.log('\x1b[1m╚══════════════════════════════════════╝\x1b[0m');
if (!runSmoke) {
  console.log('\x1b[2m  (pass --smoke to include Electron smoke test)\x1b[0m');
}

let failed = false;

for (const { name, cmd } of CHECKS) {
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 120_000 });
  } catch (err) {
    console.log(`\n\x1b[31m✗ "${name}" failed (exit ${err.status || 'unknown'})\x1b[0m`);
    failed = true;
    break; // fail-fast
  }
}

console.log('\n\x1b[1m══════════════════════════════════════\x1b[0m');
if (failed) {
  console.log('\x1b[31m  RELEASE CHECK FAILED\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32m  ALL CHECKS PASSED\x1b[0m');
  console.log('\n\x1b[2m  Manual verification still needed:\x1b[0m');
  console.log('\x1b[2m  - macOS: Gatekeeper / notarization\x1b[0m');
  console.log('\x1b[2m  - Windows: SmartScreen signing\x1b[0m');
  console.log('\x1b[2m  - Visual review of landing page\x1b[0m');
  console.log('\x1b[2m  - Test actual download links on GitHub\x1b[0m');
}
