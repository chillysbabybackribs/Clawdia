/**
 * TaskScheduler — evaluates due tasks and triggers headless execution.
 *
 * Modeled after DashboardExecutor's setTimeout chain pattern.
 * Uses adaptive polling intervals based on active task state.
 */

import { Notification } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import { evaluateCondition } from '../dashboard/condition-parser';
import { collectExtendedMetrics, buildMetricContext } from '../dashboard/metrics';
import { computeNextRun } from './cron-utils';
import { getModelConfig } from '../../shared/models';
import {
    getDueTasks,
    getConditionTasks,
    getActiveTaskCount,
    hasRunningRun,
    updateTask,
    addRun,
    computeNextRunAt,
    getTask,
} from './task-store';
import { executeTask, type TaskRunResult } from './headless-runner';
import type { PersistentTask } from '../../shared/task-types';

const log = createLogger('scheduler');

// ── Singleton access ────────────────────────────────────────────

let _instance: TaskScheduler | null = null;

export function setSchedulerInstance(s: TaskScheduler | null): void {
    _instance = s;
}

export function getScheduler(): TaskScheduler | null {
    return _instance;
}

// ── Polling intervals ───────────────────────────────────────────

const INTERVAL_IDLE = 5 * 60 * 1000;     // 5 minutes — no active tasks
const INTERVAL_ACTIVE = 60 * 1000;        // 60 seconds — tasks exist
const INTERVAL_RUNNING = 15 * 1000;       // 15 seconds — tasks currently running

const MAX_CONCURRENT = 2;

// Condition tasks: minimum cooldown between re-triggers (seconds)
const CONDITION_COOLDOWN_S = 300; // 5 minutes

// ── Daily cost budget ───────────────────────────────────────────

const DEFAULT_DAILY_BUDGET = 1.0; // $1.00/day

interface DailySpend {
    date: string;  // YYYY-MM-DD local
    totalCost: number;
}

function todayString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Scheduler ───────────────────────────────────────────────────

export interface SchedulerDeps {
    getApiKey: () => string;
    getSelectedModel: () => string;
    getDailyBudget?: () => number;
    /** Optional callback when a task run completes or needs approval */
    onRunCompleted?: (task: PersistentTask, result: TaskRunResult) => void;
    onApprovalNeeded?: (task: PersistentTask, runId: string) => void;
    lastMessageGetter: () => number | null;
    /** Provide BrowserWindow for notification click-to-focus */
    getMainWindow?: () => import('electron').BrowserWindow | null;
}

export class TaskScheduler {
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    private deps: SchedulerDeps;

    /** Currently executing tasks: taskId → promise */
    private runningTasks = new Map<string, Promise<TaskRunResult>>();

    /** Daily spend tracker (resets at midnight or on restart) */
    private dailySpend: DailySpend = { date: todayString(), totalCost: 0 };

    /** Condition trigger cooldowns: taskId → last triggered unix seconds */
    private conditionCooldowns = new Map<string, number>();

    constructor(deps: SchedulerDeps) {
        this.deps = deps;
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        log.info('[Scheduler] Started');
        this.schedulePoll();
    }

    stop(): void {
        this.stopped = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        log.info(`[Scheduler] Stopped (${this.runningTasks.size} tasks still running)`);
    }

    /** Called when a new task is created — immediately compute next_run_at */
    onTaskCreated(taskId: string): void {
        log.info('[Scheduler] onTaskCreated called with taskId:', taskId);
        const task = getTask(taskId);
        if (!task) {
            log.warn('[Scheduler] onTaskCreated: task not found for ID:', taskId);
            return;
        }

        log.info('[Scheduler] Task retrieved:', { id: task.id, description: task.description, triggerType: task.triggerType, nextRunAt: task.nextRunAt });

        if (task.triggerType !== 'condition' && !task.nextRunAt) {
            const nextRunAt = computeNextRunAt({
                triggerType: task.triggerType,
                triggerConfig: task.triggerConfig,
            });
            if (nextRunAt) {
                updateTask(taskId, { nextRunAt });
                log.info(`[Scheduler] Task ${taskId} next run: ${new Date(nextRunAt * 1000).toISOString()}`);
            }
        } else {
            log.info('[Scheduler] Task already has nextRunAt or is condition-based, skipping update');
        }
    }

