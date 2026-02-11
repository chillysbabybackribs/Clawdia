
import { getVaultDB } from '../vault/db';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { computeNextRun } from './cron-utils';
import {
    PersistentTask,
    TaskRun,
    TaskExecutor,
    CreateTaskParams,
    UpdateTaskParams,
    CreateRunParams,
    UpdateRunParams,
} from '../../shared/task-types';

const log = createLogger('task-store');

// ── Row mappers ──────────────────────────────────────────────

function mapTask(row: any): PersistentTask {
    return {
        id: row.id,
        description: row.description,
        triggerType: row.trigger_type,
        triggerConfig: row.trigger_config,
        executionPlan: row.execution_plan,
        status: row.status,
        approvalMode: row.approval_mode,
        allowedTools: row.allowed_tools,
        maxIterations: row.max_iterations,
        model: row.model,
        tokenBudget: row.token_budget,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRunAt: row.last_run_at,
        nextRunAt: row.next_run_at,
        runCount: row.run_count,
        failureCount: row.failure_count,
        maxFailures: row.max_failures,
        conversationId: row.conversation_id,
        metadataJson: row.metadata_json,
    };
}

function mapRun(row: any): TaskRun {
    return {
        id: row.id,
        taskId: row.task_id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        resultSummary: row.result_summary,
        resultDetail: row.result_detail,
        toolCallsCount: row.tool_calls_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        errorMessage: row.error_message,
        triggerSource: row.trigger_source,
    };
}

// ── Task CRUD ────────────────────────────────────────────────

