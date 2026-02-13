/**
 * Security Timeline renderer module.
 *
 * Fetches audit events from the main process via IPC and renders them
 * as a grouped, filterable timeline in the sidebar panel.
 */

import { elements } from './state';
import { eventSummary } from '../../shared/audit-types';
import type { AuditEvent, AuditEventKind, AuditOutcome } from '../../shared/audit-types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let events: AuditEvent[] = [];
let activeFilter: 'all' | 'approvals' | 'blocked' | 'executed' = 'all';
let cleanupLiveListener: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Wire up filter buttons and live-event listener (call once at init). */
export function initTimeline(): void {
  // Filter buttons
  elements.tlFilters.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.tl-filter-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const filter = btn.dataset.filter as typeof activeFilter;
    if (filter === activeFilter) return;
    activeFilter = filter;
    elements.tlFilters.querySelectorAll('.tl-filter-btn').forEach(b =>
      b.classList.toggle('tl-filter-btn--active', b === btn),
    );
    renderEvents();
  });

  // Clear button
  elements.tlClearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all security timeline events? This cannot be undone.')) return;
    await window.api.clearAuditEvents();
    events = [];
    renderEvents();
  });

  // Live-push listener — add new events to the top if timeline is open
  cleanupLiveListener = window.api.onAuditEvent((event: AuditEvent) => {
    // Deduplicate
    if (events.some(e => e.id === event.id)) return;
    events.unshift(event);
    // Re-render if timeline view is visible
    if (!elements.timelineView.classList.contains('hidden')) {
      renderEvents();
    }
  });
}

/** Load events from the audit store (called when the timeline view opens). */
export async function loadTimeline(): Promise<void> {
  try {
    events = await window.api.getAuditEvents({ limit: 500 });
  } catch (err) {
    console.error('[Timeline] Failed to load events:', err);
    events = [];
  }
  renderEvents();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEvents(): void {
  const container = elements.tlEvents;
  const emptyEl = elements.tlEmpty;

  const filtered = filterEvents(events);
  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  // Group by day
  const groups = groupByDay(filtered);
  const fragment = document.createDocumentFragment();

  for (const [label, items] of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'tl-group';

    const headerEl = document.createElement('div');
    headerEl.className = 'tl-group-header';
    headerEl.textContent = label;
    groupEl.appendChild(headerEl);

    for (const event of items) {
      groupEl.appendChild(renderEventRow(event));
    }

    fragment.appendChild(groupEl);
  }

  container.innerHTML = '';
  container.appendChild(fragment);
}

function renderEventRow(event: AuditEvent): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tl-row';
  row.dataset.eventId = event.id;

  // Time
  const timeEl = document.createElement('span');
  timeEl.className = 'tl-time';
  timeEl.textContent = formatTime(event.ts);

  // Summary
  const summaryEl = document.createElement('span');
  summaryEl.className = 'tl-summary';
  summaryEl.textContent = eventSummary(event);

  // Badge
  const badgeEl = document.createElement('span');
  const outcome = event.outcome || 'info';
  badgeEl.className = `tl-badge tl-badge--${outcome}`;
  const label = badgeLabel(outcome);
  badgeEl.textContent = label;
  badgeEl.dataset.label = label;

  // Top line
  const topLine = document.createElement('div');
  topLine.className = 'tl-row-top';
  topLine.appendChild(timeEl);
  topLine.appendChild(summaryEl);
  topLine.appendChild(badgeEl);

  row.appendChild(topLine);

  // Expandable details (hidden by default)
  const detailsEl = document.createElement('div');
  detailsEl.className = 'tl-details hidden';
  buildDetailsDOM(event, detailsEl);

  // Copy button inside details
  const copyBtn = document.createElement('button');
  copyBtn.className = 'tl-copy-btn';
  copyBtn.textContent = 'Copy details';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = buildDetailsCopyText(event);
    const doCopy = (window as any).clawdia?.clipboardWriteText
      ? (window as any).clawdia.clipboardWriteText(text)
      : navigator.clipboard.writeText(text);
    doCopy.then(() => {
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('tl-copy-btn--copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy details';
        copyBtn.classList.remove('tl-copy-btn--copied');
      }, 1200);
    }).catch(() => {
      copyBtn.textContent = 'Failed';
      setTimeout(() => { copyBtn.textContent = 'Copy details'; }, 1200);
    });
  });
  detailsEl.appendChild(copyBtn);

  row.appendChild(detailsEl);

  // Toggle expand on click
  topLine.addEventListener('click', () => {
    detailsEl.classList.toggle('hidden');
    row.classList.toggle('tl-row--expanded');
  });

  return row;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const APPROVAL_KINDS: AuditEventKind[] = ['approval_requested', 'approval_decided', 'tool_expired'];
