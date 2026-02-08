-- ENABLE FOREIGN KEYS & WAL
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. DOCUMENTS (Content-Addressed Storage)
-- A document is defined by its content hash. Multiple file paths can point here.
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,                  -- UUID
    hash TEXT UNIQUE NOT NULL,            -- SHA-256 of binary content
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    metadata_json TEXT DEFAULT '{}',      -- Flexible metadata (author, created dates)
    extractor_version INTEGER DEFAULT 1,  -- To trigger re-indexing on logic updates
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    is_archived INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_docs_hash ON documents(hash);

-- 2. DOCUMENT SOURCES (Many-to-One)
-- Maps file paths or URLs to the content-addressed document.
CREATE TABLE IF NOT EXISTS document_sources (
    source_uri TEXT PRIMARY KEY,          -- file:///abs/path or https://...
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sources_doc ON document_sources(document_id);

-- 3. CHUNKS (Granular Search Units)
-- rowid is explicitly mapped to chunk_rowid for FTS5 binding.
CREATE TABLE IF NOT EXISTS chunks (
    chunk_rowid INTEGER PRIMARY KEY,      -- Stable integer ID for FTS
    id TEXT UNIQUE NOT NULL,              -- API-facing UUID
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,           -- SHA-256 of chunk content (integrity)
    chunk_index INTEGER NOT NULL,         -- Ordering within doc
    -- Locators (Best Effort)
    page_number INTEGER,                  -- PDF page (1-based, nullable, best effort)
    start_char_offset INTEGER NOT NULL,   -- Character index in extracted text
    end_char_offset INTEGER NOT NULL,
    -- Resilience: Prevent duplicate chunks for the same segment
    UNIQUE(document_id, start_char_offset, end_char_offset)
);

-- 4. FTS5 INDEX (Search)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='chunk_rowid'  -- Explicit binding
);

-- Triggers to synchronize FTS
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.chunk_rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.chunk_rowid, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_rowid, new.content);
END;

-- 5. INGESTION JOBS (Resilience)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id TEXT PRIMARY KEY,
    source_uri TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL
);

-- 6. ACTION LEDGER (Reversibility)
CREATE TABLE IF NOT EXISTS action_plans (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'executing', 'done', 'failed')),
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
    sequence_order INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('fs_write', 'fs_delete', 'fs_move', 'db_insert')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'executed', 'failed', 'rolled_back')),
    payload_json TEXT NOT NULL,           -- Arguments used to execute
    backup_path TEXT,                     -- Path to quarantined original file (internal userData)
    executed_at INTEGER,
    error_message TEXT
);
