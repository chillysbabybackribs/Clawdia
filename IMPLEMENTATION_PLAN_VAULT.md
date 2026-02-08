# IMPLEMENATION PLAN: KNOWLEDGE VAULT & UNIVERSAL INGESTION

## 1. System Architecture & Component Mapping

### Module Ownership
| System | Responsibility | Location |
| :--- | :--- | :--- |
| **Vault Core** | Database connection, schema management, raw storage | `src/main/vault/db.ts`, `src/main/vault/schema.sql` |
| **Ingestion** | File parsing, text extraction, **job tracking** | `src/main/ingestion/pipeline.ts`, `src/main/ingestion/extractors/*` |
| **Search** | Full-text query, citation resolution, source selection | `src/main/vault/search.ts` |
| **Action Ledger** | Transaction logging, execution, **quarantine management** | `src/main/actions/ledger.ts`, `src/main/actions/executor.ts` |
| **Shared Types** | Data contracts (RPC, DB entities) | `src/shared/vault-types.ts` |

---

## 2. Database Schema (SQLite + FTS5)

**File:** `src/main/vault/schema.sql`

```sql
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
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_rowid, new.content);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.chunk_rowid, old.content);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
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
```

---

## 3. Data Models & Constants

**File:** `src/shared/vault-types.ts`

### Versioning Constants
```typescript
export const VAULT_SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = 1;  // Bump to force re-extraction
export const CHUNKER_VERSION = 1;    // Bump to force re-chunking
```

### Citation Logic
```typescript
export interface VaultCitation {
    documentId: string;
    chunkId: string;
    text: string;           // The exact text content of the chunk
    locator: {
        pageNumber?: number;    // If extractor provided it (best effort)
        charRange: [number, number]; // [start, end] in extracted text
    };
    sourceUri: string;      // Resolved primary source URI
    score: number;          // FTS rank
}
```

**Source Selection Rule (Deterministic)**:
When resolving `sourceUri` for a `VaultCitation`:
1.  Query `document_sources` for `document_id`.
2.  Filter for valid `file://` URIs (check basic existence if possible, or trust `last_seen_at`).
3.  **Sort**: Prefer `file://` over `https://`, then sort by `last_seen_at` DESC.
4.  **Fallback**: If no `file://` exists, use `https://` (most recent).
5.  **Result**: Return the top candidate.

---

## 4. Logic & Algorithms

### A. Deduplication & Ingestion (Content-Addressed)
**Objective**: Avoid storing duplicate `documents` or `chunks` when files are renamed or moved.

**Logic Flow (`IngestionManager.ingest(filePath)`):**
1.  **Job Start**: Insert `ingestion_jobs` (status='pending').
2.  **Hash**: Calculate SHA-256 of `filePath` content.
3.  **Check DB**: `SELECT id FROM documents WHERE hash = ?`.
    *   **Match Found**:
        1.  Upsert `document_sources` with `(filePath, document_id)`. Update `last_seen_at`.
        2.  Update `ingestion_jobs` with `document_id` and status='completed'. Return early.
    *   **No Match**:
        1.  **Extract**: Run `Extractor` (returns `text`, `metadata`, `pages?`).
        2.  **Chunk**: Run `Chunker` (see below).
        3.  **Refine Metadata**: Add `title` (filename), `size`, `mime`.
        4.  **Transaction**:
            *   Insert `documents`.
            *   Insert `document_sources`.
            *   Insert `chunks` (batch).
        5.  Update `ingestion_jobs` with `document_id` and status='completed'.

### B. Deterministic Chunking
**Strategy**: Character-based sliding window with paragraph boundaries.
**Constants**:
- `TARGET_CHUNK_SIZE`: 1500 characters
- `OVERLAP_SIZE`: 200 characters

**Algorithm**:
1.  Normalize newlines (`\r\n` -> `\n`).
2.  Split text by double newline `\n\n` (paragraphs).
3.  Accumulate paragraphs until `current_chunk.length >= TARGET_CHUNK_SIZE`.
4.  If a single paragraph > `TARGET_CHUNK_SIZE`, split at sentence ending (`. `).
5.  Save chunk with `start_char_offset`, `end_char_offset` and `content_hash`.

