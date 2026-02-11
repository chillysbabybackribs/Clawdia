import { elements } from './state';

type StepStatus = 'running' | 'success' | 'error' | 'warning' | 'skipped';

interface StepRow {
  el: HTMLDivElement;
  status: StepStatus;
  startedAt: number;
  durationEl: HTMLSpanElement;
  substeps?: HTMLDivElement;
  toolName: string;
  args: Record<string, unknown>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.entries(args)[0];
  if (!first) return '';
  const [key, value] = first;
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const trimmed = str.length > 40 ? `${str.slice(0, 37)}…` : str;
  return `${key} ${trimmed}`;
}

function iconForStatus(status: StepStatus): string {
  if (status === 'success') return '✓';
  if (status === 'warning') return '✓';
  if (status === 'error') return '✗';
  if (status === 'skipped') return '·';
  return '◌';
}

class ActivityFeed {
  private container: HTMLDivElement;
  private listEl: HTMLDivElement;
  private summaryEl: HTMLDivElement;
  private toggleEl: HTMLSpanElement;
  private cancelEl: HTMLSpanElement;
  private steps = new Map<string, StepRow>();
  private collapsed = false;
  private startTime = Date.now();
  private actionCount = 0;
  private failureCount = 0;

  constructor(anchor: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'activity-feed';

    const topDivider = document.createElement('div');
    topDivider.className = 'activity-feed__divider';

    this.listEl = document.createElement('div');
    this.listEl.className = 'activity-feed__list';

    const bottomRow = document.createElement('div');
    bottomRow.className = 'activity-feed__footer';

    const bottomDivider = document.createElement('div');
    bottomDivider.className = 'activity-feed__divider';

    this.cancelEl = document.createElement('span');
    this.cancelEl.className = 'activity-feed__cancel';
    this.cancelEl.textContent = 'cancel';
    this.cancelEl.addEventListener('click', () => {
      void window.api.stopGeneration();
    });

    bottomRow.appendChild(bottomDivider);
    bottomRow.appendChild(this.cancelEl);

    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'activity-feed__summary hidden';
    this.summaryEl.title = 'Show details';

    this.toggleEl = document.createElement('span');
    this.toggleEl.className = 'activity-feed__toggle';
    this.toggleEl.textContent = '▾';
    this.summaryEl.appendChild(this.toggleEl);
    this.summaryEl.addEventListener('click', () => {
      if (this.collapsed) {
        this.expand();
      } else {
        this.collapse();
      }
    });

    this.container.appendChild(topDivider);
    this.container.appendChild(this.listEl);
    this.container.appendChild(bottomRow);
    this.container.appendChild(this.summaryEl);

    const parent = anchor.parentElement ?? elements.outputEl;
    parent.insertBefore(this.container, anchor.nextSibling);
  }

  addStep(toolId: string, toolName: string, args: Record<string, unknown>): void {
    const row = document.createElement('div');
    row.className = 'activity-feed__step activity-feed__step--active';

    const icon = document.createElement('span');
    icon.className = 'activity-feed__icon';
    icon.textContent = iconForStatus('running');

    const text = document.createElement('span');
    text.className = 'activity-feed__text';
    const summary = summarizeArgs(args);
    text.textContent = summary ? `${toolName} ${summary}` : toolName;

    const time = document.createElement('span');
    time.className = 'activity-feed__time';
    time.textContent = '...';

    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(time);

    this.listEl.appendChild(row);
    this.steps.set(toolId, { el: row, status: 'running', startedAt: Date.now(), durationEl: time, toolName, args });
    this.actionCount += 1;
    this.container.classList.remove('hidden');
  }

  updateStep(toolId: string, status: 'success' | 'error' | 'warning', duration: number, summary: string): void {
    const step = this.steps.get(toolId);
    if (!step) return;
    step.status = status;
    step.el.classList.remove('activity-feed__step--active');
    step.el.classList.toggle('activity-feed__step--success', status === 'success' || status === 'warning');
    step.el.classList.toggle('activity-feed__step--warning', status === 'warning');
    step.el.classList.toggle('activity-feed__step--error', status === 'error');
    const iconEl = step.el.querySelector('.activity-feed__icon');
    if (iconEl) iconEl.textContent = iconForStatus(status);
    step.durationEl.textContent = formatDuration(duration);
    if (status === 'error') this.failureCount += 1;
    const text = step.el.querySelector('.activity-feed__text');
    if (text && summary) {
      (text as HTMLElement).textContent = summary;
    }

    // Add Undo button for executable plans (ONLY if success)
    if (status === 'success' && (step.toolName === 'action_execute_plan' || step.toolName === 'execute_plan')) {
      const planId = (step.args as any)?.planId;
      if (planId) {
        const undoBtn = document.createElement('button');
        undoBtn.textContent = 'Undo';

        // Inline styles for now, but better to use CSS class
        undoBtn.className = 'tool-activity-undo-btn';
        undoBtn.style.marginLeft = '8px';
        undoBtn.style.padding = '2px 6px';
        undoBtn.style.fontSize = '10px';
        undoBtn.style.borderRadius = '4px';
        undoBtn.style.border = '1px solid var(--border)';
        undoBtn.style.background = 'var(--bg-tertiary)';
        undoBtn.style.color = 'var(--text-secondary)';
        undoBtn.style.cursor = 'pointer';

        undoBtn.onclick = (e) => {
          e.stopPropagation();
          undoBtn.disabled = true;
          undoBtn.textContent = 'Undoing...';
          window.api.actionUndoPlan(planId)
            .then(() => { undoBtn.textContent = 'Undone'; })
            .catch((err: any) => { // Explicit type annotation
              undoBtn.textContent = 'Failed';
              console.error(err);
            });
        };
        step.el.appendChild(undoBtn);
      }
    }
  }

