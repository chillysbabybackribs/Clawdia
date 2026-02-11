
import { Tool } from '../../shared/types';
import {
    createTask,
    getTask,
    listTasks,
    updateTask,
    deleteTask,
    pauseTask,
    resumeTask,
    addRun,
    getRunsForTask,
    computeNextRunAt,
} from './task-store';
import type { PersistentTask, TaskTriggerType, ApprovalMode } from '../../shared/task-types';
import { getScheduler } from './scheduler';
import { normalizeTriggerConfig } from './cron-utils';
import { createLogger } from '../logger';
import { broadcastTaskState } from '../main';

const log = createLogger('task-tools');

// ── Helpers ──────────────────────────────────────────────────

function timeAgo(unixSeconds: number): string {
    const diff = Math.floor(Date.now() / 1000) - unixSeconds;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ── Tool Definitions ─────────────────────────────────────────

export const TASK_TOOL_DEFINITIONS: Tool[] = [
    {
        name: 'task_create',
        description: 'Create a persistent task that runs on a schedule or in response to a condition. Call this tool immediately when the user asks for something recurring, scheduled, or monitored. The task scheduler will execute it automatically.',
        input_schema: {
            type: 'object',
            properties: {
                description: {
                    type: 'string',
                    description: 'Human-readable task summary (e.g., "Check Hacker News for AI articles every morning").',
                },
                trigger_type: {
                    type: 'string',
                    enum: ['one_time', 'scheduled', 'condition'],
                    description: 'When this task should run: one_time (once at a specific time), scheduled (recurring cron), condition (when a system condition is met).',
                },
                trigger_config: {
                    type: 'string',
                    description: 'Cron expression for scheduled (e.g., "0 9 * * *" for daily at 9am), condition string for condition-based (e.g., "disk_percent > 90"), or unix timestamp for one_time.',
                },
                execution_prompt: {
                    type: 'string',
                    description: 'Detailed instructions for what to do when the task runs. Write as a complete message that Clawdia will execute autonomously — include specific URLs, steps, and expected output format.',
                },
                approval_mode: {
                    type: 'string',
                    enum: ['auto', 'approve_always'],
                    description: 'Whether to execute automatically (auto) or wait for user approval each time (approve_always). Default: auto.',
                },
                model: {
                    type: 'string',
                    description: 'Model to use. Use "haiku" for simple checks, "sonnet" for browser/complex tasks. Omit to use default.',
                },
            },
            required: ['description', 'trigger_type', 'trigger_config', 'execution_prompt'],
        },
    },
    {
        name: 'task_list',
        description: 'Show all persistent tasks with their status, schedule, and last result.',
        input_schema: {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    enum: ['active', 'paused', 'completed', 'failed', 'archived'],
                    description: 'Optional: filter tasks by status.',
                },
            },
        },
    },
    {
        name: 'task_pause',
        description: 'Pause a persistent task by name or ID. The task will stop running until resumed.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
            },
            required: ['task_ref'],
        },
    },
    {
        name: 'task_resume',
        description: 'Resume a paused persistent task.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
            },
            required: ['task_ref'],
        },
    },
    {
        name: 'task_delete',
        description: 'Delete a persistent task permanently. This cannot be undone.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
            },
            required: ['task_ref'],
        },
    },
    {
        name: 'task_run_now',
        description: 'Trigger immediate execution of a persistent task, regardless of its schedule.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
            },
            required: ['task_ref'],
        },
    },
    {
        name: 'task_edit',
        description: 'Edit a persistent task — change its schedule, description, model, or approval mode.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
                description: {
                    type: 'string',
                    description: 'New description for the task.',
                },
                trigger_config: {
                    type: 'string',
                    description: 'New cron expression or condition string.',
                },
                execution_prompt: {
                    type: 'string',
                    description: 'New execution instructions.',
                },
                model: {
                    type: 'string',
                    description: 'New model: "haiku" or "sonnet".',
                },
                approval_mode: {
                    type: 'string',
                    enum: ['auto', 'approve_always'],
                    description: 'New approval mode.',
                },
            },
            required: ['task_ref'],
        },
    },
    {
        name: 'task_get_results',
        description: 'Get recent run results for a task. Shows run history with summaries, timestamps, and status.',
        input_schema: {
            type: 'object',
            properties: {
                task_ref: {
                    type: 'string',
                    description: 'Task description fragment or ID to match.',
                },
                limit: {
                    type: 'number',
                    description: 'Number of recent runs to show (default: 5, max: 20).',
                },
                detail: {
                    type: 'boolean',
                    description: 'If true, include full result detail instead of just summaries.',
                },
            },
            required: ['task_ref'],
        },
    },
];