    /** Called when a task is paused */
    onTaskPaused(taskId: string): void {
        this.conditionCooldowns.delete(taskId);
        log.info(`[Scheduler] Task ${taskId} paused — removed from active tracking`);
    }

    /** Called when a task is resumed */
    onTaskResumed(taskId: string): void {
        const task = getTask(taskId);
        if (!task) return;

        const nextRunAt = computeNextRunAt({
            triggerType: task.triggerType,
            triggerConfig: task.triggerConfig,
        });
        updateTask(taskId, { nextRunAt, failureCount: 0 });
        this.conditionCooldowns.delete(taskId);
        log.info(`[Scheduler] Task ${taskId} resumed — next run: ${nextRunAt ? new Date(nextRunAt * 1000).toISOString() : 'N/A'}`);
    }

    /** Trigger a manual run of a task (bypasses schedule) */
    async triggerManualRun(taskId: string): Promise<TaskRunResult | null> {
        const task = getTask(taskId);
        if (!task) return null;
        return this.spawnRun(task, 'manual');
    }

    /** Get count of currently running tasks */
    getRunningCount(): number {
        return this.runningTasks.size;
    }

    /** Get today's autonomous spend */
    getDailySpend(): number {
        this.resetDailySpendIfNeeded();
        return this.dailySpend.totalCost;
    }

    // ── Private: Polling ──────────────────────────────────────────

    private getInterval(): number {
        if (this.runningTasks.size > 0) return INTERVAL_RUNNING;
        try {
            const activeCount = getActiveTaskCount();
            return activeCount > 0 ? INTERVAL_ACTIVE : INTERVAL_IDLE;
        } catch {
            return INTERVAL_IDLE;
        }
    }

    private schedulePoll(): void {
        if (this.stopped) return;
        const interval = this.getInterval();
        this.pollTimer = setTimeout(() => {
            this.runPollCycle()
                .catch((err) => log.warn(`[Scheduler] Poll cycle error: ${err}`))
                .finally(() => this.schedulePoll());
        }, interval);
    }

    private async runPollCycle(): Promise<void> {
        if (!this.deps.getApiKey()) return; // No API key — skip

        log.debug(`[Scheduler] tick — running=${this.runningTasks.size}, interval=${this.getInterval()}ms`);

        // Reset daily spend if date changed
        this.resetDailySpendIfNeeded();

        // Check budget
        const budget = this.deps.getDailyBudget?.() ?? DEFAULT_DAILY_BUDGET;
        if (this.dailySpend.totalCost >= budget) {
            log.warn(`[Scheduler] Daily budget exhausted ($${this.dailySpend.totalCost.toFixed(4)} / $${budget.toFixed(2)})`);
            return;
        }

        // 1. Process completed running tasks
        this.processCompletedRuns();

        // 2. Scheduled/one-time tasks that are due
        await this.processScheduledTasks();

        // 3. Condition-based tasks
        await this.processConditionTasks();
    }

    private async processScheduledTasks(): Promise<void> {
        let dueTasks: PersistentTask[];
        try {
            dueTasks = getDueTasks();
        } catch (err: any) {
            log.warn(`[Scheduler] getDueTasks failed: ${err?.message}`);
            return;
        }

        if (dueTasks.length > 0) {
            log.info(`[Scheduler] Found ${dueTasks.length} due task(s)`);
        }

        for (const task of dueTasks) {
            if (this.runningTasks.size >= MAX_CONCURRENT) {
                log.info(`[Scheduler] Concurrent limit reached (${MAX_CONCURRENT}), deferring ${dueTasks.length - Array.from(dueTasks).indexOf(task)} tasks`);
                break;
            }

            // Skip if already running
            if (this.runningTasks.has(task.id)) continue;
            if (hasRunningRun(task.id)) continue;

            // Approval mode check
            if (task.approvalMode === 'approve_always') {
                this.createApprovalPendingRun(task);
                continue;
            }

            if (task.approvalMode === 'approve_first' && task.runCount === 0) {
                this.createApprovalPendingRun(task);
                continue;
            }

            // Spawn execution
            this.spawnRun(task, 'scheduled');
        }
    }

