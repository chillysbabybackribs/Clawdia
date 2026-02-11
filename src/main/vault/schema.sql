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

-- 7. PERSISTENT TASKS
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('one_time', 'scheduled', 'condition')),
    trigger_config TEXT,
    execution_plan TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed', 'archived')),
    approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('auto', 'approve_first', 'approve_always')),
    allowed_tools TEXT DEFAULT '[]',
    max_iterations INTEGER DEFAULT 30,
    model TEXT,
    token_budget INTEGER DEFAULT 50000,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_run_at INTEGER,
    next_run_at INTEGER,
    run_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    max_failures INTEGER DEFAULT 3,
    conversation_id TEXT,
    metadata_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at) WHERE status = 'active';

-- 8. TASK EXECUTION HISTORY
CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'approval_pending')),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    duration_ms INTEGER,
    result_summary TEXT,
    result_detail TEXT,
    tool_calls_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    error_message TEXT,
    trigger_source TEXT NOT NULL DEFAULT 'scheduled' CHECK(trigger_source IN ('scheduled', 'condition', 'manual', 'system')),
    run_source TEXT CHECK(run_source IN ('full_llm', 'executor'))
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

-- 9. TASK EXECUTOR CACHE
CREATE TABLE IF NOT EXISTS task_executors (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    executor_json TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_cost_saved REAL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_from_run_id TEXT,
    superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_task_executors_task ON task_executors(task_id);

-- 10. INTERACTIVE EXECUTOR CACHE
-- Caches executors for interactive LLM calls, keyed by archetype+host+toolSequence hash.
-- Separate from task_executors which are keyed by task_id for scheduled tasks.
CREATE TABLE IF NOT EXISTS interactive_executors (
    id TEXT PRIMARY KEY,
    cache_key_hash TEXT NOT NULL,
    cache_key_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    executor_json TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_cost_saved REAL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    superseded_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_executors_key
    ON interactive_executors(cache_key_hash) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_interactive_executors_used
    ON interactive_executors(last_used_at);
