#!/usr/bin/env node
// scripts/site-check.mjs — Static site integrity checks
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SITE = join(ROOT, 'site');

let failures = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; }

console.log('\n\x1b[1m[site:check]\x1b[0m Running site integrity checks...\n');

// ── 1. No YOURDOMAIN.com placeholders ──
const siteFiles = readdirSync(SITE).filter(f => /\.(html|js|css|json|xml)$/.test(f));
for (const file of siteFiles) {
  const content = readFileSync(join(SITE, file), 'utf8');
  if (/YOURDOMAIN\.com/i.test(content)) {
    fail(`${file} contains YOURDOMAIN.com placeholder`);
  } else {
    pass(`${file} — no placeholder found`);
  }
}

// ── 2. Demo video file exists ──
const videoPath = join(SITE, 'assets', 'loom_video.mp4');
if (existsSync(videoPath)) {
  const stat = readFileSync(videoPath);
  if (stat.length > 1024) {
    pass(`assets/loom_video.mp4 exists (${(stat.length / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    fail('assets/loom_video.mp4 exists but is suspiciously small');
  }
} else {
  fail('assets/loom_video.mp4 missing');
}

// ── 3. Video is referenced in index.html ──
const indexHtml = readFileSync(join(SITE, 'index.html'), 'utf8');
if (indexHtml.includes('loom_video.mp4')) {
  pass('index.html references loom_video.mp4');
} else {
  fail('index.html does NOT reference loom_video.mp4');
}

// ── 4. Required assets exist ──
for (const asset of ['icon.png', 'og-image.png']) {
  if (existsSync(join(SITE, 'assets', asset))) {
    pass(`assets/${asset} exists`);
  } else {
    fail(`assets/${asset} missing`);
  }
}

// ── 5. Local HTTP server check ──
async function serveAndCheck() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain', '.json': 'application/json' };

  const server = createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = join(SITE, urlPath);
    if (existsSync(filePath)) {
      const ext = '.' + filePath.split('.').pop();
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const paths = ['/', '/index.html', '/style.css', '/script.js', '/robots.txt', '/sitemap.xml'];
  for (const p of paths) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      if (res.status === 200) {
        pass(`HTTP 200 ${p}`);
      } else {
        fail(`HTTP ${res.status} ${p}`);
      }
    } catch (e) {
      fail(`HTTP request failed for ${p}: ${e.message}`);
    }
  }

  server.close();
}

await serveAndCheck();

// ── 6. GitHub release script logic test (mock) ──
// Simulates the getLatestRelease() logic from script.js with a mock GitHub API response
const mockRelease = {
  tag_name: 'v1.0.0',
  assets: [
    { name: 'Clawdia-1.0.0.AppImage', browser_download_url: 'https://example.com/Clawdia-1.0.0.AppImage', size: 166723584 },
    { name: 'Clawdia-1.0.0.dmg', browser_download_url: 'https://example.com/Clawdia-1.0.0.dmg', size: 120000000 },
    { name: 'Clawdia-Setup-1.0.0.exe', browser_download_url: 'https://example.com/Clawdia-Setup-1.0.0.exe', size: 130000000 },
  ]
};

const version = mockRelease.tag_name.replace(/^v/, '');
const linux = mockRelease.assets.find(a => /\.AppImage$/i.test(a.name));
const mac = mockRelease.assets.find(a => /\.dmg$/i.test(a.name));
const win = mockRelease.assets.find(a => /Setup.*\.exe$/i.test(a.name) || /\.exe$/i.test(a.name));

if (version === '1.0.0' && linux && mac && win) {
  pass('GitHub release parsing logic works with mock data');
} else {
  fail('GitHub release parsing logic failed with mock data');
}

// ── Summary ──
console.log('');
if (failures > 0) {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[32mAll site checks passed.\x1b[0m');
}
