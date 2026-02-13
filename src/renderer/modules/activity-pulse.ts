// ============================================================================
// ACTIVITY PULSE
// ============================================================================
//
// Renders a single in-chat status sentence while tools are running.
// The sentence updates in place with a smooth crossfade so users can always
// see what the agent is doing (browser, headless browser, local tools, etc.).

import type { CapabilityRuntimeEvent, ToolExecCompleteEvent, ToolExecStartEvent } from '../../shared/types';
import { appState, elements } from './state';
import { scrollToBottom } from './stream';

interface PulseState {
  active: boolean;
  startedAt: number;
  toolsCompleted: number;
  toolsRunning: number;
  lastToolName: string;
  iteration: number;
  pulseTimer: ReturnType<typeof setInterval> | null;
  idleMessageTimer: ReturnType<typeof setTimeout> | null;
  lastStatusAt: number;
  currentText: string;
  lineEl: HTMLDivElement | null;
  frontTextEl: HTMLSpanElement | null;
  backTextEl: HTMLSpanElement | null;
  activeLayer: 'front' | 'back';
}

const state: PulseState = {
  active: false,
  startedAt: 0,
  toolsCompleted: 0,
  toolsRunning: 0,
  lastToolName: '',
  iteration: 0,
  pulseTimer: null,
  idleMessageTimer: null,
  lastStatusAt: 0,
  currentText: '',
  lineEl: null,
  frontTextEl: null,
  backTextEl: null,
  activeLayer: 'front',
};

const PULSE_CHECK_INTERVAL_MS = 4_000;
const STALE_STATUS_REFRESH_MS = 12_000;
const IDLE_MESSAGE_DELAY_MS = 700;
const CLEANUP_FADE_MS = 360;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function asReadableString(value: unknown): string {
  if (typeof value === 'string') return compactWhitespace(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return compactWhitespace(JSON.stringify(value));
  } catch {
    return '';
  }
}

function extractHost(urlValue: unknown): string {
  const raw = asReadableString(urlValue);
  if (!raw) return '';

  const normalized = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `https://${raw}`;

  try {
    return new URL(normalized).host;
  } catch {
    return truncate(raw, 48);
  }
}

function startPulseIfNeeded(): void {
  if (state.active) return;
  state.active = true;
  state.startedAt = Date.now();
  state.lastStatusAt = Date.now();
  startPulseTimer();
}

export function isActivityPulseActive(): boolean {
  return state.active;
}

function ensureStatusLine(): void {
  if (state.lineEl && state.lineEl.parentElement === elements.outputEl) return;

  const line = document.createElement('div');
  line.className = 'activity-pulse-line';

  const front = document.createElement('span');
  front.className = 'activity-pulse-text activity-pulse-text--front';

  const back = document.createElement('span');
  back.className = 'activity-pulse-text activity-pulse-text--back';

  line.appendChild(front);
  line.appendChild(back);
  elements.outputEl.appendChild(line);

  state.lineEl = line;
  state.frontTextEl = front;
  state.backTextEl = back;
  state.activeLayer = 'front';
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/^browser_/, 'browser ')
    .replace(/^file_/, 'file ')
    .replace(/^task_/, 'task ')
    .replace(/^vault_/, 'vault ')
    .replace(/_/g, ' ')
    .trim();
}

function summarizePrimaryArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = args[key];
    const value = asReadableString(raw);
    if (value) return truncate(value, 72);
  }
  return '';
}

function describeBrowserTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'browser_navigate') {
    const host = extractHost(args.url);
    return host ? `Navigating the browser to ${host}.` : 'Navigating the browser to the requested page.';
  }

  if (toolName === 'browser_search' || toolName === 'browser_search_rich') {
    const query = summarizePrimaryArg(args, ['query']);
    return query ? `Searching the web for "${query}".` : 'Searching the web for relevant sources.';
  }

  if (toolName === 'browser_news') {
    const query = summarizePrimaryArg(args, ['query']);
    return query ? `Checking current news for "${query}".` : 'Checking current news sources.';
  }

  if (toolName === 'browser_shopping') {
    const query = summarizePrimaryArg(args, ['query', 'item']);
    return query ? `Comparing shopping results for "${query}".` : 'Comparing shopping results.';
  }

  if (toolName === 'browser_places') {
    const query = summarizePrimaryArg(args, ['query', 'location']);
    return query ? `Looking up places for "${query}".` : 'Looking up places and map details.';
  }

  if (toolName === 'browser_images') {
    const query = summarizePrimaryArg(args, ['query']);
    return query ? `Finding images for "${query}".` : 'Finding relevant images.';
  }

  if (toolName === 'browser_read_page') {
    return 'Reading the current browser page.';
  }

  if (toolName === 'browser_read_tabs') {
    return 'Reading open browser tabs to gather context.';
  }

  if (toolName === 'browser_click') {
    const target = summarizePrimaryArg(args, ['target', 'selector', 'element', 'text']);
    return target ? `Clicking "${target}" in the browser.` : 'Clicking a browser element.';
  }

  if (toolName === 'browser_type') {
    const field = summarizePrimaryArg(args, ['selector', 'target', 'label', 'field']);
    return field ? `Typing into "${field}" in the browser.` : 'Typing into a browser form field.';
  }

  if (toolName === 'browser_scroll') {
    const direction = summarizePrimaryArg(args, ['direction']);
    return direction ? `Scrolling the browser ${direction}.` : 'Scrolling the browser page.';
  }

  if (toolName === 'browser_tab') {
    const action = summarizePrimaryArg(args, ['action']);
    if (action === 'new') return 'Opening a new browser tab.';
    if (action === 'switch') return 'Switching to a different browser tab.';
    if (action === 'close') return 'Closing a browser tab.';
    return 'Managing browser tabs.';
  }

  if (toolName === 'browser_screenshot') {
    return 'Capturing a browser screenshot.';
  }

  if (toolName === 'browser_detect_account') {
    return 'Checking browser session and account state.';
  }

  if (toolName === 'browser_interact') {
    return 'Executing multi-step browser interactions.';
  }

  if (toolName === 'browser_fill_form') {
    return 'Filling form fields in the browser.';
  }

  if (toolName === 'browser_extract' || toolName === 'browser_visual_extract' || toolName === 'browser_batch') {
    return 'Running headless browser extraction for this step.';
  }

  if (toolName === 'cache_read') {
    return 'Reading cached browser context to speed up this step.';
  }

  return `Running browser step: ${humanizeToolName(toolName)}.`;
}

function describeLocalTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'shell_exec') {
    const command = summarizePrimaryArg(args, ['command']);
    return command ? `Running command: ${command}.` : 'Running a terminal command.';
  }

  if (toolName === 'file_read') {
    const target = summarizePrimaryArg(args, ['path']);
    return target ? `Reading file ${target}.` : 'Reading a file.';
  }

  if (toolName === 'file_write') {
    const target = summarizePrimaryArg(args, ['path']);
    return target ? `Writing file ${target}.` : 'Writing a file.';
  }

  if (toolName === 'file_edit') {
    const target = summarizePrimaryArg(args, ['path']);
    return target ? `Editing file ${target}.` : 'Editing a file.';
  }

  if (toolName === 'directory_tree') {
    const target = summarizePrimaryArg(args, ['path']);
    return target ? `Scanning folder structure at ${target}.` : 'Scanning folder structure.';
  }

  if (toolName === 'process_manager') {
    return 'Inspecting running processes.';
  }

  if (toolName === 'sequential_thinking') {
    return 'Planning the next action sequence.';
  }

  if (toolName.startsWith('vault_')) {
    return 'Searching the local vault for relevant information.';
  }

  if (toolName.startsWith('task_')) {
    return 'Updating task state and execution context.';
  }

  if (toolName.startsWith('archive_')) {
    return 'Reviewing archived data for this request.';
  }

  return `Running ${humanizeToolName(toolName)}.`;
}

