// ============================================================================
// Dashboard — 3-layer intelligence system UI
// Layout: greeting → suggestions → metrics grid → tool status → footer
// ============================================================================

import type { DashboardSuggestion, DashboardState, SystemMetrics, StaticDashboardState, ToolStatusIndicator } from '../../shared/dashboard-types';
import { elements } from './state';

let dashboardContainer: HTMLDivElement | null = null;
let updateUnsubscribe: (() => void) | null = null;
let cachedState: DashboardState | null = null;

const ICON_MAP: Record<string, string> = {
  cpu:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
  memory:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/><line x1="14" y1="10" x2="14" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/></svg>',
  disk:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  network:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>',
  battery:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>',
  browser:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  git:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><line x1="12" y1="12" x2="12" y2="15"/></svg>',
  project:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  time:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  cleanup:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  alert:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function getIconSvg(icon: string): string {
  return ICON_MAP[icon] || ICON_MAP.project;
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------
function getGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Late night.';
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  if (hour < 21) return 'Good evening.';
  return 'Late night.';
}

// ---------------------------------------------------------------------------
// Metric severity helpers
// ---------------------------------------------------------------------------
function metricSeverity(percent: number): 'healthy' | 'warning' | 'critical' {
  if (percent > 85) return 'critical';
  if (percent > 65) return 'warning';
  return 'healthy';
}

function batteryClass(batt: SystemMetrics['battery']): 'healthy' | 'warning' | 'critical' {
  if (!batt) return 'healthy';
  if (batt.charging) return 'healthy';
  if (batt.percent < 20) return 'critical';
  if (batt.percent < 40) return 'warning';
  return 'healthy';
}

function barColor(percent: number): string {
  if (percent > 85) return 'var(--error)';
  if (percent > 65) return '#f59e0b';
  return 'var(--accent)';
}

function batteryBarColor(batt: SystemMetrics['battery']): string {
  if (!batt) return 'var(--accent)';
  if (batt.charging) return 'var(--accent)';
  if (batt.percent < 20) return 'var(--error)';
  if (batt.percent < 40) return '#f59e0b';
  return 'var(--accent)';
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function renderMetrics(metrics: SystemMetrics): string {
  const items: string[] = [];

  const cpuSev = metricSeverity(metrics.cpu.usagePercent);
  items.push(`
    <div class="dash-metric dash-metric--${cpuSev}" data-metric="cpu">
      <span class="dash-metric-label">CPU</span>
      <span class="dash-metric-value">${metrics.cpu.usagePercent}%</span>
      <div class="dash-metric-bar"><div class="dash-metric-bar-fill" style="width:${metrics.cpu.usagePercent}%;background:${barColor(metrics.cpu.usagePercent)}"></div></div>
    </div>
  `);

  const memPct = metrics.memory.usagePercent;
  const memUsed = (metrics.memory.usedMB / 1024).toFixed(1);
  const memTotal = (metrics.memory.totalMB / 1024).toFixed(1);
  const ramSev = metricSeverity(memPct);
  items.push(`
    <div class="dash-metric dash-metric--${ramSev}" data-metric="ram">
      <span class="dash-metric-label">RAM</span>
      <span class="dash-metric-value">${memUsed}/${memTotal} GB</span>
      <div class="dash-metric-bar"><div class="dash-metric-bar-fill" style="width:${memPct}%;background:${barColor(memPct)}"></div></div>
    </div>
  `);

  const diskSev = metricSeverity(metrics.disk.usagePercent);
  items.push(`
    <div class="dash-metric dash-metric--${diskSev}" data-metric="disk">
      <span class="dash-metric-label">Disk</span>
      <span class="dash-metric-value">${metrics.disk.usedGB}/${metrics.disk.totalGB} GB</span>
      <div class="dash-metric-bar"><div class="dash-metric-bar-fill" style="width:${metrics.disk.usagePercent}%;background:${barColor(metrics.disk.usagePercent)}"></div></div>
    </div>
  `);

  if (metrics.battery) {
    const battSev = batteryClass(metrics.battery);
    const battIcon = metrics.battery.charging ? ' +' : '';
    items.push(`
      <div class="dash-metric dash-metric--${battSev}" data-metric="battery">
        <span class="dash-metric-label">Battery${battIcon}</span>
        <span class="dash-metric-value">${metrics.battery.percent}%</span>
        <div class="dash-metric-bar"><div class="dash-metric-bar-fill" style="width:${metrics.battery.percent}%;background:${batteryBarColor(metrics.battery)}"></div></div>
      </div>
    `);
  }

  return items.join('');
}

function renderSuggestionCard(s: DashboardSuggestion): string {
  const iconHtml = getIconSvg(s.icon);
  const ruleId = s.ruleId || '';
  const actionAttr = s.type === 'actionable' && s.action
    ? `data-action="${s.action.replace(/"/g, '&quot;')}" role="button" tabindex="0"`
    : '';
  const cursorClass = s.type === 'actionable' ? 'dash-suggestion-actionable' : '';

  return `
    <div class="dash-suggestion ${cursorClass} dash-suggestion-entering" ${actionAttr} data-rule-id="${ruleId}">
      <div class="dash-suggestion-icon">${iconHtml}</div>
      <div class="dash-suggestion-text">${s.text}</div>
      ${ruleId ? `<button class="dash-suggestion-dismiss" data-dismiss-rule="${ruleId}" title="Dismiss">&times;</button>` : ''}
    </div>
  `;
}

function renderToolStatus(statuses: ToolStatusIndicator[]): string {
  return statuses.map(t => {
    const dotClass = `dash-tool-dot--${t.status}`;
    const title = t.detail ? ` title="${t.detail.replace(/"/g, '&quot;')}"` : '';
    return `<div class="dash-tool"${title}><span class="dash-tool-dot ${dotClass}"></span>${t.name}</div>`;
  }).join('');
}

function renderFooter(staticState: StaticDashboardState): string {
  return `
    <span class="dash-footer-model">${staticState.activeModel}</span>
    <span class="dash-footer-sep">&middot;</span>
    <span>up ${staticState.uptime}</span>
    <span class="dash-footer-sep">&middot;</span>
    <span class="dash-footer-cost">${staticState.sessionCost}</span>
  `;
}

// ---------------------------------------------------------------------------
// Show / Hide / Update
// ---------------------------------------------------------------------------

export function showDashboard(outputEl: HTMLElement, state: DashboardState): void {
  hideDashboard();
  cachedState = state;

  const container = document.createElement('div');
  container.className = 'dash-container';

  const suggestionsHtml = state.suggestions.length > 0
    ? `<div class="dash-suggestions">${state.suggestions.map(s => renderSuggestionCard(s)).join('')}</div>`
    : '<div class="dash-all-clear"><span>All systems nominal</span></div>';

  const now = new Date();
  const greeting = getGreeting(now);

  container.innerHTML = `
    <div class="dash-inner">
      <div class="dash-greeting">${greeting}</div>
      ${suggestionsHtml}
      <div class="dash-metrics">${renderMetrics(state.metrics)}</div>
      <div class="dash-tools">${state.static ? renderToolStatus(state.static.toolStatuses) : ''}</div>
      <div class="dash-footer">${state.static ? renderFooter(state.static) : ''}</div>
    </div>
  `;

  // Event delegation
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Dismiss button
    const dismissBtn = target.closest('.dash-suggestion-dismiss') as HTMLElement | null;
    if (dismissBtn) {
      e.stopPropagation();
      const ruleId = dismissBtn.dataset.dismissRule;
      if (ruleId) {
        window.api.dismissDashboardRule(ruleId);
        const card = dismissBtn.closest('.dash-suggestion');
        if (card) {
          card.classList.add('dash-suggestion-exiting');
          setTimeout(() => card.remove(), 200);
        }
      }
      return;
    }

    // Actionable suggestion click
    const card = target.closest('.dash-suggestion-actionable') as HTMLElement | null;
    if (card?.dataset.action) {
      executeAction(card.dataset.action);
    }
  });

  outputEl.appendChild(container);
  dashboardContainer = container;

  // Subscribe to live updates
  subscribeToUpdates();

  // Notify main process dashboard is visible
  window.api.setDashboardVisible(true);

  // Fade in
  requestAnimationFrame(() => container.classList.add('dash-visible'));
}

