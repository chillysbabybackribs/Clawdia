// ---------------------------------------------------------------------------
// New command-center types
// ---------------------------------------------------------------------------

export interface DashboardProjectCard {
  name: string;
  fullPath: string;
  heatScore: number;
  branch?: string;
  uncommittedCount?: number;
  stagedCount?: number;
  unpushedCount?: number;
  lastCommitMessage?: string;
  hoursSinceLastCommit?: number;
  actions?: Array<{ label: string; command: string }>;
}

export interface DashboardActivityItem {
  type: 'browser' | 'shell' | 'file';
  text: string;
  command?: string;
}

export interface DashboardAlert {
  id: string;
  metric: 'cpu' | 'ram' | 'disk' | 'battery';
  message: string;
  severity: 'warning' | 'critical';
  action?: string;
  actionLabel?: string;
}

export interface HaikuDashboardResponse {
  projects: Array<{ path: string; rank: number; actions?: Array<{ label: string; command: string }> }>;
  activity_highlights: string[];
  pattern_note?: string;
}

// ---------------------------------------------------------------------------
// Metrics & static layer (unchanged)
// ---------------------------------------------------------------------------

export interface SystemMetrics {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMB: number; usedMB: number; usagePercent: number };
  disk: { totalGB: number; usedGB: number; usagePercent: number; mountPoint: string };
  battery: { percent: number; charging: boolean } | null;
  topProcesses: Array<{ name: string; cpu: number; mem: number }>;
  uptime: string;
}

export interface ExtendedMetrics extends SystemMetrics {
  cpu_delta: number;
  network_up: boolean;
  process_count: number;
  hour: number;
  minute: number;
  day_of_week: number;
  session_duration_minutes: number;
  minutes_since_last_message: number | null;
  active_project: string | null;
  git_uncommitted_changes: number | null;
  git_hours_since_last_commit: number | null;
}

export type ToolStatusLevel = 'ready' | 'active' | 'busy' | 'error' | 'disabled';

export interface ToolStatusIndicator {
  name: string;
  status: ToolStatusLevel;
  detail?: string;
}

export interface StaticDashboardState {
  toolStatuses: ToolStatusIndicator[];
  activeModel: string;
  sessionCost: string;
  uptime: string;
}

export type PollingTier = 'IDLE' | 'ELEVATED' | 'ALERT';

// ---------------------------------------------------------------------------
// Task Dashboard Items
// ---------------------------------------------------------------------------

export type TaskDashboardStatus = 'active' | 'paused' | 'running' | 'failed' | 'approval_pending';

export interface TaskDashboardItem {
  id: string;
  description: string;
  status: TaskDashboardStatus;
  scheduleSummary: string;           // "every day 9am", "every 1h", "one-time", "condition"
  lastRunResult?: string;            // truncated 1-line summary
  lastRunAgo?: string;               // "2h ago", "5m ago"
  lastRunSuccess?: boolean;
  runCount: number;
  failureCount: number;
  approvalRunId?: string;            // set when status === 'approval_pending'
  approvalSummary?: string;          // result text waiting for approval
}

// ---------------------------------------------------------------------------
// Dashboard state (new shape)
// ---------------------------------------------------------------------------

export interface DashboardState {
  projects: DashboardProjectCard[];
  activityFeed: DashboardActivityItem[];
  alerts: DashboardAlert[];
  tasks: TaskDashboardItem[];
  patternNote?: string;
  metrics: SystemMetrics;
  static: StaticDashboardState;
  generatedAt: number;
  pollingTier: PollingTier;
  taskUnreadCount: number;
}

// ---------------------------------------------------------------------------
// @deprecated — kept temporarily during migration
// ---------------------------------------------------------------------------

export type SuggestionIcon = 'cpu' | 'memory' | 'disk' | 'network' | 'battery' | 'browser' | 'terminal' | 'git' | 'project' | 'time' | 'cleanup' | 'alert';

/** @deprecated Use DashboardProjectCard instead */
export interface DashboardSuggestion {
  text: string;
  type: 'actionable' | 'info';
  action?: string;
  icon: SuggestionIcon;
  ruleId?: string;
}

/** @deprecated Use alert-evaluator instead */
export interface DashboardRule {
  id: string;
  condition: string;
  suggestion_text: string;
  type: 'actionable' | 'info';
  action?: string;
  icon: SuggestionIcon;
  priority: number;
  cooldown_minutes: number;
}
