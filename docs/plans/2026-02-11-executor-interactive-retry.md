# Executor Cache: Interactive Pipeline Integration + Per-Step Retry

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the executor cache system to work with interactive LLM calls (not just scheduled tasks), and add per-step retry logic so transient failures don't immediately trigger expensive full LLM fallbacks.

**Architecture:** Two additions to the existing executor system: (A) A `TracingEmitter` wrapper captures execution traces from interactive chat calls, generates executors after success, and checks for matching executors before making LLM calls. (B) `ExecutorRunner` retries each failed step once (1s backoff) before aborting. Both changes integrate with existing components — no ToolLoop modifications needed.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, Electron IPC

---

## Context for the Implementer

### Existing Architecture (Read These First)

- `src/main/tasks/executor-runner.ts` — Replays cached executors step-by-step using tool dispatch + Haiku LLM calls
- `src/main/tasks/executor-generator.ts` — Pure TypeScript function that converts execution traces into replayable executor steps
- `src/main/tasks/headless-runner.ts` — Two-path orchestrator for scheduled tasks: try executor → fallback to full LLM → generate new executor
- `src/main/tasks/task-store.ts` — SQLite CRUD for tasks, runs, and executor storage/health checks
- `src/main/tasks/null-emitter.ts` — Captures IPC events into execution traces during headless runs
- `src/main/llm/chat-pipeline.ts` — Interactive chat orchestration (currently has NO executor integration)
- `src/main/llm/tool-loop.ts` — Interactive tool execution loop (builds `cacheKey` at line 852, records to `strategyCache` at line 1310)
- `src/main/llm/strategy-cache.ts` — Session-scoped hint cache (text hints only, does NOT replay)
- `src/shared/task-types.ts` — Type definitions for TraceStep, TaskExecutor, ExecutorStep, etc.
- `src/shared/ipc-channels.ts` — IPC event names
- `src/main/vault/schema.sql` — Database schema including `task_executors` table

### Key Design Decisions

1. **Cache key:** `archetype + primaryHost + toolSequence` (hybrid). Matches by task type + site + exact tool path.
2. **Retry:** 1 retry per failed step (1s backoff). Not full executor restart.
3. **UX:** Fast execution with "cached" badge. Tools fire visibly but no LLM thinking.
4. **Scope:** New `interactive_executors` SQLite table (separate from scheduled task executors).

---

## Task 1: Add Per-Step Retry to ExecutorRunner

**Files:**
- Modify: `src/main/tasks/executor-runner.ts:37-64`
- Test: `src/main/tasks/executor-runner.test.ts`

**Step 1: Write the failing test**

Add to `src/main/tasks/executor-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// At the top of the test file, add these test cases:

describe('ExecutorRunner retry logic', () => {
    it('retries a failed step once before aborting', async () => {
        // Mock a tool that fails once then succeeds
        let callCount = 0;
        vi.doMock('../browser/tools', () => ({
            executeTool: vi.fn(async () => {
                callCount++;
                if (callCount === 1) throw new Error('Network timeout');
                return 'success result';
            }),
        }));
        vi.doMock('../local/tools', () => ({
            executeLocalTool: vi.fn(async () => 'local result'),
        }));

        const { ExecutorRunner } = await import('./executor-runner');
        const mockClient = { complete: vi.fn() } as any;
        const runner = new ExecutorRunner(mockClient);

        const executor = {
            id: 'exec-1',
            task_id: 'task-1',
            version: 1,
            created_at: 1000,
            created_from_run_id: 'run-1',
            steps: [
                { type: 'tool' as const, tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' }, store_as: 'step_0_result' },
            ],
            validation: { expect_result: true, max_duration_ms: 300000, required_variables: [], abort_on_empty_extract: false },
            stats: { total_steps: 1, deterministic_steps: 1, llm_steps: 0, estimated_cost_per_run: 0 },
        };

        const result = await runner.run(executor);
        expect(result.success).toBe(true);
        expect(callCount).toBe(2); // First attempt + 1 retry
    });

    it('aborts after retry exhaustion (2 failures)', async () => {
        vi.doMock('../browser/tools', () => ({
            executeTool: vi.fn(async () => { throw new Error('Permanent failure'); }),
        }));
        vi.doMock('../local/tools', () => ({
            executeLocalTool: vi.fn(async () => { throw new Error('Permanent failure'); }),
        }));

        const { ExecutorRunner } = await import('./executor-runner');
        const mockClient = { complete: vi.fn() } as any;
        const runner = new ExecutorRunner(mockClient);

        const executor = {
            id: 'exec-1',
            task_id: 'task-1',
            version: 1,
            created_at: 1000,
            created_from_run_id: 'run-1',
            steps: [
                { type: 'tool' as const, tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
            ],
            validation: { expect_result: true, max_duration_ms: 300000, required_variables: [], abort_on_empty_extract: false },
            stats: { total_steps: 1, deterministic_steps: 1, llm_steps: 0, estimated_cost_per_run: 0 },
        };

        const result = await runner.run(executor);
        expect(result.success).toBe(false);
        expect(result.failedAt).toBe(0);
        expect(result.reason).toBe('step_error');
    });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/tasks/executor-runner.test.ts --reporter=verbose`
