// ============================================================================
// MESSAGE TYPES
// ============================================================================

export interface ImageAttachment {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
}

export interface DocumentAttachment {
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
  pageCount?: number;
  sheetNames?: string[];
  truncated?: boolean;
}

export interface DocumentMeta {
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount?: number;
  sheetNames?: string[];
  truncated?: boolean;
}

export type DocProgressStage =
  | 'generating'
  | 'parsing'
  | 'assembling'
  | 'writing'
  | 'complete'
  | 'error';

export interface DocProgressEvent {
  conversationId: string;
  messageId: string;
  stage: DocProgressStage;
  stageLabel: string;
  stageNumber: number;
  totalStages: number;
  elapsedMs: number;
  detail?: string;
  filename?: string;
  error?: string;
  writeCompletedAtMs?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  images?: ImageAttachment[];
  documents?: DocumentMeta[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'success' | 'error';
  result?: string;
}

// ---------------------------------------------------------------------------
// TOOL EXECUTION EVENT TYPES (live activity feed)
// ---------------------------------------------------------------------------

export interface ToolExecStartEvent {
  toolName: string;
  toolId: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolExecCompleteEvent {
  toolId: string;
  status: 'success' | 'error' | 'warning';
  duration: number;
  summary: string;
  stderr?: string[];
}

export interface ToolStepProgressEvent {
  toolId: string;
  stepIndex: number;
  totalSteps: number;
  action: string;
  status: 'success' | 'error' | 'skipped';
  duration: number;
}

export type CapabilityRuntimeEventName =
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

export interface CapabilityRuntimeEvent {
  toolId: string;
  toolName: string;
  type:
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
  eventName?: CapabilityRuntimeEventName;
  message: string;
  detail?: string;
  command?: string;
  capabilityId?: string;
  recipeId?: string;
  stepIndex?: number;
  totalSteps?: number;
  durationMs?: number;
  status?: 'success' | 'error' | 'warning' | 'pending';
  metadata?: Record<string, unknown>;
}

export interface TaskEvidenceSummaryEvent {
  totalTools: number;
  totalDuration: number;
  failures: number;
  toolClasses: {
    browser: number;
    local: number;
    task: number;
    archive: number;
    vault: number;
    other: number;
  };
  topTools: Array<{ name: string; count: number }>;
}

export interface MCPServerHealthEvent {
  serverName: string;
  status: MCPServerHealthStatus;
  detail?: string;
  restartCount?: number;
  consecutiveFailures?: number;
  timestamp: number;
}

export interface ToolLoopCompleteEvent {
  totalTools: number;
  totalDuration: number;
  failures: number;
}

// ---------------------------------------------------------------------------
// TOOL TIMING (debug instrumentation for latency diagnosis)
// ---------------------------------------------------------------------------

export interface ToolTimingEvent {
  toolCallId: string;
  toolName: string;
  /** T0: renderer submit (ms since page load) — filled by renderer, 0 if unavailable */
  t0_submit?: number;
  /** T1: main received the tool call from API response */
  t1_received: number;
  /** T2: risk classification completed */
  t2_classified: number;
  /** T3: approval resolved (same as T2 if no approval needed) */
  t3_approved: number;
  /** T4: child spawned / execution started */
  t4_spawned: number;
  /** T5: first stdout/stderr chunk */
  t5_firstOutput?: number;
  /** T6: tool finished */
  t6_finished: number;
  /** Summary durations in ms */
  durations: {
    classify: number;
    approve: number;
    spawn: number;
    firstOutput?: number;
    execute: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// TOKEN USAGE EVENTS
// ---------------------------------------------------------------------------

export interface TokenUsageUpdateEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  timestamp: number;
}

// ============================================================================
// TOOL ACTIVITY TYPES (anti-fabrication tracking)
// ============================================================================

export interface ToolActivityEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'success' | 'error' | 'warning' | 'skipped';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  resultPreview?: string;
  liveOutput?: string;
  error?: string;
}

export interface ToolActivitySummary {
  totalCalls: number;
  entries: ToolActivityEntry[];
  fabricationWarning?: string;
}

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

// ============================================================================
// BROWSER TYPES
// ============================================================================

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface InteractiveElement {
  nodeId: string;
  tag: string;
  role?: string;
  text: string;
  selector: string;
  type?: string;
  placeholder?: string;
  rect: { x: number; y: number; width: number; height: number };
  dataset?: Record<string, string>;
  ariaLabel?: string;
}

export interface PageObservation {
  url: string;
  title: string;
  pagePreview: string;
  content: string;
  interactiveElements: InteractiveElement[];
  formCount: number;
  linkCount: number;
  inputCount: number;
  timestamp: number;
}

// ============================================================================
// TOOL RESULT TYPES
// ============================================================================

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ============================================================================
// LLM TYPES
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Abstraction over BrowserWindow for ToolLoop IPC emissions.
 * Allows headless execution with a NullEmitter that captures output.
 */
export interface ToolLoopEmitter {
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface StreamEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_result' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
  toolResult?: { id: string; result: string; isError: boolean };
  error?: string;
}

// ============================================================================
// MCP TYPES
// ============================================================================

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  tools: MCPToolSchema[];
  idleTimeout?: number;
}

export type MCPServerHealthStatus = 'starting' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped';

export interface MCPToolRuntimeState {
  namespace: string;
  name: string;
  version?: string;
  schemaHash?: string;
  enabled: boolean;
  lastRegisteredAt?: number;
}

export interface MCPServerRuntimeState {
  name: string;
  namespace: string;
  pid?: number;
  status: MCPServerHealthStatus;
  restartCount: number;
  consecutiveFailures: number;
  lastStartedAt?: number;
  lastHealthCheckAt?: number;
  lastError?: string;
  tools: MCPToolRuntimeState[];
}

export type CapabilityRolloutCohort = 'internal' | 'beta' | 'default';

export interface CapabilityPlatformFlags {
  enabled: boolean;
  cohort: CapabilityRolloutCohort;
  lifecycleEvents: boolean;
  installOrchestrator: boolean;
  checkpointRollback: boolean;
  mcpRuntimeManager: boolean;
  containerExecution: boolean;
  containerizeMcpServers: boolean;
}

export interface MCPServerProcessState {
  name: string;
  source?: string;
  command?: string;
  args?: string[];
  pid?: number;
  running: boolean;
}

export interface CapabilityPlatformStatus {
  flags: CapabilityPlatformFlags;
  sandboxRuntime: 'container' | 'host';
  containerRuntime: {
    available: boolean;
    runtime: 'docker' | 'podman' | null;
    detail: string;
    checkedAt: number;
  };
  containerPolicy: {
    networkMode: 'allow' | 'restricted' | 'none' | 'host';
    allowedRoots: string[];
  };
  mcpRuntime: MCPServerRuntimeState[];
  mcpProcesses: MCPServerProcessState[];
}

// ============================================================================
// TASK INTAKE TYPES
// ============================================================================

export type RouteType = 'chat' | 'browse' | 'research';

export interface IntakeResult {
  route: RouteType;
  taskSpec?: TaskSpec;
}

export type DomainId = 'SOFTWARE' | 'PHYSICAL_PROCESS' | 'GENERAL';

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
  type: 'search' | 'navigate' | 'open_and_scan';
  source: string;
  query?: string;
  url?: string;
  priority: number;
  reason?: string;
}