const BLOCKED_OUTCOMES: AuditOutcome[] = ['blocked', 'denied', 'expired'];
const EXECUTED_OUTCOMES: AuditOutcome[] = ['executed'];

function filterEvents(all: AuditEvent[]): AuditEvent[] {
  switch (activeFilter) {
    case 'approvals':
      return all.filter(e => APPROVAL_KINDS.includes(e.kind));
    case 'blocked':
      return all.filter(e => e.outcome && BLOCKED_OUTCOMES.includes(e.outcome));
    case 'executed':
      return all.filter(e => e.outcome && EXECUTED_OUTCOMES.includes(e.outcome));
    default:
      return all;
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupByDay(items: AuditEvent[]): [string, AuditEvent[]][] {
  const groups = new Map<string, AuditEvent[]>();
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);

  for (const event of items) {
    const key = dayKey(event.ts);
    let label: string;
    if (key === today) label = 'Today';
    else if (key === yesterday) label = 'Yesterday';
    else label = formatDate(event.ts);

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(event);
  }

  return Array.from(groups.entries());
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function badgeLabel(outcome: string): string {
  switch (outcome) {
    case 'executed': return 'Executed';
    case 'blocked': return 'Blocked';
    case 'denied': return 'Denied';
    case 'expired': return 'Expired';
    case 'pending': return 'Pending';
    case 'info': return 'Info';
    default: return outcome;
  }
}

// ---------------------------------------------------------------------------
// Detail builders
// ---------------------------------------------------------------------------

function addDetailRow(parent: HTMLElement, label: string, value: string, mono = false): void {
  const row = document.createElement('div');
  row.className = 'tl-detail-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'tl-detail-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = mono ? 'tl-detail-value tl-detail-mono' : 'tl-detail-value';
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  parent.appendChild(row);
}

function buildDetailsDOM(e: AuditEvent, container: HTMLElement): void {
  if (e.detail) addDetailRow(container, 'Detail', e.detail);
  if (e.risk) addDetailRow(container, 'Risk', e.risk);
  if (e.toolName) addDetailRow(container, 'Tool', e.toolName);
  if (e.commandPreview) addDetailRow(container, 'Command', e.commandPreview, true);
  if (e.urlPreview) addDetailRow(container, 'URL', e.urlPreview, true);
  if (e.riskReason) addDetailRow(container, 'Reason', e.riskReason);
  if (e.decision) addDetailRow(container, 'Decision', e.decision);
  if (e.decisionScope) addDetailRow(container, 'Scope', e.decisionScope);
  if (e.decisionSource) addDetailRow(container, 'Source', e.decisionSource);
  if (e.autonomyMode) addDetailRow(container, 'Mode', e.autonomyMode);
  if (e.durationMs !== undefined) addDetailRow(container, 'Duration', `${e.durationMs}ms`);
  if (e.exitCode !== undefined) addDetailRow(container, 'Exit code', String(e.exitCode));
  if (e.errorPreview) addDetailRow(container, 'Error', e.errorPreview, true);
}

function buildDetailsCopyText(e: AuditEvent): string {
  const lines: string[] = [
    `Event: ${e.kind}`,
    `Time: ${new Date(e.ts).toISOString()}`,
    `Summary: ${eventSummary(e)}`,
  ];
  if (e.risk) lines.push(`Risk: ${e.risk}`);
  if (e.detail) lines.push(`Detail: ${e.detail}`);
  if (e.toolName) lines.push(`Tool: ${e.toolName}`);
  if (e.commandPreview) lines.push(`Command: ${e.commandPreview}`);
  if (e.urlPreview) lines.push(`URL: ${e.urlPreview}`);
  if (e.riskReason) lines.push(`Reason: ${e.riskReason}`);
  if (e.decision) lines.push(`Decision: ${e.decision}`);
  if (e.decisionScope) lines.push(`Scope: ${e.decisionScope}`);
  if (e.decisionSource) lines.push(`Source: ${e.decisionSource}`);
  if (e.autonomyMode) lines.push(`Mode: ${e.autonomyMode}`);
  if (e.durationMs !== undefined) lines.push(`Duration: ${e.durationMs}ms`);
  if (e.exitCode !== undefined) lines.push(`Exit code: ${e.exitCode}`);
  if (e.errorPreview) lines.push(`Error: ${e.errorPreview}`);
  lines.push(`ID: ${e.id}`);
  return lines.join('\n');
}
