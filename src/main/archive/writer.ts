/**
 * Conversation Archive — permanent SQLite store for all messages.
 *
 * Every user/assistant message is written here untruncated and never pruned.
 * The LLM can search past conversations via the memory_search tool.
 *
 * Database location: <userData>/conversations-archive.sqlite
 */

import { app } from 'electron';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger';

const log = createLogger('archive');

// --- Types ---

export interface ArchivedMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  hasToolCalls?: boolean;
  hasImages?: boolean;
  hasDocuments?: boolean;
}

export interface ArchivedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ArchiveSearchResult {
  conversationId: string;
  conversationTitle: string;
  messageDate: string;
  role: string;
  snippet: string;
}

export interface ArchiveStats {
  conversationCount: number;
  messageCount: number;
  dbSizeMB: string;
}

// --- Singleton ---

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  throw new Error('Archive not initialized — call initArchive() first');
}

// --- Public API ---

export function initArchive(): void {
  if (db) return;

  const dbPath = path.join(app.getPath('userData'), 'conversations-archive.sqlite');
  log.info(`Opening conversation archive at ${dbPath}`);

  try {
    db = new Database(dbPath);
  } catch (err: any) {
    log.warn(`Failed to open archive DB: ${err?.message}`);
    return;
  }

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      has_tool_calls INTEGER NOT NULL DEFAULT 0,
      has_images INTEGER NOT NULL DEFAULT 0,
      has_documents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
  `);

  // FTS5 virtual table with auto-sync triggers (same pattern as user_memory)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id
    );

    -- Auto-sync triggers
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // Log stats
  try {
    const stats = getArchiveStats();
    log.info(`[archive] ${stats.conversationCount} conversations, ${stats.messageCount} messages, ${stats.dbSizeMB}MB`);
  } catch {
    // Stats are non-critical
  }
}

export function closeArchive(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Conversation archive closed');
  }
}

export function archiveMessage(
  conversationId: string,
  conversationTitle: string,
  message: ArchivedMessage,
): void {
  if (!db) return;

  const database = getDb();
  const now = message.createdAt || new Date().toISOString();

  // UPSERT conversation row
  database.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, message_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN excluded.title != 'New Chat' THEN excluded.title ELSE conversations.title END,
      updated_at = excluded.updated_at,
      message_count = conversations.message_count + 1
  `).run(conversationId, conversationTitle, now, now);

  // INSERT message (ignore duplicates via external_id UNIQUE)
  database.prepare(`
    INSERT OR IGNORE INTO messages (external_id, conversation_id, role, content, created_at, has_tool_calls, has_images, has_documents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    conversationId,
    message.role,
    message.content,
    now,
    message.hasToolCalls ? 1 : 0,
    message.hasImages ? 1 : 0,
    message.hasDocuments ? 1 : 0,
  );
}

export function searchArchive(
  query: string,
  options?: {
    conversationId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): ArchiveSearchResult[] {
  if (!db) return [];

  const database = getDb();
  const limit = Math.min(options?.limit || 5, 10);

  // Tokenize and prepare FTS5 query — wrap each word in quotes for safety
  const tokens = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => `"${t}"`)
    .join(' OR ');

  if (!tokens) return [];

  let sql = `
    SELECT
      m.conversation_id,
      c.title AS conversation_title,
      m.created_at AS message_date,
      m.role,
      m.content
    FROM messages_fts fts
    JOIN messages m ON m.id = fts.rowid
    JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ?
  `;
  const params: any[] = [tokens];

  if (options?.conversationId) {
    sql += ' AND m.conversation_id = ?';
    params.push(options.conversationId);
  }
  if (options?.dateFrom) {
    sql += ' AND m.created_at >= ?';
    params.push(options.dateFrom);
  }
  if (options?.dateTo) {
    sql += ' AND m.created_at <= ?';
    params.push(options.dateTo);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  const rows = database.prepare(sql).all(...params) as any[];

  return rows.map(row => {
    // Build snippet: center ~800 chars around the first match
    const content: string = row.content || '';
    const snippet = buildSnippet(content, query, 800);

    return {
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || 'Untitled',
      messageDate: row.message_date,
      role: row.role,
      snippet,
    };
  });
}

export function getArchiveStats(): ArchiveStats {
  if (!db) return { conversationCount: 0, messageCount: 0, dbSizeMB: '0.0' };

  const database = getDb();
  const convCount = (database.prepare('SELECT COUNT(*) as c FROM conversations').get() as any).c;
  const msgCount = (database.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
  const sizeResult = database.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
  const sizeMB = ((sizeResult?.size || 0) / (1024 * 1024)).toFixed(1);

  return {
    conversationCount: convCount,
    messageCount: msgCount,
    dbSizeMB: sizeMB,
  };
}

// --- Helpers ---

function buildSnippet(content: string, query: string, maxChars: number): string {
  const lowerContent = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  // Find first match position
  let bestIdx = -1;
  for (const word of words) {
    const idx = lowerContent.indexOf(word);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }

  if (bestIdx < 0) {
    // No match found — return beginning
    return content.slice(0, maxChars);
  }

  // Center window around match
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, bestIdx - half);
  let end = Math.min(content.length, bestIdx + half);

  // Snap to word boundaries
  if (start > 0) {
    const space = content.indexOf(' ', start);
    if (space > 0 && space < start + 50) start = space + 1;
  }
  if (end < content.length) {
    const space = content.lastIndexOf(' ', end);
    if (space > end - 50) end = space;
  }

  let snippet = content.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}
