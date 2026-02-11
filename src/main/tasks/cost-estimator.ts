
import { getModelConfig, resolveModelId } from '../../shared/models';
import type { PersistentTask, TaskExecutor } from '../../shared/task-types';

/**
 * Estimate the cost of a full LLM run based on typical browser task token usage.
 * Uses the task's configured model (or default Sonnet) pricing from ModelConfig.
 */
export function estimateFullRunCost(task: PersistentTask): number {
    const avgInputTokens = 20_000;
    const avgOutputTokens = 4_000;
    const modelId = resolveModelId(task.model || 'sonnet');
    const config = getModelConfig(modelId);
    if (!config) return 0.04;

    return (avgInputTokens * config.inputCostPerMTok / 1_000_000)
        + (avgOutputTokens * config.outputCostPerMTok / 1_000_000);
}

/**
 * Estimate cost of an executor run.
 * Only LLM steps cost money (Haiku). Deterministic tool steps are free.
 */
export function estimateExecutorCost(executor: TaskExecutor): number {
    const haikuConfig = getModelConfig(resolveModelId('haiku'));
    if (!haikuConfig) return 0.002;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const step of executor.steps) {
        if (step.type === 'llm') {
            totalInputTokens += 500;
            totalOutputTokens += (step.max_tokens || 500);
        }
    }

    return (totalInputTokens * haikuConfig.inputCostPerMTok / 1_000_000)
        + (totalOutputTokens * haikuConfig.outputCostPerMTok / 1_000_000);
}