Expected: FAIL — current code doesn't retry, so the "retries once" test will fail

**Step 3: Implement per-step retry**

In `src/main/tasks/executor-runner.ts`, replace the `run()` method's for-loop body (lines 37-64) with:

```typescript
const RETRY_BACKOFF_MS = 1000;
const MAX_ATTEMPTS = 2; // 1 original + 1 retry

// ... inside the class, in the run() method:

async run(executor: TaskExecutor): Promise<ExecutorRunResult> {
    const startMs = Date.now();
    const totalSteps = executor.steps.length;

    for (const [i, step] of executor.steps.entries()) {
        // Check timeout
        if (executor.validation.max_duration_ms > 0) {
            const elapsed = Date.now() - startMs;
            if (elapsed > executor.validation.max_duration_ms) {
                log.warn(`[Executor] Timed out at step ${i + 1}/${totalSteps} after ${elapsed}ms`);
                return { success: false, failedAt: i, reason: 'step_error', error: new Error('Executor timeout') };
            }
        }

        let lastError: any = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const result = await this.executeStep(step, i, totalSteps);

                // Check expect conditions if present
                if ('expect' in step && step.expect && !this.checkExpect(step.expect, result)) {
                    log.warn(`[Executor] Step ${i + 1}/${totalSteps}: ${this.stepLabel(step)} — expect condition failed (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
                    lastError = { reason: 'expect_failed' };
                    if (attempt < MAX_ATTEMPTS - 1) {
                        await sleep(RETRY_BACKOFF_MS);
                        continue;
                    }
                    return { success: false, failedAt: i, reason: 'expect_failed' };
                }

                // Store result if step has store_as
                if ('store_as' in step && step.store_as) {
                    this.variables.set(step.store_as, result);
                }

                lastError = null;
                break; // Step succeeded, move to next step
            } catch (error: any) {
                lastError = error;
                if (attempt < MAX_ATTEMPTS - 1) {
                    log.warn(`[Executor] Step ${i + 1}/${totalSteps}: ${this.stepLabel(step)} — failed (attempt ${attempt + 1}), retrying in ${RETRY_BACKOFF_MS}ms...`);
                    await sleep(RETRY_BACKOFF_MS);
                } else {
                    log.error(`[Executor] Step ${i + 1}/${totalSteps}: ${this.stepLabel(step)} — failed after ${MAX_ATTEMPTS} attempts: ${error?.message || error}`);
                }
            }
        }

        if (lastError) {
            if (lastError.reason === 'expect_failed') {
                return { success: false, failedAt: i, reason: 'expect_failed' };
            }
            return { success: false, failedAt: i, reason: 'step_error', error: lastError };
        }
    }

    // Build final result from template
    const resultStep = executor.steps.find(s => s.type === 'result');
    const finalResult = resultStep && resultStep.type === 'result'
        ? this.interpolate(resultStep.template)
        : this.variables.get('summary') || 'Task completed';

    const totalMs = Date.now() - startMs;
    log.info(`[Executor] Completed in ${totalMs}ms (${totalSteps} steps)`);

    return { success: true, result: finalResult };
}
```

Add the `sleep` helper at the bottom of the file (before the closing export):

```typescript
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/tasks/executor-runner.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/tasks/executor-runner.ts src/main/tasks/executor-runner.test.ts
git commit -m "feat(executor): add per-step retry with 1s backoff before fallback"
```

---

## Task 2: Create the Interactive Executor Store (SQLite table + CRUD)

**Files:**
- Modify: `src/main/vault/schema.sql` (add new table)
- Create: `src/main/llm/interactive-executor-store.ts`
- Test: `src/main/llm/interactive-executor-store.test.ts`

**Step 1: Add the new table to schema.sql**

Append to `src/main/vault/schema.sql` after line 159:

```sql
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
```

**Step 2: Write the failing tests**

Create `src/main/llm/interactive-executor-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// We'll test the store functions directly.
// Mock getVaultDB to return an in-memory SQLite DB.
import Database from 'better-sqlite3';

