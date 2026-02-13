export type CapabilityKind = 'binary' | 'tool' | 'mcp';

export type InstallMethod = 'apt' | 'npm' | 'pip' | 'script' | 'github_release' | 'direct_binary';

export type TrustPolicy = 'verified_fallback' | 'strict_verified' | 'best_effort';

export interface VerificationSpec {
  command: string;
  expectedExitCode?: number;
  expectedPattern?: string;
  timeoutMs?: number;
}

export interface InstallRecipe {
  id: string;
  method: InstallMethod;
  command: string;
  timeoutMs?: number;
  verified?: boolean;
  verifyCommand?: string;
  source?: string;
  checksum?: string;
  signature?: string;
  smokeTest?: VerificationSpec;
}

export interface CapabilityRequirement {
  id: string;
  reason?: string;
  optional?: boolean;
  minVersion?: string;
}

export interface ScopeRequirement {
  workspacePaths?: string[];
  sharedPaths?: string[];
  networkAccess?: 'none' | 'allow' | 'restricted';
  secretScopes?: string[];
}

export interface CapabilityHealthCheck {
  command: string;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  binary?: string;
  aliases?: string[];
  description: string;
  sideEffects?: string[];
  requirements?: CapabilityRequirement[];
  scope?: ScopeRequirement;
  verification?: VerificationSpec;
  estimatedCost?: 'low' | 'medium' | 'high';
  estimatedLatencyMs?: number;
  healthCheck?: CapabilityHealthCheck;
  installRecipes?: InstallRecipe[];
}

export interface CapabilityState {
  id: string;
  available: boolean;
  lastCheckedAt: number;
  source?: string;
  detail?: string;
  health?: 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
  lastError?: string;
  activatedAt?: number;
}

export type CapabilityEventType =
  | 'capability_discovered'
  | 'capability_missing'
  | 'install_started'
  | 'install_verified'
  | 'install_succeeded'
  | 'install_failed'
  | 'policy_rewrite'
  | 'policy_blocked'
  | 'checkpoint_created'
  | 'rollback_applied'
  | 'rollback_failed'
  | 'mcp_server_health'
  | 'task_evidence_summary';

export type CapabilityLifecycleEventName =
  | 'CAPABILITY_DISCOVERED'
  | 'CAPABILITY_MISSING'
  | 'INSTALL_STARTED'
  | 'INSTALL_VERIFIED'
  | 'INSTALL_FAILED'
  | 'POLICY_REWRITE_APPLIED'
  | 'POLICY_BLOCKED'
  | 'CHECKPOINT_CREATED'
  | 'ROLLBACK_APPLIED'
  | 'MCP_SERVER_HEALTH'
  | 'TASK_EVIDENCE_SUMMARY';

export interface CapabilityEvent {
  type: CapabilityEventType;
  eventName?: CapabilityLifecycleEventName;
  capabilityId?: string;
  message: string;
  detail?: string;
  command?: string;
  recipeId?: string;
  stepIndex?: number;
  totalSteps?: number;
  durationMs?: number;
  status?: 'success' | 'error' | 'warning' | 'pending';
  metadata?: Record<string, unknown>;
}

export const CAPABILITY_EVENT_NAME_BY_TYPE: Record<CapabilityEventType, CapabilityLifecycleEventName> = {
  capability_discovered: 'CAPABILITY_DISCOVERED',
  capability_missing: 'CAPABILITY_MISSING',
  install_started: 'INSTALL_STARTED',
  install_verified: 'INSTALL_VERIFIED',
  install_succeeded: 'INSTALL_VERIFIED',
  install_failed: 'INSTALL_FAILED',
  policy_rewrite: 'POLICY_REWRITE_APPLIED',
  policy_blocked: 'POLICY_BLOCKED',
  checkpoint_created: 'CHECKPOINT_CREATED',
  rollback_applied: 'ROLLBACK_APPLIED',
  rollback_failed: 'ROLLBACK_APPLIED',
  mcp_server_health: 'MCP_SERVER_HEALTH',
  task_evidence_summary: 'TASK_EVIDENCE_SUMMARY',
};

export function toCapabilityLifecycleEventName(type: CapabilityEventType): CapabilityLifecycleEventName {
  return CAPABILITY_EVENT_NAME_BY_TYPE[type];
}

export function tryCapabilityLifecycleEventName(type: string): CapabilityLifecycleEventName | undefined {
  return (CAPABILITY_EVENT_NAME_BY_TYPE as Record<string, CapabilityLifecycleEventName | undefined>)[type];
}

export type PolicyAction = 'allow' | 'rewrite' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  command?: string;
  detail?: string;
  invariantId?: string;
  rewriteApplied?: boolean;
  hardViolation?: boolean;
}

export interface ExecutionInvariant {
  id: string;
  description: string;
  hardDeny: boolean;
  scope: 'filesystem' | 'network' | 'secrets' | 'privilege' | 'process';
}

export interface InstallAttempt {
  capabilityId: string;
  recipeId: string;
  ok: boolean;
  durationMs: number;
  output: string;
}

export interface InstallResult {
  capabilityId: string;
  ok: boolean;
  attempts: InstallAttempt[];
  detail: string;
}

export interface EvidenceRecord {
  id: string;
  ts: number;
  capabilityId?: string;
  command?: string;
  toolName?: string;
  summary: string;
  sourceRefs?: string[];
}