function describeToolStart(payload: ToolExecStartEvent): string {
  const { toolName, args } = payload;

  if (toolName.startsWith('browser_') || toolName === 'cache_read') {
    return describeBrowserTool(toolName, args);
  }

  return describeLocalTool(toolName, args);
}

function describeToolComplete(payload: ToolExecCompleteEvent): string | null {
  if (payload.status === 'error') {
    const detail = compactWhitespace(payload.summary || 'The last step failed.');
    return `Step failed: ${truncate(detail, 96)}. Trying a recovery path.`;
  }

  if (payload.status === 'warning') {
    const detail = compactWhitespace(payload.summary || 'The last step completed with warnings.');
    return `Step completed with warnings: ${truncate(detail, 96)}.`;
  }

  if (compactWhitespace(payload.summary).toLowerCase() === 'skipped') {
    return 'Skipping a redundant step and continuing.';
  }

  // Success events are noisy during rapid tool chains; keep current sentence
  // stable and only update when we have meaningful state changes.
  return null;
}

function describeCapabilityEvent(payload: CapabilityRuntimeEvent): string | null {
  if (payload.type === 'install_started') {
    const target = payload.capabilityId ? ` ${payload.capabilityId}` : '';
    return `Installing missing capability${target} automatically.`;
  }

  if (payload.type === 'install_succeeded') {
    return 'Installed dependency successfully. Retrying the tool step.';
  }

  if (payload.type === 'install_verified') {
    return 'Dependency verification passed.';
  }

  if (payload.type === 'install_failed') {
    const detail = compactWhitespace(payload.detail || payload.message || 'Dependency install failed.');
    return `Auto-install failed: ${truncate(detail, 96)}.`;
  }

  if (payload.type === 'policy_blocked') {
    const detail = compactWhitespace(payload.message || 'Policy blocked this action.');
    return `Blocked by policy: ${truncate(detail, 96)}.`;
  }

  if (payload.type === 'rollback_applied') {
    return 'Rolled back file changes after a failed write.';
  }

  if (payload.type === 'rollback_failed') {
    const detail = compactWhitespace(payload.detail || payload.message || 'Rollback failed.');
    return `Rollback failed: ${truncate(detail, 96)}.`;
  }

  if (payload.type === 'capability_missing') {
    const detail = compactWhitespace(payload.message || 'Missing capability detected.');
    return truncate(detail, 96);
  }

  return null;
}

function clearIdleMessageTimer(): void {
  if (!state.idleMessageTimer) return;
  clearTimeout(state.idleMessageTimer);
  state.idleMessageTimer = null;
}

function scheduleIdleMessage(): void {
  clearIdleMessageTimer();
  state.idleMessageTimer = setTimeout(() => {
    if (!state.active || state.toolsRunning > 0) return;
    setStatusText('Analyzing the latest results and planning the next step.');
  }, IDLE_MESSAGE_DELAY_MS);
}

function setStatusText(nextText: string): void {
  const text = compactWhitespace(nextText);
  if (!text) return;

  ensureStatusLine();
  if (!state.lineEl || !state.frontTextEl || !state.backTextEl) return;
  if (state.currentText === text) return;

  const showEl = state.activeLayer === 'front' ? state.backTextEl : state.frontTextEl;
  const hideEl = state.activeLayer === 'front' ? state.frontTextEl : state.backTextEl;

  showEl.textContent = text;
  state.lineEl.classList.add('visible');
  showEl.classList.add('is-visible');
  hideEl.classList.remove('is-visible');

  state.activeLayer = state.activeLayer === 'front' ? 'back' : 'front';
  state.currentText = text;
  state.lastStatusAt = Date.now();
  scrollToBottom(false);
}