let db: any;

vi.mock('../vault/db', () => ({
    getVaultDB: () => db,
}));

import {
    lookupInteractiveExecutor,
    saveInteractiveExecutor,
    updateInteractiveExecutorStats,
    buildCacheKeyHash,
} from './interactive-executor-store';
import type { CacheKey } from './strategy-cache';
import type { TaskExecutor } from '../../shared/task-types';

function makeExecutor(overrides: Partial<TaskExecutor> = {}): TaskExecutor {
    return {
        id: 'exec-1',
        task_id: 'interactive',
        version: 1,
        created_at: Math.floor(Date.now() / 1000),
        created_from_run_id: 'run-1',
        steps: [
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
            { type: 'result', template: '{{step_0_result}}' },
        ],
        validation: { expect_result: true, max_duration_ms: 300000, required_variables: [], abort_on_empty_extract: false },
        stats: { total_steps: 2, deterministic_steps: 1, llm_steps: 0, estimated_cost_per_run: 0 },
        ...overrides,
    };
}

const testKey: CacheKey = {
    archetype: 'page-read' as any,
    primaryHost: 'news.ycombinator.com',
    toolClass: 'browser' as any,
};

describe('interactive-executor-store', () => {
    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(`
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
                created_at INTEGER NOT NULL DEFAULT (cast(strftime('%s','now') as integer)),
                superseded_at INTEGER
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_interactive_executors_key
                ON interactive_executors(cache_key_hash) WHERE superseded_at IS NULL;
        `);
    });

    it('buildCacheKeyHash produces deterministic hash', () => {
        const toolSeq = ['browser_navigate', 'browser_extract'];
        const h1 = buildCacheKeyHash(testKey, toolSeq);
        const h2 = buildCacheKeyHash(testKey, toolSeq);
        expect(h1).toBe(h2);
        expect(h1.length).toBe(64); // SHA-256 hex
    });

    it('buildCacheKeyHash differs for different sequences', () => {
        const h1 = buildCacheKeyHash(testKey, ['browser_navigate', 'browser_extract']);
        const h2 = buildCacheKeyHash(testKey, ['browser_navigate', 'browser_read_page']);
        expect(h1).not.toBe(h2);
    });

    it('saves and retrieves an executor', () => {
        const executor = makeExecutor();
        const toolSeq = ['browser_navigate'];
        saveInteractiveExecutor(testKey, toolSeq, executor);

        const found = lookupInteractiveExecutor(testKey, toolSeq);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(executor.id);
    });

    it('returns null when no executor exists', () => {
        const found = lookupInteractiveExecutor(testKey, ['browser_navigate']);
        expect(found).toBeNull();
    });

    it('supersedes old executor when saving new one with same key', () => {
        const exec1 = makeExecutor({ id: 'exec-1' });
        const exec2 = makeExecutor({ id: 'exec-2' });
        const toolSeq = ['browser_navigate'];

        saveInteractiveExecutor(testKey, toolSeq, exec1);
        saveInteractiveExecutor(testKey, toolSeq, exec2);

        const found = lookupInteractiveExecutor(testKey, toolSeq);
        expect(found).not.toBeNull();
        expect(found!.id).toBe('exec-2');
    });

    it('supersedes executor after 3 consecutive failures', () => {
        const executor = makeExecutor();
        const toolSeq = ['browser_navigate'];
        saveInteractiveExecutor(testKey, toolSeq, executor);

        updateInteractiveExecutorStats(executor.id, false, 0);
        updateInteractiveExecutorStats(executor.id, false, 0);
        updateInteractiveExecutorStats(executor.id, false, 0);

        const found = lookupInteractiveExecutor(testKey, toolSeq);
        expect(found).toBeNull(); // Superseded after 3 failures
    });

    it('resets failure_count on success', () => {
        const executor = makeExecutor();
        const toolSeq = ['browser_navigate'];
        saveInteractiveExecutor(testKey, toolSeq, executor);

        updateInteractiveExecutorStats(executor.id, false, 0);
        updateInteractiveExecutorStats(executor.id, false, 0);
        updateInteractiveExecutorStats(executor.id, true, 0.10); // Success resets failures

        const found = lookupInteractiveExecutor(testKey, toolSeq);
        expect(found).not.toBeNull(); // Still active because failure count was reset
    });
});
```

**Step 3: Run test to verify it fails**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/llm/interactive-executor-store.test.ts --reporter=verbose`
Expected: FAIL — module doesn't exist yet

