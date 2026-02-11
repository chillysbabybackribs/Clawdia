
import { randomUUID } from 'crypto';
import { ToolLoop } from '../llm/tool-loop';
import { getDynamicPrompt } from '../llm/system-prompt';
import { NullEmitter } from './null-emitter';
import { getTask, updateTask, addRun, updateRun, getExecutorForTask, saveExecutor, updateExecutorStats } from './task-store';
import { generateExecutor } from './executor-generator';
import { ExecutorRunner } from './executor-runner';
import { estimateFullRunCost, estimateExecutorCost } from './cost-estimator';
import { createTaskContext } from './task-browser';
import type { PersistentTask, RunStatus } from '../../shared/task-types';
import { resolveModelId } from '../../shared/models';
import { createLogger } from '../logger';
import { ApprovalDecision, ApprovalRequest } from '../../shared/autonomy';

const log = createLogger('headless-runner');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const LOGIN_DETECTION_INSTRUCTION = `[System] AUTHENTICATION SAFETY: If you navigate to a website and see a login page, sign-in form, or authentication prompt instead of the expected content, do NOT attempt to enter credentials or interact with the login form. Instead, report that the site requires authentication and the user needs to log into this site in the Clawdia desktop browser first. Mention the specific site URL so the user knows which site to log into.\n\n`;

export interface TaskRunResult {
    runId: string;
    status: RunStatus;
    responseText: string;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    errorMessage?: string;
    source?: 'full_llm' | 'executor';
    executorVersion?: number;
    estimatedCost?: number;
}

interface RunnerDeps {
    getApiKey: () => string;
    getClient: (apiKey: string, model: string) => any; // AnthropicClient
    getDefaultModel: () => string;
    requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

let deps: RunnerDeps | null = null;

/**
 * Initialize the headless runner with dependencies from main.ts.
 * Must be called once at app startup after the API key is available.
 */
export function initHeadlessRunner(d: RunnerDeps): void {
    deps = d;
}

/**
 * Execute a persistent task in the background.
 * Two-path flow: tries cached executor first (cheap), falls back to full LLM (expensive).
 * On successful full LLM run, generates a new executor for future runs.
 */
export async function executeTask(task: PersistentTask): Promise<TaskRunResult> {
    const startTime = Date.now();

    if (!deps) {
        return makeFailedResult('HeadlessToolRunner not initialized', startTime);
    }

    const apiKey = deps.getApiKey();
    if (!apiKey) {
        return makeFailedResult('No API key configured', startTime);
    }

    // ── PATH A: Try cached executor (cheap) ──────────────────
    const executor = getExecutorForTask(task.id);

    if (executor) {
        log.info(`[Executor] Task "${task.description}" — using executor v${executor.version}`);

        // Create an isolated browser context for executor runs via standalone Playwright.
        // By default, inject Electron session cookies so executor can access authenticated sites.
        let execIsolatedCleanup: (() => Promise<void>) | null = null;
        let execIsolatedPage: import('playwright').Page | null = null;
        try {
            const isolated = await createTaskContext();
            if (isolated) {
                execIsolatedPage = isolated.page;
                execIsolatedCleanup = isolated.cleanup;
                log.info(`[Executor] Standalone browser context created for task ${task.id}`);
            } else {
                log.warn(`[Executor] Standalone browser unavailable for task ${task.id}. Running without browser tools.`);
            }
        } catch (err: any) {
            log.warn(`[Executor] Could not create task context for task ${task.id}: ${err?.message}. Running without browser isolation.`);
        }

        try {
            const haikuClient = deps.getClient(apiKey, resolveModelId('haiku'));
            const runner = new ExecutorRunner(haikuClient, execIsolatedPage);
            const result = await runner.run(executor);

            if (result.success) {
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
                    inputTokens: 0,
                    outputTokens: 0,
                });
                updateTask(task.id, {
                    lastRunAt: Math.floor(Date.now() / 1000),
                    runCount: (task.runCount || 0) + 1,
                    failureCount: 0,
                });

                const execCost = estimateExecutorCost(executor);
                const fullCost = estimateFullRunCost(task);
                log.info(`[Executor] Completed in ${durationMs}ms, est. cost: $${execCost.toFixed(4)} (vs $${fullCost.toFixed(4)} full LLM, saved $${costSaved.toFixed(4)})`);

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
                    estimatedCost: execCost,
                };
            }

