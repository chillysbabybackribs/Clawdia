import { elements } from './state';
import type { ApprovalRequest } from '../../shared/autonomy';

type StepStatus = 'running' | 'success' | 'error' | 'skipped' | 'blocked' | 'denied';

interface StepRow {
  el: HTMLDivElement;
  status: StepStatus;
  startedAt: number;
  durationEl: HTMLSpanElement;
  substeps?: HTMLDivElement;
  toolName: string;
  args: Record<string, unknown>;
  stderr?: string[];
  stdout?: string[];
}

interface PipelinePhase {
  name: string;
  steps: string[]; // tool IDs
  status: StepStatus;
  el: HTMLDivElement;
  contentEl: HTMLDivElement;
  headerEl: HTMLDivElement;
  collapsed: boolean;
}

interface ActionRequiredCard {
  id: string;
  title: string;
  description: string;
  primaryAction?: { label: string; command: string };
  secondaryAction?: { label: string; callback: () => void };
}

// Pattern matchers for actionable errors
const ERROR_PATTERNS = [
  {
    regex: /vercel.*login|vercel.*auth.*expired|vercel.*token/i,
    card: {
      title: 'Vercel login required',
      description: 'Your Vercel authentication has expired. Please log in again.',
      primaryAction: { label: 'Login to Vercel', command: 'vercel login' },
    }
  },
  {
    regex: /git.*authentication.*failed|git.*permission.*denied|remote:.*authentication/i,
    card: {
      title: 'Git authentication failed',
      description: 'Unable to authenticate with the remote repository. Check your credentials.',
      primaryAction: { label: 'Configure Git', command: 'git config --list' },
    }
  },
  {
    regex: /tag.*already.*exists|tag.*'.*'.*already/i,
    card: {
      title: 'Tag already exists',
      description: 'The Git tag you\'re trying to create already exists in the repository.',
      primaryAction: { label: 'Delete tag', command: 'git tag -d' },
    }
  },
  {
    regex: /no.*git.*remote|fatal:.*no.*configured.*push/i,
    card: {
      title: 'No Git remote configured',
      description: 'Your repository doesn\'t have a remote configured for pushing.',
      primaryAction: { label: 'View remotes', command: 'git remote -v' },
    }
  },
  {
    regex: /permission.*denied.*sudo|sudo:.*password/i,
    card: {
      title: 'Permission denied',
      description: 'The operation requires elevated privileges.',
    }
  },
];

// Phase detection patterns
const PHASE_PATTERNS = [
  { regex: /^git add/, phase: 'staging' },
  { regex: /^git commit/, phase: 'commit' },
  { regex: /^git tag/, phase: 'tag' },
  { regex: /^git push/, phase: 'push' },
  { regex: /^vercel/, phase: 'deploy' },
  { regex: /^npm (run |)build/, phase: 'build' },
  { regex: /^npm (run |)test/, phase: 'test' },
  { regex: /browser_navigate|browser_click|browser_type/, phase: 'browser' },
  { regex: /file_write|file_edit/, phase: 'files' },
];

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
  if (status === 'success') return '›';
  if (status === 'error') return '×';
  if (status === 'skipped') return '·';
  if (status === 'blocked') return '‖';
  if (status === 'denied') return '×';
  return '›';
}

function detectPhase(toolName: string, args: Record<string, unknown>): string {
  const commandStr = `${toolName} ${JSON.stringify(args)}`.toLowerCase();
  for (const pattern of PHASE_PATTERNS) {
    if (pattern.regex.test(commandStr)) {
      return pattern.phase;
    }
  }
  return 'general';
}

function detectActionRequired(stderr: string[]): ActionRequiredCard | null {
  const fullStderr = stderr.join('\n');
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.regex.test(fullStderr)) {
      return {
        id: Math.random().toString(36).slice(2),
        ...pattern.card
      };
    }
  }
  return null;
}

