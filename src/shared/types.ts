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
  status: 'success' | 'error';
  duration: number;
  summary: string;
}

export interface ToolStepProgressEvent {
  toolId: string;
  stepIndex: number;
  totalSteps: number;
  action: string;
  status: 'success' | 'error' | 'skipped';
  duration: number;
}

export interface ToolLoopCompleteEvent {
  totalTools: number;
  totalDuration: number;
  failures: number;
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
  status: 'running' | 'success' | 'error' | 'skipped';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  resultPreview?: string;
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