export function createTask(params: CreateTaskParams): string {
    log.info('[task_store] createTask called with params:', JSON.stringify(params));

    const db = getVaultDB();
    log.info('[task_store] VaultDB obtained:', db ? 'present' : 'null');

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const nextRunAt = computeNextRunAt({
        triggerType: params.triggerType,
        triggerConfig: params.triggerConfig ?? null,
    });

    log.info('[task_store] About to INSERT task:', { id, description: params.description, nextRunAt });

    try {
        db.prepare(`
            INSERT INTO tasks (id, description, trigger_type, trigger_config, execution_plan,
                status, approval_mode, allowed_tools, max_iterations, model, token_budget,
                created_at, updated_at, next_run_at, conversation_id, metadata_json)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            params.description,
            params.triggerType,
            params.triggerConfig ?? null,
            params.executionPlan ?? '{}',
            params.approvalMode ?? 'auto',
            params.allowedTools ? JSON.stringify(params.allowedTools) : '[]',
            params.maxIterations ?? 30,
            params.model ?? null,
            params.tokenBudget ?? 50000,
            now,
            now,
            nextRunAt,
            params.conversationId ?? null,
            params.metadata ? JSON.stringify(params.metadata) : '{}',
        );

        log.info('[task_store] INSERT succeeded for task:', id, params.description);
    } catch (err: any) {
        log.error('[task_store] INSERT failed:', err?.message || err, 'Stack:', err?.stack);
        throw err;
    }

    log.info(`Created task ${id}: ${params.description}`);
    return id;
}

export function getTask(id: string): PersistentTask | null {
    const db = getVaultDB();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? mapTask(row) : null;
}

export function listTasks(filter?: { status?: string }): PersistentTask[] {
    const db = getVaultDB();
    if (filter?.status) {
        const rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC').all(filter.status);
        return rows.map(mapTask);
    }
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
    return rows.map(mapTask);
}

export function updateTask(id: string, updates: UpdateTaskParams): void {
    const db = getVaultDB();
    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.description !== undefined) { setClauses.push('description = ?'); params.push(updates.description); }
    if (updates.triggerType !== undefined) { setClauses.push('trigger_type = ?'); params.push(updates.triggerType); }
    if (updates.triggerConfig !== undefined) { setClauses.push('trigger_config = ?'); params.push(updates.triggerConfig); }
    if (updates.executionPlan !== undefined) { setClauses.push('execution_plan = ?'); params.push(updates.executionPlan); }
    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if (updates.approvalMode !== undefined) { setClauses.push('approval_mode = ?'); params.push(updates.approvalMode); }
    if (updates.allowedTools !== undefined) { setClauses.push('allowed_tools = ?'); params.push(JSON.stringify(updates.allowedTools)); }
    if (updates.maxIterations !== undefined) { setClauses.push('max_iterations = ?'); params.push(updates.maxIterations); }
    if (updates.model !== undefined) { setClauses.push('model = ?'); params.push(updates.model); }
    if (updates.tokenBudget !== undefined) { setClauses.push('token_budget = ?'); params.push(updates.tokenBudget); }
    if (updates.nextRunAt !== undefined) { setClauses.push('next_run_at = ?'); params.push(updates.nextRunAt); }
    if (updates.lastRunAt !== undefined) { setClauses.push('last_run_at = ?'); params.push(updates.lastRunAt); }
    if (updates.runCount !== undefined) { setClauses.push('run_count = ?'); params.push(updates.runCount); }
    if (updates.failureCount !== undefined) { setClauses.push('failure_count = ?'); params.push(updates.failureCount); }
    if (updates.maxFailures !== undefined) { setClauses.push('max_failures = ?'); params.push(updates.maxFailures); }
    if (updates.conversationId !== undefined) { setClauses.push('conversation_id = ?'); params.push(updates.conversationId); }
    if (updates.metadata !== undefined) { setClauses.push('metadata_json = ?'); params.push(JSON.stringify(updates.metadata)); }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(id);

    db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteTask(id: string): void {
    const db = getVaultDB();
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    log.info(`Deleted task ${id}`);
}

export function pauseTask(id: string): void {
    updateTask(id, { status: 'paused' });
    log.info(`Paused task ${id}`);
}

export function resumeTask(id: string): void {
    const task = getTask(id);
    if (!task) return;

    const nextRunAt = computeNextRunAt({
        triggerType: task.triggerType,
        triggerConfig: task.triggerConfig,
    });

    updateTask(id, { status: 'active', nextRunAt, failureCount: 0 });
    log.info(`Resumed task ${id}`);
}

// ── Run CRUD ─────────────────────────────────────────────────

export function addRun(params: CreateRunParams): string {
    const db = getVaultDB();
    const id = randomUUID();

    db.prepare(`
        INSERT INTO task_runs (id, task_id, status, started_at, trigger_source)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        id,
        params.taskId,
        params.status ?? 'pending',
        Math.floor(Date.now() / 1000),
        params.triggerSource,
    );

    return id;
}

export function getRun(runId: string): TaskRun | null {
    const db = getVaultDB();
    const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId);
    return row ? mapRun(row) : null;
}

