# Clawdia Autonomous Foundation — Architecture Audit & Implementation Plan

---

## Part 1: Architecture Audit

### 1.1 Tool Execution Architecture

#### Entry Point: User Message → Tool Loop
**Path**: Renderer IPC → `main.ts:503` (CHAT_SEND handler) → `ToolLoop` creation (`main.ts:523`) → `loop.run()` (`main.ts:540`)

1. **IPC Handler** (`main.ts:503-577`): Validates payload via `ipc-validator.ts`, retrieves API key + model, gets or creates conversation, instantiates `ToolLoop(mainWindow, client)`.
2. **ToolLoop.run()** (`tool-loop.ts:685-1436`): Accepts `message, history, images, documents, context`. Builds system prompt (static cached + dynamic uncached). Optionally runs deterministic fast-path for media downloads. Enters main iteration loop (max 150 iterations).
3. **Per Iteration**: Calls `client.chat()` with streaming → parses `tool_use` blocks → executes tools → packages results → feeds back as user messages → next iteration.
4. **Termination**: When LLM stops calling tools (`stopReason !== 'tool_use'`), final response is emitted via IPC.

#### Tool Registry — Static, Not Dynamic
**File**: `tool-loop.ts:67`
```
ALL_TOOLS = [...BROWSER_TOOL_DEFINITIONS, ...LOCAL_TOOL_DEFINITIONS,
             SEQUENTIAL_THINKING_TOOL_DEFINITION, ...VAULT_TOOL_DEFINITIONS]
```

| Tool Group | File | Count | Examples |
|-----------|------|-------|---------|
| Browser | `src/main/browser/tools.ts` | ~30 | browser_search, browser_navigate, browser_click, browser_screenshot |
| Local | `src/main/local/tools.ts` | ~15 | file_read, file_write, shell_exec, create_document |
| Vault | `src/main/vault/tools.ts` | 6 | vault_search, action_create_plan, action_execute_plan |
| Thinking | `src/main/llm/sequential-thinking.ts` | 1 | sequential_thinking |

**Dispatch** (`tool-loop.ts:517-548`): Prefix-based routing — `sequential_thinking` → direct, `browser_*` → `executeBrowserTool()`, vault names → `executeVaultTool()`, local names → `executeLocalTool()`.

**Dynamic Filtering**: Tool set is filtered per iteration 0 based on intent classification (chat-only, browser, local, mixed). Subsequent iterations get all tools.

#### Tool Result Feedback
Tool results are packaged as `tool_result` content blocks with `tool_use_id` correlation, serialized as JSON user messages (`tool-loop.ts:1419`). Multi-part content supported for image results (`parseImageResult()` at `tool-loop.ts:413`). Old tool results compressed after `KEEP_FULL_TOOL_RESULTS=4` iterations.

#### Error Handling
- **No automatic retry**: Tool errors caught, converted to error message string, returned to LLM as tool result. LLM decides whether to retry.
- **API errors**: AbortError returns `[Stopped]`; other errors bubble up to IPC error handler.
- **Session invalidation**: Detected between iterations; LLM informed via injected message.
- **Search deduplication**: Duplicate searches detected and skipped with informational message.

#### Tool Call Limits
- `MAX_TOOL_CALLS = 150` (countable tools, excludes `sequential_thinking`)
- `MAX_TOOL_ITERATIONS = 150` (API call iterations)
- At limit: Asks user whether to continue or forces final response.
- Warning injected at 145 calls.

#### Can Tool Execution Happen Without User Message?
**NO.** `ToolLoop` is always instantiated in response to `CHAT_SEND` IPC from renderer. No background, scheduled, or system-initiated tool loops exist. The `client.complete()` method is used for non-tool LLM calls (memory extraction, dashboard insights), but never drives a tool loop.

---

### 1.2 Background Execution Capability

