# Task Creation from Telegram - Debug Analysis

## Problem
Tasks created via Telegram appear to succeed (tool returns success message) but don't persist in the database or show up in `task_list` or on the dashboard.

## Code Path Traced

### 1. Telegram Message Flow
**File: `src/main/integrations/telegram-bot.ts`**

- Line 538-578: `handleChatMessage()` creates a TelegramEmitter and ToolLoop
- Line 562-564: Creates new ToolLoop with TelegramEmitter
- Line 565-568: Calls `loop.run()` with user message
- Line 571-572: Adds messages to conversation on success

**Key finding:** TelegramEmitter is a proper ToolLoopEmitter implementation. It doesn't interfere with tool execution.

### 2. Tool Loop Execution
**File: `src/main/llm/tool-loop.ts`**

- Line 71: `ALL_TOOLS` includes `...TASK_TOOL_DEFINITIONS` ✅
- Line 73: `TASK_TOOL_NAMES` set is properly defined ✅
- Line 556-557: Task tools are dispatched to `executeTaskTool()` ✅
- Line 1318: Tools executed in parallel via `executeToolsParallel()`
- Line 1511-1622: `runToolTask()` wraps tool execution with try/catch
  - **Line 1595-1621: Errors ARE caught and logged as `Tool error: ...`**

**Key finding:** Task tools ARE included in the tool set and ARE dispatched correctly.

### 3. Task Tool Execution
**File: `src/main/tasks/task-tools.ts`**

**Added debug logging:**
- Line 283: Log when `task_create` is called with full input
- Line 291: Log before calling `createTask()`
- Line 294: Log the returned `taskId`
- Line 297-298: Log scheduler instance presence

**Key finding:** Tool execution is NOT wrapped in try/catch that would swallow errors. Errors bubble up to tool-loop's catch handler.

### 4. Task Store
**File: `src/main/tasks/task-store.ts`**

**Added debug logging:**
- Line 66: Log when `createTask()` is called with params
- Line 69: Log VaultDB instance presence
- Line 77: Log before INSERT
- Line 97: Log INSERT success
- Line 99-102: Catch and log INSERT failures with full error + stack trace

**Key finding:** Database INSERT is wrapped in try/catch that will THROW the error (not swallow it).

### 5. Scheduler Notification
**File: `src/main/tasks/scheduler.ts`**

**Added debug logging:**
- Line 119: Log when `onTaskCreated()` is called
- Line 121-124: Log if task retrieval fails
- Line 126: Log retrieved task details

**Key finding:** Scheduler notification happens AFTER task creation succeeds.

### 6. Initialization Order
**File: `src/main/main.ts`**

- Line 1238: `initVault()` — DB initialized ✅
- Line 1241: Comment confirms "Must happen after initVault()" ✅
- Line 1297-1312: Telegram bot started AFTER vault init ✅

**Key finding:** Vault DB is initialized BEFORE Telegram bot starts. DB should be available.

## What the Debug Logs Will Reveal

When a user creates a task via Telegram, the terminal will show:

### If task creation succeeds:
```
[task-tools] [task_create] Called with input: {"description":"...","trigger_type":"..."}
[task-tools] [task_create] About to call createTask with: {...}
[task_store] [task_store] createTask called with params: {...}
[task_store] [task_store] VaultDB obtained: present
[task_store] [task_store] About to INSERT task: {...}
[task_store] [task_store] INSERT succeeded for task: <uuid> <description>
[task-store] Created task <uuid>: <description>
[task-tools] [task_create] createTask returned taskId: <uuid>
[task-tools] [task_create] Scheduler instance: present
[scheduler] [Scheduler] onTaskCreated called with taskId: <uuid>
[scheduler] [Scheduler] Task retrieved: {...}
```

### If DB is not initialized:
```
[task-tools] [task_create] Called with input: {...}
[task-tools] [task_create] About to call createTask with: {...}
[task-store] [task_store] createTask called with params: {...}
[task-store] [task_store] VaultDB obtained: null
ERROR: Vault DB not initialized. Call initVault() first.
[tool-loop] Tool: task_create: <time>ms (error)
```

### If INSERT fails (constraint violation, schema mismatch):
```
[task-store] [task_store] About to INSERT task: {...}
[task-store] [task_store] INSERT failed: <error message> Stack: <stack trace>
[tool-loop] Tool: task_create: <time>ms (error)
```

### If scheduler is null:
```
[task-tools] [task_create] createTask returned taskId: <uuid>
[task-tools] [task_create] Scheduler instance: null
```

### If task retrieval fails in scheduler:
```
[scheduler] [Scheduler] onTaskCreated called with taskId: <uuid>
[scheduler] [Scheduler] onTaskCreated: task not found for ID: <uuid>
```

## Possible Root Causes

Based on the code analysis, here are the most likely issues:

### 1. **Silent Success, Task Not Persisted** (Most Likely)
- Task creation appears to succeed in Telegram response
- BUT the task is NOT actually in the database
- **Cause:** Transaction rollback or DB not flushed to disk
- **Evidence:** No INSERT log would appear, or INSERT succeeds but SELECT afterwards returns null

### 2. **VaultDB Not Initialized**
- `getVaultDB()` throws "Vault DB not initialized" error
- Error is caught by tool-loop and returned as `Tool error: ...`
- **Evidence:** Log would show "VaultDB obtained: null" or error

### 3. **Schema Mismatch / Constraint Violation**
- INSERT fails due to missing column, type mismatch, or constraint
- Error is caught and logged
- **Evidence:** `[task_store] INSERT failed:` log with SQL error

### 4. **Scheduler Not Created**
- Task is created successfully
- But scheduler is null, so `onTaskCreated()` is never called
- Task exists but `nextRunAt` is not computed
- **Evidence:** `Scheduler instance: null` in logs

### 5. **Wrong Database File**
- Vault DB is initialized to a different path in production vs development
- Tasks are created in one DB, queries check another
- **Evidence:** INSERT succeeds but `task_list` returns empty

## Next Steps

1. **Run the app with debug logs enabled**
2. **Create a task via Telegram**
3. **Check terminal output** for the debug messages above
4. **Identify which step fails** or is skipped
5. **Check the actual DB file** to verify if the task exists:
   ```bash
   sqlite3 ~/.config/Clawdia/clawdia_vault/vault.db "SELECT id, description, status FROM tasks ORDER BY created_at DESC LIMIT 5;"
   ```

## Expected Fix

Once we identify the root cause from the logs, the fix will likely be one of:

- **If DB not initialized:** Fix initialization order or check for race condition
- **If INSERT fails:** Fix schema migration or constraint issue
- **If scheduler null:** Ensure scheduler is created before Telegram bot starts
- **If wrong DB path:** Fix path resolution in packaged vs dev environments
- **If transaction issue:** Add explicit commit or ensure WAL mode is working

## Temporary Workaround

If the issue is that tasks are created but not showing up due to scheduler issues, the user can:
1. Restart the app (scheduler will pick up existing tasks on init)
2. Use the dashboard to view tasks (bypasses Telegram conversation state)
3. Check the SQLite DB directly to confirm task exists
