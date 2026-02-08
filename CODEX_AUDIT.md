
# Codex Audit: Knowledge Vault & Universal Ingestion

## Executive Summary
*   **Current Status**: The system is **entirely ephemeral** regarding local files. It has powerful *web* search (Serper/Playwright) and *outbound* document creation, but **zero** persistent index of user content. Ingestion is manual (one-off file reads) and "memory" is limited to conversation context or site-specific scraping hints.
*   **Critical Gap**: `extractDocument` loads entire files into RAM (Buffer), risking crashes on large files. There is **no undo** for filesystem operations (`file_write` is immediate and destructive).
*   **Recommendation**: Implement a **SQLite-based Knowledge Vault** (mirroring the existing `site-knowledge.db` pattern) for finding content, and a **Transaction Log** pattern for all ingestion/mutation actions to enable safety and reversibility.

---

## A) Knowledge Vault with Citations

### 1. Current State (Findings)
*   **Data Sources**: File access is "pull-only" via `toolFileRead` (local/tools.ts:405). No background indexing or watching exists.
*   **Indexing**: Non-existent for local content. `src/main/search/backends.ts` is exclusively for **web search** (Serper, SerpAPI, Bing).
*   **Citation Support**: The `toolFileRead` output manually appends line numbers, but there is no structured "Citation Object" passed through the system.
*   **Persistence**: `src/main/learning/site-knowledge.ts` demonstrates a working SQLite pattern (`better-sqlite3`) but is currently scoped only to "web scraping hints" (selectors), not content.

### 2. Gaps & Risks
*   **No "Recall"**: The user cannot ask "What did I write about project X last week?" because nothing is indexed.
*   **Context Window Thrashing**: Without retrieval, the user must manually `read_file` every relevant doc, wasting tokens.
*   **Privacy**: No "ignored paths" enforcement beyond the `toolDirectoryTree` default ignore list (local/tools.ts:528).

### 3. Proposed Architecture
**New Module**: `src/main/knowledge/vault.ts`
*   **Storage**: SQLite (`knowledge.db`) using **FTS5** for full-text search.
    *   Schema: `documents (id, path, hash, last_modified)`, `chunks (doc_id, content, start_line, end_line, embedding_stub)`.
*   **Ingestion**: A simplified `FileWatcher` (chokidar) that debounces updates and feeds the `Ingestor`.
*   **Retrieval**: A new tool `knowledge_query` exposed to the LLM.

**Citation Flow**:
1.  LLM calls `knowledge_query(query="project X")`.
2.  Vault returns snippets with standard format: `[Source: /abs/path/doc.md:10-25]`.
3.  UI (Renderer) detects this pattern (regex) and renders a clickable "Source" badge that triggers `IPC.DOCUMENT_OPEN_FOLDER` or `IPC.DOCUMENT_EXTRACT`.

### 4. Implementation Plan (Minimal)
*   **PR 1: Vault Foundation**: Scaffold `src/main/knowledge/vault.ts` using `better-sqlite3`. Define FTS5 schema. Add `ipc-validator` support for vault queries.
*   **PR 2: Ingestion Pipeline**: Refactor `extractDocument` (documents/extractor.ts) to support **streaming/chunking** instead of full-buffer load. Connect `chokidar` to feed text chunks to Vault.
*   **PR 3: Tool Integration**: Add `knowledge_query` to `src/main/local/tools.ts`. Wire it to the Vault.
*   **PR 4: UI & Citations**: Update `src/renderer` to parse `[Source: ...]` and add the "View Source" interaction.

### 5. Acceptance Criteria
*   [ ] User can ask "Find the contract from last week" and get a specific file path.
*   [ ] `knowledge.db` is created in `userData` and survives restarts.
*   [ ] Citations include line ranges (e.g., `:10-20`).

---

## B) Universal Ingestion & Reversible Actions

### 1. Current State (Findings)
*   **Ingestion Entry Points**:
    *   `IPC.DOCUMENT_EXTRACT` (main.ts:512): Accepts a raw Buffer, extracts text, returns it. **Blocking & RAM-heavy**.
    *   Drag-and-drop in UI sends this IPC immediately.
*   **Structured Records**: None. `extractDocument` returns a loose object `{ text: string, metadata: ... }`. No persistence of "Ingested Records".
*   **Safety**: `toolFileWrite` (local/tools.ts:463) and `shell_exec` (local/tools.ts:357) are **immediate**. `file_write` has no backup/undo.
*   **Reversibility**: **Zero**. If the LLM overwrites a file, it's gone (unless git tracks it).

### 2. Gaps & Risks
*   **Destructive Edits**: `file_write` has an `overwrite` mode that offers no safety net.
*   **Opaque Actions**: The user sees "Thinking..." then the file is changed. No "Preview Plan" step for complex batch ops (e.g., "Rename 50 files").
*   **Buffer Overflow**: `IPC.DOCUMENT_EXTRACT` taking a `number[]` (JSON serialization of Buffer) is extremely inefficient for large files (>10MB).

### 3. Proposed Architecture
**New Module**: `src/main/actions/`
*   **Action Interface**:
    ```typescript
    interface Action {
      type: 'move' | 'write' | 'delete';
      preview(): string;  // "Rename A -> B"
      execute(): Promise<void>;
      rollback(): Promise<void>; // Move B -> A
    }
    ```
*   **Transaction Log**: A simple JSON-L file or SQLite table `action_log` recording executed plan IDs.
*   **Ingestor Service**: A higher-level coordinator that:
    1.  Receives a path/buffer.
    2.  Identifies Type (`extractor.ts`).
    3.  Creates a **Structured Record** (stored in `knowledge.db`).
    4.  Triggers necessary Actions (e.g., "Move to /Inbox").

### 4. Implementation Plan (Minimal)
*   **PR 1: Action Framework**: Create `Action` interface and `TransactionManager` in `src/main/actions/`. Implement `FileWriteAction` with `.bak` file creation for rollback.
*   **PR 2: Refactor Tools**: Update `toolFileWrite` in `local/tools.ts` to use `TransactionManager`. It now creates a plan, auto-executes (if safe) or requests approval (future), and logs for undo.
*   **PR 3: Ingestor Service**: Create `Ingestor` that wraps `extractDocument`. Change IPC to pass **file paths** (not buffers) to avoid IPC bloat. Stream file reading.
*   **PR 4: Batch Tool**: Add `batch_organize` tool that takes a directory, proposes a set of Moves/Renames (ActionPlan), and executes them transactionally.

### 5. Acceptance Criteria
*   [ ] "Undo" button appears after a `file_write` or batch operation.
*   [ ] Clicking "Undo" restores the previous file state perfectly.
*   [ ] Ingesting a 100MB PDF does not crash the main process (streaming used).

---

## Appendix: Source Citations

*   **File Read (Pull-Only)**: `src/main/local/tools.ts` lines 405-461 (`toolFileRead`).
*   **Web-Only Search**: `src/main/search/backends.ts` lines 219-228 (`BACKENDS` array: serper, serpapi, bing).
*   **SQLite Pattern**: `src/main/learning/site-knowledge.ts` lines 14-61 (Class `SiteKnowledgeBase`).
*   **Dangerous File Write**: `src/main/local/tools.ts` lines 463-486 (`toolFileWrite` using `fs.writeFile`).
*   **Blocking Ingestion**: `src/main/main.ts` line 512 (`IPC.DOCUMENT_EXTRACT` receives `data.buffer`).
*   **Extraction Logic**: `src/main/documents/extractor.ts` lines 62-81 (`extractDocument`).
