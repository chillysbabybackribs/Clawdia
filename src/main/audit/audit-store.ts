/**
 * SQLite-backed append-only audit event store.
 *
 * Every security-relevant decision (approval, deny, mode change, override)
 * is persisted here so the Security Timeline can query it.
 *
 * Database location: <userData>/audit-events.sqlite
 */

import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger';
import type {
  AuditEvent,
  AuditEventKind,
  AuditOutcome,
  AuditQueryFilters,
  AuditSummary,
} from '../../shared/audit-types';
import type { RiskLevel } from '../../shared/autonomy';

const log = createLogger('audit-store');

// ---------------------------------------------------------------------------
// Singleton + listener
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
type AuditListener = (event: AuditEvent) => void;
const listeners: AuditListener[] = [];

/** Register a listener called on every new audit event (for live-push to renderer). */
export function onAuditEvent(fn: AuditListener): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'audit-events.sqlite');
  log.info(`Opening audit store at ${dbPath}`);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');

  // Create table
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      conversation_id TEXT,
      task_id         TEXT,
      tool_call_id    TEXT,
      request_id      TEXT,
      tool_name       TEXT,
      risk            TEXT,
      risk_reason     TEXT,
      autonomy_mode   TEXT,
      decision        TEXT,
      decision_scope  TEXT,
      decision_source TEXT,
      outcome         TEXT,
      command_preview  TEXT,
      url_preview      TEXT,
      detail          TEXT,
      duration_ms     INTEGER,
      exit_code       INTEGER,
      error_preview   TEXT
    );
  `);

  // Indexes for timeline queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_conv_ts ON audit_events(conversation_id, ts);
    CREATE INDEX IF NOT EXISTS idx_audit_kind_ts ON audit_events(kind, ts);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the audit store (call at app startup). */
export function initAuditStore(): void {
  try {
    getDb();
    pruneOldEvents(30); // keep 30 days by default
    log.info('Audit store initialized');
  } catch (err: any) {
    log.error(`Failed to initialize audit store: ${err?.message}`);
  }
}

/** Close the database on shutdown. */
export function closeAuditStore(): void {
  if (db) {
    try {
      db.close();
    } catch { /* ignore */ }
    db = null;
    log.info('Audit store closed');
  }
}

/** Append a new audit event. Returns the event ID. Safe to call before init. */
export function appendAuditEvent(event: Omit<AuditEvent, 'id'>): string {
  const id = randomUUID();
  try {
    const d = getDb();
    if (!d) return id; // Store not ready yet
    d.prepare(`
      INSERT INTO audit_events (
        id, ts, kind, conversation_id, task_id, tool_call_id, request_id,
        tool_name, risk, risk_reason, autonomy_mode, decision, decision_scope,
        decision_source, outcome, command_preview, url_preview, detail,
        duration_ms, exit_code, error_preview
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      id, event.ts, event.kind,
      event.conversationId ?? null, event.taskId ?? null,
      event.toolCallId ?? null, event.requestId ?? null,
      event.toolName ?? null, event.risk ?? null, event.riskReason ?? null,
      event.autonomyMode ?? null, event.decision ?? null, event.decisionScope ?? null,
      event.decisionSource ?? null, event.outcome ?? null,
      event.commandPreview ?? null, event.urlPreview ?? null, event.detail ?? null,
      event.durationMs ?? null, event.exitCode ?? null, event.errorPreview ?? null,
    );
    // Notify listeners for live-push
    const full: AuditEvent = { id, ...event };
    for (const fn of listeners) {
      try { fn(full); } catch { /* ignore */ }
    }
  } catch (err: any) {
    log.error(`Failed to append audit event: ${err?.message}`);
  }
  return id;
}

