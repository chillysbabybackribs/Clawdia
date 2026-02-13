# Phase 7: Self-Healing Executor Cache

Add this to the autonomous implementation plan after Phase 6.

---

Build the executor cache system that records successful task runs as replayable scripts, dramatically reducing the cost of recurring tasks. After a task's first full LLM run, subsequent runs replay deterministic steps and only call the LLM (Haiku) where actual intelligence is needed. If an executor fails, it falls back to a full LLM run and generates a new executor from the successful trace.

Reference: `docs/planning/AUTONOMOUS_FOUNDATION_PLAN.md` - this extends the headless runner from Phase 3.

## PART A: EXECUTION TRACE CAPTURE

The NullEmitter from Phase 3 captures tool call count, token usage, and streamed text. However it does NOT currently record individual tool call details (names, inputs, full results). Extend it to produce a structured execution trace by intercepting the existing IPC emissions that already flow through during a full LLM run.

The tool loop already emits three events per tool call that NullEmitter receives via `send()`:
- `TOOL_EXEC_START` → `ToolExecStartEvent { toolName, toolId, args, timestamp }`
- `TOOL_EXEC_COMPLETE` → `ToolExecCompleteEvent { toolId, status, duration, summary }`
- `CHAT_TOOL_ACTIVITY` → `ToolActivityEntry { id, name, input, status, startedAt, completedAt, durationMs, resultPreview, error }`

These types are already defined in `src/shared/types.ts` (lines 77-133).

Update: `src/main/tasks/null-emitter.ts`

Add an `executionTrace` array and a `textBetweenToolCalls` tracker:

```typescript
interface TraceStep {
  index: number;
  tool_name: string;
  tool_input: Record<string, any>;    // From TOOL_EXEC_START args
  tool_result: string;                 // From CHAT_TOOL_ACTIVITY resultPreview (200 chars max)
  full_result: string;                 // Full result — see note below
  duration_ms: number;                 // From CHAT_TOOL_ACTIVITY durationMs
  was_llm_dependent: boolean;          // Did the LLM emit reasoning text before this call?
}
```

Capture logic in `NullEmitter.send()`:

1. On `TOOL_EXEC_START`: Push a partial trace entry with `tool_name` = `args[0].toolName`, `tool_input` = `args[0].args`. Track the tool ID for correlation.

2. On `CHAT_TOOL_ACTIVITY` where `args[0].status === 'success'` or `'error'`: Find the matching partial entry by `args[0].id`, fill in `duration_ms` = `args[0].durationMs`, `tool_result` = `args[0].resultPreview`. Set `index` as the sequential position.

3. For `was_llm_dependent` detection: Track whether any `CHAT_STREAM_TEXT` emissions occurred between the previous `TOOL_EXEC_COMPLETE` and this `TOOL_EXEC_START`. If the LLM emitted reasoning text (not just whitespace) between tool calls, mark `was_llm_dependent = true`. If the LLM responded with only a `tool_use` block (no text reasoning), mark `false`. Implement via a `textSinceLastToolComplete: string` accumulator that resets on each `TOOL_EXEC_COMPLETE`.

4. For `full_result`: The `resultPreview` in `ToolActivityEntry` is truncated to 200 chars. Full results are NOT available through current IPC events. Two options:
   - **Option A (recommended)**: For executor generation purposes, the 200-char preview plus the tool name + input params is sufficient to classify steps as deterministic vs LLM-dependent. Full results aren't needed for the executor itself — only for debugging.
   - **Option B (if full results needed later)**: Add a new `TOOL_RESULT_FULL` emission in `tool-loop.ts` after line 1556 that sends `{ toolId, result }`. NullEmitter captures it. This adds ~0 overhead since it's just another `emitter.send()` call, but increases memory usage for large results.

   Start with Option A. The `full_result` field can remain empty string for now and be populated via Option B if executor generation needs it.

Add a public getter:

```typescript
getExecutionTrace(): TraceStep[] {
  return [...this.executionTrace];
}
```

## PART B: EXECUTOR GENERATION

After a successful full LLM task run, analyze the execution trace and generate an executor.

Create: `src/main/tasks/executor-generator.ts`

```typescript
function generateExecutor(task: PersistentTask, trace: TraceStep[]): TaskExecutor | null
```

