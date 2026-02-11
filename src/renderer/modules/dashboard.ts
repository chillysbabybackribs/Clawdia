// ============================================================================
// Dashboard — Command Center (Redesign)
// Layout: Projects → Activity → Tasks → Alerts (Conditional) → Status Bar
// ============================================================================

import type {
  DashboardState,
  DashboardProjectCard,
  DashboardActivityItem,
  DashboardAlert,
  TaskDashboardItem,
  SystemMetrics,
  StaticDashboardState,
} from '../../shared/dashboard-types';
import { renderMarkdown } from './markdown';
import { elements } from './state';

let dashboardContainer: HTMLDivElement | null = null;
let updateUnsubscribe: (() => void) | null = null;
let taskStateUnsubscribe: (() => void) | null = null;
let taskNotificationsInitialized = false;
let cachedState: DashboardState | null = null;
let fetchAttempted = false;

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

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICONS = {
  fire: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="dash-icon-fire"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.1.2-2.2.6-3a6.87 6.87 0 0 0 .9 2.5z"/></svg>',
  circle: '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="10"/></svg>',
  browser: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
  alert: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

// ---------------------------------------------------------------------------
// Render Functions
// ---------------------------------------------------------------------------

function renderProjects(projects: DashboardProjectCard[]): string {
  if (!projects || projects.length === 0) return '';

  const fullCards: string[] = [];
  const compactLines: string[] = [];

  for (const p of projects.slice(0, 5)) {
    const hasChanges = (p.uncommittedCount ?? 0) > 0 || (p.unpushedCount ?? 0) > 0;
    const isFullCard = p.heatScore > 50 || hasChanges;

    if (isFullCard) {
      // --- Full card ---
      const heatIcon = p.heatScore > 70 ? ICONS.fire : '';

      let statusColor = 'var(--success)';
      if (p.unpushedCount && p.unpushedCount > 0) statusColor = 'var(--error)';
      else if (p.uncommittedCount && p.uncommittedCount > 0) statusColor = '#f59e0b';
      const statusDot = `<span style="color:${statusColor}">${ICONS.circle}</span>`;

      const metaParts: string[] = [];
      if (p.uncommittedCount) metaParts.push(`${p.uncommittedCount} uncommitted`);
      if (p.unpushedCount) metaParts.push(`${p.unpushedCount} unpushed`);
      if (typeof p.hoursSinceLastCommit === 'number') {
        const time = p.hoursSinceLastCommit < 1 ? '<1h ago' : `${Math.round(p.hoursSinceLastCommit)}h ago`;
        metaParts.push(time);
      }
      const metaLine = metaParts.join(' · ');

      const commitMsg = p.lastCommitMessage
        ? `<div class="dash-project-commit" title="${p.lastCommitMessage.replace(/"/g, '&quot;')}">"${p.lastCommitMessage}"</div>`
        : '';

      let actionsHtml = '';
      if (p.actions && p.actions.length > 0) {
        actionsHtml = `<div class="dash-project-actions">
          ${p.actions.map(a => `
            <button class="dash-btn" data-action="${a.command.replace(/"/g, '&quot;')}">${a.label}</button>
          `).join('')}
        </div>`;
      }

      fullCards.push(`
        <div class="dash-project dash-project--hot">
          <div class="dash-project-header">
            ${statusDot}
            <span class="dash-project-name">${p.name}</span>
            ${p.branch ? `<span class="dash-project-branch">(${p.branch})</span>` : ''}
            ${heatIcon}
          </div>
          ${metaLine ? `<div class="dash-project-meta">${metaLine}</div>` : ''}
          ${commitMsg}
          ${actionsHtml}
        </div>
      `);
    } else {
      // --- Compact single-line ---
      const timeStr = typeof p.hoursSinceLastCommit === 'number'
        ? (p.hoursSinceLastCommit < 24 ? 'today' : `${Math.round(p.hoursSinceLastCommit / 24)}d ago`)
        : '';
      const parts = [
        p.branch ? `<span class="dash-compact-branch">(${p.branch})</span>` : '',
        '<span class="dash-compact-status">clean</span>',
        timeStr ? `<span class="dash-compact-time">${timeStr}</span>` : '',
      ].filter(Boolean);

      compactLines.push(`
        <div class="dash-project-compact">
          <span style="color:var(--success)">${ICONS.circle}</span>
          <span class="dash-compact-name">${p.name}</span>
          ${parts.join('<span class="dash-compact-sep">·</span>')}
        </div>
      `);
    }
  }

  if (fullCards.length === 0 && compactLines.length === 0) return '';

  return `
    <div class="dash-section">
      <div class="dash-section-title">PROJECTS</div>
      <div class="dash-projects-list">
        ${fullCards.join('')}
        ${compactLines.join('')}
      </div>
    </div>
  `;
}

