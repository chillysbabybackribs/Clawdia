// ============================================================================
// AUTONOMY MODE
// ============================================================================

export type AutonomyMode = 'safe' | 'guided' | 'unrestricted';

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = 'guided';

export interface AutonomyModeOption {
  id: AutonomyMode;
  label: string;
  description: string;
}

export const AUTONOMY_MODES: AutonomyModeOption[] = [
  {
    id: 'safe',
    label: 'Safe',
    description: 'Asks before installs, sudo, exfiltration, sensitive sites.',
  },
  {
    id: 'guided',
    label: 'Guided',
    description: 'Runs most actions; asks for exfiltration + sensitive sites.',
  },
  {
    id: 'unrestricted',
    label: 'Unrestricted',
    description: 'No guardrails. Full autonomy. You accept the risk.',
  },
];

// ============================================================================
// RISK CLASSIFICATION
// ============================================================================

export type RiskLevel = 'SAFE' | 'ELEVATED' | 'EXFIL' | 'SENSITIVE_DOMAIN';

export interface RiskClassification {
  risk: RiskLevel;
  reason: string;
  detail: string;
}

// ============================================================================
// APPROVAL TYPES
// ============================================================================

export type ApprovalDecision = 'APPROVE' | 'TASK' | 'ALWAYS' | 'DENY';

export interface ApprovalRequest {
  requestId: string;
  tool: string;
  risk: RiskLevel;
  reason: string;
  detail: string;
  autonomyMode: AutonomyMode;
  taskId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalResponse {
  requestId: string;
  decision: ApprovalDecision;
}

// ============================================================================
// AUTONOMY OVERRIDES (persisted in settings)
// ============================================================================

/** Stored under store key 'autonomyOverrides' — maps risk level to whether globally allowed */
export type AutonomyOverrides = Partial<Record<RiskLevel, boolean>>;
