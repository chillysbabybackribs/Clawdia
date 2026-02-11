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
    description: 'All system-level changes require approval.',
  },
  {
    id: 'guided',
    label: 'Guided',
    description: 'Most actions run automatically. Sensitive operations require approval.',
  },
  {
    id: 'unrestricted',
    label: 'Unrestricted',
    description: 'Full autonomy. All actions execute without confirmation.',
  },
];

// ============================================================================
// RISK CLASSIFICATION
// ============================================================================

export type RiskLevel = 'SAFE' | 'ELEVATED' | 'EXFIL' | 'SENSITIVE_DOMAIN' | 'SENSITIVE_READ';

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