function renderActivity(feed: DashboardActivityItem[], patternNote?: string): string {
  if ((!feed || feed.length === 0) && !patternNote) return '';

  const itemsHtml = feed.slice(0, 6).map(item => {
    let icon = ICONS.file;
    if (item.type === 'browser') icon = ICONS.browser;
    else if (item.type === 'shell') icon = ICONS.terminal;

    // Shell commands use monospace, browser domain part uses regular font
    const textClass = item.type === 'shell' ? 'dash-activity-text dash-mono' : 'dash-activity-text';

    return `
      <div class="dash-activity-item"${item.command ? ` data-action="${item.command.replace(/"/g, '&quot;')}" role="button" tabindex="0"` : ''}>
        <span class="dash-activity-icon">${icon}</span>
        <span class="${textClass}" title="${item.text.replace(/"/g, '&quot;')}">${item.text}</span>
      </div>
    `;
  }).join('');

  const noteHtml = patternNote
    ? `<div class="dash-pattern-note">${ICONS.circle} ${patternNote}</div>`
    : '';

  return `
    <div class="dash-section">
      <div class="dash-section-title">ACTIVITY</div>
      ${noteHtml}
      <div class="dash-activity-list">
        ${itemsHtml}
      </div>
    </div>
  `;
}

function renderAlerts(alerts: DashboardAlert[]): string {
  if (!alerts || alerts.length === 0) return '';

  return `
    <div class="dash-alerts">
      ${alerts.map(a => {
    const actionBtn = a.action && a.actionLabel
      ? `<button class="dash-alert-action" data-action="${a.action.replace(/"/g, '&quot;')}">${a.actionLabel}</button>`
      : '';

    return `
        <div class="dash-alert dash-alert--${a.severity}" data-alert-id="${a.id}">
          <span class="dash-alert-icon">${ICONS.alert}</span>
          <span class="dash-alert-text">${a.message}</span>
          ${actionBtn}
          <button class="dash-alert-dismiss" title="Dismiss">${ICONS.close}</button>
        </div>
      `}).join('')}
    </div>
  `;
}

function renderTasks(tasks: TaskDashboardItem[], unreadCount: number): string {
  if (!tasks || tasks.length === 0) return '';

  const badge = unreadCount > 0 ? ` <span class="dash-task-badge">${unreadCount} new</span>` : '';

  const taskCards = tasks.map(t => {
    // Status dot color
    let dotColor = 'var(--success)';     // active = green
    if (t.status === 'paused') dotColor = '#f59e0b';           // yellow
    else if (t.status === 'failed') dotColor = 'var(--error)';  // red
    else if (t.status === 'running') dotColor = 'var(--accent)'; // blue
    else if (t.status === 'approval_pending') dotColor = '#f97316'; // orange

    const dot = `<span class="dash-task-dot" style="background:${dotColor}"></span>`;

    // Schedule line
    const scheduleLine = `<span class="dash-task-schedule">${escapeHtml(t.scheduleSummary)}</span>`;

    // Last run result
    let lastRunHtml = '';
    if (t.lastRunResult) {
      const icon = t.lastRunSuccess ? '\u2713' : '\u2717';
      const ago = t.lastRunAgo ? ` ${escapeHtml(t.lastRunAgo)}` : '';
      lastRunHtml = `<div class="dash-task-lastrun">Last: ${icon}${ago} \u2014 "${escapeHtml(t.lastRunResult)}"</div>`;
    } else if (t.runCount === 0) {
      lastRunHtml = `<div class="dash-task-lastrun">Not yet run</div>`;
    }

    // Approval banner
    let approvalHtml = '';
    if (t.status === 'approval_pending' && t.approvalRunId) {
      approvalHtml = `
        <div class="dash-task-approval">
          <span class="dash-task-approval-label">\u26A0 APPROVAL NEEDED</span>
          ${t.approvalSummary ? `<div class="dash-task-approval-text">${escapeHtml(t.approvalSummary)}</div>` : ''}
          <div class="dash-task-actions">
            <button class="dash-btn dash-btn--accent" data-task-action="approve" data-run-id="${escapeHtml(t.approvalRunId)}">Review &amp; Approve</button>
            <button class="dash-btn" data-task-action="dismiss" data-run-id="${escapeHtml(t.approvalRunId)}">Skip</button>
          </div>
        </div>
      `;
    }

    // Action buttons based on state
    let actionsHtml = '';
    if (t.status === 'active') {
      actionsHtml = `
        <div class="dash-task-actions">
          <button class="dash-btn" data-task-action="run-now" data-task-id="${t.id}">Run now</button>
          <button class="dash-btn" data-task-action="pause" data-task-id="${t.id}">Pause</button>
        </div>
      `;
    } else if (t.status === 'paused') {
      actionsHtml = `
        <div class="dash-task-actions">
          <button class="dash-btn" data-task-action="resume" data-task-id="${t.id}">Resume</button>
          <button class="dash-btn dash-btn--danger" data-task-action="delete" data-task-id="${t.id}">Delete</button>
        </div>
      `;
    } else if (t.status === 'failed') {
      actionsHtml = `
        <div class="dash-task-actions">
          <button class="dash-btn" data-task-action="run-now" data-task-id="${t.id}">Retry</button>
          <button class="dash-btn dash-btn--danger" data-task-action="delete" data-task-id="${t.id}">Delete</button>
        </div>
      `;
    } else if (t.status === 'running') {
      actionsHtml = `<div class="dash-task-actions"><span class="dash-task-running-label">Running\u2026</span></div>`;
    }

    return `
      <div class="dash-task" data-task-id="${t.id}">
        <div class="dash-task-header">
          ${dot}
          <span class="dash-task-desc">${escapeHtml(t.description)}</span>
          ${scheduleLine}
        </div>
        ${lastRunHtml}
        ${approvalHtml || actionsHtml}
      </div>
    `;
  }).join('');

  return `
    <div class="dash-section">
      <div class="dash-section-title">TASKS${badge}</div>
      <div class="dash-tasks-list">
        ${taskCards}
      </div>
    </div>
  `;
}

function renderStatusBar(metrics?: SystemMetrics, staticState?: StaticDashboardState): string {
  if (!metrics) return '';

  // Severity helper
  const sev = (val: number, warn: number, crit: number): string =>
    val > crit ? 'critical' : (val > warn ? 'warning' : 'normal');

  const cpuVal = metrics.cpu.usagePercent;
  const memUsed = (metrics.memory.usedMB / 1024).toFixed(1);
  const diskUsed = metrics.disk.usedGB;

  const cpuSev = sev(cpuVal, 70, 90);
  const memSev = sev(metrics.memory.usagePercent, 75, 90);
  const diskSev = sev(metrics.disk.usagePercent, 85, 95);

  // Inline metrics: "CPU 22% · RAM 11.3G · DISK 273G"
  const metricSpans = [
    `<span class="dash-metric-inline dash-metric--${cpuSev}">CPU ${cpuVal}%</span>`,
    `<span class="dash-metric-inline dash-metric--${memSev}">RAM ${memUsed}G</span>`,
    `<span class="dash-metric-inline dash-metric--${diskSev}">DISK ${diskUsed}G</span>`,
  ];

  // Tool dots
  let toolsHtml = '';
  if (staticState) {
    toolsHtml = staticState.toolStatuses.map(t => {
      const dotClass = `dash-status-dot--${t.status}`;
      return `<span class="dash-status-tool"><span class="dash-status-dot ${dotClass}"></span>${t.name}</span>`;
    }).join('');
  }

  // Footer: model · uptime · cost
  let footerParts: string[] = [];
  if (staticState) {
    footerParts.push(staticState.activeModel);
    if (staticState.uptime) footerParts.push(`up ${staticState.uptime}`);
    if (staticState.sessionCost) footerParts.push(staticState.sessionCost);
  }

  return `
    <div class="dash-status-bar">
      <div class="dash-metrics-inline-row">
        ${metricSpans.join('<span class="dash-metric-sep">·</span>')}
        ${toolsHtml ? `<span class="dash-metric-sep">·</span>${toolsHtml}` : ''}
      </div>
      ${footerParts.length > 0 ? `<div class="dash-footer-row">${footerParts.join(' <span class="dash-footer-sep">·</span> ')}</div>` : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Task Run Notification — Toast + Report Modal
// ---------------------------------------------------------------------------

interface TaskRunNotificationData {
  taskId: string;
  description: string;
  status: string;
  responseText: string;
  errorMessage?: string;
  durationMs: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

let activeToast: HTMLElement | null = null;
let toastDismissTimer: ReturnType<typeof setTimeout> | null = null;

function showTaskToast(data: TaskRunNotificationData): void {
  // Remove existing toast if any
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }
  if (toastDismissTimer) {
    clearTimeout(toastDismissTimer);
    toastDismissTimer = null;
  }

  const isSuccess = data.status === 'completed';
  const icon = isSuccess ? '\u2713' : '\u2717';
  const iconClass = isSuccess ? 'task-toast-icon--success' : 'task-toast-icon--error';

  // Render a preview of the response (first ~120 chars of plain text)
  const previewText = isSuccess
    ? (data.responseText || '').slice(0, 120)
    : (data.errorMessage || 'Unknown error').slice(0, 120);
  const previewHtml = renderMarkdown(previewText);

  const toast = document.createElement('div');
  toast.className = 'task-toast task-toast-enter';

  // When the browser panel is open, the BrowserView (a native Electron overlay)
  // covers the right side of the window. A fixed-position toast at right:16px would
  // be hidden behind it. Detect this and anchor the toast inside the chat container instead.
  const panelOpen = !elements.panelContainer?.classList.contains('hidden');
  if (panelOpen) {
    toast.classList.add('task-toast--chat-anchored');
  }

  toast.innerHTML = `
    <div class="task-toast-row">
      <span class="task-toast-icon ${iconClass}">${icon}</span>
      <div class="task-toast-body">
        <div class="task-toast-title">${escapeHtml(data.description)}</div>
        <div class="task-toast-preview">${previewHtml}</div>
      </div>
    </div>
  `;

  toast.addEventListener('click', () => {
    dismissToast();
    showTaskReportInChat(data);
  });

  // Append to chat container when panel is open (so it stays above BrowserView),
  // otherwise to document.body for full-width positioning.
  const chatContainer = document.querySelector('.chat-container');
  if (panelOpen && chatContainer) {
    chatContainer.appendChild(toast);
  } else {
    document.body.appendChild(toast);
  }
  activeToast = toast;

  // Trigger enter animation
  requestAnimationFrame(() => {
    toast.classList.remove('task-toast-enter');
  });

  // Auto-dismiss after 8 seconds
  toastDismissTimer = setTimeout(() => dismissToast(), 8000);
}

function dismissToast(): void {
  if (toastDismissTimer) {
    clearTimeout(toastDismissTimer);
    toastDismissTimer = null;
  }
  if (!activeToast) return;

  const toast = activeToast;
  activeToast = null;
  toast.classList.add('task-toast-exit');
  setTimeout(() => toast.remove(), 300);
}

/** Inject task report as an inline card in the chat output area */
function showTaskReportInChat(data: TaskRunNotificationData): void {
  const outputEl = elements.outputEl;
  if (!outputEl) return;

  const isSuccess = data.status === 'completed';
  const icon = isSuccess ? '\u2713' : '\u2717';
  const statusClass = isSuccess ? 'task-report-inline--success' : 'task-report-inline--error';

  const durationStr = data.durationMs < 1000
    ? `${data.durationMs}ms`
    : `${(data.durationMs / 1000).toFixed(1)}s`;
  const tokens = `${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out`;
  const metaParts = [durationStr, tokens];
  if (data.toolCallCount > 0) metaParts.push(`${data.toolCallCount} tool calls`);

  const bodyText = isSuccess
    ? (data.responseText || 'No output.')
    : (data.errorMessage || 'Unknown error');

  const card = document.createElement('div');
  card.className = `task-report-inline ${statusClass}`;
  card.innerHTML = `
    <div class="task-report-inline-header">
      <span class="task-report-inline-icon">${icon}</span>
      <span class="task-report-inline-title">${escapeHtml(data.description)}</span>
      <button class="task-report-inline-dismiss" title="Dismiss">${ICONS.close}</button>
    </div>
    <div class="task-report-inline-meta">${metaParts.join('  \u00B7  ')}</div>
    <div class="task-report-inline-body message-content">${renderMarkdown(bodyText)}</div>
    <div class="task-report-inline-actions">
      <button class="dash-btn task-report-action-pause">Pause</button>
      <button class="dash-btn dash-btn--danger task-report-action-delete">Delete</button>
    </div>
  `;

  const removeCard = () => {
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 200);
  };

  // Dismiss button
  const dismissBtn = card.querySelector('.task-report-inline-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', removeCard);
  }

  // Pause button
  const pauseBtn = card.querySelector('.task-report-action-pause') as HTMLButtonElement | null;
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      window.api.taskPause(data.taskId);
      pauseBtn.textContent = 'Paused';
      pauseBtn.disabled = true;
    });
  }

  // Delete button — requires confirmation
  const deleteBtn = card.querySelector('.task-report-action-delete') as HTMLButtonElement | null;
  if (deleteBtn) {
    let confirmPending = false;
    deleteBtn.addEventListener('click', () => {
      if (!confirmPending) {
        confirmPending = true;
        deleteBtn.textContent = 'Confirm delete?';
        deleteBtn.classList.add('task-report-action-delete--confirm');
        // Auto-reset after 3 seconds
        setTimeout(() => {
          if (confirmPending) {
            confirmPending = false;
            deleteBtn.textContent = 'Delete';
            deleteBtn.classList.remove('task-report-action-delete--confirm');
          }
        }, 3000);
      } else {
        window.api.taskDelete(data.taskId);
        removeCard();
      }
    });
  }

  outputEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ---------------------------------------------------------------------------
