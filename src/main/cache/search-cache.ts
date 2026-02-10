/**
 * SQLite-backed search cache.
 *
 * Stores compressed web page content and search results locally so that
 * the LLM context window only holds short references. The LLM can then
 * request full content on demand via the cache_read tool.
 *
 * Database location: <userData>/search-cache.sqlite
 */

import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger';

const log = createLogger('search-cache');

// --- Types ---

export interface CachedPage {
  id: string;
  url: string;
  title: string;
  content: string;
  summary: string;
  fetchedAt: number;
  contentLength: number;
  compressedLength: number;
  contentType: string;
}

export interface CachedSearch {
  id: string;
  query: string;
  results: SearchResultEntry[];
  searchedAt: number;
  source: string;
}

export interface SearchResultEntry {
  title: string;
  url: string;
  snippet: string;
  pageId?: string;
}

// --- Singleton ---

let db: Database.Database | null = null;
let initFailCount = 0;
const MAX_INIT_RETRIES = 3;

/** Returns true if the cache DB is available (or could be opened). */
export function isCacheAvailable(): boolean {
  if (db) return true;
  if (initFailCount >= MAX_INIT_RETRIES) return false;
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

function getDb(): Database.Database {
  if (db) return db;
  if (initFailCount >= MAX_INIT_RETRIES) throw new Error(`Search cache failed to initialize after ${MAX_INIT_RETRIES} attempts`);

  const dbPath = path.join(app.getPath('userData'), 'search-cache.sqlite');
  log.info(`Opening search cache at ${dbPath} (attempt ${initFailCount + 1})`);

  try {
    db = new Database(dbPath);
    initFailCount = 0; // Reset on success
  } catch (err: any) {
    initFailCount++;
    log.warn(`Failed to open search cache DB (attempt ${initFailCount}/${MAX_INIT_RETRIES}): ${err?.message}`);
    throw err;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      summary TEXT DEFAULT '',
      fetched_at INTEGER NOT NULL,
      content_length INTEGER,
      compressed_length INTEGER,
      content_type TEXT DEFAULT 'article'
    );

    CREATE TABLE IF NOT EXISTS searches (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      results_json TEXT NOT NULL,
      searched_at INTEGER NOT NULL,
      source TEXT DEFAULT 'google'
    );

    CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
    CREATE INDEX IF NOT EXISTS idx_pages_fetched ON pages(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_searches_query ON searches(query);
    CREATE INDEX IF NOT EXISTS idx_searches_searched ON searches(searched_at);
  `);

  // Log stats
  const pageCount = (db.prepare('SELECT COUNT(*) as c FROM pages').get() as any).c;
  const searchCount = (db.prepare('SELECT COUNT(*) as c FROM searches').get() as any).c;
  const dbSizeResult = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
  const dbSizeMB = ((dbSizeResult?.size || 0) / (1024 * 1024)).toFixed(1);
  log.info(`[search-cache] ${pageCount} pages, ${searchCount} searches, ${dbSizeMB}MB`);

  return db;
}

// --- Page ID generation ---

function makePageId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

// --- Public API ---

export function storePage(
  url: string,
  title: string,
  content: string,
  options?: {
    summary?: string;
    contentLength?: number;
    compressedLength?: number;
    contentType?: string;
  },
): string {
  const id = makePageId(url);
  if (initFailCount >= MAX_INIT_RETRIES) return ''; // Signal that storage was skipped
  const database = getDb();

  database.prepare(`
    INSERT OR REPLACE INTO pages (id, url, title, content, summary, fetched_at, content_length, compressed_length, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    url,
    title || '',
    content,
    options?.summary || '',
    Date.now(),
    options?.contentLength || content.length,
    options?.compressedLength || content.length,
    options?.contentType || 'article',
  );

  log.debug(`Stored page: ${id} (${url})`);
  return id;
}

export function storeSearch(
  query: string,
  results: SearchResultEntry[],
  source?: string,
): string {
  const id = randomUUID().slice(0, 12);
  if (initFailCount >= MAX_INIT_RETRIES) return '';
  const database = getDb();

  database.prepare(`
    INSERT INTO searches (id, query, results_json, searched_at, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    query,
    JSON.stringify(results),
    Date.now(),
    source || 'google',
  );

  log.debug(`Stored search: ${id} ("${query}")`);
  return id;
}

export function getPage(pageId: string): CachedPage | null {
  if (initFailCount >= MAX_INIT_RETRIES) return null;
  const database = getDb();
  const row = database.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as any;
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    content: row.content,
    summary: row.summary,
    fetchedAt: row.fetched_at,
    contentLength: row.content_length,
    compressedLength: row.compressed_length,
    contentType: row.content_type,
  };
}

export function getPageByUrl(url: string, maxAgeMs?: number): CachedPage | null {
  if (initFailCount >= MAX_INIT_RETRIES) return null;
  const database = getDb();
  let row: any;

  if (maxAgeMs) {
    const minTimestamp = Date.now() - maxAgeMs;
    row = database.prepare('SELECT * FROM pages WHERE url = ? AND fetched_at >= ?').get(url, minTimestamp);
  } else {
    row = database.prepare('SELECT * FROM pages WHERE url = ?').get(url);
  }

  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    content: row.content,
    summary: row.summary,
    fetchedAt: row.fetched_at,
    contentLength: row.content_length,
    compressedLength: row.compressed_length,
    contentType: row.content_type,
  };
}

export function getSearch(searchId: string): CachedSearch | null {
  if (initFailCount >= MAX_INIT_RETRIES) return null;
  const database = getDb();
  const row = database.prepare('SELECT * FROM searches WHERE id = ?').get(searchId) as any;
  if (!row) return null;
  return {
    id: row.id,
    query: row.query,
    results: JSON.parse(row.results_json),
    searchedAt: row.searched_at,
    source: row.source,
  };
}

export function getRecentSearches(limit = 10): CachedSearch[] {
  if (initFailCount >= MAX_INIT_RETRIES) return [];
  const database = getDb();
  const rows = database.prepare('SELECT * FROM searches ORDER BY searched_at DESC LIMIT ?').all(limit) as any[];
  return rows.map((row) => ({
    id: row.id,
    query: row.query,
    results: JSON.parse(row.results_json),
    searchedAt: row.searched_at,
    source: row.source,
  }));
}

/**
 * Generate a compact reference string for the LLM.
 * Example: [cached:abc123] "Article Title" (example.com) — summary text
 */
export function getPageReference(pageId: string): string {
  const page = getPage(pageId);
  if (!page) return `[cached:${pageId}] (not found)`;

  let hostname = '';
  try {
    hostname = new URL(page.url).hostname.replace('www.', '');
  } catch {
    hostname = page.url;
  }

  const summary = page.summary || page.content.slice(0, 200).replace(/\n/g, ' ').trim();
  return `[cached:${pageId}] "${page.title}" (${hostname}) — ${summary}`;
}

/**
 * Search cached content for a section keyword and return a ~5000 char window.
 */
export function getPageSection(pageId: string, keyword: string, maxChars = 5_000): string | null {
  const page = getPage(pageId);
  if (!page) return null;

  const content = page.content;
  const lowerContent = content.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  // Find the best match location
  const idx = lowerContent.indexOf(lowerKeyword);
  if (idx < 0) {
    // Keyword not found — return the beginning
    return content.slice(0, maxChars);
  }

  // Center the window around the match
  const halfWindow = Math.floor(maxChars / 2);
  let start = Math.max(0, idx - halfWindow);
  let end = Math.min(content.length, idx + halfWindow);

  // Adjust to paragraph boundaries
  const paragraphBefore = content.lastIndexOf('\n\n', start + 200);
  if (paragraphBefore > start - 500 && paragraphBefore >= 0) {
    start = paragraphBefore;
  }
  const paragraphAfter = content.indexOf('\n\n', end - 200);
  if (paragraphAfter > 0 && paragraphAfter < end + 500) {
    end = paragraphAfter;
  }

  let result = content.slice(start, end).trim();
  if (start > 0) result = `[...]\n${result}`;
  if (end < content.length) result = `${result}\n[...]`;

  return result;
}

/**
 * Delete entries older than maxAgeMs. Returns count of deleted entries.
 */
export function pruneOlderThan(maxAgeMs: number): number {
  if (initFailCount >= MAX_INIT_RETRIES) return 0;
  const database = getDb();
  const cutoff = Date.now() - maxAgeMs;

  const pageResult = database.prepare('DELETE FROM pages WHERE fetched_at < ?').run(cutoff);
  const searchResult = database.prepare('DELETE FROM searches WHERE searched_at < ?').run(cutoff);

  const deleted = (pageResult.changes || 0) + (searchResult.changes || 0);
  if (deleted > 0) {
    log.info(`Pruned ${deleted} old cache entries (older than ${Math.round(maxAgeMs / 86400000)}d)`);
  }
  return deleted;
}

/**
 * Initialize the cache on app startup — prunes old entries.
 */
export function initSearchCache(): void {
  try {
    getDb();
    pruneOlderThan(7 * 24 * 60 * 60 * 1000); // 7 days
  } catch (err: any) {
    log.warn(`Failed to initialize search cache: ${err?.message}`);
  }
}

/**
 * Close the database connection (for app shutdown).
 */
export function closeSearchCache(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Search cache closed');
  }
}

/** Cache freshness thresholds */
export const CACHE_MAX_AGE = {
  NEWS: 1 * 60 * 60 * 1000,       // 1 hour for news
  ARTICLE: 24 * 60 * 60 * 1000,   // 24 hours for articles
  SEARCH: 30 * 60 * 1000,         // 30 minutes for search results
} as const;