function subscribeToUpdates(): void {
  if (updateUnsubscribe) return;
  updateUnsubscribe = window.api.onDashboardUpdate((state: DashboardState) => {
    if (dashboardContainer && state) {
      cachedState = state;
      updateDashboardInPlace(state);
    }
  });
}

function unsubscribeFromUpdates(): void {
  if (updateUnsubscribe) {
    updateUnsubscribe();
    updateUnsubscribe = null;
  }
}

/**
 * Surgical DOM updates — avoids full re-render for smoother transitions.
 */
function updateDashboardInPlace(state: DashboardState): void {
  if (!dashboardContainer) return;

  // Update metrics (bar widths + values)
  updateMetricCell(state.metrics, 'cpu', state.metrics.cpu.usagePercent, `${state.metrics.cpu.usagePercent}%`);
  const memPct = state.metrics.memory.usagePercent;
  const memUsed = (state.metrics.memory.usedMB / 1024).toFixed(1);
  const memTotal = (state.metrics.memory.totalMB / 1024).toFixed(1);
  updateMetricCell(state.metrics, 'ram', memPct, `${memUsed}/${memTotal} GB`);
  updateMetricCell(state.metrics, 'disk', state.metrics.disk.usagePercent, `${state.metrics.disk.usedGB}/${state.metrics.disk.totalGB} GB`);
  if (state.metrics.battery) {
    updateBatteryCell(state.metrics.battery);
  }

  // Update suggestions
  const suggestionsContainer = dashboardContainer.querySelector('.dash-suggestions');
  const allClearContainer = dashboardContainer.querySelector('.dash-all-clear');
  if (state.suggestions.length > 0) {
    if (allClearContainer) allClearContainer.remove();
    if (suggestionsContainer) {
      // Replace suggestions content
      suggestionsContainer.innerHTML = state.suggestions.map(s => renderSuggestionCard(s)).join('');
    } else {
      // Create suggestions container after greeting
      const greeting = dashboardContainer.querySelector('.dash-greeting');
      if (greeting) {
        const newContainer = document.createElement('div');
        newContainer.className = 'dash-suggestions';
        newContainer.innerHTML = state.suggestions.map(s => renderSuggestionCard(s)).join('');
        greeting.after(newContainer);
      }
    }
  } else {
    if (suggestionsContainer) suggestionsContainer.remove();
    if (!allClearContainer) {
      const greeting = dashboardContainer.querySelector('.dash-greeting');
      if (greeting) {
        const ac = document.createElement('div');
        ac.className = 'dash-all-clear';
        ac.innerHTML = '<span>All systems nominal</span>';
        greeting.after(ac);
      }
    }
  }

  // Update tool status
  const toolsEl = dashboardContainer.querySelector('.dash-tools');
  if (toolsEl && state.static) {
    toolsEl.innerHTML = renderToolStatus(state.static.toolStatuses);
  }

  // Update footer
  const footerEl = dashboardContainer.querySelector('.dash-footer');
  if (footerEl && state.static) {
    footerEl.innerHTML = renderFooter(state.static);
  }
}