// Main Render Logic
// ---------------------------------------------------------------------------

function renderDashboard(state: DashboardState): string {
  const sections: string[] = [];

  // Only show projects section if any have heat > 10
  const visibleProjects = (state.projects || []).filter(p => p.heatScore > 10);
  const projectsHtml = renderProjects(visibleProjects);
  if (projectsHtml) sections.push(projectsHtml);

  // Only show activity if there's data
  const activityHtml = renderActivity(state.activityFeed || [], state.patternNote);
  if (activityHtml) sections.push(activityHtml);

  // Tasks section — hidden when empty
  const tasksHtml = renderTasks(state.tasks || [], state.taskUnreadCount || 0);
  if (tasksHtml) sections.push(tasksHtml);

  // Alerts always shown if present
  if (state.alerts && state.alerts.length > 0) {
    sections.push(renderAlerts(state.alerts));
  }

  // Status bar always shown (this is the "nothing to show" fallback)
  if (state.metrics) {
    sections.push(renderStatusBar(state.metrics, state.static));
  }

  return `
    <div class="dash-inner">
      ${sections.join('')}
    </div>
  `;
}

export function showDashboard(outputEl: HTMLElement, state: DashboardState): void {
  // If we already have a container and it's visible, update in place logic 
  // allows us to avoid re-creating DOM if we want, but here we rebuild for simplicity
  // unless we want to avoid focus loss.

  if (dashboardContainer) {
    dashboardContainer.innerHTML = renderDashboard(state);
    return;
  }

  cachedState = state;

  const container = document.createElement('div');
  container.className = 'dash-container';
  container.innerHTML = renderDashboard(state);

  // Event Delegation
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Dismiss alert
    const dismissBtn = target.closest('.dash-alert-dismiss');
    if (dismissBtn) {
      e.stopPropagation();
      const alertEl = dismissBtn.closest('.dash-alert') as HTMLElement;
      if (alertEl && alertEl.dataset.alertId) {
        window.api.dismissDashboardAlert(alertEl.dataset.alertId);

        alertEl.style.opacity = '0';
        setTimeout(() => alertEl.remove(), 200);
      }
      return;
    }

    // Task actions
    const taskActionEl = target.closest('[data-task-action]') as HTMLElement;
    if (taskActionEl) {
      e.stopPropagation();
      const action = taskActionEl.dataset.taskAction;
      const taskId = taskActionEl.dataset.taskId;
      const runId = taskActionEl.dataset.runId;

      if (action === 'run-now' && taskId) {
        window.api.taskRunNow(taskId);
      } else if (action === 'pause' && taskId) {
        window.api.taskPause(taskId);
      } else if (action === 'resume' && taskId) {
        window.api.taskResume(taskId);
      } else if (action === 'delete' && taskId) {
        window.api.taskDelete(taskId);
      } else if (action === 'approve' && runId) {
        window.api.taskApproveRun(runId);
      } else if (action === 'dismiss' && runId) {
        window.api.taskDismissRun(runId);
      }
      return;
    }

    // Action execution (buttons or clickable cards/rows)
    const actionEl = target.closest('[data-action]') as HTMLElement;
    if (actionEl) {
      const command = actionEl.dataset.action;
      if (command) executeAction(command);
    }
  });

  outputEl.appendChild(container);
  dashboardContainer = container;

  subscribeToUpdates();
  window.api.setDashboardVisible(true);

  // Fade in
  requestAnimationFrame(() => container.classList.add('dash-visible'));
}