class EnhancedActivityFeed {
  private container: HTMLDivElement;
  private pipelineHeader: HTMLDivElement;
  private actionCardsContainer: HTMLDivElement;
  private phasesContainer: HTMLDivElement;
  private footerRow: HTMLDivElement;
  private cancelEl: HTMLSpanElement;
  private verboseToggle: HTMLButtonElement;
  private steps = new Map<string, StepRow>();
  private phases = new Map<string, PipelinePhase>();
  private actionCards = new Map<string, HTMLDivElement>();
  private startTime = Date.now();
  private totalSteps = 0;
  private completedSteps = 0;
  private failedSteps = 0;
  private verboseMode = false;
  private currentPhase: string | null = null;
  private pipelineStatus: 'running' | 'success' | 'failed' | 'blocked' | 'denied' = 'running';
  private currentApprovalRequest: ApprovalRequest | null = null;

  constructor(anchor: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'enhanced-activity-feed';

    // Pipeline State Header
    this.pipelineHeader = this.createPipelineHeader();

    // Action Required Cards
    this.actionCardsContainer = document.createElement('div');
    this.actionCardsContainer.className = 'action-cards-container';

    // Phases Container
    this.phasesContainer = document.createElement('div');
    this.phasesContainer.className = 'phases-container';

    // Footer with cancel and verbose toggle
    this.footerRow = document.createElement('div');
    this.footerRow.className = 'activity-feed__footer';

    const footerDivider = document.createElement('div');
    footerDivider.className = 'activity-feed__divider';

    this.verboseToggle = document.createElement('button');
    this.verboseToggle.className = 'verbose-toggle';
    this.verboseToggle.textContent = 'Normal';
    this.verboseToggle.title = 'Toggle verbose output';
    this.verboseToggle.addEventListener('click', () => this.toggleVerbose());

    this.cancelEl = document.createElement('span');
    this.cancelEl.className = 'activity-feed__cancel';
    this.cancelEl.textContent = 'cancel';
    this.cancelEl.addEventListener('click', () => {
      void window.api.stopGeneration();
    });

    this.footerRow.appendChild(footerDivider);
    this.footerRow.appendChild(this.verboseToggle);
    this.footerRow.appendChild(this.cancelEl);

    this.container.appendChild(this.pipelineHeader);
    this.container.appendChild(this.actionCardsContainer);
    this.container.appendChild(this.phasesContainer);
    this.container.appendChild(this.footerRow);

    const parent = anchor.parentElement ?? elements.outputEl;
    parent.insertBefore(this.container, anchor.nextSibling);
  }

