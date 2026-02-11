// ============================================================================
// Task View — Full task management panel (replaces chat when sidebar tab active)
// ============================================================================

import type { TaskDashboardItem } from '../../shared/dashboard-types';
import type { TaskRun, TaskExecutor } from '../../shared/task-types';
import { elements } from './state';

let taskViewInitialized = false;
let taskStateUnsubscribe: (() => void) | null = null;
let cachedTasks: TaskDashboardItem[] = [];
let expandedRunHistory: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString();
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function statusLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active';
    case 'paused': return 'Paused';
    case 'running': return 'Running';
    case 'failed': return 'Failed';
    case 'approval_pending': return 'Awaiting Approval';
    default: return status;
  }
}

function statusDotColor(status: string): string {
  switch (status) {
    case 'active': return 'var(--success)';
    case 'paused': return '#f59e0b';
    case 'failed': return 'var(--error)';
    case 'running': return 'var(--accent)';
    case 'approval_pending': return '#f97316';
    default: return 'var(--text-tertiary)';
  }
}

function runStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u2713';
    case 'failed': return '\u2717';
    case 'running': return '\u25CB';
    case 'cancelled': return '\u2014';
    case 'approval_pending': return '\u26A0';
    default: return '\u00B7';
  }
}

function runStatusColor(status: string): string {
  switch (status) {
    case 'completed': return 'var(--success)';
    case 'failed': return 'var(--error)';
    case 'running': return 'var(--accent)';
    case 'approval_pending': return '#f97316';
    default: return 'var(--text-tertiary)';
  }
}

// ---------------------------------------------------------------------------
// Render: Empty State
// ---------------------------------------------------------------------------