function updateDashboardInPlace(state: DashboardState): void {
  if (!dashboardContainer) return;
  dashboardContainer.innerHTML = renderDashboard(state);
}

// ---------------------------------------------------------------------------
// Global Task Notification Subscriptions (independent of dashboard visibility)
// ---------------------------------------------------------------------------

/** Subscribe to task notifications globally — called once at app init, never torn down. */
export function initTaskNotifications(): void {
  if (taskNotificationsInitialized) return;
  taskNotificationsInitialized = true;

  // Toast + report modal on task run completion — must fire even when dashboard is hidden
  window.api.onTaskRunNotification((data) => {
    showTaskToast(data);
  });

  // Focus task card when OS notification is clicked
  window.api.onTaskFocus((taskId) => {
    highlightTask(taskId);
  });

  // Focus approval card when OS notification is clicked
  window.api.onTaskApprovalFocus((runId) => {
    if (!dashboardContainer) return;
    const btn = dashboardContainer.querySelector(`[data-run-id="${runId}"]`);
    if (btn) {
      const card = btn.closest('.dash-task') as HTMLElement;
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('dash-task--highlight');
        setTimeout(() => card.classList.remove('dash-task--highlight'), 2000);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle & Helpers
// ---------------------------------------------------------------------------

function subscribeToUpdates(): void {
  if (updateUnsubscribe) return;
  updateUnsubscribe = window.api.onDashboardUpdate((state: DashboardState) => {
    if (dashboardContainer && state) {
      cachedState = state;
      updateDashboardInPlace(state);
    }
  });

  // Also subscribe to task state updates (pushed when tasks change)
  if (!taskStateUnsubscribe) {
    taskStateUnsubscribe = window.api.onTaskStateUpdate((items) => {
      if (cachedState && dashboardContainer) {
        cachedState.tasks = items;
        updateDashboardInPlace(cachedState);
      }
    });
  }

  // Clear unread count when dashboard becomes visible
  window.api.taskClearUnread().catch(() => {});
}

function highlightTask(taskId: string): void {
  if (!dashboardContainer) return;
  const card = dashboardContainer.querySelector(`.dash-task[data-task-id="${taskId}"]`) as HTMLElement;
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('dash-task--highlight');
    setTimeout(() => card.classList.remove('dash-task--highlight'), 2000);
  }
}

function unsubscribeFromUpdates(): void {
  if (updateUnsubscribe) {
    updateUnsubscribe();
    updateUnsubscribe = null;
  }
  if (taskStateUnsubscribe) {
    taskStateUnsubscribe();
    taskStateUnsubscribe = null;
  }
  // Note: task notification listeners (toast, focus, approval) are global — never torn down
}

function executeAction(action: string): void {
  hideDashboard();
  elements.promptEl.value = action;
  elements.promptEl.dispatchEvent(new Event('input', { bubbles: true }));
  elements.sendBtn.click();
}

export function hideDashboard(): void {
  unsubscribeFromUpdates();
  window.api.setDashboardVisible(false);
  if (dashboardContainer) {
    dashboardContainer.remove();
    dashboardContainer = null;
  }
}

export function isDashboardVisible(): boolean {
  return dashboardContainer !== null;
}

export async function fetchAndShowDashboard(outputEl: HTMLElement): Promise<void> {
  if (fetchAttempted && cachedState) {
    showDashboard(outputEl, cachedState);
    return;
  }
  if (fetchAttempted) return;
  fetchAttempted = true;

  try {
    const state = await window.api.getDashboard();
    if (state) {
      cachedState = state;
      showDashboard(outputEl, state);
    }
  } catch {
    // Dashboard is optional
  }
}

export function resetDashboardCache(): void {
  fetchAttempted = false;
  cachedState = null;
}
