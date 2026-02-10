export type SuggestionIcon = 'cpu' | 'memory' | 'disk' | 'network' | 'battery' | 'browser' | 'terminal' | 'git' | 'project' | 'time' | 'cleanup' | 'alert';

export interface DashboardSuggestion {
  text: string;
  type: 'actionable' | 'info';
  action?: string;
  icon: SuggestionIcon;
  ruleId?: string;
}

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
  day_of_week: number;        // 0=Mon..6=Sun
  session_duration_minutes: number;
  minutes_since_last_message: number;
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

export interface DashboardRule {
  id: string;
  condition: string;
  suggestion_text: string;
  type: 'actionable' | 'info';
  action?: string;
  icon: SuggestionIcon;
  priority: number;         // 1-5 (1=critical)
  cooldown_minutes: number;
}

export type PollingTier = 'IDLE' | 'ELEVATED' | 'ALERT';

export interface DashboardState {
  static: StaticDashboardState;
  suggestions: DashboardSuggestion[];
  metrics: SystemMetrics;
  generatedAt: number;
  pollingTier: PollingTier;
}