export function updateRun(runId: string, updates: UpdateRunParams): void {
    const db = getVaultDB();
    const setClauses: string[] = [];
    const params: any[] = [];

    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if (updates.completedAt !== undefined) { setClauses.push('completed_at = ?'); params.push(updates.completedAt); }
    if (updates.durationMs !== undefined) { setClauses.push('duration_ms = ?'); params.push(updates.durationMs); }
    if (updates.resultSummary !== undefined) { setClauses.push('result_summary = ?'); params.push(updates.resultSummary); }
    if (updates.resultDetail !== undefined) { setClauses.push('result_detail = ?'); params.push(updates.resultDetail); }
    if (updates.toolCallsCount !== undefined) { setClauses.push('tool_calls_count = ?'); params.push(updates.toolCallsCount); }
    if (updates.inputTokens !== undefined) { setClauses.push('input_tokens = ?'); params.push(updates.inputTokens); }
    if (updates.outputTokens !== undefined) { setClauses.push('output_tokens = ?'); params.push(updates.outputTokens); }
    if (updates.errorMessage !== undefined) { setClauses.push('error_message = ?'); params.push(updates.errorMessage); }

    if (setClauses.length === 0) return;

    params.push(runId);
    db.prepare(`UPDATE task_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

export function getRunsForTask(taskId: string, limit: number = 20): TaskRun[] {
    const db = getVaultDB();
    const rows = db.prepare(
        'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(taskId, limit);
    return rows.map(mapRun);
}

// ── Scheduling queries ───────────────────────────────────────

export function getDueTasks(): PersistentTask[] {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(
        "SELECT * FROM tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?"
    ).all(now);
    return rows.map(mapTask);
}

export function getConditionTasks(): PersistentTask[] {
    const db = getVaultDB();
    const rows = db.prepare(
        "SELECT * FROM tasks WHERE status = 'active' AND trigger_type = 'condition'"
    ).all();
    return rows.map(mapTask);
}

export function getActiveTaskCount(): number {
    const db = getVaultDB();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'active'").get() as any;
    return row?.cnt ?? 0;
}

export function hasRunningRun(taskId: string): boolean {
    const db = getVaultDB();
    const row = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ? AND status = 'running'"
    ).get(taskId) as any;
    return (row?.cnt ?? 0) > 0;
}

/**
 * Brief summary of active tasks for injection into the system prompt.
 * Returns empty string if no tasks exist.
 */
export function getTasksSummaryForPrompt(): string {
    const db = getVaultDB();
    const rows = db.prepare(
        "SELECT status, COUNT(*) as cnt FROM tasks WHERE status IN ('active', 'paused', 'failed') GROUP BY status"
    ).all() as { status: string; cnt: number }[];

    if (rows.length === 0) return '';

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
        counts[r.status] = r.cnt;
        total += r.cnt;
    }

    // Check for any currently running runs
    const runningRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_runs WHERE status = 'running'"
    ).get() as { cnt: number };
    const running = runningRow?.cnt ?? 0;

    const parts: string[] = [`${total} task(s)`];
    if (counts.active) parts.push(`${counts.active} active`);
    if (running > 0) parts.push(`${running} running now`);
    if (counts.paused) parts.push(`${counts.paused} paused`);
    if (counts.failed) parts.push(`${counts.failed} failed`);

    // Get latest run result across all tasks
    const latestRun = db.prepare(
        "SELECT t.description, r.result_summary, r.status as run_status, r.started_at FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.status IN ('completed', 'failed') ORDER BY r.started_at DESC LIMIT 1"
    ).get() as { description: string; result_summary: string | null; run_status: string; started_at: number } | undefined;

    let summary = `ACTIVE TASKS: ${parts.join(', ')}`;
    if (latestRun) {
        const ago = Math.floor(Date.now() / 1000) - latestRun.started_at;
        const agoStr = ago < 3600 ? `${Math.floor(ago / 60)}m ago` : ago < 86400 ? `${Math.floor(ago / 3600)}h ago` : `${Math.floor(ago / 86400)}d ago`;
        const icon = latestRun.run_status === 'completed' ? '✓' : '✗';
        summary += `\nLast run: ${icon} "${latestRun.description}" ${agoStr}`;
        if (latestRun.result_summary) {
            summary += ` — ${latestRun.result_summary.slice(0, 120)}`;
        }
    }

    return summary;
}

// ── Executor CRUD ─────────────────────────────────────────────

const MAX_EXECUTOR_FAILURES = 3;
const EXECUTOR_STALE_DAYS = 30;

/**
 * Get the latest active (non-superseded) executor for a task.
 * Returns null if no executor exists, or if the executor is stale or has too many failures.
 */
export function getExecutorForTask(taskId: string): TaskExecutor | null {
    const db = getVaultDB();
    const row = db.prepare(
        `SELECT * FROM task_executors WHERE task_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`
    ).get(taskId) as any;
    if (!row) return null;

    // Health check: consecutive failures
    if (row.failure_count >= MAX_EXECUTOR_FAILURES) {
        log.warn(`Executor ${row.id} for task ${taskId} has ${row.failure_count} failures, superseding`);
        supersedeExecutor(row.id);
        return null;
    }

    // Health check: staleness (no use in 30 days)
    const now = Math.floor(Date.now() / 1000);
    const lastActivity = row.last_used_at || row.created_at;
    const staleSec = EXECUTOR_STALE_DAYS * 24 * 3600;
    if (now - lastActivity > staleSec) {
        log.warn(`Executor ${row.id} for task ${taskId} is stale (last used ${Math.floor((now - lastActivity) / 86400)}d ago), superseding`);
        supersedeExecutor(row.id);
        return null;
    }

    try {
        return JSON.parse(row.executor_json) as TaskExecutor;
    } catch {
        log.error(`Failed to parse executor JSON for ${row.id}`);
        return null;
    }
}

/** Save a new executor, superseding any previous active version for the same task. */
export function saveExecutor(executor: TaskExecutor): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);

    // Find the current highest version for this task to auto-increment
    const current = db.prepare(
        `SELECT MAX(version) as maxVer FROM task_executors WHERE task_id = ?`
    ).get(executor.task_id) as any;
    const newVersion = (current?.maxVer || 0) + 1;
    executor.version = newVersion;

    // Supersede all previous active executors
    db.prepare(
        `UPDATE task_executors SET superseded_at = ? WHERE task_id = ? AND superseded_at IS NULL`
    ).run(now, executor.task_id);

    // Insert new executor
    db.prepare(
        `INSERT INTO task_executors (id, task_id, version, executor_json, created_at, created_from_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(executor.id, executor.task_id, newVersion, JSON.stringify(executor), now, executor.created_from_run_id);

    log.info(`Saved executor v${newVersion} for task ${executor.task_id}`);
}

/** Update success/failure stats and last_used_at after an executor run. */
export function updateExecutorStats(executorId: string, success: boolean, costSaved: number): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);
    if (success) {
        db.prepare(
            `UPDATE task_executors SET success_count = success_count + 1, failure_count = 0, total_cost_saved = total_cost_saved + ?, last_used_at = ? WHERE id = ?`
        ).run(costSaved, now, executorId);
    } else {
        db.prepare(
            `UPDATE task_executors SET failure_count = failure_count + 1, last_used_at = ? WHERE id = ?`
        ).run(now, executorId);
    }
}

