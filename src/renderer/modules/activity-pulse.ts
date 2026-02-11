// ============================================================================
// ACTIVITY PULSE
// ============================================================================
//
// Tracks tool-loop state from existing IPC events and periodically injects
// styled status lines into the chat output during long runs. Gives the user
// visual confirmation that work is happening even when the thinking indicator
// cycles between thoughts.

import { elements } from './state';
import { scrollToBottom } from './stream';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PulseState {
  active: boolean;
  startedAt: number;
  toolsCompleted: number;
  toolsRunning: number;
  lastToolName: string;
  iteration: number;
  statusLinesEmitted: number;
  pulseTimer: ReturnType<typeof setInterval> | null;
  lastStatusLineAt: number;
}

const state: PulseState = {
  active: false,
  startedAt: 0,
  toolsCompleted: 0,
  toolsRunning: 0,
  lastToolName: '',
  iteration: 0,
  statusLinesEmitted: 0,
  pulseTimer: null,
  lastStatusLineAt: 0,
};

const PULSE_CHECK_INTERVAL_MS = 5_000;
const MIN_ELAPSED_FOR_STATUS_MS = 20_000;
const MIN_GAP_BETWEEN_LINES_MS = 20_000;

// ---------------------------------------------------------------------------
// Status line rendering
// ---------------------------------------------------------------------------

function buildStatusText(): string {
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  const parts: string[] = ['Working'];
  parts.push(`${elapsed}s elapsed`);
  if (state.toolsCompleted > 0) {
    parts.push(`${state.toolsCompleted} tool${state.toolsCompleted === 1 ? '' : 's'} completed`);
  }
  if (state.iteration > 0) {
    parts.push(`iteration ${state.iteration}`);
  }
  return parts.join(' \u00b7 '); // middle dot separator
}

function appendStatusLine(): void {
  const el = document.createElement('div');
  el.className = 'activity-pulse-line';
  el.textContent = buildStatusText();
  elements.outputEl.appendChild(el);
  state.statusLinesEmitted++;
  state.lastStatusLineAt = Date.now();
  scrollToBottom(false);
}

// ---------------------------------------------------------------------------
// Pulse timer
// ---------------------------------------------------------------------------

function startPulseTimer(): void {
  if (state.pulseTimer) return;
  state.pulseTimer = setInterval(() => {
    if (!state.active) {
      stopPulseTimer();
      return;
    }
    const now = Date.now();
    const elapsed = now - state.startedAt;
    const sinceLast = now - state.lastStatusLineAt;
    if (elapsed >= MIN_ELAPSED_FOR_STATUS_MS && sinceLast >= MIN_GAP_BETWEEN_LINES_MS) {
      appendStatusLine();
    }
  }, PULSE_CHECK_INTERVAL_MS);
}

function stopPulseTimer(): void {
  if (state.pulseTimer) {
    clearInterval(state.pulseTimer);
    state.pulseTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Cleanup — fade out and remove status lines
// ---------------------------------------------------------------------------

export function cleanupPulseLines(): void {
  stopPulseTimer();
  state.active = false;
  const lines = elements.outputEl.querySelectorAll('.activity-pulse-line');
  if (lines.length === 0) return;
  for (const line of lines) {
    (line as HTMLElement).classList.add('fading');
  }
  // Remove after fade transition completes
  setTimeout(() => {
    const remaining = elements.outputEl.querySelectorAll('.activity-pulse-line');
    for (const el of remaining) {
      el.remove();
    }
  }, 600);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resetActivityPulse(): void {
  stopPulseTimer();
  state.active = false;
  state.startedAt = 0;
  state.toolsCompleted = 0;
  state.toolsRunning = 0;
  state.lastToolName = '';
  state.iteration = 0;
  state.statusLinesEmitted = 0;
  state.lastStatusLineAt = 0;
  // Immediately remove any lingering pulse lines (no fade on reset)
  const lines = elements.outputEl.querySelectorAll('.activity-pulse-line');
  for (const el of lines) {
    el.remove();
  }
}

export function initActivityPulse(): void {
  window.api.onToolExecStart((payload) => {
    if (!state.active) {
      state.active = true;
      state.startedAt = Date.now();
      state.lastStatusLineAt = Date.now(); // don't emit immediately
      startPulseTimer();
    }
    state.toolsRunning++;
    state.lastToolName = payload.toolName;
  });

  window.api.onToolExecComplete(() => {
    state.toolsRunning = Math.max(0, state.toolsRunning - 1);
    state.toolsCompleted++;
  });

  window.api.onRouteInfo(() => {
    state.iteration++;
  });

  window.api.onToolLoopComplete(() => {
    cleanupPulseLines();
  });

  window.api.onStreamEnd(() => {
    cleanupPulseLines();
  });
}