  private createPipelineHeader(): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'pipeline-header';
    header.innerHTML = `
      <div class="pipeline-status">
        <span class="pipeline-status-icon">▸</span>
        <span class="pipeline-status-text">running</span>
      </div>
      <div class="pipeline-progress">
        <span class="pipeline-progress-text">0/0</span>
      </div>
    `;
    return header;
  }

  private updatePipelineHeader(): void {
    const statusTextEl = this.pipelineHeader.querySelector('.pipeline-status-text');
    const progressTextEl = this.pipelineHeader.querySelector('.pipeline-progress-text');
    const statusIconEl = this.pipelineHeader.querySelector('.pipeline-status-icon');

    if (statusTextEl) {
      const statusLabels = {
        running: 'running',
        success: 'done',
        failed: 'failed',
        blocked: 'awaiting approval',
        denied: 'denied'
      };
      statusTextEl.textContent = statusLabels[this.pipelineStatus];
      this.pipelineHeader.className = `pipeline-header pipeline-header--${this.pipelineStatus}`;
    }

    if (statusIconEl) {
      const icons = {
        running: '▸',
        success: '—',
        failed: '×',
        blocked: '‖',
        denied: '×'
      };
      statusIconEl.textContent = icons[this.pipelineStatus];
    }

    if (progressTextEl) {
      progressTextEl.textContent = `${this.completedSteps}/${this.totalSteps}`;
    }
  }

  private getOrCreatePhase(phaseName: string): PipelinePhase {
    if (this.phases.has(phaseName)) {
      return this.phases.get(phaseName)!;
    }

    const phaseEl = document.createElement('div');
    phaseEl.className = 'pipeline-phase';

    const headerEl = document.createElement('div');
    headerEl.className = 'pipeline-phase-header';
    headerEl.innerHTML = `
      <span class="pipeline-phase-icon">${iconForStatus('running')}</span>
      <span class="pipeline-phase-title">${phaseName}</span>
      <span class="pipeline-phase-status"></span>
      <span class="pipeline-phase-chevron">▾</span>
    `;

    const contentEl = document.createElement('div');
    contentEl.className = 'pipeline-phase-content';

    headerEl.addEventListener('click', () => {
      const phase = this.phases.get(phaseName);
      if (phase) {
        phase.collapsed = !phase.collapsed;
        phaseEl.classList.toggle('collapsed', phase.collapsed);
        const chevron = headerEl.querySelector('.pipeline-phase-chevron');
        if (chevron) chevron.textContent = phase.collapsed ? '▸' : '▾';
      }
    });

    phaseEl.appendChild(headerEl);
    phaseEl.appendChild(contentEl);
    this.phasesContainer.appendChild(phaseEl);

    const phase: PipelinePhase = {
      name: phaseName,
      steps: [],
      status: 'running',
      el: phaseEl,
      contentEl,
      headerEl,
      collapsed: false
    };

    this.phases.set(phaseName, phase);
    return phase;
  }

  private updatePhaseStatus(phaseName: string): void {
    const phase = this.phases.get(phaseName);
    if (!phase) return;

    const phaseSteps = phase.steps.map(id => this.steps.get(id)).filter(Boolean) as StepRow[];
    const hasRunning = phaseSteps.some(s => s.status === 'running');
    const hasBlocked = phaseSteps.some(s => s.status === 'blocked');
    const hasDenied = phaseSteps.some(s => s.status === 'denied');
    const hasFailed = phaseSteps.some(s => s.status === 'error');
    const allComplete = phaseSteps.every(s => s.status === 'success' || s.status === 'error' || s.status === 'skipped' || s.status === 'denied');

    if (hasBlocked) {
      phase.status = 'blocked';
    } else if (hasRunning) {
      phase.status = 'running';
    } else if (hasDenied) {
      phase.status = 'denied';
    } else if (hasFailed) {
      phase.status = 'error';
    } else if (allComplete) {
      phase.status = 'success';
    }

    const iconEl = phase.headerEl.querySelector('.pipeline-phase-icon');
    if (iconEl) iconEl.textContent = iconForStatus(phase.status);

    const statusEl = phase.headerEl.querySelector('.pipeline-phase-status');
    if (statusEl) {
      if (hasBlocked && this.currentApprovalRequest) {
        statusEl.textContent = 'Awaiting approval';
        statusEl.className = 'pipeline-phase-status pipeline-phase-status--blocked';
      } else {
        statusEl.textContent = '';
        statusEl.className = 'pipeline-phase-status';
      }
    }

    phase.el.className = `pipeline-phase pipeline-phase--${phase.status}`;
  }

  private shouldShowInNormalMode(toolName: string, status: StepStatus): boolean {
    if (this.verboseMode) return true;

    // Always show errors
    if (status === 'error') return true;

    // Hide internal/debug tools in normal mode
    const hiddenInNormal = [
      'sequential_thinking',
      'vault_search',
      'vault_ingest',
      'directory_tree',
    ];

    return !hiddenInNormal.includes(toolName);
  }

  private isNoiseOutput(line: string): boolean {
    if (this.verboseMode) return false;

    const noisePatterns = [
      /^IPC validation/i,
      /^replacing file/i,
      /^export.*type/i,
      /^export.*interface/i,
      /^\s*$/,
    ];

    return noisePatterns.some(p => p.test(line));
  }

  addStep(toolId: string, toolName: string, args: Record<string, unknown>): void {
    this.totalSteps++;

    const phaseName = detectPhase(toolName, args);
    const phase = this.getOrCreatePhase(phaseName);
    phase.steps.push(toolId);

    // Collapse previous phases when new one starts
    if (this.currentPhase && this.currentPhase !== phaseName) {
      const prevPhase = this.phases.get(this.currentPhase);
      if (prevPhase && !prevPhase.collapsed) {
        prevPhase.collapsed = true;
        prevPhase.el.classList.add('collapsed');
        const chevron = prevPhase.headerEl.querySelector('.pipeline-phase-chevron');
        if (chevron) chevron.textContent = '▸';
      }
    }
    this.currentPhase = phaseName;

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

    phase.contentEl.appendChild(row);
    this.steps.set(toolId, {
      el: row,
      status: 'running',
      startedAt: Date.now(),
      durationEl: time,
      toolName,
      args,
      stderr: [],
      stdout: []
    });

    this.updatePhaseStatus(phaseName);
    this.updatePipelineHeader();
    this.container.classList.remove('hidden');
  }

  updateStep(toolId: string, status: 'success' | 'error', duration: number, summary: string, stderr?: string[]): void {
    const step = this.steps.get(toolId);
    if (!step) return;

    step.status = status;
    step.el.classList.remove('activity-feed__step--active');
    step.el.classList.toggle('activity-feed__step--success', status === 'success');
    step.el.classList.toggle('activity-feed__step--error', status === 'error');

    const iconEl = step.el.querySelector('.activity-feed__icon');
    if (iconEl) iconEl.textContent = iconForStatus(status);

    step.durationEl.textContent = formatDuration(duration);

    if (status === 'error') {
      this.failedSteps++;
      this.pipelineStatus = 'failed';
    }

    this.completedSteps++;

    const text = step.el.querySelector('.activity-feed__text');
    if (text && summary) {
      (text as HTMLElement).textContent = summary;
    }

    // Store stderr for error pattern detection
    if (stderr && stderr.length > 0) {
      step.stderr = stderr;
      const actionCard = detectActionRequired(stderr);
      if (actionCard && !this.actionCards.has(actionCard.id)) {
        this.addActionRequiredCard(actionCard);
      }

      // Add collapsible technical details if there's stderr output
      if (status === 'error' && !step.substeps) {
        const detailsToggle = document.createElement('div');
        detailsToggle.className = 'activity-feed__details-toggle';
        detailsToggle.textContent = '▸ details';

        const detailsContent = document.createElement('pre');
        detailsContent.className = 'activity-feed__details-content hidden';
        detailsContent.textContent = stderr.join('\n');

        detailsToggle.addEventListener('click', () => {
          const isHidden = detailsContent.classList.toggle('hidden');
          detailsToggle.textContent = isHidden ? '▸ details' : '▾ details';
        });

        step.el.appendChild(detailsToggle);
        step.el.appendChild(detailsContent);
      }
    }

    // Undo button for executable plans
    if (status === 'success' && (step.toolName === 'action_execute_plan' || step.toolName === 'execute_plan')) {
      const planId = (step.args as any)?.planId;
      if (planId) {
        const undoBtn = document.createElement('button');
        undoBtn.textContent = 'Undo';
        undoBtn.className = 'tool-activity-undo-btn';
        undoBtn.onclick = (e) => {
          e.stopPropagation();
          undoBtn.disabled = true;
          undoBtn.textContent = 'Undoing...';
          window.api.actionUndoPlan(planId)
            .then(() => { undoBtn.textContent = 'Undone'; })
            .catch((err: any) => {
              undoBtn.textContent = 'Failed';
              console.error(err);
            });
        };
        step.el.appendChild(undoBtn);
      }
    }

    // Update phase status
    const phaseName = detectPhase(step.toolName, step.args);
    this.updatePhaseStatus(phaseName);
    this.updatePipelineHeader();

    // Hide step if in normal mode and should be hidden
    if (!this.shouldShowInNormalMode(step.toolName, status)) {
      step.el.style.display = 'none';
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

    if (status === 'error') this.failedSteps++;
  }

  setApprovalBlocked(request: ApprovalRequest, affectedToolId?: string): void {
    this.currentApprovalRequest = request;
    this.pipelineStatus = 'blocked';

    if (affectedToolId) {
      const step = this.steps.get(affectedToolId);
      if (step) {
        step.status = 'blocked';
        const iconEl = step.el.querySelector('.activity-feed__icon');
        if (iconEl) iconEl.textContent = iconForStatus('blocked');
        step.el.classList.add('activity-feed__step--blocked');

        const phaseName = detectPhase(step.toolName, step.args);
        this.updatePhaseStatus(phaseName);
      }
    }

    this.updatePipelineHeader();
  }

  approvalResolved(decision: string): void {
    this.currentApprovalRequest = null;

    // Log the decision
    if (this.currentPhase) {
      const phase = this.phases.get(this.currentPhase);
      if (phase) {
        const logLine = document.createElement('div');
        logLine.className = 'approval-log-line';
        logLine.textContent = decision === 'DENY'
          ? '× denied'
          : decision === 'ALWAYS'
            ? '› always approved'
            : decision === 'TASK'
              ? '› approved (task)'
              : '› approved (once)';
        phase.contentEl.appendChild(logLine);
      }
    }

    // Resume or deny based on decision
    if (decision === 'DENY') {
      this.pipelineStatus = 'denied';
    } else {
      this.pipelineStatus = 'running';
    }

    // Update all blocked steps
    for (const step of this.steps.values()) {
      if (step.status === 'blocked') {
        step.status = decision === 'DENY' ? 'denied' : 'running';
        step.el.classList.remove('activity-feed__step--blocked');
        step.el.classList.toggle('activity-feed__step--denied', decision === 'DENY');
        const phaseName = detectPhase(step.toolName, step.args);
        this.updatePhaseStatus(phaseName);
      }
    }

    this.updatePipelineHeader();
  }

  private addActionRequiredCard(card: ActionRequiredCard): void {
    const cardEl = document.createElement('div');
    cardEl.className = 'action-required-card';
    cardEl.innerHTML = `
      <div class="action-required-header">
        <span class="action-required-icon">!</span>
        <span class="action-required-title">${card.title}</span>
      </div>
      <div class="action-required-description">${card.description}</div>
      <div class="action-required-actions"></div>
    `;

    const actionsContainer = cardEl.querySelector('.action-required-actions') as HTMLDivElement;

    if (card.primaryAction) {
      const primaryBtn = document.createElement('button');
      primaryBtn.className = 'action-required-btn action-required-btn--primary';
      primaryBtn.textContent = card.primaryAction.label;
      primaryBtn.addEventListener('click', () => {
        // Execute command via shell_exec
        primaryBtn.disabled = true;
        primaryBtn.textContent = 'Running...';
        // TODO: Wire to actual shell_exec tool call
        console.log('Execute command:', card.primaryAction!.command);
      });
      actionsContainer.appendChild(primaryBtn);
    }

    if (card.secondaryAction) {
      const secondaryBtn = document.createElement('button');
      secondaryBtn.className = 'action-required-btn action-required-btn--secondary';
      secondaryBtn.textContent = card.secondaryAction.label;
      secondaryBtn.addEventListener('click', () => {
        card.secondaryAction!.callback();
        cardEl.remove();
        this.actionCards.delete(card.id);
      });
      actionsContainer.appendChild(secondaryBtn);
    }

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'action-required-btn action-required-btn--dismiss';
    dismissBtn.textContent = '×';
    dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      cardEl.remove();
      this.actionCards.delete(card.id);
    });
    cardEl.querySelector('.action-required-header')!.appendChild(dismissBtn);

    this.actionCardsContainer.appendChild(cardEl);
    this.actionCards.set(card.id, cardEl);
  }

  private toggleVerbose(): void {
    this.verboseMode = !this.verboseMode;
    this.verboseToggle.textContent = this.verboseMode ? 'Verbose' : 'Normal';
    this.verboseToggle.classList.toggle('verbose-toggle--active', this.verboseMode);

    // Re-evaluate visibility of all steps
    for (const step of this.steps.values()) {
      const shouldShow = this.shouldShowInNormalMode(step.toolName, step.status);
      step.el.style.display = shouldShow ? '' : 'none';
    }
  }

  complete(totalDuration: number): void {
    // Only mark as success if:
    // 1. No failed steps
    // 2. Pipeline is currently running (not blocked, denied, or failed)
    // 3. At least one step actually completed successfully
    const hasSuccessfulSteps = Array.from(this.steps.values()).some(s => s.status === 'success');

    if (this.pipelineStatus === 'running') {
      if (this.failedSteps === 0 && hasSuccessfulSteps) {
        this.pipelineStatus = 'success';
      } else if (!hasSuccessfulSteps) {
        // No steps completed - likely all were skipped or cancelled
        this.pipelineStatus = 'failed';
      }
    } else if (this.pipelineStatus === 'blocked') {
      // If still blocked when completing, treat as incomplete
      this.pipelineStatus = 'failed';
    }
    // If pipelineStatus is already 'failed' or 'denied', keep it that way

    this.updatePipelineHeader();

    // Hide cancel button
    this.cancelEl.style.display = 'none';
  }

  destroy(): void {
    this.container.remove();
    this.steps.clear();
    this.phases.clear();
    this.actionCards.clear();
  }
}

