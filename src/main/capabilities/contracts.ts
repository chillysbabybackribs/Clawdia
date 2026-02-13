export type CapabilityKind = 'binary' | 'tool' | 'mcp';

export type InstallMethod = 'apt' | 'npm' | 'pip' | 'script';

export type TrustPolicy = 'verified_fallback' | 'strict_verified' | 'best_effort';

export interface InstallRecipe {
  id: string;
  method: InstallMethod;
  command: string;
  timeoutMs?: number;
  verified?: boolean;
  verifyCommand?: string;
}

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  binary?: string;
  aliases?: string[];
  description: string;
  installRecipes?: InstallRecipe[];
}

export interface CapabilityState {
  id: string;
  available: boolean;
  lastCheckedAt: number;
  source?: string;
  detail?: string;
}

export type CapabilityEventType =
  | 'capability_missing'
  | 'install_started'
  | 'install_succeeded'
  | 'install_failed'
  | 'policy_rewrite'
  | 'policy_blocked'
  | 'checkpoint_created'
  | 'rollback_applied'
  | 'rollback_failed';

export interface CapabilityEvent {
  type: CapabilityEventType;
  capabilityId?: string;
  message: string;
  detail?: string;
  command?: string;
  recipeId?: string;
  stepIndex?: number;
  totalSteps?: number;
  durationMs?: number;
}

export type PolicyAction = 'allow' | 'rewrite' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  command?: string;
  detail?: string;
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