#### Window Close Behavior
**File**: `main.ts:955-981`
- **Linux/Windows**: `app.quit()` called on `window-all-closed` — main process terminates.
- **macOS**: App stays alive (dock icon remains), window re-opens on `activate`.
- Before quit: Dashboard state saved, executor stopped, session reaper stopped, search cache closed, learning system shut down.

#### Existing Background Processing

| System | Pattern | Interval | File |
|--------|---------|----------|------|
| Dashboard Executor | `setTimeout` chain | Adaptive: 30s-5min | `executor.ts:170-178` |
| Session Reaper | `setTimeout` chain | 60s fixed | `manager.ts:664-677` |
| Learning Pruning | One-shot `setTimeout` | 10s after init | `learning/index.ts:20-23` |
| Memory Extraction | Fire-and-forget async | On every 10th message | `learning/index.ts:41-103` |

No `setInterval` used anywhere — all recurring work uses `setTimeout` chains (self-re-arming after completion). This prevents overlapping executions.

#### Dashboard Executor Pattern (Reusable Template)
`DashboardExecutor` (`executor.ts`) is an excellent template for task scheduling:
- **Tier-based intervals**: IDLE (5m), ELEVATED (90s), ALERT (30s)
- **Self-healing**: Catches errors per cycle, always re-arms
- **Visibility-gated emissions**: Only sends IPC when dashboard is visible
- **External dependency injection**: `ExecutorDeps` interface for testability
- **Clean start/stop lifecycle**: `start()` / `stop()` methods

#### No Renderer-Independent Work Initiation
All work originates from renderer IPC calls. Main process cannot initiate tool loops, conversations, or LLM calls independently. Dashboard insights use `client.complete()` but only at startup in `ready-to-show`.

---

### 1.3 Conversation & Message Architecture

#### ConversationManager
**File**: `src/main/llm/conversation.ts`

- **Storage**: `Map<string, Conversation>` in memory, persisted to electron-store (`store.get('conversations')`) with 500ms debounced writes.
- **Conversation shape**: `{ id, title, createdAt, updatedAt, messages: Message[] }` (from `shared/types.ts`)
- **Message shape**: `{ id, role: 'user'|'assistant', content, createdAt, images?, documents? }`
- **Auto-pruning**: After each assistant reply, keeps last `MAX_PERSISTED_MESSAGES` (default 50).
- **Title generation**: Auto-set from first user message.

#### Programmatic Conversation Creation
**YES — `conversationManager.create(title?)` is a clean API** (`conversation.ts:66`). Called from:
- `main.ts:509` — when user sends message without conversationId
- `main.ts:591` — `CHAT_NEW` handler

No renderer dependency in `create()`. A system-initiated conversation is architecturally possible.

#### API Boundary
The boundary between "user sends message" and "process with LLM" is in the `CHAT_SEND` handler (`main.ts:503`):
1. Validate payload
2. Get/create conversation
3. Add user message to conversation
4. Create ToolLoop
5. Call `loop.run(message, history, images, documents, context)`

Steps 1-5 could be refactored into a callable function (currently inline in IPC handler).

#### History Management
Full conversation history sent to LLM, but:
- Old tool results truncated to `MAX_TOOL_RESULT_IN_HISTORY=2000` chars
- Images stripped from old results
- History trimmed to `MAX_HISTORY_TOKENS=5000` (~20K chars)
- Compaction (Opus only) at 100K tokens

---

### 1.4 Scheduling & Timing

- **No scheduling libraries** in `package.json`. No `node-cron`, `node-schedule`, or equivalent.
- **Existing patterns**: Only `setTimeout` chains (dashboard executor, session reaper).
- **Dashboard condition parser** (`condition-parser.ts`): Recursive descent parser supporting AND/OR/NOT with comparison operators. Evaluates metric expressions like `cpu > 90 AND ram > 85`. Currently used for legacy rule evaluation — could be repurposed for task triggers.
- **Dashboard `ExtendedMetrics`**: Includes temporal fields (`hour`, `minute`, `day_of_week`, `session_duration_minutes`, `minutes_since_last_message`) suitable for schedule matching.

