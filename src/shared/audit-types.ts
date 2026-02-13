// ============================================================================
// AUDIT EVENT TYPES — Security Timeline
// ============================================================================

import type { RiskLevel, AutonomyMode, ApprovalDecision } from './autonomy';

/** Every kind of security-relevant event the audit store records. */
export type AuditEventKind =
  | 'risk_classified'
  | 'approval_requested'
  | 'approval_decided'
  | 'tool_executed'
  | 'tool_denied'
  | 'tool_expired'
  | 'capability_event'
  | 'mode_changed'
  | 'override_added'
  | 'override_removed';

/** Where the decision originated. */
export type DecisionSource = 'desktop' | 'telegram' | 'auto' | 'timeout';

/** Outcome shown in the timeline badge. */
export type AuditOutcome = 'executed' | 'blocked' | 'denied' | 'expired' | 'pending' | 'info';

/** A single, immutable audit event row. */
export interface AuditEvent {
  id: string;
  ts: number;                     // Unix ms
  kind: AuditEventKind;
  conversationId?: string;
  taskId?: string;
  toolCallId?: string;
  requestId?: string;

  // What happened
  toolName?: string;
  risk?: RiskLevel;
  riskReason?: string;
  autonomyMode?: AutonomyMode;
  decision?: ApprovalDecision;
  decisionScope?: 'once' | 'task' | 'always';
  decisionSource?: DecisionSource;
  outcome?: AuditOutcome;

  // Redacted previews (never raw secrets)
  commandPreview?: string;        // first 120 chars, home path replaced with ~
  urlPreview?: string;            // host + truncated path
  detail?: string;                // short human-readable detail

  // Execution result (for tool_executed)
  durationMs?: number;
  exitCode?: number;
  errorPreview?: string;
}

/** Filters for querying audit events. */
export interface AuditQueryFilters {
  limit?: number;
  sinceTs?: number;
  beforeTs?: number;
  kinds?: AuditEventKind[];
  outcomes?: AuditOutcome[];
  risks?: RiskLevel[];
  conversationId?: string;
}

/** Summary counts returned by get-summary. */
export interface AuditSummary {
  total: number;
  byOutcome: Partial<Record<AuditOutcome, number>>;
  byRisk: Partial<Record<RiskLevel, number>>;
  oldestTs?: number;
  newestTs?: number;
}

// ============================================================================
// Redaction helpers (shared between main + renderer if needed)
// ============================================================================

const HOME_RE = /(?:\/home\/[^/]+|\/Users\/[^/]+|~)/g;

/** Replace absolute home paths with ~ */
export function redactHomePath(s: string): string {
  return s.replace(HOME_RE, '~');
}

/** Truncate to maxLen, append ... if trimmed */
export function truncatePreview(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

/** Extract host + short path from a URL string */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const pathPart = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '...' : u.pathname;
    return `${u.host}${pathPart}`;
  } catch {
    return truncatePreview(raw, 60);
  }
}

/** Strip query strings, tokens, keys from a command string for safe storage */
export function redactCommand(raw: string): string {
  let s = raw;
  // Strip common secret patterns
  s = s.replace(/(?:token|key|secret|password|bearer)\s*[=:]\s*\S+/gi, '$&'.split('=')[0] + '=***');
  s = s.replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***');
  s = s.replace(/ghp_[a-zA-Z0-9]{10,}/g, 'ghp_***');
  return truncatePreview(redactHomePath(s), 120);
}

// ============================================================================
// Human-readable summary builders
// ============================================================================

/** Map an audit event to a short, non-technical summary string. */
export function eventSummary(e: AuditEvent): string {
  switch (e.kind) {
    case 'approval_requested':
      return `Approval needed: ${friendlyTool(e.toolName)}`;
    case 'approval_decided': {
      const src = e.decisionSource === 'telegram' ? ' via Telegram' : '';
      const scope = e.decisionScope ? ` (${capitalize(e.decisionScope)})` : '';
      if (e.decision === 'DENY') return `Denied by you${src}`;
      return `Approved${src}${scope}`;
    }
    case 'tool_executed':
      return e.exitCode !== undefined && e.exitCode !== 0
        ? `Command finished with error (exit ${e.exitCode})`
        : `${friendlyTool(e.toolName)} ran successfully`;
    case 'tool_denied':
      return `Blocked: ${e.riskReason || friendlyTool(e.toolName)}`;
    case 'tool_expired':
      return 'Approval expired (no response)';
    case 'capability_event':
      return e.detail || `Capability event: ${friendlyTool(e.toolName)}`;
    case 'risk_classified':
      return `Risk assessed: ${e.risk || 'SAFE'}`;
    case 'mode_changed':
      return `Mode changed to ${capitalize(e.autonomyMode || '')}`;
    case 'override_added':
      return `Always-approve added for ${friendlyRisk(e.risk)}`;
    case 'override_removed':
      return `Always-approve removed for ${friendlyRisk(e.risk)}`;
    default:
      return e.detail || 'Security event';
  }
}

function friendlyTool(name?: string): string {
  if (!name) return 'action';
  const map: Record<string, string> = {
    shell_exec: 'system command',
    browser_navigate: 'page navigation',
    browser_click: 'browser click',
    browser_type: 'browser typing',
    browser_batch: 'browser batch',
    browser_interact: 'browser interaction',
    file_write: 'file write',
    file_edit: 'file edit',
    action_execute_plan: 'action plan',
  };
  return map[name] || name.replace(/_/g, ' ');
}

function friendlyRisk(risk?: RiskLevel): string {
  if (!risk) return 'unknown';
  const map: Record<string, string> = {
    SAFE: 'safe actions',
    ELEVATED: 'elevated actions',
    EXFIL: 'network actions',
    SENSITIVE_DOMAIN: 'sensitive sites',
    SENSITIVE_READ: 'sensitive files',
  };
  return map[risk] || risk;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
