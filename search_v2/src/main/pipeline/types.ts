export type DomainId = 'SOFTWARE' | 'PHYSICAL_PROCESS' | 'GENERAL';
export type TimeIntent = 'IMMEDIATE' | 'FUTURE' | 'UNKNOWN';

export interface RouterResult {
  domain: DomainId;
  timeIntent: TimeIntent;
  entityHint?: string;
}

export interface TaskSpec {
  userGoal: string;
  successCriteria: string[];
  deliverableSchema: string[];
  budget: {
    maxActions: number;
    maxBatches: number;
    maxTimeSeconds: number;
  };
  actions: PlannedAction[];
  domain?: DomainId;
}

export interface PlannedAction {
  id: string;
  type: 'search';
  source: 'google';
  query: string;
  priority: number;
  reason?: string;
}

export type SourceKind =
  | 'official_docs'
  | 'repo_canonical'
  | 'repo_noncanonical'
  | 'content_primary'
  | 'content_secondary'
  | 'forum'
  | 'search_results'
  | 'docs_meta';
export type SourceTier = 'A' | 'B' | 'C' | 'D';

export interface ResearchSourcePreview {
  sourceId: string;
  title: string;
  host: string;
  url: string;
  sourceKind?: SourceKind;
  sourceTier?: SourceTier;
  reason?: string;
  snippet?: string;
  eligibleForSynthesis?: boolean;
  eligibleForPrimaryClaims?: boolean;
  discardReason?: string;
}

export interface SourceEvidence extends ResearchSourcePreview {
  keyFindings: string[];
}

export interface ActionResult {
  actionId: string;
  source: string;
  status: 'success' | 'failed';
  previews: ResearchSourcePreview[];
  evidence: SourceEvidence[];
  visitedLinks: string[];
  executionStatus: 'succeeded' | 'failed' | 'discarded';
  reason: string;
}

export interface GateStatus {
  ok: boolean;
  reasons: string[];
  eligibleCount: number;
  hostCount: number;
  hasPrimary: boolean;
}

export interface ResearchProgressEvent {
  phase: 'intake' | 'executing' | 'checkpoint' | 'synthesizing' | 'done';
  message: string;
  actions?: Array<{
    id: string;
    source: string;
    status: 'running' | 'pending' | 'success' | 'failed';
    preview?: string;
    reason?: string;
    executionStatus?: string;
    producedSources?: ResearchSourcePreview[];
  }>;
  checkpointNumber?: number;
  sources?: ResearchSourcePreview[];
  activeSourceId?: string;
  activeSourceUrl?: string;
  gateStatus?: GateStatus;
}

export interface ExecutionSummary {
  results: ActionResult[];
  gateStatus: GateStatus;
  missingCriteria: string[];
  sources: ResearchSourcePreview[];
}
