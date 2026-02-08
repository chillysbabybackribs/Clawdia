#!/usr/bin/env node
// scripts/artifacts-check.mjs — Release artifact verification
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');

let failures = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; }
function warn(msg) { console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }

console.log('\n\x1b[1m[artifacts:check]\x1b[0m Verifying build artifacts...\n');

// ── 1. dist/ structure ──
const requiredDist = ['main/main.js', 'renderer/index.html'];
for (const p of requiredDist) {
  const full = join(DIST, p);
  if (existsSync(full)) {
    const size = statSync(full).size;
    pass(`dist/${p} (${(size / 1024).toFixed(1)} KB)`);
  } else {
    fail(`dist/${p} missing — run 'npm run build' first`);
  }
}

// ── 2. release/ directory ──
if (!existsSync(RELEASE)) {
  warn('release/ directory not found — skipping release artifact checks');
  warn('Run "npm run dist" to produce release artifacts');
} else {
  const files = readdirSync(RELEASE, { recursive: false });

  // Check for at least one distributable
  const distributable = files.filter(f =>
    /\.(AppImage|dmg|exe|deb|snap|rpm)$/i.test(f)
  );

  if (distributable.length > 0) {
    for (const f of distributable) {
      const stat = statSync(join(RELEASE, f));
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      if (stat.size > 10 * 1024 * 1024) {
        pass(`release/${f} (${sizeMB} MB)`);
      } else {
        fail(`release/${f} is suspiciously small (${sizeMB} MB)`);
      }
    }
  } else {
    warn('No distributable files found in release/ (.AppImage/.dmg/.exe/.deb)');
  }

  // Check naming convention
  for (const f of distributable) {
    if (/Clawdia/i.test(f)) {
      pass(`${f} — name contains "Clawdia"`);
    } else {
      fail(`${f} — name does not contain "Clawdia"`);
    }
  }

  // Check for builder debug file
  if (files.includes('builder-debug.yml')) {
    warn('release/builder-debug.yml present (not a distributable — ignore in checksums)');
  }
}

// ── Summary ──
console.log('');
if (failures > 0) {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[32mAll artifact checks passed.\x1b[0m');
}