    private async processConditionTasks(): Promise<void> {
        let conditionTasks: PersistentTask[];
        try {
            conditionTasks = getConditionTasks();
        } catch (err: any) {
            log.warn(`[Scheduler] getConditionTasks failed: ${err?.message}`);
            return;
        }

        if (conditionTasks.length === 0) return;

        // Collect metrics once for all condition evaluations
        let metricContext: Record<string, number | boolean | string | null>;
        try {
            const metrics = await collectExtendedMetrics({
                lastMessageGetter: this.deps.lastMessageGetter,
            });
            metricContext = buildMetricContext(metrics);
        } catch (err: any) {
            log.warn(`[Scheduler] Metrics collection failed: ${err?.message}`);
            return;
        }

        const nowSeconds = Math.floor(Date.now() / 1000);

        for (const task of conditionTasks) {
            if (this.runningTasks.size >= MAX_CONCURRENT) break;
            if (this.runningTasks.has(task.id)) continue;
            if (hasRunningRun(task.id)) continue;
            if (!task.triggerConfig) continue;

            // Check cooldown
            const lastTriggered = this.conditionCooldowns.get(task.id) ?? 0;
            if (nowSeconds - lastTriggered < CONDITION_COOLDOWN_S) continue;

            // Evaluate condition
            const conditionMet = evaluateCondition(task.triggerConfig, metricContext);
            if (!conditionMet) continue;

            log.info(`[Scheduler] Condition met for task ${task.id}: "${task.triggerConfig}"`);
            this.conditionCooldowns.set(task.id, nowSeconds);

            if (task.approvalMode === 'approve_always') {
                this.createApprovalPendingRun(task);
                continue;
            }

            this.spawnRun(task, 'condition');
        }
    }

    // ── Run management ────────────────────────────────────────────

    private spawnRun(
        task: PersistentTask,
        _triggerSource: 'scheduled' | 'condition' | 'manual',
    ): Promise<TaskRunResult> {
        log.info(`[Scheduler] Spawning run for task ${task.id}: "${task.description}"`);

        const promise = executeTask(task).then((result) => {
            // Post-run: update next_run_at for recurring tasks
            this.handleRunComplete(task, result);
            return result;
        }).catch((err) => {
            log.error(`[Scheduler] Run for task ${task.id} threw unexpectedly: ${err}`);
            // executeTask should never throw (errors captured in result), but just in case
            const fallback: TaskRunResult = {
                runId: '',
                status: 'failed',
                responseText: '',
                toolCallCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                durationMs: 0,
                errorMessage: String(err),
            };
            this.handleRunComplete(task, fallback);
            return fallback;
        });

        this.runningTasks.set(task.id, promise);
        return promise;
    }

    private handleRunComplete(task: PersistentTask, result: TaskRunResult): void {
        this.runningTasks.delete(task.id);

        // Track cost
        this.trackCost(result, task.model || this.deps.getSelectedModel());

        // Compute next_run_at for scheduled tasks
        if (task.triggerType === 'scheduled' && task.triggerConfig) {
            const nextRunAt = computeNextRun(task.triggerConfig, Math.floor(Date.now() / 1000));
            if (nextRunAt) {
                updateTask(task.id, { nextRunAt });
            }
        }

        // For one_time tasks, mark completed after successful run
        if (task.triggerType === 'one_time' && result.status === 'completed') {
            updateTask(task.id, { status: 'completed' });
        }

        // Send notification
        this.notifyRunResult(task, result);

        // Callback
        this.deps.onRunCompleted?.(task, result);

        log.info(`[Scheduler] Task ${task.id} run finished: status=${result.status}, duration=${result.durationMs}ms`);
    }

    private processCompletedRuns(): void {
        // The runningTasks map cleans itself via handleRunComplete callbacks.
        // This method is a safety net — check for any promises that resolved
        // without cleanup (shouldn't happen, but defensive).
        for (const [taskId, promise] of this.runningTasks) {
            // Check if promise settled by attempting a non-blocking inspection
            // JavaScript doesn't have a native way to check if a promise is settled,
            // so we rely on the .then() handler in spawnRun to clean up.
            // This loop just logs the active set.
            void promise; // suppress unused warning
            void taskId;
        }
    }