function updateMetricCell(_metrics: SystemMetrics, name: string, percent: number, valueText: string): void {
  if (!dashboardContainer) return;
  const cell = dashboardContainer.querySelector(`[data-metric="${name}"]`) as HTMLElement | null;
  if (!cell) return;

  const sev = metricSeverity(percent);
  cell.className = `dash-metric dash-metric--${sev}`;

  const valueEl = cell.querySelector('.dash-metric-value');
  if (valueEl) valueEl.textContent = valueText;

  const fillEl = cell.querySelector('.dash-metric-bar-fill') as HTMLElement | null;
  if (fillEl) {
    fillEl.style.width = `${percent}%`;
    fillEl.style.background = barColor(percent);
  }
}

function updateBatteryCell(batt: NonNullable<SystemMetrics['battery']>): void {
  if (!dashboardContainer) return;
  const cell = dashboardContainer.querySelector('[data-metric="battery"]') as HTMLElement | null;
  if (!cell) return;

  const sev = batteryClass(batt);
  cell.className = `dash-metric dash-metric--${sev}`;

  const valueEl = cell.querySelector('.dash-metric-value');
  if (valueEl) valueEl.textContent = `${batt.percent}%`;

  const labelEl = cell.querySelector('.dash-metric-label');
  if (labelEl) labelEl.textContent = batt.charging ? 'Battery +' : 'Battery';

  const fillEl = cell.querySelector('.dash-metric-bar-fill') as HTMLElement | null;
  if (fillEl) {
    fillEl.style.width = `${batt.percent}%`;
    fillEl.style.background = batteryBarColor(batt);
  }
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

let fetchAttempted = false;

export async function fetchAndShowDashboard(outputEl: HTMLElement): Promise<void> {
  if (fetchAttempted && cachedState) {
    showDashboard(outputEl, cachedState);
    return;
  }
  if (fetchAttempted) return;
  fetchAttempted = true;

  try {
    const state = await window.api.getDashboard();
    if (state && state.metrics) {
      cachedState = state;
      showDashboard(outputEl, state);
    }
  } catch {
    // Dashboard is optional — silently fail
  }
}

export function resetDashboardCache(): void {
  fetchAttempted = false;
  cachedState = null;
}