**Step 4: Implement the store**

Create `src/main/llm/interactive-executor-store.ts`:

```typescript
import { createHash } from 'crypto';
import { getVaultDB } from '../vault/db';
import { createLogger } from '../logger';
import type { CacheKey } from './strategy-cache';
import type { TaskExecutor } from '../../shared/task-types';

const log = createLogger('interactive-executor-store');

const MAX_FAILURES = 3;
const STALE_DAYS = 30;

/**
 * Build a deterministic SHA-256 hash from a cache key + tool sequence.
 * This is the lookup key for interactive executors.
 */
export function buildCacheKeyHash(key: CacheKey, toolSequence: string[]): string {
    const raw = `${key.archetype}|${key.primaryHost || '_'}|${key.toolClass}|${toolSequence.join(',')}`;
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Look up an active (non-superseded, healthy) interactive executor.
 * Returns null if none found, or if the executor is stale/over-failed.
 */
export function lookupInteractiveExecutor(
    key: CacheKey,
    toolSequence: string[],
): TaskExecutor | null {
    const db = getVaultDB();
    const hash = buildCacheKeyHash(key, toolSequence);

    const row = db.prepare(
        `SELECT * FROM interactive_executors
         WHERE cache_key_hash = ? AND superseded_at IS NULL
         ORDER BY version DESC LIMIT 1`
    ).get(hash) as any;

    if (!row) return null;

    // Health check: consecutive failures
    if (row.failure_count >= MAX_FAILURES) {
        log.warn(`Interactive executor ${row.id} has ${row.failure_count} failures, superseding`);
        supersedeInteractiveExecutor(row.id);
        return null;
    }

    // Health check: staleness
    const now = Math.floor(Date.now() / 1000);
    const lastActivity = row.last_used_at || row.created_at;
    if (now - lastActivity > STALE_DAYS * 86400) {
        log.warn(`Interactive executor ${row.id} is stale, superseding`);
        supersedeInteractiveExecutor(row.id);
        return null;
    }

    try {
        return JSON.parse(row.executor_json) as TaskExecutor;
    } catch {
        log.error(`Failed to parse interactive executor JSON for ${row.id}, superseding`);
        supersedeInteractiveExecutor(row.id);
        return null;
    }
}

/**
 * Save a new interactive executor, superseding any previous active one for the same key.
 */
export function saveInteractiveExecutor(
    key: CacheKey,
    toolSequence: string[],
    executor: TaskExecutor,
): void {
    const db = getVaultDB();
    const hash = buildCacheKeyHash(key, toolSequence);
    const now = Math.floor(Date.now() / 1000);
    const keyJson = JSON.stringify({ ...key, toolSequence });

    // Find current highest version for this key
    const current = db.prepare(
        `SELECT MAX(version) as maxVer FROM interactive_executors WHERE cache_key_hash = ?`
    ).get(hash) as any;
    const newVersion = (current?.maxVer || 0) + 1;
    executor.version = newVersion;

    // Supersede all previous active executors for this key
    db.prepare(
        `UPDATE interactive_executors SET superseded_at = ? WHERE cache_key_hash = ? AND superseded_at IS NULL`
    ).run(now, hash);

    // Insert new executor
    db.prepare(
        `INSERT INTO interactive_executors (id, cache_key_hash, cache_key_json, version, executor_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(executor.id, hash, keyJson, newVersion, JSON.stringify(executor), now);

    log.info(`Saved interactive executor v${newVersion} for key ${key.archetype}|${key.primaryHost}`);
}

/**
 * Update success/failure stats after an interactive executor run.
 */
export function updateInteractiveExecutorStats(
    executorId: string,
    success: boolean,
    costSaved: number,
): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);
    if (success) {
        db.prepare(
            `UPDATE interactive_executors
             SET success_count = success_count + 1, failure_count = 0,
                 total_cost_saved = total_cost_saved + ?, last_used_at = ?
             WHERE id = ?`
        ).run(costSaved, now, executorId);
    } else {
        db.prepare(
            `UPDATE interactive_executors
             SET failure_count = failure_count + 1, last_used_at = ?
             WHERE id = ?`
        ).run(now, executorId);
    }
}

function supersedeInteractiveExecutor(executorId: string): void {
    const db = getVaultDB();
    db.prepare(
        `UPDATE interactive_executors SET superseded_at = ? WHERE id = ?`
    ).run(Math.floor(Date.now() / 1000), executorId);
}
```

**Step 5: Run test to verify it passes**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/llm/interactive-executor-store.test.ts --reporter=verbose`
Expected: PASS