function renderEmptyState(): string {
  return `
    <div class="tv-empty">
      <div class="tv-empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
      </div>
      <p class="tv-empty-title">No tasks yet</p>
      <p class="tv-empty-hint">Ask Clawdia to do something on a schedule, like:</p>
      <div class="tv-empty-examples">
        <span class="tv-empty-example">"Check Hacker News every morning for AI articles"</span>
        <span class="tv-empty-example">"Monitor my server uptime every 30 minutes"</span>
        <span class="tv-empty-example">"Summarize my GitHub notifications daily at 9am"</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Render: Task Card
// ---------------------------------------------------------------------------

function renderTaskCard(task: TaskDashboardItem): string {
  const dotColor = statusDotColor(task.status);
  const label = statusLabel(task.status);

  // Last run line
  let lastRunHtml = '';
  if (task.lastRunResult) {
    const icon = task.lastRunSuccess ? '\u2713' : '\u2717';
    const iconColor = task.lastRunSuccess ? 'var(--success)' : 'var(--error)';
    const ago = task.lastRunAgo ? ` ${escapeHtml(task.lastRunAgo)}` : '';
    lastRunHtml = `
      <div class="tv-card-lastrun">
        <span style="color:${iconColor}">${icon}</span>${ago} \u2014 ${escapeHtml(task.lastRunResult)}
      </div>
    `;
  } else if (task.runCount === 0) {
    lastRunHtml = `<div class="tv-card-lastrun">Not yet run</div>`;
  }

  // Stats line
  const stats: string[] = [];
  stats.push(`${task.runCount} run${task.runCount !== 1 ? 's' : ''}`);
  if (task.failureCount > 0) {
    stats.push(`<span style="color:var(--error)">${task.failureCount} failed</span>`);
  }

  // Approval banner
  let approvalHtml = '';
  if (task.status === 'approval_pending' && task.approvalRunId) {
    approvalHtml = `
      <div class="tv-card-approval">
        <span class="tv-card-approval-label">\u26A0 APPROVAL NEEDED</span>
        ${task.approvalSummary ? `<div class="tv-card-approval-text">${escapeHtml(task.approvalSummary)}</div>` : ''}
        <div class="tv-card-actions">
          <button class="tv-btn tv-btn--accent" data-task-action="approve" data-run-id="${escapeHtml(task.approvalRunId)}">Review &amp; Approve</button>
          <button class="tv-btn" data-task-action="dismiss" data-run-id="${escapeHtml(task.approvalRunId)}">Skip</button>
        </div>
      </div>
    `;
  }

  // Action buttons based on state
  let actionsHtml = '';
  if (task.status === 'active') {
    actionsHtml = `
      <div class="tv-card-actions">
        <button class="tv-btn" data-task-action="run-now" data-task-id="${task.id}">Run now</button>
        <button class="tv-btn" data-task-action="pause" data-task-id="${task.id}">Pause</button>
        <button class="tv-btn tv-btn--danger" data-task-action="delete" data-task-id="${task.id}">Delete</button>
      </div>
    `;
  } else if (task.status === 'paused') {
    actionsHtml = `
      <div class="tv-card-actions">
        <button class="tv-btn" data-task-action="resume" data-task-id="${task.id}">Resume</button>
        <button class="tv-btn tv-btn--danger" data-task-action="delete" data-task-id="${task.id}">Delete</button>
      </div>
    `;
  } else if (task.status === 'failed') {
    actionsHtml = `
      <div class="tv-card-actions">
        <button class="tv-btn" data-task-action="run-now" data-task-id="${task.id}">Retry</button>
        <button class="tv-btn tv-btn--danger" data-task-action="delete" data-task-id="${task.id}">Delete</button>
      </div>
    `;
  } else if (task.status === 'running') {
    actionsHtml = `<div class="tv-card-actions"><span class="tv-running-label">Running\u2026</span></div>`;
  }

  const isExpanded = expandedRunHistory.has(task.id);

  return `
    <div class="tv-card" data-task-id="${task.id}">
      <div class="tv-card-header">
        <span class="tv-card-dot" style="background:${dotColor}"></span>
        <span class="tv-card-desc">${escapeHtml(task.description)}</span>
        <span class="tv-card-status-label" style="color:${dotColor}">${label}</span>
      </div>
      <div class="tv-card-meta">
        <span class="tv-card-schedule">${escapeHtml(task.scheduleSummary)}</span>
        <span class="tv-card-sep">\u00B7</span>
        <span class="tv-card-stats">${stats.join(' \u00B7 ')}</span>
      </div>
      ${lastRunHtml}
      ${approvalHtml || actionsHtml}
      <div class="tv-card-footer">
        <button class="tv-history-toggle" data-task-id="${task.id}" data-expanded="${isExpanded}">
          <span class="tv-history-chevron${isExpanded ? ' tv-history-chevron--open' : ''}">\u25B6</span>
          Run History
        </button>
        <div id="tv-executor-${task.id}" class="tv-executor-slot"></div>
      </div>
      <div class="tv-history-panel${isExpanded ? '' : ' hidden'}" id="tv-history-${task.id}">
        <div class="tv-history-loading">Loading\u2026</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Render: Run History Rows
// ---------------------------------------------------------------------------

function renderRunHistory(runs: TaskRun[]): string {
  if (runs.length === 0) {
    return '<div class="tv-history-empty">No runs yet</div>';
  }

  return runs.map((run, i) => {
    const num = runs.length - i;
    const icon = runStatusIcon(run.status);
    const color = runStatusColor(run.status);
    const time = formatTimestamp(run.startedAt);
    const duration = formatDuration(run.durationMs);
    const source = run.triggerSource || 'scheduled';
    const error = run.status === 'failed' && run.errorMessage
      ? `<div class="tv-run-error">${escapeHtml(run.errorMessage.slice(0, 200))}</div>`
      : '';

    return `
      <div class="tv-run-row">
        <span class="tv-run-num">#${num}</span>
        <span class="tv-run-icon" style="color:${color}">${icon}</span>
        <span class="tv-run-time">${time}</span>
        <span class="tv-run-source">${source}</span>
        <span class="tv-run-duration">${duration}</span>
        ${error}
      </div>
    `;
  }).join('');
}

// ---------------------------------------------------------------------------
// Render: Executor Info
// ---------------------------------------------------------------------------

function renderExecutorInfo(executor: TaskExecutor): string {
  const steps = executor.steps || [];
  const toolSteps = steps.filter((s: any) => s.type === 'tool').length;
  const llmSteps = steps.filter((s: any) => s.type === 'llm').length;
  const stats = executor.stats;

  let costHtml = '';
  if (stats?.estimated_cost_per_run) {
    costHtml = `<span class="tv-executor-cost">~$${stats.estimated_cost_per_run.toFixed(4)}/run</span>`;
  }

  return `
    <div class="tv-executor-info">
      <span class="tv-executor-label">Executor v${executor.version}</span>
      <span class="tv-executor-sep">\u00B7</span>
      <span class="tv-executor-detail">${toolSteps} tool${toolSteps !== 1 ? 's' : ''}, ${llmSteps} llm</span>
      ${costHtml ? `<span class="tv-executor-sep">\u00B7</span>${costHtml}` : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Render
// ---------------------------------------------------------------------------

function renderTaskView(tasks: TaskDashboardItem[]): string {
  if (!tasks || tasks.length === 0) {
    return renderEmptyState();
  }

  return `
    <div class="tv-list">
      ${tasks.map(t => renderTaskCard(t)).join('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Event Handling
// ---------------------------------------------------------------------------

function handleTaskAction(action: string, taskId?: string, runId?: string): void {
  if (action === 'run-now' && taskId) {
    window.api.taskRunNow(taskId);
  } else if (action === 'pause' && taskId) {
    window.api.taskPause(taskId);
  } else if (action === 'resume' && taskId) {
    window.api.taskResume(taskId);
  } else if (action === 'delete' && taskId) {
    // Require confirmation
    const btn = elements.tvContent.querySelector(`[data-task-action="delete"][data-task-id="${taskId}"]`) as HTMLButtonElement | null;
    if (btn) {
      if (btn.dataset.confirmPending === 'true') {
        window.api.taskDelete(taskId);
        btn.dataset.confirmPending = '';
      } else {
        btn.dataset.confirmPending = 'true';
        btn.textContent = 'Confirm?';
        btn.classList.add('tv-btn--confirm');
        setTimeout(() => {
          if (btn.dataset.confirmPending === 'true') {
            btn.dataset.confirmPending = '';
            btn.textContent = 'Delete';
            btn.classList.remove('tv-btn--confirm');
          }
        }, 3000);
      }
    }
  } else if (action === 'approve' && runId) {
    window.api.taskApproveRun(runId);
  } else if (action === 'dismiss' && runId) {
    window.api.taskDismissRun(runId);
  }
}

async function toggleRunHistory(taskId: string): Promise<void> {
  const panel = document.getElementById(`tv-history-${taskId}`);
  if (!panel) return;

  if (expandedRunHistory.has(taskId)) {
    expandedRunHistory.delete(taskId);
    panel.classList.add('hidden');
    // Update chevron
    const toggle = elements.tvContent.querySelector(`.tv-history-toggle[data-task-id="${taskId}"]`);
    if (toggle) {
      const chevron = toggle.querySelector('.tv-history-chevron');
      if (chevron) chevron.classList.remove('tv-history-chevron--open');
      toggle.setAttribute('data-expanded', 'false');
    }
    return;
  }

  expandedRunHistory.add(taskId);
  panel.classList.remove('hidden');

  // Update chevron
  const toggle = elements.tvContent.querySelector(`.tv-history-toggle[data-task-id="${taskId}"]`);
  if (toggle) {
    const chevron = toggle.querySelector('.tv-history-chevron');
    if (chevron) chevron.classList.add('tv-history-chevron--open');
    toggle.setAttribute('data-expanded', 'true');
  }

  // Load run history
  panel.innerHTML = '<div class="tv-history-loading">Loading\u2026</div>';
  try {
    const result = await window.api.taskGetRuns(taskId);
    const runs = (result as any)?.runs || [];
    panel.innerHTML = renderRunHistory(runs);
  } catch {
    panel.innerHTML = '<div class="tv-history-empty">Failed to load runs</div>';
  }

  // Also load executor info
  const executorSlot = document.getElementById(`tv-executor-${taskId}`);
  if (executorSlot && !executorSlot.innerHTML.trim()) {
    try {
      const result = await window.api.taskGetExecutor(taskId);
      const executor = (result as any)?.executor;
      if (executor) {
        executorSlot.innerHTML = renderExecutorInfo(executor);
      }
    } catch {
      // Executor info is optional
    }
  }
}

function setupEventDelegation(): void {
  elements.tvContent.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Task action buttons
    const actionEl = target.closest('[data-task-action]') as HTMLElement;
    if (actionEl) {
      e.stopPropagation();
      handleTaskAction(
        actionEl.dataset.taskAction!,
        actionEl.dataset.taskId,
        actionEl.dataset.runId
      );
      return;
    }

    // Run history toggle
    const toggleEl = target.closest('.tv-history-toggle') as HTMLElement;
    if (toggleEl) {
      e.stopPropagation();
      const taskId = toggleEl.dataset.taskId;
      if (taskId) void toggleRunHistory(taskId);
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function updateTaskView(tasks: TaskDashboardItem[]): void {
  cachedTasks = tasks;
  elements.tvContent.innerHTML = renderTaskView(tasks);
}

function subscribeToTaskUpdates(): void {
  if (taskStateUnsubscribe) return;
  taskStateUnsubscribe = window.api.onTaskStateUpdate((items: TaskDashboardItem[]) => {
    console.log('[TaskView] Received TASK_STATE_UPDATE event with', items.length, 'items');
    updateTaskView(items);
  });
}

function unsubscribeFromTaskUpdates(): void {
  if (taskStateUnsubscribe) {
    taskStateUnsubscribe();
    taskStateUnsubscribe = null;
  }
}

export async function showTaskView(): Promise<void> {
  // Re-subscribe to live updates (hideTaskView unsubscribes to avoid stale listeners)
  subscribeToTaskUpdates();

  // Fetch fresh task list from DB (always — never rely on stale cache)
  try {
    const items = await window.api.taskList() as TaskDashboardItem[];
    updateTaskView(items);
  } catch (err) {
    console.error('[TaskView] Failed to fetch task list:', err);
    elements.tvContent.innerHTML = renderEmptyState();
  }
}

export function hideTaskView(): void {
  // Unsubscribe when view is hidden — re-subscribed on next showTaskView()
  unsubscribeFromTaskUpdates();
}

export function isTaskViewVisible(): boolean {
  return !elements.taskView.classList.contains('hidden');
}

export function highlightTaskInView(taskId: string): void {
  const card = elements.tvContent.querySelector(`.tv-card[data-task-id="${taskId}"]`) as HTMLElement;
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('tv-card--highlight');
    setTimeout(() => card.classList.remove('tv-card--highlight'), 2000);
  }
}

export function initTaskView(): void {
  if (taskViewInitialized) return;
  taskViewInitialized = true;
  setupEventDelegation();

  // Subscribe to task updates immediately so we get updates even when the view is hidden
  subscribeToTaskUpdates();
}
