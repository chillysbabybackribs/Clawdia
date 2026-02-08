import type { ToolActivityEntry, ToolActivitySummary } from '../../shared/types';
import { elements } from './state';

// ---------------------------------------------------------------------------
// Tool Activity Panel — subtle collapsible dropdown above chat
// Shows what tools were actually invoked during the current response.
// ---------------------------------------------------------------------------

let panelEl: HTMLDivElement | null = null;
let headerEl: HTMLDivElement | null = null;
let badgeEl: HTMLSpanElement | null = null;
let listEl: HTMLDivElement | null = null;
let warningEl: HTMLDivElement | null = null;
let backdropEl: HTMLDivElement | null = null;
let expanded = false;
let currentEntries: ToolActivityEntry[] = [];
let currentWarning: string | undefined;

const TOOL_ICONS: Record<string, string> = {
  browser_search: '🔍',
  browser_search_rich: '🔍',
  browser_navigate: '🌐',
  browser_read_page: '📖',
  browser_click: '👆',
  browser_type: '⌨️',
  browser_scroll: '↕️',
  browser_tab: '📑',
  browser_read_tabs: '📑',
  browser_extract: '📋',
  browser_visual_extract: '👁️',
  browser_screenshot: '📸',
  browser_batch: '📦',
  browser_news: '📰',
  browser_shopping: '🛒',
  browser_places: '📍',
  browser_images: '🖼️',
  file_read: '📄',
  file_write: '✏️',
  file_edit: '✏️',
  shell_exec: '💻',
  directory_tree: '📁',
  process_manager: '⚙️',
  create_document: '📝',
  sequential_thinking: '🧠',
  vault_search: '🔍',
  vault_ingest: '📥',
  action_plan: '📋',
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || '🔧';
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  // Show a compact summary of key params
  const parts: string[] = [];
  for (const key of keys.slice(0, 3)) {
    const val = input[key];
    if (typeof val === 'string') {
      parts.push(`${key}: "${val.length > 60 ? val.slice(0, 57) + '...' : val}"`);
    } else if (val !== undefined && val !== null) {
      const s = JSON.stringify(val);
      parts.push(`${key}: ${s.length > 40 ? s.slice(0, 37) + '...' : s}`);
    }
  }
  if (keys.length > 3) parts.push(`+${keys.length - 3} more`);
  return parts.join(', ');
}

