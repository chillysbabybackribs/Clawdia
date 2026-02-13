# Executor Cache System — Deep Technical Audit

**Date:** 2026-02-10
**Auditor:** Claude Opus 4.6
**Scope:** All files in `src/main/tasks/` related to the executor cache system, plus supporting types, schema, and integration points.

---

## 1. Executor Lifecycle — End to End

### First Run of a New Task (Trace Capture)

When a task runs for the first time, there is no cached executor. The flow:

1. **Scheduler** (`scheduler.ts:254`) calls `spawnRun(task, 'scheduled')`
2. `spawnRun()` (`scheduler.ts:314`) calls `executeTask(task)` from `headless-runner.ts`
3. `executeTask()` (`headless-runner.ts:54`) checks for a cached executor via `getExecutorForTask(task.id)` — returns `null` on first run
4. Falls through to **PATH B**: `executeFullLlmRun(task, startTime)` at line 130

Inside `executeFullLlmRun()`:
- Creates a `NullEmitter` instance (line 164) — this is the trace capture mechanism
- Creates a `ToolLoop(emitter, client)` (line 165) — same ToolLoop used for interactive chat, but with NullEmitter instead of a BrowserWindow emitter
- Optionally creates an isolated browser context via `createIsolatedContext()` (line 171) and sets it on the loop via `loop.setIsolatedPage(isolated.page)` (line 173)
- Runs the loop: `loop.run(executionPrompt, [], ...)` (line 189)
- On success, extracts the trace: `emitter.getExecutionTrace()` (line 237)
- Calls `generateExecutor(task, trace, runId)` (line 238)
- If non-null and has deterministic steps, calls `saveExecutor(newExecutor)` (line 242)

### Trace Data Structure

The trace is an array of `TraceStep` objects (`task-types.ts:101-108`):

```typescript
interface TraceStep {
    index: number;              // Sequential step number (0-based)
    tool_name: string;          // e.g. "browser_navigate", "browser_extract"
    tool_input: Record<string, any>;  // The parameters passed to the tool
    tool_result: string;        // resultPreview — truncated to 200 chars (see below)
    duration_ms: number;        // Wall-clock duration of tool execution
    was_llm_dependent: boolean; // Whether the LLM emitted reasoning text before this tool call
}
```

**Critical detail on `tool_result`:** The result stored in the trace is NOT the full tool result. It comes from `entry.resultPreview` in the `CHAT_TOOL_ACTIVITY` IPC event, which is set in `tool-loop.ts:1585` as `result.slice(0, 200)`. This means the trace only captures **the first 200 characters** of each tool result. This is adequate for variable tracking during executor generation but means the executor generator cannot inspect full page content to make decisions.

### Executor Generation

`generateExecutor()` in `executor-generator.ts` performs these steps:

**Exclusion checks (lines 43-58):**
- Returns `null` for condition-triggered tasks (line 43)
- Returns `null` for one-time tasks (line 47)
- Returns `null` if trace has < 2 steps (line 51)
- Returns `null` if ALL steps are LLM-dependent (line 55)

**Step conversion (lines 61-98):**
For each `TraceStep`:
- If `was_llm_dependent === true`: creates an `ExecutorStep` of `type: 'llm'` with a generated prompt template
- If `was_llm_dependent === false`: creates an `ExecutorStep` of `type: 'tool'` with the exact same `tool_name` and `tool_input` from the trace

**Result step (lines 100-107):**
Adds a final `type: 'result'` step that references the last stored variable via `{{varName}}` template syntax.

**Cost estimation (lines 110-121):**
For each LLM step, estimates 500 input tokens + `max_tokens` (1000) output tokens at Haiku pricing.

**Validation (lines 124-129):**
```typescript
{
    expect_result: true,
    max_duration_ms: 300000,  // 5 minutes hardcoded
    required_variables: [lastVar],  // or empty array
    abort_on_empty_extract: true if any step used browser_extract
}
```

The generated `TaskExecutor` object:
```typescript
{
    id: randomUUID(),
    task_id: task.id,
    version: 1,  // overwritten by saveExecutor()
    created_at: unix_seconds,
    created_from_run_id: runId,
    steps: ExecutorStep[],
    validation: ExecutorValidation,
    stats: {
        total_steps: number,
        deterministic_steps: number,
        llm_steps: number,
        estimated_cost_per_run: number
    }
}
```

### Executor Storage