export function beginActivityPulse(initialText: string = 'Analyzing your request and planning the first step.'): void {
  startPulseIfNeeded();
  clearIdleMessageTimer();
  setStatusText(initialText);
}

function buildStaleRefreshText(): string {
  const elapsed = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000));
  if (state.toolsRunning > 0 && state.lastToolName) {
    return `Still working on ${humanizeToolName(state.lastToolName)} (${elapsed}s elapsed).`;
  }
  return `Still working on your request (${elapsed}s elapsed).`;
}

function startPulseTimer(): void {
  if (state.pulseTimer) return;

  state.pulseTimer = setInterval(() => {
    if (!state.active) {
      stopPulseTimer();
      return;
    }

    const staleFor = Date.now() - state.lastStatusAt;
    if (staleFor >= STALE_STATUS_REFRESH_MS) {
      setStatusText(buildStaleRefreshText());
    }
  }, PULSE_CHECK_INTERVAL_MS);
}

function stopPulseTimer(): void {
  if (!state.pulseTimer) return;
  clearInterval(state.pulseTimer);
  state.pulseTimer = null;
}

export function cleanupPulseLines(): void {
  stopPulseTimer();
  clearIdleMessageTimer();
  state.active = false;

  if (!state.lineEl) return;

  state.lineEl.classList.add('fading');
  state.lineEl.classList.remove('visible');

  setTimeout(() => {
    if (!state.lineEl) return;
    state.lineEl.remove();
    state.lineEl = null;
    state.frontTextEl = null;
    state.backTextEl = null;
    state.currentText = '';
  }, CLEANUP_FADE_MS);
}

export function resetActivityPulse(): void {
  stopPulseTimer();
  clearIdleMessageTimer();

  state.active = false;
  state.startedAt = 0;
  state.toolsCompleted = 0;
  state.toolsRunning = 0;
  state.lastToolName = '';
  state.iteration = 0;
  state.lastStatusAt = 0;
  state.currentText = '';
  state.activeLayer = 'front';

  if (state.lineEl) {
    state.lineEl.remove();
    state.lineEl = null;
  }
  state.frontTextEl = null;
  state.backTextEl = null;
}

export function initActivityPulse(): void {
  window.api.onThinking((thought) => {
    if (!appState.isStreaming) return;
    if (!thought?.trim()) return;
    if (state.active) return;
    beginActivityPulse();
  });

  window.api.onToolExecStart((payload) => {
    startPulseIfNeeded();
    clearIdleMessageTimer();

    state.toolsRunning++;
    state.lastToolName = payload.toolName;

    setStatusText(describeToolStart(payload));
  });

  window.api.onToolExecComplete((payload) => {
    if (!state.active) return;

    state.toolsRunning = Math.max(0, state.toolsRunning - 1);
    state.toolsCompleted++;

    const completionText = describeToolComplete(payload);
    if (completionText) {
      setStatusText(completionText);
      return;
    }

    if (state.toolsRunning === 0) {
      scheduleIdleMessage();
    }
  });

  window.api.onRouteInfo((info) => {
    state.iteration = info.iteration;
    if (!state.active) {
      startPulseIfNeeded();
    }
    if (state.toolsRunning > 0) return;

    clearIdleMessageTimer();
    const nextStep = state.iteration + 1;
    setStatusText(`Planning step ${nextStep} with ${info.model}.`);
  });

  window.api.onToolLoopComplete(() => {
    cleanupPulseLines();
  });

  if (window.api.onCapabilityEvent) {
    window.api.onCapabilityEvent((payload) => {
      if (!state.active) return;
      const text = describeCapabilityEvent(payload);
      if (!text) return;
      clearIdleMessageTimer();
      setStatusText(text);
    });
  }

  window.api.onStreamEnd(() => {
    cleanupPulseLines();
  });

  window.api.onChatError(() => {
    cleanupPulseLines();
  });
}