  addSubStep(toolId: string, _stepIndex: number, action: string, status: 'success' | 'error' | 'skipped', duration: number): void {
    const parent = this.steps.get(toolId);
    if (!parent) return;
    if (!parent.substeps) {
      parent.substeps = document.createElement('div');
      parent.substeps.className = 'activity-feed__substeps';
      parent.el.appendChild(parent.substeps);
    }
    const sub = document.createElement('div');
    sub.className = 'activity-feed__step activity-feed__substep';
    sub.classList.toggle('activity-feed__step--success', status === 'success');
    sub.classList.toggle('activity-feed__step--error', status === 'error');
    sub.classList.toggle('activity-feed__step--skipped', status === 'skipped');

    const icon = document.createElement('span');
    icon.className = 'activity-feed__icon';
    icon.textContent = iconForStatus(status);

    const text = document.createElement('span');
    text.className = 'activity-feed__text';
    text.textContent = action;

    const time = document.createElement('span');
    time.className = 'activity-feed__time';
    time.textContent = formatDuration(duration);

    sub.appendChild(icon);
    sub.appendChild(text);
    sub.appendChild(time);
    parent.substeps.appendChild(sub);
    this.actionCount += 1;
    if (status === 'error') this.failureCount += 1;
  }

  complete(totalDuration: number): void {
    const actionsLabel = `${this.actionCount} ${this.actionCount === 1 ? 'action' : 'actions'}`;
    const summaryText = `⚡ ${actionsLabel} · ${(totalDuration / 1000).toFixed(1)}s` + (this.failureCount ? ` · ${this.failureCount} failed` : '');
    this.summaryEl.textContent = summaryText;
    this.summaryEl.appendChild(this.toggleEl);
    this.summaryEl.classList.remove('hidden');

    // Check if we should keep it expanded (e.g. if we have reversible actions)
    const hasReversibleAction = Array.from(this.steps.values()).some(s =>
      s.toolName === 'action_execute_plan' || s.toolName === 'execute_plan'
    );

    if (hasReversibleAction) {
      this.expand();
      // Force immediate visibility
      this.listEl.classList.remove('hidden');
      this.container.classList.remove('activity-feed--collapsed');
    } else {
      this.collapse();
    }
  }

  expand(): void {
    this.collapsed = false;
    this.listEl.classList.remove('hidden');
    this.container.classList.remove('activity-feed--collapsed');
    this.toggleEl.textContent = '▾';
  }

  collapse(): void {
    this.collapsed = true;
    this.listEl.classList.add('hidden');
    this.container.classList.add('activity-feed--collapsed');
    this.toggleEl.textContent = '▸';
  }

  destroy(): void {
    this.container.remove();
    this.steps.clear();
  }
}

let activeFeed: ActivityFeed | null = null;

export function startActivityFeed(anchor: HTMLElement): void {
  activeFeed = new ActivityFeed(anchor);
}

export function collapseActiveFeed(): void {
  activeFeed?.collapse();
}

export function destroyActivityFeed(): void {
  if (activeFeed) {
    activeFeed.destroy();
    activeFeed = null;
  }
}

export function initActivityFeed(): void {
  // Wire IPC listeners
  window.api.onToolExecStart((payload) => {
    if (!activeFeed) return;
    activeFeed.addStep(payload.toolId, payload.toolName, payload.args || {});
  });

  window.api.onToolExecComplete((payload) => {
    if (!activeFeed) return;
    activeFeed.updateStep(payload.toolId, payload.status, payload.duration, payload.summary);
  });

  window.api.onToolStepProgress((payload) => {
    if (!activeFeed) return;
    activeFeed.addSubStep(payload.toolId, payload.stepIndex, payload.action, payload.status, payload.duration);
  });

  window.api.onToolLoopComplete((payload) => {
    if (!activeFeed) return;
    activeFeed.complete(payload.totalDuration);
  });
}

// Reset feed when new chat tab is loaded or cleared
document.addEventListener('clawdia:conversation:reset', () => {
  destroyActivityFeed();
});

// Collapse automatically when assistant starts streaming
window.api.onStreamText(() => {
  if (activeFeed) {
    collapseActiveFeed();
  }
});

// Static hydration for history
export function renderStaticActivityFeed(toolCalls: { id: string; name: string; input: Record<string, unknown>; status: string }[], anchor: HTMLElement): void {
  if (!toolCalls || toolCalls.length === 0) return;

  const feed = new ActivityFeed(anchor);

  // Mark as static/historical
  // (Optional: visual destinction?)

  for (const call of toolCalls) {
    // Determine status
    let status: StepStatus = 'success';
    if (call.status === 'error') status = 'error';
    if (call.status === 'pending') status = 'running';

    // Add step
    feed.addStep(call.id, call.name, call.input);

    // Update step to completion immediately
    // We don't have duration in standard ToolCall types usually, default to 0 or estimates
    feed.updateStep(call.id, (status === 'running' ? 'success' : status) as 'success' | 'error' | 'warning', 0, summarizeArgs(call.input));
  }

  // Complete the feed
  feed.complete(0);
}
