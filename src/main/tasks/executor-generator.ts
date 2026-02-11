
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { getModelConfig, resolveModelId } from '../../shared/models';
import type {
    PersistentTask,
    TraceStep,
    TaskExecutor,
    ExecutorStep,
    ExecutorValidation,
} from '../../shared/task-types';

const log = createLogger('executor-generator');

/** Tools that produce results worth storing as variables for later steps. */
const RESULT_BEARING_TOOLS = new Set([
    'browser_navigate',
    'browser_read_page',
    'browser_extract',
    'browser_visual_extract',
    'browser_search',
    'browser_search_rich',
    'browser_news',
    'browser_shopping',
    'browser_places',
    'browser_images',
    'browser_batch',
    'browser_read_tabs',
    'file_read',
    'cache_read',
    'shell_exec',
]);

/**
 * Analyze an execution trace from a successful task run and generate
 * a replayable executor. Returns null if the task shouldn't be cached.
 */
export function generateExecutor(
    task: PersistentTask,
    trace: TraceStep[],
    runId: string,
): TaskExecutor | null {
    // ── Exclusion checks (Part I) ────────────────────────────
    if (task.triggerType === 'condition') {
        log.info(`[ExecGen] Skipping: task ${task.id} is condition-triggered`);
        return null;
    }
    if (task.triggerType === 'one_time') {
        log.info(`[ExecGen] Skipping: task ${task.id} is one-time`);
        return null;
    }
    if (trace.length < 1) {
        log.info(`[ExecGen] Skipping: task ${task.id} has no trace steps`);
        return null;
    }
    if (trace.every(s => s.was_llm_dependent)) {
        log.info(`[ExecGen] Skipping: task ${task.id} — all ${trace.length} steps are LLM-dependent`);
        return null;
    }

    // ── Build executor steps ─────────────────────────────────
    const steps: ExecutorStep[] = [];
    const resultVars: Map<number, string> = new Map(); // traceIndex → variable name
    let deterministicCount = 0;
    let llmCount = 0;

    for (const traceStep of trace) {
        if (traceStep.was_llm_dependent) {
            // LLM-dependent step: convert to an LLM step with a prompt template
            const varName = `step_${traceStep.index}_result`;
            const promptTemplate = buildLlmPromptTemplate(traceStep, resultVars);
            steps.push({
                type: 'llm',
                prompt_template: promptTemplate,
                store_as: varName,
                max_tokens: 1000,
            });
            resultVars.set(traceStep.index, varName);
            llmCount++;
        } else {
            // Deterministic step: replay the exact tool call
            const varName = RESULT_BEARING_TOOLS.has(traceStep.tool_name)
                ? `step_${traceStep.index}_result`
                : undefined;

            // Interpolate any references to previous step outputs
            const toolInput = interpolateReferences(traceStep.tool_input, resultVars, trace);

            steps.push({
                type: 'tool',
                tool_name: traceStep.tool_name,
                tool_input: toolInput,
                store_as: varName,
            });

            if (varName) resultVars.set(traceStep.index, varName);
            deterministicCount++;
        }
    }

    // Add a final LLM interpretation step + result.
    // The original LLM run ended with the model reading tool output and producing
    // a natural-language answer. We replicate that with a cheap Haiku call.
    const lastVar = findLastStoredVar(resultVars);
    if (lastVar) {
        const summaryVar = 'final_answer';
        steps.push({
            type: 'llm',
            prompt_template: `Task: ${task.description}\n\nData collected:\n{{${lastVar}}}\n\nBased on the data above, provide a concise answer to the task. Be direct and brief.`,
            store_as: summaryVar,
            max_tokens: 500,
        });
        llmCount++;
        steps.push({
            type: 'result',
            template: `{{${summaryVar}}}`,
        });
    }

    // ── Cost estimation ──────────────────────────────────────
    const haikuConfig = getModelConfig(resolveModelId('haiku'));
    let estimatedCost = 0;
    if (haikuConfig) {
        for (const step of steps) {
            if (step.type === 'llm') {
                const inputTokens = 500;
                const outputTokens = step.max_tokens || 500;
                estimatedCost += (inputTokens * haikuConfig.inputCostPerMTok / 1_000_000)
                    + (outputTokens * haikuConfig.outputCostPerMTok / 1_000_000);
            }
        }
    }

    // ── Build validation ─────────────────────────────────────
    const validation: ExecutorValidation = {
        expect_result: true,
        max_duration_ms: 5 * 60 * 1000, // 5 minutes
        required_variables: lastVar ? [lastVar] : [],
        abort_on_empty_extract: trace.some(s => s.tool_name === 'browser_extract'),
    };

    const executor: TaskExecutor = {
        id: randomUUID(),
        task_id: task.id,
        version: 1, // Will be incremented by saveExecutor if superseding
        created_at: Math.floor(Date.now() / 1000),
        created_from_run_id: runId,
        steps,
        validation,
        stats: {
            total_steps: steps.length,
            deterministic_steps: deterministicCount,
            llm_steps: llmCount,
            estimated_cost_per_run: estimatedCost,
        },
    };

    log.info(`[ExecGen] Generated executor for task ${task.id}: ${deterministicCount} deterministic, ${llmCount} LLM, est. $${estimatedCost.toFixed(4)}/run`);
    return executor;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Build a Haiku prompt template for an LLM-dependent step.
 * Includes references to previous step results via {{variable}} syntax.
 */
function buildLlmPromptTemplate(
    step: TraceStep,
    resultVars: Map<number, string>,
): string {
    // Gather variable references from earlier steps
    const refs: string[] = [];
    for (const [idx, varName] of resultVars) {
        if (idx < step.index) {
            refs.push(`Previous step result (${varName}): {{${varName}}}`);
        }
    }

    const context = refs.length > 0 ? refs.join('\n') + '\n\n' : '';

    // Build a prompt that describes what the LLM was asked to do
    const toolDesc = step.tool_name
        ? `The next action should use ${step.tool_name} with appropriate parameters.`
        : '';
    const inputDesc = Object.keys(step.tool_input).length > 0
        ? `Parameters to decide: ${JSON.stringify(step.tool_input)}`
        : '';

    return `${context}Given the above context, determine the appropriate action.\n${toolDesc}\n${inputDesc}\nProvide just the result or the parameter values needed.`.trim();
}

/**
 * Replace string values in tool_input that reference previous step results
 * with {{variable}} template syntax, enabling cross-step data flow.
 *
 * Only replaces exact full-value matches (or URL matches) to avoid false positives.
 * Skips results that appear truncated (exactly 200 chars — the TraceStep limit).
 * Prefers the most recent matching step when multiple steps produce the same value.
 */
function interpolateReferences(
    input: Record<string, any>,
    resultVars: Map<number, string>,
    traceSteps?: TraceStep[],
): Record<string, any> {
    if (!traceSteps || resultVars.size === 0) return { ...input };

    // Build lookup: variable name → tool_result, only for steps with store_as.
    // Collect in index order so we can prefer the most recent match.
    const varResults: Array<{ varName: string; result: string; index: number }> = [];
    for (const [idx, varName] of resultVars) {
        const trace = traceSteps.find(s => s.index === idx);
        if (!trace) continue;
        const res = trace.tool_result;
        // Skip if the result was likely truncated (exactly 200 chars = TraceStep cap)
        if (!res || res.length === 200) continue;
        varResults.push({ varName, result: res, index: idx });
    }

    if (varResults.length === 0) return { ...input };

    function replaceValue(value: any): any {
        if (typeof value === 'string' && value.length > 0) {
            // Try exact full-value match against previous results (most recent first)
            let bestMatch: { varName: string; index: number } | null = null;
            for (const entry of varResults) {
                if (value === entry.result) {
                    if (!bestMatch || entry.index > bestMatch.index) {
                        bestMatch = entry;
                    }
                }
            }
            if (bestMatch) return `{{${bestMatch.varName}}}`;
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(item => replaceValue(item));
        }
        if (typeof value === 'object' && value !== null) {
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = replaceValue(v);
            }
            return out;
        }
        return value;
    }

    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) {
        result[k] = replaceValue(v);
    }
    return result;
}

/** Find the variable name of the last step that stored a result. */
function findLastStoredVar(resultVars: Map<number, string>): string | undefined {
    let lastIdx = -1;
    let lastVar: string | undefined;
    for (const [idx, varName] of resultVars) {
        if (idx > lastIdx) {
            lastIdx = idx;
            lastVar = varName;
        }
    }
    return lastVar;
}