    private createApprovalPendingRun(task: PersistentTask): void {
        const runId = addRun({
            taskId: task.id,
            triggerSource: 'scheduled',
            status: 'approval_pending',
        });

        log.info(`[Scheduler] Task ${task.id} requires approval — run ${runId} created as approval_pending`);

        // Advance next_run_at so we don't keep creating approval runs
        if (task.triggerType === 'scheduled' && task.triggerConfig) {
            const nextRunAt = computeNextRun(task.triggerConfig, Math.floor(Date.now() / 1000));
            if (nextRunAt) {
                updateTask(task.id, { nextRunAt });
            }
        }

        // Notify
        this.notifyApprovalNeeded(task, runId);
        this.deps.onApprovalNeeded?.(task, runId);
    }

    // ── Cost tracking ─────────────────────────────────────────────

    private resetDailySpendIfNeeded(): void {
        const today = todayString();
        if (this.dailySpend.date !== today) {
            log.info(`[Scheduler] Daily spend reset (was $${this.dailySpend.totalCost.toFixed(4)} on ${this.dailySpend.date})`);
            this.dailySpend = { date: today, totalCost: 0 };
        }
    }

    private trackCost(result: TaskRunResult, modelId: string): void {
        const config = getModelConfig(modelId);
        if (!config) return;

        const inputCost = (result.inputTokens / 1_000_000) * config.inputCostPerMTok;
        const outputCost = (result.outputTokens / 1_000_000) * config.outputCostPerMTok;
        const runCost = inputCost + outputCost;

        this.dailySpend.totalCost += runCost;
        log.info(`[Scheduler] Run cost: $${runCost.toFixed(4)} (daily total: $${this.dailySpend.totalCost.toFixed(4)})`);

        const budget = this.deps.getDailyBudget?.() ?? DEFAULT_DAILY_BUDGET;
        if (this.dailySpend.totalCost >= budget) {
            log.warn(`[Scheduler] Daily budget of $${budget.toFixed(2)} exhausted — pausing all scheduled runs until midnight`);
        }
    }

    // ── Notifications ─────────────────────────────────────────────

    private notifyRunResult(task: PersistentTask, result: TaskRunResult): void {
        // Send in-app notification with full result payload
        log.info(`[Scheduler] Sending notification: task=${task.id} status=${result.status} source=${(result as any).source || 'full_llm'} responseLen=${(result.responseText || '').length}`);
        try {
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed()) {
                log.info(`[Scheduler] Window available, sending TASK_RUN_NOTIFICATION`);
                win.webContents.send(IPC_EVENTS.TASK_RUN_NOTIFICATION, {
                    taskId: task.id,
                    description: task.description,
                    status: result.status,
                    responseText: result.responseText,
                    errorMessage: result.errorMessage,
                    durationMs: result.durationMs,
                    toolCallCount: result.toolCallCount,
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                });
            }
        } catch (err: any) {
            log.warn(`[Scheduler] In-app notification failed: ${err?.message}`);
        }

        // Native OS notification only when window is hidden/minimized
        try {
            const win = this.deps.getMainWindow?.();
            if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) {
                if (Notification.isSupported()) {
                    const isSuccess = result.status === 'completed';
                    const n = new Notification({
                        title: isSuccess
                            ? `\u2713 ${task.description.slice(0, 50)}`
                            : `\u2717 ${task.description.slice(0, 50)}`,
                        body: isSuccess
                            ? (result.responseText || '').slice(0, 200)
                            : (result.errorMessage || 'Unknown error').slice(0, 200),
                        silent: false,
                    });
                    n.on('click', () => {
                        if (win && !win.isDestroyed()) {
                            win.show();
                            win.focus();
                            win.webContents.send(IPC_EVENTS.TASK_FOCUS, task.id);
                        }
                    });
                    n.show();
                }
            }
        } catch (err: any) {
            log.warn(`[Scheduler] Notification failed: ${err?.message}`);
        }
    }

    private notifyApprovalNeeded(task: PersistentTask, runId: string): void {
        if (!Notification.isSupported()) return;

        try {
            const n = new Notification({
                title: `\u23F8 Approval needed: ${task.description.slice(0, 50)}`,
                body: 'Click to review and approve',
                silent: false,
            });
            n.on('click', () => {
                const win = this.deps.getMainWindow?.();
                if (win && !win.isDestroyed()) {
                    win.show();
                    win.focus();
                    win.webContents.send(IPC_EVENTS.TASK_APPROVAL_FOCUS, runId);
                }
            });
            n.show();
        } catch (err: any) {
            log.warn(`[Scheduler] Approval notification failed: ${err?.message}`);
        }
    }
}