### C. Undo/Trash Quarantine
**Storage Location**: `app.getPath('userData')/clawdia_vault/backups/`
**Structure**: `.../backups/<planId>/<actionId>/<original_filename>`

**Logic (`ActionExecutor`):**
-   **On `fs_write` (overwrite)**:
    1.  Calculate hash of existing file.
    2.  Copy existing file to Quarantine.
    3.  Record `backup_path` in `actions` table.
    4.  Perform write.
-   **On `fs_delete`**:
    1.  Move file to Quarantine.
    2.  Record `backup_path`.
-   **On `undo`**:
    1.  Reads `backup_path`.
    2.  Restores file to original location (overwriting current).

### D. Approval Gates
**Default Policy**:
| Operation Type | Scope | Policy |
| :--- | :--- | :--- |
| `read_file`, `list_dir`, `search` | Any | **Auto-Approve** |
| `fs_write` | New File | **Require Approval** (Medium) |
| `fs_write` | Overwrite | **Require Approval** (High + Diff View) |
| `fs_delete` | Any | **Require Approval** (High) |
| `ingest` | Any | **Auto-Approve** (Safe read-only op) |
| `run_command` | Any | **Require Approval** (High) |

---

## 5. Phased Implementation Plan (PR Backlog)

### PR 1: Database Foundation
-   **Files**: `src/main/vault/db.ts`, `src/main/vault/schema.sql` (v2), `src/shared/vault-types.ts`.
-   **Task**:
    -   Init SQLite with `better-sqlite3`.
    -   Enable WAL mode.
    -   Run schema migration.
-   **Tests**: Verify FK constraints, FTS5 table creation, and correct trigger behavior.

### PR 2: Ingestion & Deduplication
-   **Files**: `src/main/ingestion/`, `src/main/vault/documents.ts`.
-   **Task**:
    -   Implement `IngestionManager` components.
    -   Implement `ingestion_jobs` persistence.
    -   Implement `Chunker` (character-based + offset tracking).
    -   Implement `Chunker` hashing (SHA-256).
-   **Tests**:
    -   Ingest File A.
    -   Copy File A -> File B. Ingest File B.
    -   **Assert**: 1 row in `documents`, 2 rows in `document_sources`.
    -   **Assert**: Chunks are unique by offset/document_id.

### PR 3: Vault Search & Citation Resolution
-   **Files**: `src/main/vault/search.ts`.
-   **Task**:
    -   Query `chunks_fts`.
    -   Implement `CitationResolver` with source selection logic (file:// preference).
-   **Performance**: Verify 50ms latency on 10k chunks.

### PR 4: Action Ledger & Quarantine
-   **Files**: `src/main/actions/`.
-   **Task**:
    -   Implement `quarantineFile(path)` -> moves to `userData`.
    -   Implement `restoreFile(backupPath, originalPath)`.
    -   Wire up `actions` table.
    -   Implement `ActionExecutor` (write/delete/move).

### PR 5: UI & Integration
-   **Files**: Renderer components.
-   **Task**:
    -   Show "Ingesting..." status based on `ingestion_jobs`.
    -   Show simple "Vault Search" tool output.
    -   Add "Undo" button to Chat interface (IPCs).

---

## 6. Acceptance & Failure Criteria

### Must Work
1.  **Exact Citations**: Every answer derived from a document must cite the filename and reliable char-range/page.
2.  **Restart Persistence**: Undoing an action must work even if the app was closed and reopened.
3.  **Crash Resilience**: If ingestion crashes, the job remains "processing" or "failed" and can be retried without duplicate chunks.

### Failure Modes
1.  **Locked File**: If file is locked by OS, IngestionJob fails with clear error.
2.  **Encrypted PDF**: Fails with "Password required" error, does not crash.

### Performance Limits
-   **Max File Size**: 50MB.
-   **Max Batch**: 50 files per drag-drop.

---

## 7. Enforced Anti-Goals
1.  **No SHA-1**: Use SHA-256 exclusively.
2.  **No System Trash**: Use internal quarantine folder in `userData`.
3.  **No "Smart" Page Numbers**: Do not pretend to know page numbers unless the extractor guarantees it.
4.  **No Token-Based Chunking**: Use deterministic character/paragraph splitting.
5.  **No Duplicate Content**: Deduplicate binary content aggressively.