// ============================================================================
// EVIDENCE TYPES
// ============================================================================

export type SourceKind =
  | 'official_docs'
  | 'repo_canonical'
  | 'repo_noncanonical'
  | 'content_primary'
  | 'content_secondary'
  | 'forum'
  | 'serp'
  | 'search_results'
  | 'docs_meta';
export type SourceTier = 'A' | 'B' | 'C' | 'D';


export interface SourceEvidence {
  sourceId: string;
  url: string;
  host: string;
  title: string;
  retrievedAt: number;
  rawContent: string;
  keyFindings: string[];
  sourceKind: SourceKind;
  sourceTier: SourceTier;
  eligibleForSynthesis: boolean;
  eligibleForPrimaryClaims: boolean;
  authorityScore?: number;
  canonicalRepo?: boolean;
  discardReason?: string;
  headings?: string[];
}

export interface FollowUpSuggestion {
  url: string;
  title: string;
  host: string;
  reason: string;
  sourceKind?: SourceKind;
  sourceTier?: SourceTier;
}

export interface ActionResult {
  actionId: string;
  source: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startedAt?: number;
  completedAt?: number;
  evidence?: SourceEvidence[];
  error?: { code: string; message: string };
  executionStatus?: ActionStatus;
  sourceIds?: string[];
  visitedPreviews?: ResearchSourcePreview[];
  followUps?: FollowUpSuggestion[];
  reason?: string;
}

// ============================================================================
// HEARTBEAT TYPES
// ============================================================================

export interface HeartbeatCheckpoint {
  checkpointNumber: number;
  completedSources: Array<{
    sourceId: string;
    host: string;
    title: string;
    findingsCount: number;
    snippet: string;
  }>;
  successCriteria: string[];
  criteriaWithEvidence: string[];
  actionsRemaining: number;
  batchesRemaining: number;
  elapsedSeconds: number;
}

export type ActionStatus = 'succeeded' | 'failed' | 'skipped_budget' | 'skipped_policy' | 'discarded_prune';


export interface HeartbeatResponse {
  action: 'continue' | 'done';
  newActions?: PlannedAction[];
}

// ============================================================================
// IPC PROGRESS TYPE
// ============================================================================

export interface ResearchSourcePreview {
  sourceId: string;
  title: string;
  host: string;
  url: string;
  sourceKind?: SourceKind;
  sourceTier?: SourceTier;
  reason?: string;
  eligibleForSynthesis?: boolean;
  eligibleForPrimaryClaims?: boolean;
  discardReason?: string;
  authorityScore?: number;
  canonicalRepo?: boolean;
}

export interface ResearchProgress {
  phase: 'intake' | 'executing' | 'checkpoint' | 'synthesizing' | 'done';
  message: string;
  actions?: Array<{
    id: string;
    source: string;
    status: ActionResult['status'];
    preview?: string;
    executionStatus?: ActionStatus;
    sourceIds?: string[];
    reason?: string;
    producedSources?: ResearchSourcePreview[];
  }>;
  checkpointNumber?: number;
  sources?: ResearchSourcePreview[];
  activeSourceId?: string;
  activeSourceUrl?: string;
  gateStatus?: { ok: boolean; reasons: string[]; eligibleCount: number; hostCount: number; hasPrimary: boolean };
}