            // Executor failed — fall through to full LLM
            log.warn(`[Executor] v${executor.version} failed for task ${task.id} at step ${result.failedAt}: ${result.reason}. Falling back to full LLM.`);
            updateExecutorStats(executor.id, false, 0);
        } catch (err: any) {
            log.error(`[Executor] Unexpected error for task ${task.id}: ${err?.message}. Falling back to full LLM.`);
            updateExecutorStats(executor.id, false, 0);
        } finally {
            if (execIsolatedCleanup) {
                await execIsolatedCleanup().catch((err: any) => {
                    log.warn(`[Executor] Failed to clean up isolated context for task ${task.id}: ${err?.message}`);
                });
            }
        }
    }

    // ── PATH B: Full LLM run (expensive, generates executor on success) ──
    return executeFullLlmRun(task, startTime);
}

/**
 * Original full LLM execution path via NullEmitter + ToolLoop.
 * After success, generates a new executor from the execution trace.
 */
async function executeFullLlmRun(task: PersistentTask, startTime: number): Promise<TaskRunResult> {
    if (!deps) return makeFailedResult('HeadlessToolRunner not initialized', startTime);

    const apiKey = deps.getApiKey();

    // Parse execution prompt from execution_plan JSON
    let executionPrompt: string;
    try {
        const plan = JSON.parse(task.executionPlan || '{}');
        executionPrompt = plan.prompt || task.description;
    } catch {
        executionPrompt = task.description;
    }

    // Prepend login detection safety instruction
    executionPrompt = LOGIN_DETECTION_INSTRUCTION + executionPrompt;

    // Select model: task-specific override → default, resolving short names like "haiku"
    const model = resolveModelId(task.model || deps.getDefaultModel());
    const client = deps.getClient(apiKey, model);

    // Create a run record
    const runId = addRun({
        taskId: task.id,
        triggerSource: 'scheduled',
        status: 'running',
    });

    log.info(`[Headless] Starting task ${task.id}: "${task.description}" (model=${model}, run=${runId})`);

    const emitter = new NullEmitter();
    const loop = new ToolLoop(emitter, client);

    // Create an isolated browser context via standalone Playwright (separate process from Electron).
    // Each run gets its own context + page so it never touches the user's BrowserView.
    // By default, inject Electron session cookies so task can access authenticated sites.
    let isolatedCleanup: (() => Promise<void>) | null = null;
    try {
        const isolated = await createTaskContext();
        if (isolated) {
            loop.setIsolatedPage(isolated.page);
            isolatedCleanup = isolated.cleanup;
            log.info(`[Headless] Standalone browser context created for task ${task.id}`);
        } else {
            log.warn(`[Headless] Standalone browser unavailable for task ${task.id}. Running without browser tools.`);
        }
    } catch (err: any) {
        log.warn(`[Headless] Could not create task context for task ${task.id}: ${err?.message}. Running without browser tools.`);
    }

    // Set up timeout
    const timeoutMs = DEFAULT_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
        log.warn(`[Headless] Task ${task.id} timed out after ${timeoutMs}ms`);
        loop.abort();
    }, timeoutMs);

    try {
        const response = await loop.run(
            executionPrompt,
            [], // No history for headless tasks
            undefined, // No images
            undefined, // No documents
            {
                conversationId: task.conversationId || `headless-${task.id}`,
                messageId: randomUUID(),
                requestApproval: deps.requestApproval,
            },
        );

        clearTimeout(timeoutHandle);
        const durationMs = Date.now() - startTime;
        const summary = emitter.getSummary();

        // Check token budget
        const totalTokens = summary.inputTokens + summary.outputTokens;
        const overBudget = task.tokenBudget > 0 && totalTokens > task.tokenBudget;
        if (overBudget) {
            log.warn(`[Headless] Task ${task.id} exceeded token budget: ${totalTokens} > ${task.tokenBudget}`);
        }

        const responseText = response || summary.finalResponse || '';
        const resultSummary = responseText.slice(0, 500);

        // Update the run record
        updateRun(runId, {
            status: 'completed',
            completedAt: Math.floor(Date.now() / 1000),
            durationMs,
            resultSummary,
            resultDetail: responseText,
            toolCallsCount: summary.toolCallCount,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
        });

        // Update the task record
        updateTask(task.id, {
            lastRunAt: Math.floor(Date.now() / 1000),
            runCount: (task.runCount || 0) + 1,
            failureCount: 0, // Reset on success
        });

        log.info(`[Headless] Task ${task.id} completed in ${durationMs}ms (${summary.toolCallCount} tools, ${totalTokens} tokens)`);

        // ── Generate executor from the successful trace ──────
        try {
            const trace = emitter.getExecutionTrace();
            const newExecutor = generateExecutor(task, trace, runId);

            if (newExecutor) {
                if (newExecutor.stats.deterministic_steps > 0) {
                    saveExecutor(newExecutor);
                    log.info(`[Executor] Generated v${newExecutor.version} for task ${task.id}: ${newExecutor.stats.deterministic_steps} deterministic, ${newExecutor.stats.llm_steps} LLM steps. Est. cost: $${newExecutor.stats.estimated_cost_per_run.toFixed(4)}/run`);
                } else {
                    log.info(`[Executor] Skipped caching for task ${task.id}: all ${trace.length} steps are LLM-dependent`);
                }
            }
        } catch (genErr: any) {
            // Executor generation is non-critical — log and continue
            log.warn(`[Executor] Failed to generate executor for task ${task.id}: ${genErr?.message}`);
        }

        return {
            runId,
            status: 'completed',
            responseText,
            toolCallCount: summary.toolCallCount,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            durationMs,
            source: 'full_llm',
        };
    } catch (error: any) {
        clearTimeout(timeoutHandle);
        const durationMs = Date.now() - startTime;
        const errorMessage = error?.message || 'Unknown error';
        const summary = emitter.getSummary();

        log.error(`[Headless] Task ${task.id} failed: ${errorMessage}`);

        // Update run as failed
        updateRun(runId, {
            status: 'failed',
            completedAt: Math.floor(Date.now() / 1000),
            durationMs,
            errorMessage,
            toolCallsCount: summary.toolCallCount,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
        });

        // Increment failure count; auto-pause if exceeding max
        const newFailureCount = (task.failureCount || 0) + 1;
        const updates: Record<string, any> = {
            lastRunAt: Math.floor(Date.now() / 1000),
            runCount: (task.runCount || 0) + 1,
            failureCount: newFailureCount,
        };

        if (newFailureCount >= (task.maxFailures || 3)) {
            updates.status = 'paused';
            log.warn(`[Headless] Task ${task.id} auto-paused after ${newFailureCount} consecutive failures`);
        }

        updateTask(task.id, updates);

        return {
            runId,
            status: 'failed',
            responseText: '',
            toolCallCount: summary.toolCallCount,
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            durationMs,
            errorMessage,
            source: 'full_llm',
        };
    } finally {
        // Always clean up the isolated browser context, even on timeout/error/success
        if (isolatedCleanup) {
            await isolatedCleanup().catch((err: any) => {
                log.warn(`[Headless] Failed to clean up isolated context for task ${task.id}: ${err?.message}`);
            });
        }
    }
}

function makeFailedResult(errorMessage: string, startTime: number): TaskRunResult {
    return {
        runId: '',
        status: 'failed',
        responseText: '',
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        errorMessage,
    };
}