---

### 1.5 Notification Capability

- **No Electron Notification API usage anywhere in the codebase.** Zero instances of `new Notification()` or `Notification.isSupported()`.
- **No notification permissions requested.**
- **Existing "notification" references**: Only in system prompt text (describing X/Twitter notification page), intent router signal detection, and document creation phase names.
- Electron's Notification API is available out-of-the-box — no special permissions needed on Linux (uses libnotify). macOS requires app signing for production.

---

### 1.6 Database Architecture

#### SQLite Databases

| Database | Location | Tables | Init File |
|----------|----------|--------|-----------|
| **Search Cache** | `<userData>/search-cache.sqlite` | `pages`, `searches` | `cache/search-cache.ts` |
| **Learning** | `<userData>/site-knowledge.db` | `site_knowledge`, `site_hints`, `user_memory`, `user_memory_fts` | `learning/site-knowledge.ts`, `learning/user-memory.ts` |
| **Vault** | `<userData>/clawdia_vault/vault.db` | `documents`, `document_sources`, `chunks`, `chunks_fts`, `ingestion_jobs`, `action_plans`, `actions` | `vault/db.ts` + `vault/schema.sql` |

#### Migration System
- **electron-store (JSON)**: Versioned with `CURRENT_SCHEMA_VERSION=3` and ordered `migrations[]` array. Backup before migration, clean old backups after. (`store.ts:85-213`)
- **SQLite (search cache)**: No formal migration — schema uses `CREATE TABLE IF NOT EXISTS`. Pruning on startup.
- **SQLite (learning)**: Schema created inline in constructor with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` with try/catch for idempotency.
- **SQLite (vault)**: Schema from external `schema.sql` file, applied via `db.exec(schema)`. Uses `CREATE TABLE IF NOT EXISTS` throughout.

#### Adding New Tables
**Safe and straightforward.** All SQLite databases use `IF NOT EXISTS` patterns. New tables can be added to:
- Vault: Add to `schema.sql` — automatically applied on next `initVault()` call.
- Learning DB: Add `CREATE TABLE IF NOT EXISTS` in constructor or new module sharing the same DB connection.
- New standalone DB: Follow search-cache pattern — new file, new DB path, init at startup.

**Recommendation**: Add task tables to the **vault database** — it already has the `action_plans`/`actions` ledger pattern and the infrastructure for schema management.

#### Backup/Recovery
- electron-store: Automatic backup before migration (`backupStore()`). JSON format — human-readable.
- SQLite: WAL mode enabled on all databases. No explicit backup mechanism. SQLite WAL provides crash resilience. No corruption recovery beyond SQLite's built-in mechanisms.

---

### 1.7 Security & Permissions

#### API Key Storage
- Stored in electron-store with `encryptionKey: 'clawdia-local-key'` (`store.ts:132`). This is **obfuscation, not real encryption** — the key is hardcoded in source. Provides protection against casual file browsing but not against determined access.
- Keys validated against pattern `/^sk-ant-[a-zA-Z0-9_-]+$/` (`ipc-validator.ts:26`).

#### Tool Call Restrictions
- **Shell injection prevention**: `fast-path-gate.ts` validates URLs, whitelists output directories, blocks shell metacharacters.
- **Media extract forbidden tools**: `MEDIA_EXTRACT_FORBIDDEN_BROWSER_TOOLS` set blocks visual browser tools during media extraction. `MEDIA_EXTRACT_FORBIDDEN_SHELL_RE` blocks package managers (`apt-get`, `brew`, `pip`).
- **No general permission system**: No per-tool authorization, no user-grantable permissions, no allowlists/blocklists for tool categories.

#### Data Encryption
- **None beyond electron-store obfuscation.** SQLite databases are unencrypted. Conversation history, search cache, learning data, vault documents stored in plaintext.

---

## Part 2: Compatibility Matrix

| Capability | Status | Notes |
|-----------|--------|-------|
| Run LLM tool loops without user-initiated messages | **Needs to be built** | `ToolLoop` constructor needs `mainWindow` (for IPC). Needs headless variant or null-window adapter. |
| Keep main process alive when window is closed | **Needs minor change** | Remove `app.quit()` from `window-all-closed` on Linux. Add tray icon for lifecycle control. |
| SQLite table creation for task storage | **Exists (extend)** | Vault DB has `action_plans`/`actions` tables. Add new `tasks` + `task_runs` tables to `schema.sql`. |
| Cron-style scheduling | **Needs to be added** | No scheduling library. `node-cron` (4KB, zero-dep) is the standard choice. Or build minimal cron parser. |
| OS notification sending | **Needs to be built** | Electron Notification API available, zero usage currently. ~20 lines to implement. |
| IPC channels for task management | **Needs to be built** | Add `TASK_*` channels to `ipc-channels.ts`, handlers in `main.ts`, bridge in `preload.ts`. |
| Conversation creation without renderer | **Exists** | `conversationManager.create()` has no renderer dependency. |
| Result storage and retrieval | **Needs to be built** | Add `task_runs` table with result JSON, status, timestamps. |
| Ambient context in non-user-initiated LLM calls | **Partially exists** | `collectAmbientContext()` and `getDynamicPrompt()` can be called from anywhere. System prompt builder has no renderer dependency. |

---

## Part 3: Phased Implementation Plan

### Phase 1: Task Persistence Layer

**What to build**: SQLite schema and CRUD module for persistent tasks.

**Schema Design** (add to `vault/schema.sql`):

```sql
-- PERSISTENT TASKS
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,           -- Natural language task description
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('one_time', 'scheduled', 'condition')),
    trigger_config TEXT,                 -- Cron expression, condition string, or NULL
    execution_plan TEXT DEFAULT '{}',    -- JSON: tool hints, constraints, expected steps
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed', 'archived')),
    approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('auto', 'approve_first', 'approve_always')),
    allowed_tools TEXT DEFAULT '[]',     -- JSON array of tool name patterns, empty = all
    max_iterations INTEGER DEFAULT 30,   -- Per-run tool call limit
    model TEXT,                          -- Override model, NULL = use default
    token_budget INTEGER DEFAULT 50000,  -- Max tokens per run
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_run_at INTEGER,
    next_run_at INTEGER,                 -- Pre-computed next execution time
    run_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    max_failures INTEGER DEFAULT 3,      -- Pause after N consecutive failures
    conversation_id TEXT,                -- Optional: link to originating conversation
    metadata_json TEXT DEFAULT '{}'       -- Extensible metadata
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at) WHERE status = 'active';

