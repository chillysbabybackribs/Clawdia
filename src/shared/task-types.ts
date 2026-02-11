
export type TaskTriggerType = 'one_time' | 'scheduled' | 'condition';
export type TaskStatus = 'active' | 'paused' | 'completed' | 'failed' | 'archived';
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'approval_pending';
export type ApprovalMode = 'auto' | 'approve_first' | 'approve_always';
export type TriggerSource = 'scheduled' | 'condition' | 'manual' | 'system';

export interface PersistentTask {
    id: string;
    description: string;
    triggerType: TaskTriggerType;
    triggerConfig: string | null;
    executionPlan: string;
    status: TaskStatus;
    approvalMode: ApprovalMode;
    allowedTools: string;
    maxIterations: number;
    model: string | null;
    tokenBudget: number;
    createdAt: number;
    updatedAt: number;
    lastRunAt: number | null;
    nextRunAt: number | null;
    runCount: number;
    failureCount: number;
    maxFailures: number;
    conversationId: string | null;
    metadataJson: string;
    /** Whether to inject Electron session cookies into task context (default: true) */
    useSessionCookies?: boolean;
}

export interface TaskRun {
    id: string;
    taskId: string;
    status: RunStatus;
    startedAt: number;
    completedAt: number | null;
    durationMs: number | null;
    resultSummary: string | null;
    resultDetail: string | null;
    toolCallsCount: number;
    inputTokens: number;
    outputTokens: number;
    errorMessage: string | null;
    triggerSource: TriggerSource;
}

export interface CreateTaskParams {
    description: string;
    triggerType: TaskTriggerType;
    triggerConfig?: string;
    executionPlan?: string;
    approvalMode?: ApprovalMode;
    allowedTools?: string[];
    maxIterations?: number;
    model?: string;
    tokenBudget?: number;
    conversationId?: string;
    metadata?: Record<string, unknown>;
}

export interface UpdateTaskParams {
    description?: string;
    triggerType?: TaskTriggerType;
    triggerConfig?: string;
    executionPlan?: string;
    status?: TaskStatus;
    approvalMode?: ApprovalMode;
    allowedTools?: string[];
    maxIterations?: number;
    model?: string;
    tokenBudget?: number;
    nextRunAt?: number | null;
    lastRunAt?: number;
    runCount?: number;
    failureCount?: number;
    maxFailures?: number;
    conversationId?: string;
    metadata?: Record<string, unknown>;
}

export interface CreateRunParams {
    taskId: string;
    triggerSource: TriggerSource;
    status?: RunStatus;
}

export interface UpdateRunParams {
    status?: RunStatus;
    completedAt?: number;
    durationMs?: number;
    resultSummary?: string;
    resultDetail?: string;
    toolCallsCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    errorMessage?: string;
    runSource?: 'full_llm' | 'executor';
}

// ── Executor Cache Types ─────────────────────────────────────

export interface TraceStep {
    index: number;
    tool_name: string;
    tool_input: Record<string, any>;
    tool_result: string;                 // resultPreview (200 chars max)
    duration_ms: number;
    was_llm_dependent: boolean;
}

export interface ExpectCondition {
    selector_exists?: string;
    min_results?: number;
    contains_text?: string;
    status_code?: number;
}

export type ExecutorStep =
    | { type: 'tool'; tool_name: string; tool_input: Record<string, any>; store_as?: string; expect?: ExpectCondition }
    | { type: 'llm'; prompt_template: string; store_as?: string; max_tokens?: number }
    | { type: 'condition'; expression: string; on_true: 'continue' | 'skip_next' | 'abort'; message?: string }
    | { type: 'result'; template: string };

export interface ExecutorValidation {
    expect_result: boolean;
    max_duration_ms: number;
    required_variables: string[];
    abort_on_empty_extract: boolean;
}

export interface TaskExecutor {
    id: string;
    task_id: string;
    version: number;
    created_at: number;
    created_from_run_id: string;
    steps: ExecutorStep[];
    validation: ExecutorValidation;
    stats: {
        total_steps: number;
        deterministic_steps: number;
        llm_steps: number;
        estimated_cost_per_run: number;
    };
}

export interface ExecutorRunResult {
    success: boolean;
    result?: string;
    failedAt?: number;
    reason?: 'expect_failed' | 'step_error';
    error?: any;
}