function escapeText(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function createPanel(): void {
  if (panelEl) return;

  panelEl = document.createElement('div');
  panelEl.className = 'tool-activity-panel';

  // Dark backdrop that covers the whole screen when expanded
  backdropEl = document.createElement('div');
  backdropEl.className = 'tool-activity-backdrop';
  backdropEl.addEventListener('click', () => { if (expanded) togglePanel(); });

  headerEl = document.createElement('div');
  headerEl.className = 'tool-activity-header';
  headerEl.addEventListener('click', togglePanel);

  badgeEl = document.createElement('span');
  badgeEl.className = 'tool-activity-badge';
  badgeEl.textContent = '0 tool calls';

  const chevron = document.createElement('span');
  chevron.className = 'tool-activity-chevron';
  chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

  headerEl.appendChild(badgeEl);
  headerEl.appendChild(chevron);

  warningEl = document.createElement('div');
  warningEl.className = 'tool-activity-warning hidden';

  listEl = document.createElement('div');
  listEl.className = 'tool-activity-list';

  panelEl.appendChild(backdropEl);
  panelEl.appendChild(headerEl);
  panelEl.appendChild(warningEl);
  panelEl.appendChild(listEl);

  // Insert before the output element
  const outputParent = elements.outputEl.parentElement;
  if (outputParent) {
    outputParent.insertBefore(panelEl, elements.outputEl);
  }
}

function togglePanel(): void {
  expanded = !expanded;
  if (panelEl) panelEl.classList.toggle('expanded', expanded);
  // Render entries when opening so the list is up-to-date
  if (expanded) renderEntries();
}

function renderEntries(): void {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (currentEntries.length === 0) {
    listEl.innerHTML = '<div class="tool-activity-empty">No tool calls this turn</div>';
    return;
  }

  for (const entry of currentEntries) {
    const item = document.createElement('div');
    item.className = `tool-activity-item tool-activity-status-${entry.status}`;

    const icon = getToolIcon(entry.name);
    const duration = formatDuration(entry.durationMs);
    const inputSummary = truncateInput(entry.input);

    const statusIndicator =
      entry.status === 'running' ? '<span class="tool-activity-spinner"></span>' :
        entry.status === 'success' ? '<span class="tool-activity-check">✓</span>' :
          entry.status === 'error' ? '<span class="tool-activity-error-icon">✗</span>' :
            '<span class="tool-activity-skip">—</span>';

    item.innerHTML = `
      <div class="tool-activity-item-header">
        <span class="tool-activity-icon">${icon}</span>
        <span class="tool-activity-name">${escapeText(entry.name)}</span>
        ${statusIndicator}
        ${duration ? `<span class="tool-activity-duration">${duration}</span>` : ''}
      </div>
      ${inputSummary ? `<div class="tool-activity-input">${escapeText(inputSummary)}</div>` : ''}
      ${entry.error ? `<div class="tool-activity-error">${escapeText(entry.error)}</div>` : ''}
      ${entry.resultPreview && entry.status === 'success' ? `<div class="tool-activity-result">${escapeText(entry.resultPreview.slice(0, 150))}${entry.resultPreview.length > 150 ? '...' : ''}</div>` : ''}
    `;

    if ((entry.name === 'execute_plan' || entry.name.includes('action_execute')) && entry.status === 'success') {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'tool-activity-undo-btn';
      undoBtn.textContent = 'Undo';
      undoBtn.onclick = (e) => {
        e.stopPropagation();
        const planId = (entry.input as any).planId;
        if (planId) {
          undoBtn.disabled = true;
          undoBtn.textContent = 'Undoing...';
          window.api.actionUndoPlan(planId).then(() => {
            undoBtn.textContent = 'Undone';
          }).catch(err => {
            undoBtn.textContent = 'Failed';
            console.error(err);
          });
        }
      };
      item.appendChild(undoBtn);
    }

    listEl.appendChild(item);
  }
}

function updateBadge(): void {
  if (!badgeEl) return;
  const count = currentEntries.length;
  const running = currentEntries.filter(e => e.status === 'running').length;
  const errors = currentEntries.filter(e => e.status === 'error').length;

  if (count === 0) {
    badgeEl.textContent = 'No tools used';
    badgeEl.className = 'tool-activity-badge';
    return;
  }

  let text = `${count} tool call${count !== 1 ? 's' : ''}`;
  if (running > 0) text += ` (${running} running)`;
  if (errors > 0) text += ` (${errors} failed)`;

  badgeEl.textContent = text;
  badgeEl.className = 'tool-activity-badge' + (errors > 0 ? ' has-errors' : '');
}

function updateWarning(): void {
  if (!warningEl) return;
  if (currentWarning) {
    warningEl.textContent = currentWarning;
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
    warningEl.textContent = '';
  }
}

function handleToolActivity(entry: ToolActivityEntry): void {
  createPanel();

  // Update or add entry
  const idx = currentEntries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    currentEntries[idx] = entry;
  } else {
    currentEntries.push(entry);
  }

  updateBadge();
  if (expanded) renderEntries();
  if (panelEl) panelEl.classList.remove('hidden');
}

function handleToolActivitySummary(summary: ToolActivitySummary): void {
  createPanel();
  currentEntries = summary.entries;
  currentWarning = summary.fabricationWarning;
  updateBadge();
  updateWarning();
  if (expanded) renderEntries();
  if (panelEl) {
    panelEl.classList.remove('hidden');
    if (currentWarning) {
      panelEl.classList.add('has-warning');
    } else {
      panelEl.classList.remove('has-warning');
    }
  }
}

/** Reset the panel for a new message. */
export function resetToolActivity(): void {
  currentEntries = [];
  currentWarning = undefined;
  expanded = false;
  if (panelEl) panelEl.classList.add('hidden');
  if (panelEl) panelEl.classList.remove('expanded', 'has-warning');
  if (listEl) listEl.innerHTML = '';
  if (warningEl) {
    warningEl.classList.add('hidden');
    warningEl.textContent = '';
  }
  updateBadge();
}

export function initToolActivity(): void {
  createPanel();
  panelEl?.classList.add('hidden');

  window.api.onToolActivity(handleToolActivity);
  window.api.onToolActivitySummary(handleToolActivitySummary);

  // Reset when a new message starts streaming
  window.api.onStreamText(() => {
    // Only reset if panel is currently showing a summary (not mid-stream)
    // The reset happens at send time in chat.ts instead
  });
}