The generator analyzes each step in the trace and classifies it:

### 1. DETERMINISTIC STEPS (no LLM needed on replay):

These are steps where `was_llm_dependent === false` AND all input parameters are static (not derived from a previous step's output). The actual tool names in the codebase are:

**Browser tools** (from `src/main/browser/tools.ts`):
- `browser_navigate` with a static URL → replay exactly
- `browser_click` with a static ref/selector/coordinates → replay exactly
- `browser_type` with static text → replay exactly
- `browser_read_page` → replay, store result as variable
- `browser_extract` with a static schema → replay, store result as variable
- `browser_scroll` with static direction/amount → replay exactly
- `browser_tab` with a static action → replay exactly
- `browser_fill_form` with static field values → replay exactly
- `browser_interact` with static action sequence → replay exactly
- `browser_screenshot` → replay (but result is base64, store hash or skip)

**Local tools** (from `src/main/local/tools.ts`):
- `shell_exec` with a static command → replay exactly
- `file_read` with a static path → replay, store result as variable

**Cache tools**:
- `cache_read` with a static page_id → replay, store result as variable

### 2. LLM-DEPENDENT STEPS (need intelligence on replay, but use Haiku):

Steps where `was_llm_dependent === true` — meaning the LLM emitted reasoning text (via `CHAT_STREAM_TEXT`) before issuing this tool call. This indicates the LLM processed a previous result and made a decision. Common cases:
- Search queries derived from extracted content
- Click targets chosen after reading page content
- Classification, filtering, or summarization of extracted data
- Any tool call where input params reference content from a previous tool result

### 3. TEMPLATE STEPS (variable substitution):

When a step uses output from a previous step as input. Detection: check if any value in `tool_input` contains a substring that appeared in a previous step's `tool_result`. If so, create a `{{step_N_result}}` variable reference.

Example: step 1 extracts headlines, step 2 passes headlines to LLM for filtering. The executor uses `{{step_1_result}}` variable references.

The generator produces:

```typescript
interface TaskExecutor {
  id: string;
  task_id: string;
  version: number;
  created_at: number;
  created_from_run_id: string;        // Which task_run produced this executor
  steps: ExecutorStep[];
  validation: ExecutorValidation;
  stats: {
    total_steps: number;
    deterministic_steps: number;       // Free to replay
    llm_steps: number;                 // Need Haiku call
    estimated_cost_per_run: number;    // Estimated $ based on Haiku pricing from ModelConfig
  };
}

type ExecutorStep =
  | { type: 'tool'; tool_name: string; tool_input: Record<string, any>; store_as?: string; expect?: ExpectCondition }
  | { type: 'llm'; prompt_template: string; store_as?: string; max_tokens?: number }
  | { type: 'condition'; expression: string; on_true: 'continue' | 'skip_next' | 'abort'; message?: string }
  | { type: 'result'; template: string }

interface ExecutorValidation {
  expect_result: boolean;              // Must produce a non-empty result
  max_duration_ms: number;             // Timeout for the entire executor run
  required_variables: string[];        // Variables that must be populated for success
  abort_on_empty_extract: boolean;     // If a browser extract returns nothing, abort
}

interface ExpectCondition {
  selector_exists?: string;            // CSS selector that must exist on page
  min_results?: number;                // Minimum number of extracted items
  contains_text?: string;              // Page must contain this text
  status_code?: number;                // Expected HTTP status
}
```

Note on `ExecutorStep`: The `type: 'tool'` step replaces the separate `browser`, `shell`, and `file` types from an earlier draft. This is simpler because all tool execution goes through the same dispatch functions: `executeTool()` in `src/main/browser/tools.ts` (for `browser_*` and `cache_*` tools) and `executeLocalTool()` in `src/main/local/tools.ts` (for `shell_exec`, `file_read`, `create_document`). The executor runner routes by prefix, same as `tool-loop.ts` line 517-548.

## PART C: EXECUTOR RUNNER

Create: `src/main/tasks/executor-runner.ts`

Runs a cached executor WITHOUT the full LLM tool loop. Steps through the executor's steps array sequentially.

```typescript
import { executeTool as executeBrowserTool } from '../browser/tools';
import { executeLocalTool } from '../local/tools';
import { resolveModelId } from '../../shared/models';
import { createLogger } from '../logger';

const log = createLogger('executor-runner');

class ExecutorRunner {
  private variables: Map<string, any> = new Map();
  private client: AnthropicClient;

  constructor(client: AnthropicClient) {
    this.client = client;
  }

  async run(executor: TaskExecutor): Promise<ExecutorRunResult> {
    for (const [i, step] of executor.steps.entries()) {
      try {
        const result = await this.executeStep(step, i, executor.steps.length);

        // Check expect conditions if present
        if ('expect' in step && step.expect && !this.checkExpect(step.expect, result)) {
          return { success: false, failedAt: i, reason: 'expect_failed' };
        }

        // Store result if step has store_as
        if ('store_as' in step && step.store_as) {
          this.variables.set(step.store_as, result);
        }
      } catch (error) {
        return { success: false, failedAt: i, reason: 'step_error', error };
      }
    }

    // Build final result from template
    const resultStep = executor.steps.find(s => s.type === 'result');
    const finalResult = resultStep
      ? this.interpolate((resultStep as any).template)
      : this.variables.get('summary') || 'Task completed';

    return { success: true, result: finalResult };
  }

  private async executeStep(step: ExecutorStep, index: number, total: number): Promise<any> {
    const label = `Step ${index + 1}/${total}`;

    switch (step.type) {
      case 'tool': {
        // Route to the correct executor by tool name prefix,
        // same dispatch logic as tool-loop.ts (lines 517-548).
        const interpolatedInput = this.interpolateObject(step.tool_input);
        let result: string;

        if (step.tool_name.startsWith('browser_') || step.tool_name === 'cache_read') {
          result = await executeBrowserTool(step.tool_name, interpolatedInput);
        } else {
          // shell_exec, file_read, create_document, etc.
          result = await executeLocalTool(step.tool_name, interpolatedInput);
        }

        log.info(`[Executor] ${label}: ${step.tool_name} ✓ (${result.length} chars)`);
        return result;
      }

      case 'llm': {
        // ONLY step that costs money — uses Haiku with minimal tokens.
        // Uses the existing AnthropicClient.complete() method.
        // Signature: complete(messages, { model, maxTokens }) → { text, usage }
        const prompt = this.interpolate(step.prompt_template);
        const haikuModel = resolveModelId('haiku');
        const response = await this.client.complete(
          [{ role: 'user' as const, content: prompt }],
          { model: haikuModel, maxTokens: step.max_tokens || 500 }
        );
        log.info(`[Executor] ${label}: llm (haiku) ✓ (${response.text.length} chars)`);
        return response.text;
      }

      case 'condition': {
        // Evaluate expression against current variables.
        // Used for branching: "if no results, abort"
        const condResult = this.evaluateCondition(step.expression);
        if (!condResult && step.on_true === 'abort') {
          throw new Error(step.message || 'Condition not met');
        }
        return condResult;
      }

      case 'result': {
        // Terminal step — just interpolation
        return this.interpolate(step.template);
      }
    }
  }

  private interpolate(template: string): string {
    // Replace {{variable_name}} with stored values
    // Handle nested access: {{headlines.length}}, {{articles[0].title}}
    return template.replace(/\{\{(\w+(?:[\.\[\]\w]*)*)\}\}/g, (_, key) => {
      return this.resolveVariable(key) ?? `[missing: ${key}]`;
    });
  }

  private interpolateObject(obj: Record<string, any>): Record<string, any> {
    // Deep-interpolate all string values in a tool input object
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        result[k] = this.interpolate(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = this.interpolateObject(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private resolveVariable(key: string): string | undefined {
    // Support dotted access: "headlines.length" → variables.get('headlines')?.length
    const parts = key.split('.');
    let value: any = this.variables.get(parts[0]);
    for (let i = 1; i < parts.length && value != null; i++) {
      value = value[parts[i]];
    }
    return value != null ? String(value) : undefined;
  }

  private evaluateCondition(expression: string): boolean {
    // Simple expression evaluator for executor conditions
    // Supports: "{{var}} != empty", "{{var}}.length > 0", "{{var}} contains text"
    const interpolated = this.interpolate(expression);
    if (interpolated.includes('!= empty')) {
      const val = interpolated.replace('!= empty', '').trim();
      return val !== '' && val !== '[missing]';
    }
    if (interpolated.includes('.length >')) {
      const match = interpolated.match(/(\d+)\s*>\s*(\d+)/);
      return match ? Number(match[1]) > Number(match[2]) : false;
    }
    return interpolated !== '' && !interpolated.includes('[missing:');
  }

  private checkExpect(expect: ExpectCondition, result: any): boolean {
    if (expect.contains_text && typeof result === 'string') {
      if (!result.includes(expect.contains_text)) return false;
    }
    if (expect.min_results !== undefined && typeof result === 'string') {
      // Heuristic: count newlines or JSON array items as "results"
      try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.length < expect.min_results) return false;
      } catch {
        const lines = result.split('\n').filter(l => l.trim());
        if (lines.length < expect.min_results) return false;
      }
    }
    return true;
  }
}

interface ExecutorRunResult {
  success: boolean;
  result?: string;
  failedAt?: number;
  reason?: 'expect_failed' | 'step_error';
  error?: any;
}
```

## PART D: EXECUTOR PERSISTENCE

Add to `src/main/vault/schema.sql` (as table 9, after task_runs):

```sql
-- 9. TASK EXECUTOR CACHE
CREATE TABLE IF NOT EXISTS task_executors (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    executor_json TEXT NOT NULL,          -- Full TaskExecutor serialized as JSON
    success_count INTEGER DEFAULT 0,      -- Times this executor ran successfully
    failure_count INTEGER DEFAULT 0,      -- Times this executor failed (triggers regeneration)
    total_cost_saved REAL DEFAULT 0,      -- Estimated $ saved vs full LLM runs
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_from_run_id TEXT,
    superseded_at INTEGER                 -- When a newer version replaced this one
);

CREATE INDEX IF NOT EXISTS idx_task_executors_task ON task_executors(task_id);
```

Add to `src/main/tasks/task-store.ts`:

```typescript
/** Get the latest active (non-superseded) executor for a task, or null. */
export function getExecutorForTask(taskId: string): TaskExecutor | null {
  const db = getVaultDB();
  const row = db.prepare(
    `SELECT * FROM task_executors WHERE task_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`
  ).get(taskId) as any;
  if (!row) return null;
  try {
    return JSON.parse(row.executor_json) as TaskExecutor;
  } catch {
    return null;
  }
}

/** Save a new executor, superseding any previous active version for the same task. */
export function saveExecutor(executor: TaskExecutor): void {
  const db = getVaultDB();
  const now = Math.floor(Date.now() / 1000);
  // Supersede all previous executors for this task
  db.prepare(
    `UPDATE task_executors SET superseded_at = ? WHERE task_id = ? AND superseded_at IS NULL`
  ).run(now, executor.task_id);
  // Insert new executor
  db.prepare(
    `INSERT INTO task_executors (id, task_id, version, executor_json, created_at, created_from_run_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(executor.id, executor.task_id, executor.version, JSON.stringify(executor), now, executor.created_from_run_id);
}

/** Update success/failure stats after an executor run. */
export function updateExecutorStats(executorId: string, success: boolean, costSaved: number): void {
  const db = getVaultDB();
  if (success) {
    db.prepare(
      `UPDATE task_executors SET success_count = success_count + 1, total_cost_saved = total_cost_saved + ? WHERE id = ?`
    ).run(costSaved, executorId);
  } else {
    db.prepare(
      `UPDATE task_executors SET failure_count = failure_count + 1 WHERE id = ?`
    ).run(executorId);
  }
}
```

## PART E: COST ESTIMATION UTILITIES

Create: `src/main/tasks/cost-estimator.ts`

Uses the existing `ModelConfig` data from `src/shared/models.ts` which includes `inputCostPerMTok` and `outputCostPerMTok` for each model.

```typescript
import { getModelConfig, resolveModelId } from '../../shared/models';

/**
 * Estimate the cost of a full LLM run based on a task's historical averages.
 * Uses the task's configured model (or default) pricing from ModelConfig.
 */
export function estimateFullRunCost(task: PersistentTask): number {
  // Use average tokens from recent runs, or default estimates
  const avgInputTokens = 20000;   // Typical browser task with system prompt + tool results
  const avgOutputTokens = 4000;   // Typical multi-tool response
  const modelId = resolveModelId(task.model || 'sonnet');
  const config = getModelConfig(modelId);
  if (!config) return 0.04; // Fallback estimate

  return (avgInputTokens * config.inputCostPerMTok / 1_000_000) +
         (avgOutputTokens * config.outputCostPerMTok / 1_000_000);
}

/**
 * Estimate cost of an executor run.
 * Only LLM steps cost money (Haiku). Deterministic steps are free.
 */
export function estimateExecutorCost(executor: TaskExecutor): number {
  const haikuConfig = getModelConfig(resolveModelId('haiku'));
  if (!haikuConfig) return 0.002; // Fallback

  let totalTokens = 0;
  for (const step of executor.steps) {
    if (step.type === 'llm') {
      // Estimate: prompt ~500 tokens input, max_tokens output
      totalTokens += 500 + (step.max_tokens || 500);
    }
  }

  return (totalTokens * haikuConfig.inputCostPerMTok / 1_000_000) +
         (totalTokens * haikuConfig.outputCostPerMTok / 1_000_000);
}
```

## PART F: INTEGRATION WITH HEADLESS RUNNER

Update: `src/main/tasks/headless-runner.ts`

Extend the `TaskRunResult` interface to support executor metadata:

```typescript
export interface TaskRunResult {
  runId: string;
  status: RunStatus;
  responseText: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorMessage?: string;
  // New fields for executor tracking:
  source?: 'full_llm' | 'executor';       // Which path produced this result
  executorVersion?: number;                 // If source === 'executor'
  estimatedCost?: number;                   // Estimated $ for this run
}
```

The `executeTask()` method now has a two-path flow:

```typescript
export async function executeTask(task: PersistentTask): Promise<TaskRunResult> {
  const startTime = Date.now();

  if (!deps) {
    return makeFailedResult('HeadlessToolRunner not initialized', startTime);
  }

  // 1. Check for cached executor
  const executor = getExecutorForTask(task.id);

  if (executor) {
    // PATH A: Try the cached executor (cheap)
    log.info(`[Executor] Task "${task.description}" — using executor v${executor.version}`);
    const runner = new ExecutorRunner(deps.getClient(deps.getApiKey(), resolveModelId('haiku')));
    const result = await runner.run(executor);

    if (result.success) {
      // Executor worked! Update stats
      const costSaved = estimateFullRunCost(task) - estimateExecutorCost(executor);
      updateExecutorStats(executor.id, true, costSaved);

      const durationMs = Date.now() - startTime;
      const runId = addRun({
        taskId: task.id,
        triggerSource: 'scheduled',
        status: 'completed',
      });
      updateRun(runId, {
        status: 'completed',
        completedAt: Math.floor(Date.now() / 1000),
        durationMs,
        resultSummary: (result.result || '').slice(0, 500),
        resultDetail: result.result || '',
        toolCallsCount: executor.stats.total_steps,
        inputTokens: 0,  // Executor doesn't track per-step tokens yet
        outputTokens: 0,
      });
      updateTask(task.id, {
        lastRunAt: Math.floor(Date.now() / 1000),
        runCount: (task.runCount || 0) + 1,
        failureCount: 0,
      });

      log.info(`[Executor] Completed in ${durationMs}ms, est. cost: $${estimateExecutorCost(executor).toFixed(4)} (vs $${estimateFullRunCost(task).toFixed(4)} full LLM, saved $${costSaved.toFixed(4)})`);

      return {
        runId,
        status: 'completed',
        responseText: result.result || '',
        toolCallCount: executor.stats.total_steps,
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        source: 'executor',
        executorVersion: executor.version,
        estimatedCost: estimateExecutorCost(executor),
      };
    }

    // Executor failed — log it, fall through to full LLM
    log.warn(`[Executor] v${executor.version} failed for task ${task.id} at step ${result.failedAt}: ${result.reason}. Falling back to full LLM.`);
    updateExecutorStats(executor.id, false, 0);
  }

  // PATH B: Full LLM run (expensive, but generates new executor)
  // ... existing executeTask() logic (NullEmitter + ToolLoop) ...
  // After success, add executor generation:

  const emitter = new NullEmitter();
  // ... run tool loop as before ...
  const fullResult = /* existing code */;

  if (fullResult.status === 'completed') {
    // Generate new executor from the successful trace
    const trace = emitter.getExecutionTrace();
    const newExecutor = generateExecutor(task, trace);

    if (newExecutor) {
      // Only save if the executor actually has deterministic steps
      // (no point caching if every step needs LLM)
      if (newExecutor.stats.deterministic_steps > 0) {
        saveExecutor(newExecutor);
        log.info(`[Executor] Generated v${newExecutor.version} for task ${task.id}: ${newExecutor.stats.deterministic_steps} deterministic, ${newExecutor.stats.llm_steps} LLM steps. Est. cost: $${newExecutor.stats.estimated_cost_per_run.toFixed(4)}/run`);
      } else {
        log.info(`[Executor] Skipped caching for task ${task.id}: all ${trace.length} steps are LLM-dependent`);
      }
    }
  }

  return { ...fullResult, source: 'full_llm' };
}
```

## PART G: EXECUTOR HEALTH MONITORING

Add logic to detect when executors need regeneration:

### 1. CONSECUTIVE FAILURES
If an executor fails 3 times in a row, mark it as superseded and force the next run to use full LLM (which generates a new executor).

Check in `getExecutorForTask()`:
```typescript
// After fetching the executor, check failure count
if (executor && executor.failure_count >= 3) {
  // Mark superseded, return null to force full LLM
  supersede(executor.id);
  return null;
}
```

Note: `failure_count` here is on the `task_executors` row, not the `tasks` row. Read from the DB row directly before parsing JSON.

### 2. STALENESS
If an executor hasn't been used in 30 days, mark it stale. Next run uses full LLM to verify the approach is still valid and regenerate if needed.

Add a `last_used_at` column to `task_executors` (update on each successful run), or check `created_at` + `success_count === 0` as a simpler proxy.

### 3. RESULT QUALITY (optional, off by default)
After each executor run, optionally use a Haiku call to verify the result makes sense:

```
"Does this look like a valid result for the task '[task description]'? Result: [first 500 chars]. Answer yes or no."
```

Cost: ~$0.0005. This catches cases where the page changed subtly and the executor extracts wrong data without erroring. This quality check should be configurable per task (store in `metadata_json`) and OFF by default (only enable for high-value tasks).

### 4. COST TRACKING
Track estimated cost savings per executor in the `task_executors` table. Surface this in the task dashboard items (`task-dashboard.ts`):

```
"Executor has run 47 times, saving an estimated $2.12"
```

## PART H: LOGGING AND TRANSPARENCY

Every executor run should log clearly:

```
[Executor] Task "Check HN for AI articles" — using executor v3
[Executor] Step 1/5: browser_navigate → news.ycombinator.com ✓ (120ms)
[Executor] Step 2/5: browser_extract → 30 headlines extracted ✓ (340ms)
[Executor] Step 3/5: llm (haiku) → filtered to 5 AI articles ✓ (890ms, 312 tokens)
[Executor] Step 4/5: llm (haiku) → summarized ✓ (1200ms, 487 tokens)
[Executor] Step 5/5: result → formatted ✓
[Executor] Completed in 2.55s, est. cost: $0.0018 (vs $0.041 full LLM, saved $0.039)
```

And when falling back:

```
[Executor] Task "Check HN for AI articles" — executor v3 FAILED at step 2 (selector not found)
[Executor] Falling back to full LLM run
... full tool loop logs ...
[Executor] Generated executor v4 from successful fallback run
```

## PART I: WHAT NOT TO CACHE

Some tasks should NOT get executors. `generateExecutor()` should return `null` for these cases:

1. **Tasks with `triggerType === 'condition'`** — these are reactive, not repeatable
2. **Tasks with `triggerType === 'one_time'`** — they only run once, no point caching
3. **Tasks whose trace used no browser or local tools** (pure LLM reasoning) — no deterministic steps to cache. Check: `trace.length === 0` or all steps are pure text responses.
4. **Tasks where every step has `was_llm_dependent === true`** — executor would be the same cost as a full run since every step needs a Haiku call anyway.
5. **Tasks where the trace has fewer than 2 steps** — too trivial to benefit from caching.

---

## Test Plan

1. **Create a scheduled task**: `"Check news.ycombinator.com and tell me the top 3 headlines"`
   - First run: full LLM → check logs for executor generation
   - Verify `task_executors` table has an entry with the serialized executor
   - Log should show step count, deterministic vs LLM split, estimated cost

2. **Let the task run again** (or trigger with `task_run_now`):
   - Second run should use the executor (check logs for `[Executor] using executor v3`)
   - Should complete faster and cheaper than the first run
   - `task_executors.success_count` should increment

3. **Manually break the executor** by changing the site:
   - Create a task for a page you control, then change the page structure
   - Executor should fail, fall back to full LLM, generate new executor
   - Log should show the failure, fallback, and regeneration

4. **Check cost tracking**:
   - After 5+ executor runs, verify `total_cost_saved` is accumulating
   - Log should show per-run savings

5. **Verify tasks that shouldn't get executors don't**:
   - Create a task `"What's a good recipe for pasta?"` (pure LLM, no tools)
   - Confirm no executor is generated (no deterministic steps)
   - Create a one-time task — confirm no executor generated

6. **Test executor staleness**:
   - Manually set an executor's `created_at` to 31 days ago in SQLite
   - Trigger the task — should force a full LLM run and regenerate

7. **Test consecutive failure auto-supersede**:
   - Manually corrupt an executor's JSON in the DB (break a selector)
   - Trigger 3 runs — after 3 failures, next run should skip executor entirely

---

## Cost Impact Summary

```
Without executors:
  24 runs/day × $0.04/run = $0.96/day = $29/month

With executors (after first-run cache):
  24 runs/day × $0.002/run = $0.048/day = $1.44/month

Cost reduction: ~95%
Break-even: After 2 runs of any task (1st run generates executor, 2nd run saves money)

Per-task economics:
  Full LLM run (Sonnet, browser task): ~$0.03-0.05
  Executor run (Haiku for classification + deterministic replay): ~$0.001-0.003
  Executor run (no LLM steps, pure automation): ~$0.000 (just compute time)
```

---

## Revision Log (from codebase audit)

Changes made from the original draft based on auditing the actual codebase:

| # | Issue | What Changed |
|---|-------|-------------|
| R1 | Tool name `browser_read` doesn't exist | Changed to `browser_read_page`. Added `browser_fill_form`, `browser_interact` to deterministic list. |
| R2 | `client.complete()` call signature wrong | Fixed: `complete(messages, { model, maxTokens })` → returns `{ text, usage }`, not `{ content: [{ text }] }`. |
| R3 | NullEmitter doesn't capture tool details | Expanded Part A to explain which IPC events to intercept (`TOOL_EXEC_START`, `TOOL_EXEC_COMPLETE`, `CHAT_TOOL_ACTIVITY`) with exact field mappings from `ToolExecStartEvent`, `ToolExecCompleteEvent`, `ToolActivityEntry` types in `shared/types.ts`. |
| R4 | ExecutorRunner bypassed tool infrastructure | Changed to reuse `executeTool()` from `browser/tools.ts` and `executeLocalTool()` from `local/tools.ts` with prefix-based routing (same pattern as `tool-loop.ts:517-548`), not raw Playwright. |
| R5 | No heuristic for `was_llm_dependent` | Added concrete detection: track `CHAT_STREAM_TEXT` emissions between `TOOL_EXEC_COMPLETE` and next `TOOL_EXEC_START`. If text reasoning emitted → `true`. |
| R6 | `one_time` tasks not excluded | Added `triggerType === 'one_time'` check in Part I exclusion list. |
| R7 | Haiku model ID hardcoded | Changed to `resolveModelId('haiku')` throughout, using existing function from `shared/models.ts`. |
| R8 | `estimateFullRunCost()` / `estimateExecutorCost()` undefined | Added Part E with full implementations using `ModelConfig.inputCostPerMTok` / `outputCostPerMTok` from `shared/models.ts`. |
| R9 | `TaskRunResult` missing executor fields | Extended interface with `source`, `executorVersion`, `estimatedCost` optional fields. |
| R10 | Separate step types for browser/shell/file | Unified into single `type: 'tool'` step with `tool_name` field, since all tools route through `executeTool()` / `executeLocalTool()` dispatch. Simpler and matches actual codebase dispatch pattern. |