**Step 6: Commit**

```bash
git add src/main/vault/schema.sql src/main/llm/interactive-executor-store.ts src/main/llm/interactive-executor-store.test.ts
git commit -m "feat(executor): add interactive executor store with SQLite table and CRUD"
```

---

## Task 3: Create TracingEmitter Wrapper

**Files:**
- Create: `src/main/llm/tracing-emitter.ts`
- Test: `src/main/llm/tracing-emitter.test.ts`

**Step 1: Write the failing test**

Create `src/main/llm/tracing-emitter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TracingEmitter } from './tracing-emitter';
import { IPC_EVENTS } from '../../shared/ipc-channels';

describe('TracingEmitter', () => {
    it('forwards all send() calls to the inner emitter', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        tracing.send('test:channel', 'arg1', 'arg2');
        expect(inner.send).toHaveBeenCalledWith('test:channel', 'arg1', 'arg2');
    });

    it('delegates isDestroyed() to the inner emitter', () => {
        const inner = { send: vi.fn(), isDestroyed: () => true };
        const tracing = new TracingEmitter(inner);
        expect(tracing.isDestroyed()).toBe(true);
    });

    it('captures execution trace from IPC events', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        // Simulate TOOL_EXEC_START
        tracing.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
        });

        // Simulate CHAT_TOOL_ACTIVITY (completion)
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success',
            durationMs: 500,
            resultPreview: 'Page loaded',
        });

        // Simulate TOOL_EXEC_COMPLETE
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        const trace = tracing.getExecutionTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].tool_name).toBe('browser_navigate');
        expect(trace[0].tool_input).toEqual({ url: 'https://example.com' });
        expect(trace[0].was_llm_dependent).toBe(false);
    });

    it('marks steps as LLM-dependent when text is emitted between tools', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        // First tool
        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_navigate', toolId: 't1', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't1', name: 'browser_navigate', input: {}, status: 'success', durationMs: 100 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        // LLM emits reasoning text
        tracing.send(IPC_EVENTS.CHAT_STREAM_TEXT, 'Let me extract the data now...');

        // Second tool (should be marked LLM-dependent)
        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_extract', toolId: 't2', args: { selector: '.title' } });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't2', name: 'browser_extract', input: { selector: '.title' }, status: 'success', durationMs: 200 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        const trace = tracing.getExecutionTrace();
        expect(trace).toHaveLength(2);
        expect(trace[0].was_llm_dependent).toBe(false);
        expect(trace[1].was_llm_dependent).toBe(true);
    });

    it('returns tool sequence names', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_navigate', toolId: 't1', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't1', name: 'browser_navigate', input: {}, status: 'success', durationMs: 100 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_extract', toolId: 't2', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't2', name: 'browser_extract', input: {}, status: 'success', durationMs: 200 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        expect(tracing.getToolSequence()).toEqual(['browser_navigate', 'browser_extract']);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/llm/tracing-emitter.test.ts --reporter=verbose`
Expected: FAIL — module doesn't exist

**Step 3: Implement TracingEmitter**

Create `src/main/llm/tracing-emitter.ts`:

