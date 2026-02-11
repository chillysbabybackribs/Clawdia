/**
 * Converts PersistentTask rows into TaskDashboardItem[] for the renderer.
 */

import { listTasks, getRunsForTask } from './task-store';
import type { PersistentTask, TaskRun } from '../../shared/task-types';
import type { TaskDashboardItem, TaskDashboardStatus } from '../../shared/dashboard-types';

function relativeTime(unixSeconds: number): string {
    const diffMs = Date.now() - unixSeconds * 1000;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
}

function scheduleSummary(task: PersistentTask): string {
    if (task.triggerType === 'one_time') return 'one-time';
    if (task.triggerType === 'condition') return 'condition';
    if (!task.triggerConfig) return 'scheduled';
    // Show human-readable trigger config
    return task.triggerConfig;
}

function deriveStatus(task: PersistentTask, latestRun: TaskRun | null): TaskDashboardStatus {
    // Check if there's a running run
    if (latestRun?.status === 'running') return 'running';
    // Check for approval pending
    if (latestRun?.status === 'approval_pending') return 'approval_pending';
    // Task-level status
    if (task.status === 'paused') return 'paused';
    if (task.status === 'failed') return 'failed';
    return 'active';
}

export function getTaskDashboardItems(): TaskDashboardItem[] {
    let tasks: PersistentTask[];
    try {
        tasks = listTasks();
    } catch {
        return [];
    }

    // Filter out completed/archived tasks — only show active, paused, failed
    const visible = tasks.filter(t => t.status !== 'completed' && t.status !== 'archived');
    if (visible.length === 0) return [];

    return visible.map(task => {
        let runs: TaskRun[] = [];
        let latestRun: TaskRun | null = null;
        let approvalRun: TaskRun | null = null;
        try {
            runs = getRunsForTask(task.id, 3);
            latestRun = runs[0] ?? null;
            // Find any approval_pending run
            approvalRun = runs.find(r => r.status === 'approval_pending') ?? null;
        } catch {
            // DB might not be ready
        }

        const status = deriveStatus(task, latestRun);

        const item: TaskDashboardItem = {
            id: task.id,
            description: task.description,
            status,
            scheduleSummary: scheduleSummary(task),
            runCount: task.runCount,
            failureCount: task.failureCount,
        };

        // Last run info (use latest completed/failed run, not approval_pending)
        const completedRun = latestRun?.status === 'approval_pending'
            ? (runs[1] ?? null)
            : latestRun;

        if (completedRun && (completedRun.status === 'completed' || completedRun.status === 'failed')) {
            item.lastRunResult = (completedRun.resultSummary || completedRun.errorMessage || '').slice(0, 120);
            item.lastRunSuccess = completedRun.status === 'completed';
            if (completedRun.completedAt) {
                item.lastRunAgo = relativeTime(completedRun.completedAt);
            }
        }

        // Approval info
        if (approvalRun) {
            item.approvalRunId = approvalRun.id;
            item.approvalSummary = (approvalRun.resultSummary || '').slice(0, 200);
        }

        return item;
    });
}