let activeFeed: EnhancedActivityFeed | null = null;

export function startEnhancedActivityFeed(anchor: HTMLElement): void {
  activeFeed = new EnhancedActivityFeed(anchor);
}

export function destroyEnhancedActivityFeed(): void {
  if (activeFeed) {
    activeFeed.destroy();
    activeFeed = null;
  }
}

export function initEnhancedActivityFeed(): void {
  // Wire IPC listeners
  window.api.onToolExecStart((payload) => {
    if (!activeFeed) return;
    activeFeed.addStep(payload.toolId, payload.toolName, payload.args || {});
  });

  window.api.onToolExecComplete((payload) => {
    if (!activeFeed) return;
    activeFeed.updateStep(payload.toolId, payload.status, payload.duration, payload.summary, payload.stderr);
  });

  window.api.onToolStepProgress((payload) => {
    if (!activeFeed) return;
    activeFeed.addSubStep(payload.toolId, payload.stepIndex, payload.action, payload.status, payload.duration);
  });

  window.api.onToolLoopComplete((payload) => {
    if (!activeFeed) return;
    activeFeed.complete(payload.totalDuration);
  });

  // Approval integration
  window.api.onApprovalRequest((request) => {
    if (!activeFeed) return;
    // We don't have the specific tool ID here, but we can mark the pipeline as blocked
    activeFeed.setApprovalBlocked(request);
  });

  // Listen for approval responses (we need to add this to preload if not present)
  // For now, we'll add a custom event
  document.addEventListener('clawdia:approval:resolved', ((e: CustomEvent) => {
    if (!activeFeed) return;
    activeFeed.approvalResolved(e.detail.decision);
  }) as EventListener);
}

// Reset feed when new chat tab is loaded or cleared
document.addEventListener('clawdia:conversation:reset', () => {
  destroyEnhancedActivityFeed();
});

// Export for use in chat.ts
export { activeFeed };