```typescript
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { ToolLoopEmitter } from '../../shared/types';
import type { TraceStep } from '../../shared/task-types';

/**
 * Wraps an existing ToolLoopEmitter to transparently capture execution traces.
 *
 * All send() calls are forwarded to the inner emitter (so the UI works normally)
 * AND the trace capture logic from NullEmitter is applied simultaneously.
 * This enables executor generation from interactive chat runs.
 */
export class TracingEmitter implements ToolLoopEmitter {
    private inner: ToolLoopEmitter;
    private executionTrace: TraceStep[] = [];
    private pendingTraceEntries: Map<string, Partial<TraceStep> & { toolId: string }> = new Map();
    private textSinceLastToolComplete = '';
    private seenFirstToolComplete = false;
    private traceIndex = 0;
    private toolNames: string[] = [];

    constructor(inner: ToolLoopEmitter) {
        this.inner = inner;
    }

    send(channel: string, ...args: any[]): void {
        // Always forward to the real emitter first
        this.inner.send(channel, ...args);

        // Capture trace data (same logic as NullEmitter)
        if (channel === IPC_EVENTS.CHAT_STREAM_TEXT && typeof args[0] === 'string') {
            this.textSinceLastToolComplete += args[0];
        }

        if (channel === IPC_EVENTS.TOOL_EXEC_START && args[0]) {
            const event = args[0] as { toolName: string; toolId: string; args: Record<string, unknown> };
            const hadReasoningText = this.seenFirstToolComplete
                && this.textSinceLastToolComplete.trim().length > 0;
            this.pendingTraceEntries.set(event.toolId, {
                toolId: event.toolId,
                tool_name: event.toolName,
                tool_input: event.args as Record<string, any>,
                was_llm_dependent: hadReasoningText,
            });
        }

        if (channel === IPC_EVENTS.CHAT_TOOL_ACTIVITY && args[0]) {
            const entry = args[0] as {
                id: string;
                name: string;
                input: Record<string, unknown>;
                status: string;
                durationMs?: number;
                resultPreview?: string;
            };

            if (entry.status === 'success' || entry.status === 'error') {
                const pending = this.pendingTraceEntries.get(entry.id);
                if (pending) {
                    const step: TraceStep = {
                        index: this.traceIndex++,
                        tool_name: pending.tool_name || entry.name,
                        tool_input: (pending.tool_input || entry.input) as Record<string, any>,
                        tool_result: entry.resultPreview || '',
                        duration_ms: entry.durationMs || 0,
                        was_llm_dependent: pending.was_llm_dependent ?? false,
                    };
                    this.executionTrace.push(step);
                    this.toolNames.push(step.tool_name);
                    this.pendingTraceEntries.delete(entry.id);
                }
            }
        }

        if (channel === IPC_EVENTS.TOOL_EXEC_COMPLETE) {
            this.textSinceLastToolComplete = '';
            this.seenFirstToolComplete = true;
        }
    }

    isDestroyed(): boolean {
        return this.inner.isDestroyed();
    }

    /** Get the captured execution trace for executor generation. */
    getExecutionTrace(): TraceStep[] {
        return [...this.executionTrace];
    }

    /** Get the ordered list of tool names used (for cache key matching). */
    getToolSequence(): string[] {
        return [...this.toolNames];
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/llm/tracing-emitter.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/main/llm/tracing-emitter.ts src/main/llm/tracing-emitter.test.ts
git commit -m "feat(executor): add TracingEmitter wrapper for interactive trace capture"
```

---

## Task 4: Add IPC Event for Cached Badge

**Files:**
- Modify: `src/shared/ipc-channels.ts:146-202` (add new event)

**Step 1: Add the new IPC event**

In `src/shared/ipc-channels.ts`, add to the `IPC_EVENTS` object (after line 168, near `CHAT_ROUTE_INFO`):

```typescript
CHAT_EXECUTOR_USED: 'chat:executor:used',
```

**Step 2: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(executor): add CHAT_EXECUTOR_USED IPC event for cached badge"
```

---

## Task 5: Integrate Executor into Chat Pipeline

**Files:**
- Modify: `src/main/llm/chat-pipeline.ts`

This is the core integration. The pipeline needs to:
1. Wrap emitter in TracingEmitter
2. Before ToolLoop.run(), check for cached interactive executor
3. If executor found, replay it and emit cached badge
4. After successful ToolLoop.run(), generate and save executor from trace

**Step 1: Implement the pipeline changes**

Modify `src/main/llm/chat-pipeline.ts`. Add imports at the top (after existing imports):

```typescript
import { TracingEmitter } from './tracing-emitter';
import { ExecutorRunner } from '../tasks/executor-runner';
import { generateExecutor } from '../tasks/executor-generator';
import {
    lookupInteractiveExecutor,
    saveInteractiveExecutor,
    updateInteractiveExecutorStats,
} from './interactive-executor-store';
import { estimateFullRunCost, estimateExecutorCost } from '../tasks/cost-estimator';
import { classifyEnriched } from './intent-router';
import { strategyCache, type CacheKey } from './strategy-cache';
import { resolveModelId } from '../../shared/models';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';