/** Query audit events with optional filters, newest first. */
export function queryAuditEvents(filters: AuditQueryFilters = {}): AuditEvent[] {
  try {
    const d = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.sinceTs !== undefined) {
      conditions.push('ts >= ?');
      params.push(filters.sinceTs);
    }
    if (filters.beforeTs !== undefined) {
      conditions.push('ts < ?');
      params.push(filters.beforeTs);
    }
    if (filters.conversationId) {
      conditions.push('conversation_id = ?');
      params.push(filters.conversationId);
    }
    if (filters.kinds?.length) {
      conditions.push(`kind IN (${filters.kinds.map(() => '?').join(',')})`);
      params.push(...filters.kinds);
    }
    if (filters.outcomes?.length) {
      conditions.push(`outcome IN (${filters.outcomes.map(() => '?').join(',')})`);
      params.push(...filters.outcomes);
    }
    if (filters.risks?.length) {
      conditions.push(`risk IN (${filters.risks.map(() => '?').join(',')})`);
      params.push(...filters.risks);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 200;

    const rows = d.prepare(`
      SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT ?
    `).all(...params, limit) as RawRow[];

    return rows.map(rowToEvent);
  } catch (err: any) {
    log.error(`Failed to query audit events: ${err?.message}`);
    return [];
  }
}

/** Get summary counts for the timeline header. */
export function getAuditSummary(): AuditSummary {
  try {
    const d = getDb();

    const total = (d.prepare('SELECT COUNT(*) as cnt FROM audit_events').get() as any)?.cnt ?? 0;

    const outcomeRows = d.prepare(
      'SELECT outcome, COUNT(*) as cnt FROM audit_events WHERE outcome IS NOT NULL GROUP BY outcome'
    ).all() as { outcome: string; cnt: number }[];

    const riskRows = d.prepare(
      'SELECT risk, COUNT(*) as cnt FROM audit_events WHERE risk IS NOT NULL GROUP BY risk'
    ).all() as { risk: string; cnt: number }[];

    const bounds = d.prepare(
      'SELECT MIN(ts) as oldest, MAX(ts) as newest FROM audit_events'
    ).get() as { oldest: number | null; newest: number | null };

    return {
      total,
      byOutcome: Object.fromEntries(outcomeRows.map(r => [r.outcome as AuditOutcome, r.cnt])),
      byRisk: Object.fromEntries(riskRows.map(r => [r.risk as RiskLevel, r.cnt])),
      oldestTs: bounds?.oldest ?? undefined,
      newestTs: bounds?.newest ?? undefined,
    };
  } catch (err: any) {
    log.error(`Failed to get audit summary: ${err?.message}`);
    return { total: 0, byOutcome: {}, byRisk: {} };
  }
}

/** Delete all audit events. */
export function clearAuditEvents(): number {
  try {
    const d = getDb();
    const info = d.prepare('DELETE FROM audit_events').run();
    log.info(`Cleared ${info.changes} audit events`);
    return info.changes;
  } catch (err: any) {
    log.error(`Failed to clear audit events: ${err?.message}`);
    return 0;
  }
}

/** Remove events older than `days` days. */
export function pruneOldEvents(days: number): number {
  try {
    const d = getDb();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const info = d.prepare('DELETE FROM audit_events WHERE ts < ?').run(cutoff);
    if (info.changes > 0) {
      log.info(`Pruned ${info.changes} audit events older than ${days} days`);
    }
    return info.changes;
  } catch (err: any) {
    log.error(`Failed to prune audit events: ${err?.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  ts: number;
  kind: string;
  conversation_id: string | null;
  task_id: string | null;
  tool_call_id: string | null;
  request_id: string | null;
  tool_name: string | null;
  risk: string | null;
  risk_reason: string | null;
  autonomy_mode: string | null;
  decision: string | null;
  decision_scope: string | null;
  decision_source: string | null;
  outcome: string | null;
  command_preview: string | null;
  url_preview: string | null;
  detail: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error_preview: string | null;
}

function rowToEvent(row: RawRow): AuditEvent {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as AuditEventKind,
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    requestId: row.request_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    risk: (row.risk as any) ?? undefined,
    riskReason: row.risk_reason ?? undefined,
    autonomyMode: (row.autonomy_mode as any) ?? undefined,
    decision: (row.decision as any) ?? undefined,
    decisionScope: (row.decision_scope as any) ?? undefined,
    decisionSource: (row.decision_source as any) ?? undefined,
    outcome: (row.outcome as any) ?? undefined,
    commandPreview: row.command_preview ?? undefined,
    urlPreview: row.url_preview ?? undefined,
    detail: row.detail ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    exitCode: row.exit_code ?? undefined,
    errorPreview: row.error_preview ?? undefined,
  };
}