The `task_executors` table (`schema.sql:145-157`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | UUID of this executor |
| `task_id` | TEXT NOT NULL | FK → tasks(id) ON DELETE CASCADE |
| `version` | INTEGER NOT NULL DEFAULT 1 | Auto-incremented by `saveExecutor()` |
| `executor_json` | TEXT NOT NULL | Full `TaskExecutor` object as JSON |
| `success_count` | INTEGER DEFAULT 0 | Incremented on successful executor runs |
| `failure_count` | INTEGER DEFAULT 0 | Incremented on failed executor runs |
| `total_cost_saved` | REAL DEFAULT 0 | Cumulative estimated cost savings |
| `last_used_at` | INTEGER | Unix timestamp of last use (success or failure) |
| `created_at` | INTEGER NOT NULL | Unix timestamp |
| `created_from_run_id` | TEXT | The full-LLM run ID that produced this executor |
| `superseded_at` | INTEGER | Unix timestamp when superseded (NULL = active) |

`saveExecutor()` (`task-store.ts:354-377`):
1. Queries `MAX(version)` for the task_id (line 359)
2. Sets `newVersion = maxVer + 1` (line 362)
3. Supersedes ALL previous active executors: `UPDATE task_executors SET superseded_at = ? WHERE task_id = ? AND superseded_at IS NULL` (line 367)
4. Inserts the new executor with `INSERT INTO task_executors` (line 372)

**Note:** This is NOT `INSERT OR REPLACE`. It's a clean INSERT after explicit supersede. Safe against duplicates because each executor gets a fresh UUID.

### Subsequent Runs — Decision Logic

`executeTask()` in `headless-runner.ts:54`:

```
1. executor = getExecutorForTask(task.id)  ← health check happens inside
2. if (executor) → PATH A: try executor
3. if executor succeeds → return
4. if executor fails → fall through to PATH B
5. PATH B: full LLM run → on success, generate new executor
```

`getExecutorForTask()` in `task-store.ts:321-351` performs these health checks:

```typescript
const MAX_EXECUTOR_FAILURES = 3;    // line 314
const EXECUTOR_STALE_DAYS = 30;     // line 315

// Query: latest non-superseded executor for this task
SELECT * FROM task_executors WHERE task_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1

// Check 1: Consecutive failures >= 3
if (row.failure_count >= MAX_EXECUTOR_FAILURES) {
    supersedeExecutor(row.id);  // marks superseded_at = now
    return null;                // forces full LLM run
}

// Check 2: Stale — no use in 30 days
const lastActivity = row.last_used_at || row.created_at;
if (now - lastActivity > 30 * 86400) {
    supersedeExecutor(row.id);
    return null;
}

// Parse and return the executor from JSON
return JSON.parse(row.executor_json);
```

### Executor Replay

When PATH A succeeds:
1. Creates a Haiku client: `deps.getClient(apiKey, resolveModelId('haiku'))` (line 72)
2. Creates `new ExecutorRunner(haikuClient)` (line 73)
3. Calls `runner.run(executor)` (line 74)
4. On success: `updateExecutorStats(executor.id, true, costSaved)` (line 78)
5. Records a run in `task_runs` with `status: 'completed'`, `inputTokens: 0`, `outputTokens: 0` (lines 81-95)
6. Returns result with `source: 'executor'` (line 114)

### Failure Handling

When PATH A fails (executor run returns `success: false` or throws):
- `updateExecutorStats(executor.id, false, 0)` (lines 122/125) — increments `failure_count`
- Falls through to `executeFullLlmRun()` (line 130)
- The full LLM run may generate a **new** executor on success
- Note: failure_count is NOT reset on the old executor — it accumulates until >= 3, at which point `getExecutorForTask()` supersedes it

### Auto-Supersede

Triggered by `getExecutorForTask()` when:
1. `failure_count >= 3` (MAX_EXECUTOR_FAILURES) — line 329
2. Last activity > 30 days (EXECUTOR_STALE_DAYS) — line 339

`supersedeExecutor()` (`task-store.ts:395-401`) just sets `superseded_at = now`. The old record stays in the DB forever (no DELETE).

After supersede, the next run returns `null` from `getExecutorForTask()` → full LLM run → potentially generates a new executor. There is **no limit** on how many times an executor can be regenerated.

### Cost Tracking

On successful executor run (`headless-runner.ts:77`):
```typescript
const costSaved = estimateFullRunCost(task) - estimateExecutorCost(executor);
updateExecutorStats(executor.id, true, costSaved);
```

`estimateFullRunCost()` (`cost-estimator.ts:9-18`):
- Assumes 20,000 input tokens + 4,000 output tokens
- Uses the task's configured model pricing (defaults to Sonnet)
- Sonnet 4.5: `(20000 * 3 / 1M) + (4000 * 15 / 1M)` = $0.06 + $0.06 = **$0.12 per full run**

`estimateExecutorCost()` (`cost-estimator.ts:24-40`):
- Sums only LLM steps: 500 input + max_tokens (default 500) output per step
- Uses Haiku pricing
- Haiku 4.5: `(500 * 1 / 1M) + (500 * 5 / 1M)` = **$0.003 per LLM step**

`total_cost_saved` in the DB accumulates via: `total_cost_saved = total_cost_saved + ?` (SQL UPDATE in `updateExecutorStats`, line 385).

---

## 2. Trace Capture Deep Dive

### What NullEmitter.captured[] Contains

`NullEmitter` (`null-emitter.ts`) captures ALL IPC emissions — every `send()` call from the ToolLoop gets appended:

```typescript
interface CapturedEmission {
    channel: string;   // IPC event name, e.g. 'chat:stream:text', 'chat:tool:activity'
    args: any[];       // The arguments passed to send()
    timestamp: number; // Date.now() at capture time
}
```

This includes: streamed text fragments, tool execution starts/completions, token usage updates, route info, stream end — everything the ToolLoop would normally send to a BrowserWindow.

### How the Execution Trace is Built

The `executionTrace` (separate from `captured[]`) is built from specific IPC events:

1. **`TOOL_EXEC_START`** (line 59): Creates a pending entry in `pendingTraceEntries` Map keyed by `toolId`. Sets `was_llm_dependent` to `true` if the LLM emitted reasoning text since the last tool completed (`textSinceLastToolComplete.trim().length > 0`), but **only after the first tool has completed** (`seenFirstToolComplete`).

2. **`CHAT_TOOL_ACTIVITY`** (line 73): When status is `'success'` or `'error'`, looks up the pending entry by `entry.id`, creates a `TraceStep`, and pushes to `executionTrace`. The `tool_result` is `entry.resultPreview` — which is capped at **200 chars** (set in `tool-loop.ts:1585`).

3. **`TOOL_EXEC_COMPLETE`** (line 102): Resets `textSinceLastToolComplete` to `''` and sets `seenFirstToolComplete = true`.

### What's Captured vs What's Not

**Captured in trace:**
- Tool name, full input parameters, truncated result (200 chars), duration
- Whether the step was LLM-dependent (based on text emission heuristic)

**NOT captured in trace:**
- Full tool results (only 200 chars)
- LLM reasoning text between tool calls
- Token counts per individual API call
- The actual messages in the conversation history
- Any `sequential_thinking` usage (no filter exists — sequential_thinking calls ARE included if they generate IPC events, but grep confirms no special handling)

### Filtering

There is **no filtering** of specific tool types from the trace. Every tool call that goes through `TOOL_EXEC_START` → `CHAT_TOOL_ACTIVITY` gets included. This means `sequential_thinking` calls, if they emit these events, would be included in the trace.

### Maximum Trace Size

There is **no truncation or size limit** on the trace. A task that makes 50 tool calls will produce a 50-element trace. The entire trace gets serialized into `executor_json` in the DB. For a task with 30 iterations × ~1 tool call each, the JSON would be roughly 10-30KB — manageable for SQLite.

---

## 3. Executor Generation Deep Dive

### Generation Method

The executor is generated **entirely by local code** — NOT by an LLM call. `generateExecutor()` in `executor-generator.ts` is a pure TypeScript function that mechanically transforms the trace into executor steps. **No LLM is involved in executor generation.**

This is a critical architectural decision: the executor is a deterministic replay plan derived from the trace structure, not an LLM-interpreted summary.

### How Steps Are Distinguished

The `was_llm_dependent` flag is set by `NullEmitter` based on a heuristic:

```
was_llm_dependent = seenFirstToolComplete && textSinceLastToolComplete.trim().length > 0
```

Translation:
- The first tool call is **always `was_llm_dependent = false`** (because `seenFirstToolComplete` starts as `false`)
- Subsequent tool calls are **LLM-dependent if the model emitted any text** between the previous tool completion and this tool's start
- This heuristic assumes: if the LLM "thought out loud" before calling a tool, it needed reasoning to decide what to do, so it can't be deterministically replayed

**Flaw in the heuristic:** The LLM often emits brief acknowledgment text ("I'll search for that now") before deterministic tool calls. This text triggers `was_llm_dependent = true` even though the tool call is fully deterministic. This means **the executor will over-classify steps as LLM-dependent**, leading to more Haiku calls than necessary and potentially triggering the "all steps LLM-dependent" exclusion.

### LLM Prompt Template Generation

For LLM-dependent steps, `buildLlmPromptTemplate()` (line 157) generates:

```
Previous step result (step_0_result): {{step_0_result}}
Previous step result (step_2_result): {{step_2_result}}

Given the above context, determine the appropriate action.
The next action should use browser_extract with appropriate parameters.
Parameters to decide: {"selector":".article-body","format":"text"}
Provide just the result or the parameter values needed.
```

This template is static — variables get interpolated at runtime via `{{varName}}` syntax.

### Concrete Example of a Generated Executor

For a task "Check Hacker News front page daily":

```json
{
    "id": "uuid-1",
    "task_id": "task-uuid",
    "version": 1,
    "created_at": 1707580000,
    "created_from_run_id": "run-uuid",
    "steps": [
        {
            "type": "tool",
            "tool_name": "browser_navigate",
            "tool_input": { "url": "https://news.ycombinator.com" },
            "store_as": undefined
        },
        {
            "type": "tool",
            "tool_name": "browser_extract",
            "tool_input": { "selector": ".titleline", "format": "text" },
            "store_as": "step_1_result"
        },
        {
            "type": "result",
            "template": "{{step_1_result}}"
        }
    ],
    "validation": {
        "expect_result": true,
        "max_duration_ms": 300000,
        "required_variables": ["step_1_result"],
        "abort_on_empty_extract": true
    },
    "stats": {
        "total_steps": 3,
        "deterministic_steps": 2,
        "llm_steps": 0,
        "estimated_cost_per_run": 0
    }
}
```

### Conditional Logic Handling

The `generateExecutor()` function does **NOT generate condition steps**. The `ExecutorStep` type includes a `type: 'condition'` variant (`task-types.ts:120`), and `ExecutorRunner` handles it (lines 111-117), but `generateExecutor()` never creates condition steps. Conditions can only exist if manually crafted or if a future version of the generator is implemented.

### Generation Failure

If `generateExecutor()` throws, it's caught in `headless-runner.ts:248`:
```typescript
} catch (genErr: any) {
    log.warn(`[Executor] Failed to generate executor for task ${task.id}: ${genErr?.message}`);
}
```
The task remains fully functional — it just runs full LLM every time. Executor generation is explicitly non-critical.

---

## 4. Executor Runner Deep Dive

### ExecutorRunner.run() Walk-through

`executor-runner.ts:30-73`:

```typescript
async run(executor: TaskExecutor): Promise<ExecutorRunResult> {
    const startMs = Date.now();
    const totalSteps = executor.steps.length;

    for (const [i, step] of executor.steps.entries()) {
        // 1. Check timeout against validation.max_duration_ms (300s)
        if (elapsed > executor.validation.max_duration_ms) → return failure

        // 2. Execute the step via executeStep()
        const result = await this.executeStep(step, i, totalSteps);

        // 3. Check expect conditions (if step has them)
        if (step.expect && !this.checkExpect(step.expect, result)) → return failure

        // 4. Store result in variables map
        if (step.store_as) this.variables.set(step.store_as, result);
    }

    // 5. Find the 'result' step, interpolate its template
    const resultStep = executor.steps.find(s => s.type === 'result');
    const finalResult = resultStep ? this.interpolate(resultStep.template)
                       : this.variables.get('summary') || 'Task completed';

    return { success: true, result: finalResult };
}
```

### Step Execution by Type

**Tool steps** (lines 80-95):
```typescript
case 'tool': {
    const interpolatedInput = this.interpolateObject(step.tool_input);
    if (step.tool_name.startsWith('browser_') || step.tool_name === 'cache_read') {
        result = await executeBrowserTool(step.tool_name, interpolatedInput);
    } else {
        result = await executeLocalTool(step.tool_name, interpolatedInput);
    }
}
```

**Important:** The executor runner calls `executeBrowserTool()` and `executeLocalTool()` directly — the **exact same functions** used by the ToolLoop. However, it does NOT pass an `overridePage` parameter to `executeBrowserTool()`. This means **executor tool steps use the interactive BrowserView page, NOT an isolated context.**

This is a significant difference from the full LLM path, which creates an isolated browser context. The executor runner operates on whatever page state exists in the shared BrowserView.

**LLM steps** (lines 97-108):
```typescript
case 'llm': {
    const prompt = this.interpolate(step.prompt_template);
    const haikuModel = resolveModelId('haiku');  // Always Haiku
    const response = await this.client.complete(
        [{ role: 'user', content: prompt }],
        { model: haikuModel, maxTokens: step.max_tokens || 500 },
    );
    return response.text;
}
```

Confirmed: LLM steps use **Haiku** (via `resolveModelId('haiku')`) with `client.complete()` (non-streaming).

**Condition steps** (lines 111-117):
```typescript
case 'condition': {
    const condResult = this.evaluateCondition(step.expression);
    if (!condResult && step.on_true === 'abort') {
        throw new Error(step.message || 'Condition not met');
    }
    return condResult;
}
```

The condition evaluation is simplistic: handles `!= empty` and `.length > N` patterns via regex. Not a full expression evaluator.

### Failure Handling

Any exception in `executeStep()` is caught by the try/catch in `run()` (line 57):
```typescript
return { success: false, failedAt: i, reason: 'step_error', error };
```

The executor **aborts on first failure** — no retry, no skip. The entire remaining step sequence is abandoned.

Back in `headless-runner.ts`, on failure:
1. `updateExecutorStats(executor.id, false, 0)` — increments failure_count
2. Falls through to `executeFullLlmRun()` — does a complete LLM run
3. If the full LLM run succeeds, generates a NEW executor (potentially superseding the failed one on next `saveExecutor()` call)

### Variable Interpolation

`interpolate()` (line 128): Replaces `{{varName}}` with resolved variable values. Supports dot notation (`step_1_result.title`) and bracket notation (`articles[0]`).

`interpolateObject()` (line 134): Recursively interpolates all string values in an object, handling nested objects and arrays.

`resolveVariable()` (line 154): Traverses nested object paths. Returns `undefined` if path doesn't resolve, which becomes `[missing: varName]` in the interpolated string.

### Output

A successful executor run returns:
```typescript
{ success: true, result: "interpolated final result string" }
```

This is a single string, not the rich multi-tool result that a ToolLoop produces. The scheduler records it in `task_runs.result_summary` (first 500 chars) and `result_detail` (full string).

---

## 5. Health Check & Supersede Logic

### Decision Code

`getExecutorForTask()` at `task-store.ts:321-351`:

```typescript
// Query
SELECT * FROM task_executors
WHERE task_id = ? AND superseded_at IS NULL
ORDER BY version DESC LIMIT 1

// Health check 1: failures
if (row.failure_count >= 3) {
    supersedeExecutor(row.id);
    return null;
}

// Health check 2: staleness
const lastActivity = row.last_used_at || row.created_at;
if (now - lastActivity > 30 * 24 * 3600) {  // 2,592,000 seconds
    supersedeExecutor(row.id);
    return null;
}
```

### Thresholds

| Condition | Value | Constant |
|-----------|-------|----------|
| Max consecutive failures | 3 | `MAX_EXECUTOR_FAILURES` (line 314) |
| Staleness threshold | 30 days | `EXECUTOR_STALE_DAYS` (line 315) |

**Note:** "consecutive failures" is misleading in the code comment. The `failure_count` column is incremented on every failure but is **never reset on success**. So it's actually "total failures", not "consecutive failures". A successful run increments `success_count` but does NOT reset `failure_count`.

### What Happens to Old Executors

When superseded, `supersedeExecutor()` sets `superseded_at = now`. The record persists in the DB indefinitely. There is no cleanup/pruning of old executor records.

After supersede, the next call to `getExecutorForTask()` returns `null` → full LLM run → potentially `saveExecutor()` which:
1. Supersedes all remaining active executors (safety net — but there shouldn't be any after the health check already superseded one)
2. Inserts a new executor with `version = MAX(version) + 1`

### No Regeneration Limit

There is **no maximum** on how many executor versions can be created for a single task. If a task's executor keeps failing after 3 uses, it gets superseded, a new full LLM run generates a new one, and the cycle repeats.

---

## 6. Cost Analysis

### Pricing Data Source

`cost-estimator.ts` uses `getModelConfig()` from `src/shared/models.ts`, which contains hardcoded pricing:

| Model | Input ($/MTok) | Output ($/MTok) |
|-------|----------------|-----------------|
| Haiku 4.5 | $1 | $5 |
| Sonnet 4.5 | $3 | $15 |
| Sonnet 4 | $3 | $15 |
| Opus 4.6 | $5 | $25 |
| Opus 4.5 | $5 | $25 |

### Full LLM Run Cost Estimate

`estimateFullRunCost()` uses fixed assumptions:
- 20,000 input tokens
- 4,000 output tokens
- Model: task's model or Sonnet (default)

For Sonnet 4.5: `(20000 * 3 / 1M) + (4000 * 15 / 1M)` = $0.06 + $0.06 = **$0.12**

### Executor Run Cost Estimate

`estimateExecutorCost()` sums per-LLM-step:
- 500 input tokens + max_tokens (default 500) output tokens per step
- Model: always Haiku

For Haiku 4.5 per LLM step: `(500 * 1 / 1M) + (500 * 5 / 1M)` = **$0.003**

For a fully deterministic executor (0 LLM steps): **$0.00**

### Cost Accuracy

**The estimates are rough approximations:**
- Full LLM runs could easily use 50K-100K input tokens with tool results, making the 20K estimate low by 2-5x
- Executor LLM steps assume 500 input tokens, but the prompt template with interpolated variables could be much larger
- Neither estimate accounts for cache reads (discounted tokens)
- The actual Anthropic bill may differ significantly from these estimates

### Break-Even Point

For a fully deterministic executor:
- Generation cost: $0 (no LLM call in `generateExecutor()` — it's pure code)
- The first full LLM run costs ~$0.12
- Every subsequent executor run costs $0
- **Break-even: immediate** (the first executor run saves the full cost)

For an executor with 2 LLM steps:
- Executor run cost: 2 × $0.003 = $0.006
- Savings per run: $0.12 - $0.006 = $0.114
- **Break-even: first executor run** (saves $0.114)

The "95% cost reduction" claim is realistic for tasks with mostly deterministic steps. For tasks where every step is LLM-dependent, no executor is generated (exclusion check at line 55).

---

## 7. Implementation Status

### COMPLETE

| Component | Evidence |
|-----------|----------|
| `TraceStep` type definition | `task-types.ts:101-108` |
| `TaskExecutor` type definition | `task-types.ts:130-144` |
| `ExecutorStep` discriminated union | `task-types.ts:117-121` — 4 types: tool, llm, condition, result |
| `ExecutorRunResult` type | `task-types.ts:146-152` |
| `NullEmitter` trace capture | `null-emitter.ts` — captures IPC events, builds execution trace |
| `generateExecutor()` | `executor-generator.ts` — transforms trace to executor steps |
| `ExecutorRunner.run()` | `executor-runner.ts` — step-by-step execution with variable interpolation |
| `saveExecutor()` | `task-store.ts:354-377` — auto-version increment, supersede previous |
| `getExecutorForTask()` with health checks | `task-store.ts:321-351` — failure count + staleness |
| `updateExecutorStats()` | `task-store.ts:380-392` — success/failure/cost_saved tracking |
| `supersedeExecutor()` | `task-store.ts:395-401` |
| `task_executors` table | `schema.sql:145-159` — all columns, index |
| `headless-runner.ts` two-path execution | Lines 67-131 — tries executor first, falls back to full LLM |
| Executor generation after successful full LLM run | `headless-runner.ts:236-251` |
| Cost estimation | `cost-estimator.ts` — both full run and executor run |
| `TaskRunResult.source` field | `headless-runner.ts:28` — `'full_llm' | 'executor'` discriminator |
| Scheduler integration | `scheduler.ts` calls `executeTask()` which contains the two-path logic |
| Zombie run cleanup | `task-store.ts:410-420` — cleans up stale 'running' records on startup |

### PARTIAL

| Component | Status | Notes |
|-----------|--------|-------|
| `was_llm_dependent` heuristic | Functional but over-classifies | Any LLM text emission marks the step as dependent, including brief acknowledgments |
| Condition step execution | Runner supports it, generator never creates them | `ExecutorRunner` handles `type: 'condition'` but `generateExecutor()` never emits them |
| Expect conditions | Runner checks them, generator creates `abort_on_empty_extract` | Only `expect_result` and `abort_on_empty_extract` are set in validation, but `checkExpect()` supports `contains_text` and `min_results` |
| Cost tracking in scheduler | Daily budget tracks actual token costs | But executor runs report `inputTokens: 0, outputTokens: 0` so their Haiku API calls are invisible to the daily budget |
| Browser isolation for executor runs | **Missing** | Executor runner calls `executeBrowserTool()` without `overridePage` — uses the shared BrowserView, not an isolated context |

### STUBBED/MISSING

| Component | Status | Impact |
|-----------|--------|--------|
| Executor status in UI | **MISSING** | Grep for 'executor' in `src/renderer/` returns 0 results. Users cannot see whether a task has a cached executor, its version, success/failure counts, or cost savings |
| Manual executor invalidation | **MISSING** | No IPC handler, no tool, no UI to force-regenerate an executor |
| `task_runs` source column | **MISSING from schema** | The `task_runs` table has no column to record whether a run used an executor or full LLM. The `TaskRunResult.source` field exists in TypeScript but is never persisted |
| `interpolateReferences()` | **STUBBED** | `executor-generator.ts:186-194` — returns `{ ...input }` unchanged. The comment says "deterministic steps have static params" but this prevents cross-step data flow in the executor for deterministic steps |
| Executor + condition-triggered tasks | **Excluded by design** | `generateExecutor()` returns `null` for `triggerType === 'condition'` (line 43). Condition tasks always use full LLM |
| Executor for browser-isolated tasks | **Not connected** | The headless runner creates an isolated context for full LLM runs but executor runner does not |

---

## 8. Edge Cases & Risks

### DOM Structure Changes

If a site changes its DOM, cached selectors in executor steps like `{"selector": ".titleline"}` will fail. The executor runner catches the error (`run()` line 57) and returns `{ success: false, failedAt: i, reason: 'step_error' }`. This increments `failure_count` and falls back to full LLM. After 3 failures, the executor is superseded and a new one is generated from the next full LLM run.

**Risk level: Medium.** Self-healing works but costs 3 failed executor attempts + 3 full LLM fallback runs before regeneration.

### Tool Modifications

If a tool's function signature changes (e.g., `browser_extract` gains a new required param), the executor's stored `tool_input` won't have it. The tool will either throw (caught by executor runner) or produce unexpected results.

**Risk level: Low.** Tool APIs within this codebase are stable, and any failure triggers the fallback path.

### Cookie / Session Mismatch

**This is a real problem.** The executor runner calls `executeBrowserTool()` WITHOUT an `overridePage` parameter. Looking at `tools.ts:597`:

```typescript
export async function executeTool(name: string, input: any, overridePage?: Page | null)
```

The executor runner at `executor-runner.ts:87` calls:
```typescript
result = await executeBrowserTool(step.tool_name, interpolatedInput);
// Note: no third argument — overridePage defaults to null
```

This means executor runs use whatever browser state exists in the shared BrowserView. If:
- The user is browsing a different site → navigation will disrupt their session
- The shared BrowserView has different cookies than the original trace → auth-dependent tasks will fail
- No BrowserView exists (window hidden via tray) → `getActivePage()` may return null → error

The full LLM path uses `createIsolatedContext()` + `loop.setIsolatedPage()`, which is much safer. The executor path lacks this isolation entirely.

**Risk level: HIGH.** This is a correctness bug — executor runs will interfere with the user's active browsing session.

### Race Condition: Concurrent Executor Generation

The scheduler has `MAX_CONCURRENT = 2` (line 48). If the same task ID is somehow triggered twice (shouldn't happen due to `hasRunningRun()` check but race is possible), both could:
1. Both find no executor → both run full LLM → both call `generateExecutor()` → both call `saveExecutor()`
2. `saveExecutor()` runs `UPDATE SET superseded_at` + `INSERT`. If both run near-simultaneously:
   - Thread A supersedes nothing, inserts version 1
   - Thread B supersedes A's version 1, inserts version 2
   - Result: version 1 is superseded, version 2 is active — correct outcome, just wasteful

**Risk level: Low.** SQLite's default serialization handles this. The `MAX(version)` query + supersede + insert are not in a transaction, but SQLite's single-writer lock prevents true concurrency.

Actually, looking more carefully: `saveExecutor()` does NOT wrap its operations in a transaction. The three operations (query MAX, UPDATE supersede, INSERT) are separate statements. In theory, between the MAX query and the INSERT, another call could also query MAX and get the same value. Both would try to INSERT with the same version number. Since `version` is not UNIQUE-constrained in the schema, both inserts would succeed with the same version. This is a minor data integrity issue but not catastrophic.

### Invalid Executor JSON

If `JSON.stringify(executor)` produces valid JSON but `JSON.parse()` later fails (shouldn't happen), `getExecutorForTask()` catches at line 347:
```typescript
} catch {
    log.error(`Failed to parse executor JSON for ${row.id}`);
    return null;
}
```
Returns `null` → full LLM run. But the corrupt executor is never superseded — it will keep being loaded and failing to parse on every call until staleness kicks in (30 days).

**Risk level: Low** (JSON round-trip failures are extremely rare), but the lack of auto-supersede on parse failure is a gap.

### Failure Count Is Never Reset

`updateExecutorStats()` (line 380-392):
- On success: increments `success_count`, adds to `total_cost_saved`, updates `last_used_at`
- On failure: increments `failure_count`, updates `last_used_at`

**`failure_count` is never decremented or reset.** An executor that succeeds 100 times but fails 3 times total (not necessarily consecutively) will be superseded. This is overly aggressive — the intent seems to be "3 consecutive failures" but the implementation is "3 total failures ever."

**Risk level: Medium.** Long-running tasks with occasional transient failures (network blips, site downtime) will get their executors superseded unnecessarily, forcing an expensive full LLM regeneration.

---

## 9. Recommendations

### Broken / Will Fail at Runtime

1. **Executor runs use the shared BrowserView (no isolation)**
   - `executor-runner.ts:87` calls `executeBrowserTool(step.tool_name, interpolatedInput)` without `overridePage`
   - Will interfere with user's active browsing, fail if BrowserView doesn't exist, or produce incorrect results with wrong cookies
   - **Fix:** Pass an isolated page to `ExecutorRunner`, create isolated context in `executeTask()` before the executor run, similar to the full LLM path

2. **`failure_count` never resets — acts as "total failures" not "consecutive failures"**
   - After 3 transient failures across hundreds of runs, a perfectly good executor gets superseded
   - **Fix:** Reset `failure_count` to 0 on success: add `failure_count = 0` to the success UPDATE in `updateExecutorStats()`

3. **Corrupt executor JSON causes infinite retry loop**
   - `getExecutorForTask()` returns `null` on parse failure but doesn't supersede the bad record
   - Next call loads the same record, fails again — forever until 30-day staleness
   - **Fix:** Call `supersedeExecutor(row.id)` in the catch block at line 347

### Implemented but Not Connected

4. **Executor runs invisible to daily cost tracking**
   - `headless-runner.ts:93-94` sets `inputTokens: 0, outputTokens: 0` for executor runs
   - `scheduler.ts:416-424` tracks costs based on `result.inputTokens/outputTokens`
   - Haiku API calls made by executor LLM steps are not counted in the daily budget
   - **Fix:** Track actual Haiku token usage in `ExecutorRunner` and populate the fields

5. **`TaskRunResult.source` field not persisted**
   - `task_runs` table has no `source` column — can't distinguish executor runs from full LLM runs in the DB
   - The field exists on the TypeScript return type but is thrown away on persistence
   - **Fix:** Add `source TEXT` column to `task_runs`, populate in `updateRun()`

6. **Executor info not visible to user**
   - No renderer code references executors. Users can't see:
     - Whether a task has a cached executor
     - Executor version, success/failure counts
     - Cost savings
     - Whether a specific run used executor or full LLM
   - **Fix:** Add executor status to task list/detail UI, expose via IPC

7. **No manual executor invalidation**
   - If a user knows a site has changed, they can't force regeneration
   - Currently must wait for 3 failures + fallback
   - **Fix:** Add `task_invalidate_executor` tool and/or UI button

### Missing for "95% Cost Reduction" Promise

8. **`interpolateReferences()` is a no-op**
   - `executor-generator.ts:186-194` — returns input unchanged
   - Cross-step data flow for deterministic steps is broken (e.g., extracting a URL from step 1 and navigating to it in step 2)
   - This severely limits which tasks can be deterministically replayed
   - **Fix:** Implement actual reference detection — compare step inputs to previous step outputs

9. **Condition-triggered tasks excluded from executor caching**
   - `executor-generator.ts:43-46` returns `null` for condition tasks
   - Many monitoring tasks (disk alerts, price watchers) are condition-triggered
   - These could benefit from executors after the first successful run
   - **Fix:** Remove the blanket exclusion; generate executors for condition tasks that have stable execution patterns

10. **`was_llm_dependent` heuristic over-classifies**
    - Any streamed text (including "Let me check that") marks the next step as LLM-dependent
    - Results in more Haiku calls than necessary during executor replay
    - **Fix:** Consider tool-name-based classification (navigations are always deterministic) or a stricter text threshold

### Priority Order

| Priority | Item | Impact |
|----------|------|--------|
| **P0 — Bug** | #1 Browser isolation missing for executor runs | Executor runs will break user's browsing session |
| **P0 — Bug** | #2 failure_count never resets | Good executors get killed by transient failures |
| **P1 — Data** | #5 Source not persisted in task_runs | Can't analyze executor effectiveness |
| **P1 — Data** | #4 Executor Haiku costs invisible to budget | Could exceed daily budget silently |
| **P1 — Feature** | #8 interpolateReferences is a no-op | Limits which tasks can be cached |
| **P2 — UX** | #6 No executor visibility in UI | Users fly blind on cost savings |
| **P2 — UX** | #7 No manual invalidation | Users can't respond to known changes |
| **P2 — Correctness** | #3 Corrupt JSON infinite loop | Edge case but easy fix |
| **P3 — Optimization** | #9 Condition tasks excluded | Missed caching opportunity |
| **P3 — Optimization** | #10 Over-classification of LLM steps | Minor cost increase |

---

## Appendix: File Index

| File | Lines | Role |
|------|-------|------|
| `src/shared/task-types.ts` | 153 | Type definitions for all executor-related interfaces |
| `src/main/tasks/executor-generator.ts` | 208 | Transforms execution trace → `TaskExecutor` (pure code, no LLM) |
| `src/main/tasks/executor-runner.ts` | 209 | Replays `TaskExecutor` step-by-step with Haiku for LLM steps |
| `src/main/tasks/cost-estimator.ts` | 41 | Rough cost estimates for full LLM vs executor runs |
| `src/main/tasks/headless-runner.ts` | 330 | Two-path orchestrator: executor → fallback → generate |
| `src/main/tasks/null-emitter.ts` | 134 | IPC sink that captures trace during full LLM runs |
| `src/main/tasks/task-store.ts` | 448 | SQLite CRUD for tasks, runs, and executors |
| `src/main/tasks/scheduler.ts` | 509 | Timer-based task evaluation + cost budget enforcement |
| `src/main/tasks/task-tools.ts` | 528 | LLM-facing tool definitions for task CRUD |
| `src/main/vault/schema.sql` | 160 | DDL for all tables including `task_executors` |