/** Mark an executor as superseded so it won't be used again. */
export function supersedeExecutor(executorId: string): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
        `UPDATE task_executors SET superseded_at = ? WHERE id = ?`
    ).run(now, executorId);
}

// ── Zombie run cleanup ────────────────────────────────────────

/**
 * Mark any 'running' task_runs as 'failed' on startup.
 * These are leftovers from a crash or forced quit — they'll never complete.
 * Without this, hasRunningRun() returns true forever, blocking the task from running again.
 */
export function cleanupZombieRuns(): number {
    const db = getVaultDB();
    const result = db.prepare(
        `UPDATE task_runs
         SET status = 'failed',
             error_message = 'Interrupted by app shutdown',
             completed_at = ?
         WHERE status = 'running'`
    ).run(Math.floor(Date.now() / 1000));
    return result.changes;
}

// ── Scheduling ────────────────────────────────────────────────

/**
 * Compute the next run time from trigger config.
 * For cron/interval expressions, delegates to cron-utils.
 * For one_time triggers, returns the configured timestamp or null.
 * For condition triggers, returns null (evaluated by polling, not clock).
 */
export function computeNextRunAt(task: {
    triggerType: string;
    triggerConfig: string | null;
}, lastRunAt?: number | null): number | null {
    if (!task.triggerConfig) return null;

    if (task.triggerType === 'one_time') {
        const ts = parseInt(task.triggerConfig, 10);
        return isNaN(ts) ? null : ts;
    }

    if (task.triggerType === 'condition') {
        return null;
    }

    // scheduled — delegate to cron-utils (handles both cron and interval)
    return computeNextRun(task.triggerConfig, lastRunAt);
}