const log = createLogger('chat-pipeline');
```

Then modify the `processChatMessage` function. Replace the try block (lines 126-168) with:

```typescript
  try {
    // Wrap emitter in TracingEmitter to capture execution trace
    const tracingEmitter = new TracingEmitter(emitter);

    // Build archetype cache key for executor lookup
    const currentUrl = undefined; // Pipeline doesn't have direct access; ToolLoop handles this
    const enriched = classifyEnriched(message, history.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
    })), currentUrl);
    const cacheKey: CacheKey = {
        archetype: enriched.strategy.archetype,
        primaryHost: enriched.strategy.extractedParams.url
            ? (() => { try { return new URL(enriched.strategy.extractedParams.url).hostname.replace(/^www\./, ''); } catch { return null; } })()
            : null,
        toolClass: enriched.toolClass,
    };

    // Check for cached interactive executor (only for tool-class requests)
    let response: string | null = null;
    let usedExecutor = false;

    if (enriched.intent === 'tools' && enriched.strategy.archetype !== 'unknown') {
        // Look up ALL known tool sequences for this archetype+host
        // The strategy cache tracks which tool sequences have been successful
        const cachedStrategy = strategyCache.lookup(cacheKey);
        if (cachedStrategy) {
            const executor = lookupInteractiveExecutor(cacheKey, cachedStrategy.toolSequence);
            if (executor) {
                log.info(`[Pipeline] Found interactive executor v${executor.version} for ${cacheKey.archetype}|${cacheKey.primaryHost}`);
                try {
                    const haikuClient = new AnthropicClient(
                        client.getApiKey(),
                        resolveModelId('haiku'),
                    );
                    const runner = new ExecutorRunner(haikuClient);
                    const execResult = await runner.run(executor);

                    if (execResult.success && execResult.result) {
                        response = execResult.result;
                        usedExecutor = true;
                        const costSaved = 0.12 - estimateExecutorCost(executor);
                        updateInteractiveExecutorStats(executor.id, true, costSaved);

                        // Emit cached badge to renderer
                        emitter.send(IPC_EVENTS.CHAT_EXECUTOR_USED, {
                            executorVersion: executor.version,
                            costSaved: costSaved.toFixed(4),
                            stepsReplayed: executor.stats.total_steps,
                        });

                        log.info(`[Pipeline] Executor v${executor.version} succeeded, saved ~$${costSaved.toFixed(4)}`);
                    } else {
                        log.warn(`[Pipeline] Executor v${executor.version} failed at step ${execResult.failedAt}, falling back to LLM`);
                        updateInteractiveExecutorStats(executor.id, false, 0);
                    }
                } catch (err: any) {
                    log.warn(`[Pipeline] Executor error: ${err?.message}, falling back to LLM`);
                }
            }
        }
    }

    // Fall through to normal LLM path if executor didn't handle it
    if (!response) {
        // 2. Create ToolLoop with tracing emitter
        const loop = new ToolLoop(tracingEmitter, client);
        onToolLoopCreated?.(loop);

        // 3. Run the tool loop
        response = await usageTracker.runWithConversation(conversation.id, () =>
            loop.run(message, history, images, documents, {
                conversationId: conversation.id,
                messageId,
                requestApproval: options.requestApproval,
            })
        );

        // 4. Transport-specific response handling
        onResponse?.(response, loop);

        // 5. Generate executor from trace (fire-and-forget)
        try {
            const trace = tracingEmitter.getExecutionTrace();
            const toolSeq = tracingEmitter.getToolSequence();
            if (trace.length > 0 && toolSeq.length > 0) {
                // Create a synthetic task-like object for generateExecutor
                const syntheticTask = {
                    id: 'interactive',
                    description: message.slice(0, 200),
                    triggerType: 'scheduled' as const,
                    triggerConfig: null,
                    executionPlan: '{}',
                    status: 'active' as const,
                    approvalMode: 'auto' as const,
                    allowedTools: '[]',
                    maxIterations: 30,
                    model: null,
                    tokenBudget: 50000,
                    createdAt: Math.floor(Date.now() / 1000),
                    updatedAt: Math.floor(Date.now() / 1000),
                    lastRunAt: null,
                    nextRunAt: null,
                    runCount: 0,
                    failureCount: 0,
                    maxFailures: 3,
                    conversationId: conversation.id,
                    metadataJson: '{}',
                };
                const newExecutor = generateExecutor(syntheticTask, trace, messageId);
                if (newExecutor && newExecutor.stats.deterministic_steps > 0) {
                    saveInteractiveExecutor(cacheKey, toolSeq, newExecutor);
                    log.info(`[Pipeline] Generated interactive executor: ${newExecutor.stats.deterministic_steps} deterministic, ${newExecutor.stats.llm_steps} LLM steps`);
                }
            }
        } catch (genErr: any) {
            log.warn(`[Pipeline] Failed to generate interactive executor: ${genErr?.message}`);
        }
    } else {
        // Executor handled it — still need to notify onToolLoopCreated for abort tracking
        onToolLoopCreated?.(null);
    }

    // 4b. Pre-prune flush (same as before)
    const currentMsgs = conversationManager.get(conversation.id)?.messages || [];
    const willPruneCount = (currentMsgs.length + 2) - ConversationManager.getMaxPersistedMessages();
    if (willPruneCount > 0) {
      const doomed = currentMsgs.slice(0, willPruneCount);
      flushBeforePrune(conversation.id, doomed, client).catch(() => { });
    }

    // 4c. Save messages
    conversationManager.addMessage(conversation.id, {
      role: 'user',
      content: message || '[Empty message]',
      images,
      documents: documentMetas,
    });
    conversationManager.addMessage(conversation.id, {
      role: 'assistant',
      content: response || '[No response]',
    });

    // 4d. Extract learnings
    const updatedConversation = conversationManager.get(conversation.id);
    if (updatedConversation) {
      maybeExtractMemories(conversation.id, updatedConversation.messages, client);
    }

    // 4e. Transport-specific notification
    onConversationUpdated?.(conversation.id);

    return { conversationId: conversation.id, response: response || '' };
  } catch (error: any) {
    onError?.(error);
    throw error;
  } finally {
    onToolLoopCreated?.(null);
  }