// ── Task Reference Resolution ────────────────────────────────

function resolveTaskRef(ref: string): { task: PersistentTask | null; ambiguous: PersistentTask[] } {
    // Try exact ID match first
    const byId = getTask(ref);
    if (byId) return { task: byId, ambiguous: [] };

    // Try case-insensitive substring match on description
    const all = listTasks();
    const refLower = ref.toLowerCase();
    const matches = all.filter(t => t.description.toLowerCase().includes(refLower));

    if (matches.length === 1) return { task: matches[0], ambiguous: [] };
    if (matches.length > 1) return { task: null, ambiguous: matches };

    // Try word overlap scoring as fallback
    const refWords = refLower.split(/\s+/).filter(w => w.length > 2);
    if (refWords.length === 0) return { task: null, ambiguous: [] };

    const scored = all.map(t => {
        const descWords = t.description.toLowerCase().split(/\s+/);
        const overlap = refWords.filter(w => descWords.some(d => d.includes(w))).length;
        return { task: t, score: overlap / refWords.length };
    }).filter(s => s.score > 0.3).sort((a, b) => b.score - a.score);

    if (scored.length === 1) return { task: scored[0].task, ambiguous: [] };
    if (scored.length > 1) return { task: null, ambiguous: scored.map(s => s.task) };

    return { task: null, ambiguous: [] };
}

function formatTaskSummary(task: PersistentTask): string {
    const parts: string[] = [
        `ID: ${task.id}`,
        `Description: ${task.description}`,
        `Status: ${task.status}`,
        `Trigger: ${task.triggerType}`,
    ];
    if (task.triggerConfig) parts.push(`Config: ${task.triggerConfig}`);
    if (task.nextRunAt) parts.push(`Next run: ${new Date(task.nextRunAt * 1000).toLocaleString()}`);
    if (task.lastRunAt) parts.push(`Last run: ${new Date(task.lastRunAt * 1000).toLocaleString()}`);
    parts.push(`Runs: ${task.runCount} (${task.failureCount} failures)`);
    if (task.model) parts.push(`Model: ${task.model}`);
    parts.push(`Approval: ${task.approvalMode}`);
    return parts.join('\n');
}

function formatAmbiguousError(matches: PersistentTask[]): string {
    const list = matches.map((t, i) => `  ${i + 1}. "${t.description}" (${t.status}) [${t.id.slice(0, 8)}...]`).join('\n');
    return `Multiple tasks match. Please be more specific:\n${list}`;
}

// ── Cron Description Helper ──────────────────────────────────