-- TASK EXECUTION HISTORY
CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'approval_pending')),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    duration_ms INTEGER,
    result_summary TEXT,                 -- Short summary for display
    result_detail TEXT,                  -- Full LLM output
    tool_calls_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    error_message TEXT,
    trigger_source TEXT NOT NULL DEFAULT 'scheduled' CHECK(trigger_source IN ('scheduled', 'condition', 'manual', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
```

**New files**:
- `src/main/tasks/task-store.ts` — CRUD operations: `createTask()`, `getTask()`, `listTasks()`, `updateTask()`, `deleteTask()`, `pauseTask()`, `resumeTask()`, `addRun()`, `updateRun()`, `getRunsForTask()`, `computeNextRunAt()`
- `src/shared/task-types.ts` — TypeScript interfaces: `PersistentTask`, `TaskRun`, `TaskTriggerType`, `TaskStatus`, `ApprovalMode`

**Existing code to leverage**:
- Vault DB (`vault/db.ts`) — `getVaultDB()` for database access
- Action ledger (`actions/ledger.ts`) — pattern for CRUD operations on vault tables
- `randomUUID()` for ID generation

**Complexity**: Small
**Dependencies**: None
**Risks**: Schema design must accommodate future trigger types. Using `next_run_at` pre-computation avoids full-table scans on every poll tick.

---

### Phase 2: Intent Detection

**What to build**: System prompt additions + structured response format for LLM to detect persistent task intent.

**Design**:

1. **System prompt addition** (in `system-prompt.ts`): A new section in `CORE_TOOL_RULES` that instructs the LLM to recognize persistence signals:
   - Temporal patterns: "every day", "every morning", "weekly", "check hourly"
   - Conditional triggers: "whenever", "if...then", "when X happens"
   - Persistent monitoring: "keep an eye on", "watch for", "alert me when"
   - One-time future: "tonight at 8pm", "tomorrow morning", "remind me in 2 hours"

2. **Structured detection**: When the LLM detects a persistent task, it should use a new tool `task_create` rather than just executing the task immediately. The tool requires:
   - `description`: Human-readable task summary
   - `trigger_type`: `one_time`, `scheduled`, or `condition`
   - `trigger_config`: Cron expression or condition string
   - `approval_mode`: `auto` or `approve_first`

3. **Confirmation flow**: The LLM ALWAYS confirms before creating a persistent task. It presents: what it understood, the schedule, and what tools it will use. User must say "yes" or modify.

4. **Disambiguation**: "Check my email" = do it now. "Check my email every morning" = create persistent task. The temporal modifier is the key signal. The LLM executes immediately when no persistence signal is detected.

**New files**:
- Add `task_create` tool definition to `src/main/vault/tools.ts` (alongside existing action tools)
- Add detection prompt section to `src/main/llm/system-prompt.ts`

**Existing code to leverage**:
- `intent-router.ts` — `NOTIFICATION_SIGNALS` pattern already detects temporal/scheduling language
- `task-archetype.ts` — could add `persistent-task` archetype
- Tool definition pattern from `vault/tools.ts`

**Complexity**: Medium
**Dependencies**: Phase 1 (task store)
**Risks**: LLM may over-detect or under-detect persistence signals. Confidence threshold needed. Testing with diverse prompt patterns required.

---

### Phase 3: Headless Tool Execution

**What to build**: A way to run `ToolLoop` without a user conversation or renderer window.

**Design**:

1. **HeadlessToolRunner** class: Wraps `ToolLoop` with a null/stub window for IPC emissions. Instead of sending IPC events to renderer, it captures results in memory.

2. **Architecture**:
   ```
   HeadlessToolRunner
   ├── AnthropicClient (reuse cached client from main.ts)
   ├── ToolLoop (existing class, unchanged)
   ├── NullEmitter (implements IPC emit interface, captures output)
   └── ResultCapture { text, toolCalls[], tokens, duration }
   ```

3. **Model selection per task**: Task stores preferred model. Default: Haiku for simple checks (condition evaluation, quick lookups), Sonnet for complex work (multi-step browser tasks, document creation).

4. **Token/cost limits**: Each task has `token_budget`. HeadlessToolRunner tracks usage and aborts if budget exceeded. Default 50K tokens per run.

5. **Error handling**: All errors caught and stored in `task_runs.error_message`. No user to ask for guidance — if tool loop fails, run marked as failed, task `failure_count` incremented. After `max_failures` consecutive failures, task auto-paused.

6. **Browser tool access**: Headless runs CAN use browser tools (Playwright runs in main process, not renderer). The existing BrowserView can be used if window exists, or a headless Playwright context for background-only runs.

**New files**:
- `src/main/tasks/headless-runner.ts` — `HeadlessToolRunner` class
- `src/main/tasks/null-emitter.ts` — Stub IPC emitter that captures output

**Existing code to leverage**:
- `ToolLoop` class (tool-loop.ts) — the `run()` method accepts messages directly
- `AnthropicClient` (client.ts) — `getClient()` cache in main.ts
- `getDynamicPrompt()` (system-prompt.ts) — works without renderer

**Key refactoring needed**:
- `ToolLoop` constructor currently takes `BrowserWindow` for IPC. Need to either:
  - (a) Accept an interface instead of concrete `BrowserWindow` (preferred)
  - (b) Make IPC optional with null checks
- Extract the inline logic from `CHAT_SEND` handler into a callable `executeMessage()` function

**Complexity**: Large
**Dependencies**: Phase 1 (task store for result storage)
**Risks**:
- `ToolLoop` is tightly coupled to `BrowserWindow` — refactoring needed
- Browser tools require active BrowserView; headless browser sessions need separate Playwright contexts
- Memory management — background tool loops could accumulate if not bounded

---

### Phase 4: Scheduler

**What to build**: A scheduling engine that evaluates due tasks and triggers headless execution.

**Design**:

1. **TaskScheduler** class: Modeled after `DashboardExecutor`'s polling pattern. Uses `setTimeout` chain with adaptive intervals.

2. **Tick cycle**:
   ```
   Every tick:
   1. Query tasks table: WHERE status = 'active' AND next_run_at <= now()
   2. For each due task:
      a. Check concurrent execution limit (max 2 simultaneous)
      b. Check if task is already running (skip if so)
      c. If approval_mode = 'approve_always', create run with status 'approval_pending'
      d. Otherwise, spawn HeadlessToolRunner
   3. Update next_run_at for completed tasks
   4. Check condition-based tasks against current metrics/state
   ```

3. **Intervals**:
   - Base tick: 60 seconds (matches session reaper)
   - When tasks are running: 15 seconds (check for completion)
   - When no active tasks: 5 minutes (idle)

4. **Cron parsing**: Use `node-cron` package (lightweight, well-tested) for cron expression validation and next-run computation. Alternative: Build minimal parser supporting `minute hour day-of-month month day-of-week` with `*` and `/` operators.

5. **Condition-based triggers**: Reuse `condition-parser.ts` with `ExtendedMetrics`. Check conditions on every poll cycle. Example: `"cpu > 90 AND minutes_since_last_message > 5"` → trigger task when CPU high and user idle.

6. **Concurrent execution limits**: Max 2 simultaneous headless task runs. Prevents resource exhaustion. Queue additional tasks.

7. **Overlap handling**: If a task is still running when it's due again, skip and log. `next_run_at` advances past the missed slot.

**New files**:
- `src/main/tasks/scheduler.ts` — `TaskScheduler` class
- `src/main/tasks/cron-utils.ts` — Cron parsing/next-run computation (or thin wrapper around `node-cron`)

**Existing code to leverage**:
- `DashboardExecutor` (executor.ts) — polling pattern template
- `condition-parser.ts` — condition evaluation engine
- `collectExtendedMetrics()` (metrics.ts) — current system state for condition triggers

**Complexity**: Medium
**Dependencies**: Phase 1 (task store), Phase 3 (headless runner)
**Risks**:
- Clock drift with `setTimeout` chains — use absolute timestamps (`next_run_at`) not relative intervals
- Task overlap detection needs atomic check-and-set to prevent double-execution
- Condition-based triggers evaluated every tick could be expensive if conditions involve LLM calls

---

### Phase 5: Results & Notification

**What to build**: UI and notification system for surfacing task results to the user.

**Design**:

1. **OS Notifications** (new: `src/main/tasks/notifier.ts`):
   ```typescript
   import { Notification } from 'electron';

   function notifyTaskResult(task, run) {
     if (!Notification.isSupported()) return;
     const n = new Notification({
       title: `Task ${run.status === 'completed' ? 'completed' : 'failed'}: ${task.description.slice(0, 50)}`,
       body: run.result_summary || run.error_message || '',
       silent: false,
     });
     n.on('click', () => { /* focus main window, show task details */ });
     n.show();
   }
   ```

2. **Dashboard Integration**:
   - New "TASKS" section on the command center dashboard (alongside Projects, Activity, Alerts)
   - Shows: active tasks with next run time, recent results, pending approvals
   - Pending approvals have "Approve" / "Skip" buttons
   - Click on task result opens detail view or injects summary into chat

3. **IPC Channels** (add to `ipc-channels.ts`):
   - `TASK_LIST` — list all tasks
   - `TASK_GET` — get task + recent runs
   - `TASK_CREATE` — create from renderer
   - `TASK_UPDATE` — modify task
   - `TASK_DELETE` — delete task
   - `TASK_PAUSE` / `TASK_RESUME`
   - `TASK_APPROVE_RUN` — approve pending run
   - `TASK_DISMISS_RUN` — dismiss/skip pending run
   - `TASK_RUN_NOW` — trigger immediate execution
   - Event: `TASK_UPDATE` — push task state changes to renderer

4. **In-app notification queue**: When user returns to app, show badge/indicator for unread task results. Store unread count in memory (resets on view).

**New files**:
- `src/main/tasks/notifier.ts` — OS notification wrapper
- `src/renderer/modules/tasks-ui.ts` — Task dashboard section renderer
- Add IPC channels to `ipc-channels.ts`, handlers to `main.ts`, bridge to `preload.ts`

**Existing code to leverage**:
- `DashboardState` type (dashboard-types.ts) — extend with tasks section
- Dashboard renderer (`renderer/modules/dashboard.ts`) — add tasks panel
- Alert evaluator pattern — notification on critical results

**Complexity**: Large (UI work + IPC + notification)
**Dependencies**: Phase 1 (task store), Phase 4 (scheduler, for real-time updates)
**Risks**: OS notification permissions vary by platform. Linux needs `libnotify`. macOS needs app signing. Windows works out of box.

---

### Phase 6: Task Management via Chat

**What to build**: Natural language interface for managing persistent tasks through the chat.

**Design**:

1. **New tools** (add to vault tools):
   - `task_list` — Show all tasks with status, schedule, last result
   - `task_pause` — Pause a task by name/ID match
   - `task_resume` — Resume a paused task
   - `task_delete` — Delete a task (with confirmation prompt in description)
   - `task_run_now` — Trigger immediate execution
   - `task_edit` — Modify schedule, description, or settings

2. **Name matching**: Tasks referenced by description fragment, not ID. `task_store.ts` implements fuzzy match: exact substring first, then word overlap scoring. If ambiguous, LLM presents options.

3. **System prompt addition**: Section describing available task management commands:
   ```
   TASK MANAGEMENT:
   - Use task_list to show the user's persistent tasks
   - Use task_pause/task_resume to control task execution
   - Use task_edit to modify schedules or parameters
   - When user says "show my tasks" / "what tasks do I have" → use task_list
   - When user says "stop the email checker" → use task_pause with name match
   - When user says "run it now" → use task_run_now on the referenced task
   ```

4. **Task creation flow** (from Phase 2):
   ```
   User: "Check Hacker News for AI articles every morning and summarize them"
   Clawdia: "I'll create a persistent task:
     - Schedule: Every day at 8:00 AM
     - Action: Browse Hacker News, find AI-related articles, summarize top 5
     - Model: Sonnet (needs browser navigation)
     - Approval: Auto-execute
     Shall I set this up?"
   User: "Yes"
   → task_create called → task stored → scheduler picks it up
   ```

**New files**:
- Add tool definitions to `src/main/vault/tools.ts`
- Add tool execution logic to `src/main/tasks/task-tools.ts`
- Add system prompt section to `src/main/llm/system-prompt.ts`

**Existing code to leverage**:
- Tool definition pattern from vault tools
- `executeVaultTool()` dispatch table
- Intent router signals

**Complexity**: Medium
**Dependencies**: Phase 1 (task store), Phase 2 (intent detection)
**Risks**: Natural language task references can be ambiguous. Need good fuzzy matching and LLM-driven disambiguation.

---

## Part 4: Recommended Build Order

### Build order: 1 → 2 → 3 → 4 → 5 → 6

Each phase builds on the previous, but earlier phases are independently useful:

1. **Phase 1 (Task Persistence)** — Foundation. Everything else depends on this. Pure data layer, no LLM involvement. Can be tested with direct SQL.

2. **Phase 2 (Intent Detection)** — System prompt + tool definition. Users can start creating tasks through chat even before background execution works. Tasks are stored but not yet executed automatically.

3. **Phase 3 (Headless Execution)** — The core capability. Enables `task_run_now` (manual trigger) even before scheduling exists. Also enables Phase 2's tasks to actually execute.

4. **Phase 4 (Scheduler)** — Connects the pieces. Tasks created in Phase 2 and executable via Phase 3 now run on schedule. This is when the system becomes truly autonomous.

5. **Phase 5 (Results & Notification)** — Polish. Results are already being stored (Phase 3 writes to `task_runs`). This phase makes them visible and actionable.

6. **Phase 6 (Chat Management)** — Convenience. Users can manage tasks through chat. Not strictly necessary — dashboard UI from Phase 5 covers CRUD.

### Alternative: Phases 5 and 6 can run in parallel after Phase 4.

---

## Part 5: Open Questions

### Design Decisions Needed

1. **Keep main process alive?** When user closes window, should Clawdia keep running in the background (tray icon) to execute scheduled tasks? Or only run tasks while the window is open?
   - **Recommendation**: Tray icon mode. Add "Quit" vs "Close to tray" distinction. Background execution is the whole point.

2. **Browser tools in headless mode?** Can background tasks use the browser (Playwright)? If the BrowserView is tied to the window, headless tasks may need a separate Playwright browser instance.
   - **Recommendation**: Allow browser tools via headless Playwright context (no BrowserView needed). Reuse existing CDP port logic. This is critical for tasks like "check my email" or "monitor this page".

3. **Task approval UX**: How should pending approvals be presented? OS notification with action buttons? Dashboard popup? Chat injection?
   - **Recommendation**: OS notification that opens app to dashboard approval panel. Also show in dashboard when app is already open.

4. **Cost controls**: Should there be a global daily/monthly token budget for autonomous tasks, separate from interactive usage?
   - **Recommendation**: Yes. Add `dailyAutonomousBudget` to store settings. Default to $1/day. Tasks pause when budget exhausted. Reset daily.

5. **Which database for tasks?** Vault DB (existing), new standalone DB, or learning DB?
   - **Recommendation**: Vault DB. It already has action plans/ledger, schema management via SQL file, and `getVaultDB()` accessor. Natural fit.

6. **Cron library or custom?** `node-cron` adds a dependency. Custom parser is ~100 lines but needs testing.
   - **Recommendation**: Custom minimal parser. Clawdia's needs are simple (standard cron + "every N minutes/hours"). Avoid external dependency for something this small. The LLM can translate natural language to cron expressions.

7. **Condition triggers**: Should conditions be evaluated by the LLM (expensive, flexible) or by the existing condition parser (cheap, limited)?
   - **Recommendation**: Start with the existing condition parser for metric-based conditions. Add LLM-evaluated conditions later as a premium feature. The condition parser already supports the operators needed.

8. **Task persistence across app restarts**: Should task schedules survive app restart?
   - **Recommendation**: Yes, absolutely. SQLite persistence handles this. On startup, scheduler queries for overdue tasks (where `next_run_at < now()`) and decides whether to execute them (within a grace period) or skip to next scheduled time.

9. **Maximum concurrent background tasks**: How many headless tool loops can run simultaneously?
   - **Recommendation**: 2 concurrent. Each tool loop consumes API tokens and potentially browser resources. More than 2 risks resource exhaustion and API rate limits.

10. **Should task results be stored in conversations or separately?**
    - **Recommendation**: Separately in `task_runs` table. Conversations are user-facing; task runs are system records. A "View in chat" action could create a conversation from a task run's output when the user wants to dig deeper.