```

**Note:** The `incrementSessionMessageCount()` call should be moved before the try block (it's already at line 111, which is fine). The key change is wrapping the emitter and adding the executor check before + trace capture after.

**Step 2: Run the existing test suite to verify no regressions**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

**Step 3: Commit**

```bash
git add src/main/llm/chat-pipeline.ts
git commit -m "feat(executor): integrate executor lookup + trace capture into interactive chat pipeline"
```

---

## Task 6: Add run_source Column to task_runs Table

**Files:**
- Modify: `src/main/vault/schema.sql:125-139`
- Modify: `src/shared/task-types.ts` (add source to UpdateRunParams)
- Modify: `src/main/tasks/task-store.ts` (persist source field)
- Modify: `src/main/tasks/headless-runner.ts` (pass source to updateRun)

**Step 1: Add column to schema**

In `src/main/vault/schema.sql`, add after line 138 (after `trigger_source` column):

```sql
    run_source TEXT CHECK(run_source IN ('full_llm', 'executor'))
```

**Step 2: Add to UpdateRunParams type**

In `src/shared/task-types.ts`, add to `UpdateRunParams` interface:

```typescript
    runSource?: 'full_llm' | 'executor';
```

**Step 3: Add to updateRun in task-store**

In `src/main/tasks/task-store.ts`, in the `updateRun` function, add:

```typescript
    if (updates.runSource !== undefined) { setClauses.push('run_source = ?'); params.push(updates.runSource); }
```

**Step 4: Pass source in headless-runner**

In `src/main/tasks/headless-runner.ts`, in the executor success path (line 108), add `runSource: 'executor'` to the `updateRun` call. In the full LLM success path (line 250), add `runSource: 'full_llm'`.

**Step 5: Run tests**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/main/vault/schema.sql src/shared/task-types.ts src/main/tasks/task-store.ts src/main/tasks/headless-runner.ts
git commit -m "feat(executor): persist run_source field in task_runs table"
```

---

## Task 7: Enable Executor Store Tests

**Files:**
- Rename: `src/main/tasks/executor-store.test.ts.skip` → `src/main/tasks/executor-store.test.ts`

**Step 1: Rename the file**

```bash
cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider
mv src/main/tasks/executor-store.test.ts.skip src/main/tasks/executor-store.test.ts
```

**Step 2: Run the tests and fix any failures**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run src/main/tasks/executor-store.test.ts --reporter=verbose`

If tests fail, fix the issues. Common problems:
- Mock paths may need updating
- DB setup may need the new `interactive_executors` table
- Import paths may have changed

**Step 3: Commit**

```bash
git add src/main/tasks/executor-store.test.ts
git rm src/main/tasks/executor-store.test.ts.skip 2>/dev/null || true
git commit -m "chore(executor): enable executor store tests"
```

---

## Task 8: Final Integration Test + Verification

**Step 1: Run full test suite**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx vitest run --reporter=verbose 2>&1 | tail -50`
Expected: All tests pass

**Step 2: Build check**

Run: `cd /home/dp/Desktop/clawdia/.claude/worktrees/festive-greider && npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors

**Step 3: Verify schema migration**

The new `interactive_executors` table uses `CREATE TABLE IF NOT EXISTS`, so it will be created on first app launch with the updated schema. No migration script needed — the vault DB initialization runs schema.sql on startup.

**Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: address integration issues from executor interactive pipeline"
```