function describeCron(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [min, hour, dom, mon, dow] = parts;

    const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Common patterns
    if (min.startsWith('*/') && hour === '*') return `every ${min.slice(2)} minutes`;
    if (hour.startsWith('*/') && min === '0') return `every ${hour.slice(2)} hours`;
    if (dom === '*' && mon === '*' && dow === '*' && !min.startsWith('*') && !hour.startsWith('*')) {
        return `daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    if (dom === '*' && mon === '*' && dow !== '*' && !min.startsWith('*') && !hour.startsWith('*')) {
        const dayNum = parseInt(dow, 10);
        const dayName = dowNames[dayNum] ?? dow;
        return `every ${dayName} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    return cron;
}

// ── Tool Executor ────────────────────────────────────────────

export async function executeTaskTool(
    name: string,
    input: Record<string, unknown>,
): Promise<string> {
    try {
        switch (name) {
            case 'task_create': {
                log.info('[task_create] Called with input:', JSON.stringify(input));
                const description = input.description as string;
                const triggerType = input.trigger_type as TaskTriggerType;
                let triggerConfig = (input.trigger_config as string) || undefined;
                const executionPrompt = input.execution_prompt as string;
                const approvalMode = (input.approval_mode as ApprovalMode) || 'auto';
                const model = (input.model as string) || undefined;

                // Normalize trigger config — convert natural language to proper cron if needed
                if (triggerConfig && triggerType === 'scheduled') {
                    const normalized = normalizeTriggerConfig(triggerConfig);
                    if (normalized !== triggerConfig) {
                        log.info('[task_create] Normalized trigger_config from:', triggerConfig, 'to:', normalized);
                        triggerConfig = normalized;
                    }
                }

                const executionPlan = JSON.stringify({ prompt: executionPrompt });

                log.info('[task_create] About to call createTask with:', { description, triggerType, triggerConfig });

                const taskId = createTask({
                    description,
                    triggerType,
                    triggerConfig,
                    executionPlan,
                    approvalMode,
                    model,
                });

                log.info('[task_create] createTask returned taskId:', taskId);

                // Notify scheduler
                const scheduler = getScheduler();
                log.info('[task_create] Scheduler instance:', scheduler ? 'present' : 'null');
                scheduler?.onTaskCreated(taskId);

                // Broadcast state update to UI (desktop + any connected clients)
                broadcastTaskState();
                log.info('[task_create] Broadcasted task state update to UI');

                const task = getTask(taskId);
                if (!task) return `Error: task created but could not be retrieved (ID: ${taskId})`;

                const lines: string[] = [
                    `Task created successfully.`,
                    `ID: ${taskId}`,
                    `Description: ${description}`,
                    `Trigger: ${triggerType}`,
                ];
                if (triggerConfig) {
                    lines.push(`Schedule: ${triggerType === 'scheduled' ? describeCron(triggerConfig) : triggerConfig}`);
                }
                if (task.nextRunAt) {
                    lines.push(`Next run: ${new Date(task.nextRunAt * 1000).toLocaleString()}`);
                }
                lines.push(`Approval: ${approvalMode}`);
                if (model) lines.push(`Model: ${model}`);

                log.info(`Task created: ${taskId} — ${description}`);
                return lines.join('\n');
            }

            case 'task_list': {
                const statusFilter = input.status as string | undefined;
                const tasks = listTasks(statusFilter ? { status: statusFilter } : undefined);

                if (tasks.length === 0) {
                    return statusFilter
                        ? `No tasks with status "${statusFilter}".`
                        : 'No persistent tasks found.';
                }

                const summaries = tasks.map((t, i) => {
                    const statusIcon = t.status === 'active' ? '●' : t.status === 'paused' ? '⏸' : t.status === 'failed' ? '✗' : '○';
                    const lines = [`${statusIcon} ${i + 1}. ${t.description}`];
                    lines.push(`   Status: ${t.status} | Trigger: ${t.triggerType}`);
                    if (t.triggerConfig && t.triggerType === 'scheduled') {
                        lines.push(`   Schedule: ${describeCron(t.triggerConfig)}`);
                    }
                    if (t.triggerConfig && t.triggerType === 'condition') {
                        lines.push(`   Condition: ${t.triggerConfig}`);
                    }
                    if (t.nextRunAt) lines.push(`   Next run: ${new Date(t.nextRunAt * 1000).toLocaleString()}`);

                    // Include recent run result
                    if (t.lastRunAt) {
                        const lastRunAgo = timeAgo(t.lastRunAt);
                        const recentRuns = getRunsForTask(t.id, 1);
                        if (recentRuns.length > 0) {
                            const lastRun = recentRuns[0];
                            const runIcon = lastRun.status === 'completed' ? '✓' : lastRun.status === 'failed' ? '✗' : lastRun.status;
                            const summary = lastRun.errorMessage
                                ? `Error: ${lastRun.errorMessage.slice(0, 100)}`
                                : lastRun.resultSummary
                                    ? lastRun.resultSummary.slice(0, 120)
                                    : 'No summary';
                            lines.push(`   Last result (${lastRunAgo}): ${runIcon} ${summary}`);
                        } else {
                            lines.push(`   Last run: ${lastRunAgo}`);
                        }
                    }

                    lines.push(`   Runs: ${t.runCount} | Failures: ${t.failureCount} | ID: ${t.id.slice(0, 8)}...`);
                    return lines.join('\n');
                });

                return `${tasks.length} task(s):\n\n${summaries.join('\n\n')}`;
            }

            case 'task_pause': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;
                if (task.status === 'paused') return `Task "${task.description}" is already paused.`;
                if (task.status !== 'active') return `Cannot pause task "${task.description}" — status is "${task.status}".`;

                pauseTask(task.id);
                getScheduler()?.onTaskPaused(task.id);
                return `Paused task: "${task.description}"`;
            }

            case 'task_resume': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;
                if (task.status === 'active') return `Task "${task.description}" is already active.`;
                if (task.status !== 'paused') return `Cannot resume task "${task.description}" — status is "${task.status}".`;

                resumeTask(task.id);
                getScheduler()?.onTaskResumed(task.id);
                const updated = getTask(task.id);
                const nextRun = updated?.nextRunAt
                    ? `Next run: ${new Date(updated.nextRunAt * 1000).toLocaleString()}`
                    : '';
                return `Resumed task: "${task.description}"${nextRun ? `\n${nextRun}` : ''}`;
            }

            case 'task_delete': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;

                deleteTask(task.id);
                return `Deleted task: "${task.description}"`;
            }

            case 'task_run_now': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;

                const scheduler = getScheduler();
                if (scheduler) {
                    // Fire-and-forget: scheduler handles run creation, tracking, and notifications
                    void scheduler.triggerManualRun(task.id);
                    return `Triggered immediate run for task: "${task.description}"\nThe scheduler is executing it now. Results will be recorded in the task run history.`;
                }

                // Fallback: scheduler not active — queue a pending run
                const runId = addRun({ taskId: task.id, triggerSource: 'manual', status: 'pending' });
                return `Queued run for task: "${task.description}" (Run ID: ${runId})\nNote: The scheduler is not active. The run will execute when the scheduler starts.`;
            }

            case 'task_edit': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;

                const updates: Record<string, unknown> = {};
                const changes: string[] = [];

                if (input.description) {
                    updates.description = input.description as string;
                    changes.push(`Description → "${input.description}"`);
                }
                if (input.trigger_config) {
                    updates.triggerConfig = input.trigger_config as string;
                    changes.push(`Schedule → ${task.triggerType === 'scheduled' ? describeCron(input.trigger_config as string) : input.trigger_config}`);
                    // Recompute next run
                    updates.nextRunAt = computeNextRunAt({
                        triggerType: task.triggerType,
                        triggerConfig: input.trigger_config as string,
                    });
                }
                if (input.execution_prompt) {
                    updates.executionPlan = JSON.stringify({ prompt: input.execution_prompt as string });
                    changes.push('Execution instructions updated');
                }
                if (input.model) {
                    updates.model = input.model as string;
                    changes.push(`Model → ${input.model}`);
                }
                if (input.approval_mode) {
                    updates.approvalMode = input.approval_mode as string;
                    changes.push(`Approval → ${input.approval_mode}`);
                }

                if (changes.length === 0) {
                    return `No changes specified for task "${task.description}".`;
                }

                updateTask(task.id, updates as any);
                getScheduler()?.onTaskCreated(task.id); // re-sync scheduler
                log.info(`Edited task ${task.id}: ${changes.join(', ')}`);
                return `Updated task "${task.description}":\n${changes.map(c => `  • ${c}`).join('\n')}`;
            }

            case 'task_get_results': {
                const ref = input.task_ref as string;
                const { task, ambiguous } = resolveTaskRef(ref);
                if (ambiguous.length > 0) return formatAmbiguousError(ambiguous);
                if (!task) return `No task found matching "${ref}".`;

                const limit = Math.min(Math.max((input.limit as number) || 5, 1), 20);
                const showDetail = (input.detail as boolean) || false;
                const runs = getRunsForTask(task.id, limit);

                if (runs.length === 0) {
                    return `No run history for task "${task.description}".`;
                }

                const lines: string[] = [
                    `Run history for "${task.description}" (last ${runs.length}):`,
                    '',
                ];

                for (const run of runs) {
                    const time = new Date(run.startedAt * 1000).toLocaleString();
                    const ago = timeAgo(run.startedAt);
                    const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
                    const status = run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : run.status;

                    lines.push(`${status} ${time} (${ago}) — ${duration}`);

                    if (run.errorMessage) {
                        lines.push(`  Error: ${run.errorMessage}`);
                    } else if (showDetail && run.resultDetail) {
                        lines.push(`  ${run.resultDetail.slice(0, 2000)}`);
                    } else if (run.resultSummary) {
                        lines.push(`  ${run.resultSummary}`);
                    }

                    if (run.toolCallsCount > 0) {
                        lines.push(`  Tools: ${run.toolCallsCount} | Tokens: ${run.inputTokens + run.outputTokens}`);
                    }
                    lines.push('');
                }

                return lines.join('\n');
            }

            default:
                return `Unknown task tool: ${name}`;
        }
    } catch (error: any) {
        log.error(`Error executing task tool ${name}:`, error);
        return `Error executing ${name}: ${error.message}`;
    }
}
