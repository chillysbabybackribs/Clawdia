import Database from 'better-sqlite3';
import { homedir, tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../../logger';
import { filterSensitiveDomains, filterSensitiveUrls } from './privacy-filter';

const log = createLogger('ambient-browser');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainVisit {
  domain: string;
  visitCount: number;
  lastVisitMs: number;
  sampleTitles: string[];
}

export interface PageVisit {
  url: string;
  title: string;
  visitTimeMs: number;
  domain: string;
}

export interface BrowserHistoryResult {
  topDomains: DomainVisit[];
  recentPages: PageVisit[];
  source: string; // which browser DB was used
  scanDurationMs: number;
}

// ---------------------------------------------------------------------------
// Chrome time conversion
// Chrome stores microseconds since 1601-01-01.
// Unix epoch is 1970-01-01 = 11644473600 seconds after 1601-01-01.
// ---------------------------------------------------------------------------

function chromeTimeToUnixMs(chromeTime: number): number {
  return (chromeTime / 1_000_000 - 11_644_473_600) * 1000;
}

function unixMsToChromeTime(unixMs: number): number {
  return (unixMs / 1000 + 11_644_473_600) * 1_000_000;
}

// ---------------------------------------------------------------------------
// Platform-specific history DB paths
// ---------------------------------------------------------------------------

function getHistoryPaths(): Array<{ path: string; label: string }> {
  const home = homedir();
  const candidates: Array<{ path: string; label: string }> = [];

  if (process.platform === 'linux') {
    candidates.push(
      { path: path.join(home, '.config/google-chrome/Default/History'), label: 'Chrome' },
      { path: path.join(home, '.config/chromium/Default/History'), label: 'Chromium' },
      { path: path.join(home, '.config/BraveSoftware/Brave-Browser/Default/History'), label: 'Brave' },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { path: path.join(home, 'Library/Application Support/Google/Chrome/Default/History'), label: 'Chrome' },
      { path: path.join(home, 'Library/Application Support/Chromium/Default/History'), label: 'Chromium' },
      { path: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/History'), label: 'Brave' },
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    candidates.push(
      { path: path.join(localAppData, 'Google/Chrome/User Data/Default/History'), label: 'Chrome' },
      { path: path.join(localAppData, 'Chromium/User Data/Default/History'), label: 'Chromium' },
      { path: path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/Default/History'), label: 'Brave' },
    );
  }

  return candidates;
}

function findHistoryDb(): { path: string; label: string } | null {
  for (const candidate of getHistoryPaths()) {
    try {
      fs.accessSync(candidate.path, fs.constants.R_OK);
      return candidate;
    } catch { /* not accessible */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copy the locked DB to a temp file for safe reading
// ---------------------------------------------------------------------------

function copyToTemp(sourcePath: string): string | null {
  try {
    const tempPath = path.join(tmpdir(), `clawdia-history-${Date.now()}.sqlite`);
    fs.copyFileSync(sourcePath, tempPath);
    return tempPath;
  } catch (err: any) {
    log.warn(`[Ambient:Browser] Failed to copy history DB: ${err?.message || err}`);
    return null;
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export async function scanBrowserHistory(): Promise<BrowserHistoryResult | null> {
  const t0 = Date.now();

  const dbInfo = findHistoryDb();
  if (!dbInfo) {
    log.info('[Ambient:Browser] No Chrome/Chromium/Brave history database found');
    return null;
  }
  log.info(`[Ambient:Browser] Found ${dbInfo.label} history at ${dbInfo.path}`);

  const tempPath = copyToTemp(dbInfo.path);
  if (!tempPath) return null;

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(tempPath, { readonly: true, fileMustExist: true });

    const cutoffChromeTime = unixMsToChromeTime(Date.now() - 48 * 60 * 60 * 1000);

    // Query recent visits joined with urls
    const rows = db.prepare(`
      SELECT u.url, u.title, v.visit_time
      FROM visits v
      JOIN urls u ON v.url = u.id
      WHERE v.visit_time > ?
      ORDER BY v.visit_time DESC
      LIMIT 500
    `).all(cutoffChromeTime) as Array<{ url: string; title: string; visit_time: number }>;

    db.close();
    db = null;

    // Clean up temp file
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }

    // Build page visits with domain
    let pageVisits: PageVisit[] = rows
      .map(r => ({
        url: r.url,
        title: r.title || '',
        visitTimeMs: chromeTimeToUnixMs(r.visit_time),
        domain: extractDomain(r.url),
      }))
      .filter(p => p.domain && !p.domain.startsWith('chrome') && p.domain !== 'newtab');

    // Privacy filter
    pageVisits = filterSensitiveUrls(pageVisits);

    // Aggregate by domain
    const domainMap = new Map<string, { count: number; lastVisitMs: number; titles: Set<string> }>();
    for (const pv of pageVisits) {
      const existing = domainMap.get(pv.domain);
      if (existing) {
        existing.count++;
        if (pv.visitTimeMs > existing.lastVisitMs) existing.lastVisitMs = pv.visitTimeMs;
        if (existing.titles.size < 3 && pv.title) existing.titles.add(pv.title.slice(0, 60));
      } else {
        const titles = new Set<string>();
        if (pv.title) titles.add(pv.title.slice(0, 60));
        domainMap.set(pv.domain, { count: 1, lastVisitMs: pv.visitTimeMs, titles });
      }
    }

    let topDomains: DomainVisit[] = Array.from(domainMap.entries())
      .map(([domain, data]) => ({
        domain,
        visitCount: data.count,
        lastVisitMs: data.lastVisitMs,
        sampleTitles: Array.from(data.titles),
      }))
      .sort((a, b) => b.visitCount - a.visitCount);

    // Privacy filter on aggregated domains
    topDomains = filterSensitiveDomains(topDomains);
    topDomains = topDomains.slice(0, 15);

    const recentPages = pageVisits.slice(0, 20);

    const elapsed = Date.now() - t0;
    log.info(`[Ambient:Browser] Scan complete in ${elapsed}ms — ${topDomains.length} domains, ${recentPages.length} recent pages from ${rows.length} raw visits`);
    for (const d of topDomains.slice(0, 8)) {
      log.info(`[Ambient:Browser]   ${d.domain}: ${d.visitCount} visits, titles=[${d.sampleTitles.join('; ')}]`);
    }

    return { topDomains, recentPages, source: dbInfo.label, scanDurationMs: elapsed };
  } catch (err: any) {
    log.warn(`[Ambient:Browser] History query failed: ${err?.message || err}`);
    if (db) try { db.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    return null;
  }
}

/**
 * Format browser history as a compact string for injection into the Haiku prompt.
 * Max ~500 chars.
 */
export function formatBrowserActivity(result: BrowserHistoryResult | null): string {
  if (!result || result.topDomains.length === 0) return '';

  const domainLines = result.topDomains.slice(0, 8).map(d => {
    const ago = Math.round((Date.now() - d.lastVisitMs) / (1000 * 60 * 60));
    const agoStr = ago < 1 ? '<1h' : `${ago}h`;
    const titleHint = d.sampleTitles[0] ? ` "${d.sampleTitles[0].slice(0, 35)}"` : '';
    return `${d.domain}: ${d.visitCount}x ${agoStr}${titleHint}`;
  });

  const block = `<browser_activity_last_48h>\n${domainLines.join('\n')}\n</browser_activity_last_48h>`;
  return block.slice(0, 500);
}
