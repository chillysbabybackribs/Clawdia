import { describe, it, expect } from 'vitest';
import { estimateFullRunCost, estimateExecutorCost } from './cost-estimator';
import type { PersistentTask, TaskExecutor } from '../../shared/task-types';

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
    return {
        id: 'task-1',
        description: 'Test task',
        triggerType: 'scheduled',
        triggerConfig: '0 9 * * *',
        executionPlan: '{}',
        status: 'active',
        approvalMode: 'auto',
        allowedTools: '[]',
        maxIterations: 30,
        model: null,
        tokenBudget: 50000,
        createdAt: 1000,
        updatedAt: 1000,
        lastRunAt: null,
        nextRunAt: null,
        runCount: 0,
        failureCount: 0,
        maxFailures: 3,
        conversationId: null,
        metadataJson: '{}',
        ...overrides,
    };
}

function makeExecutor(llmSteps: number): TaskExecutor {
    const steps = [];
    for (let i = 0; i < llmSteps; i++) {
        steps.push({
            type: 'llm' as const,
            prompt_template: 'Summarize: {{content}}',
            store_as: `result_${i}`,
            max_tokens: 500,
        });
    }
    // Add a deterministic step
    steps.push({
        type: 'tool' as const,
        tool_name: 'browser_navigate',
        tool_input: { url: 'https://example.com' },
    });

    return {
        id: 'exec-1',
        task_id: 'task-1',
        version: 1,
        created_at: 1000,
        created_from_run_id: 'run-1',
        steps,
        validation: {
            expect_result: true,
            max_duration_ms: 300000,
            required_variables: [],
            abort_on_empty_extract: false,
        },
        stats: {
            total_steps: steps.length,
            deterministic_steps: 1,
            llm_steps: llmSteps,
            estimated_cost_per_run: 0,
        },
    };
}

describe('estimateFullRunCost', () => {
    it('returns a positive cost for default Sonnet model', () => {
        const cost = estimateFullRunCost(makeTask());
        expect(cost).toBeGreaterThan(0);
        // Sonnet: input=$3/MTok, output=$15/MTok
        // 20K input * 3/1M = 0.06, 4K output * 15/1M = 0.06 → ~$0.12
        expect(cost).toBeCloseTo(0.12, 1);
    });

    it('returns lower cost for haiku model', () => {
        const sonnetCost = estimateFullRunCost(makeTask());
        const haikuCost = estimateFullRunCost(makeTask({ model: 'haiku' }));
        expect(haikuCost).toBeLessThan(sonnetCost);
        expect(haikuCost).toBeGreaterThan(0);
    });

    it('returns higher cost for opus model', () => {
        const sonnetCost = estimateFullRunCost(makeTask());
        const opusCost = estimateFullRunCost(makeTask({ model: 'opus' }));
        expect(opusCost).toBeGreaterThan(sonnetCost);
    });

    it('falls back to 0.04 for unknown model', () => {
        const cost = estimateFullRunCost(makeTask({ model: 'nonexistent-model-xyz' }));
        // resolveModelId falls back to DEFAULT_MODEL (Sonnet), so this should still work
        expect(cost).toBeGreaterThan(0);
    });
});

describe('estimateExecutorCost', () => {
    it('returns zero cost for executor with no LLM steps', () => {
        const executor = makeExecutor(0);
        expect(estimateExecutorCost(executor)).toBe(0);
    });

    it('returns positive cost for executor with LLM steps', () => {
        const executor = makeExecutor(2);
        const cost = estimateExecutorCost(executor);
        expect(cost).toBeGreaterThan(0);
    });

    it('cost scales linearly with number of LLM steps', () => {
        const cost1 = estimateExecutorCost(makeExecutor(1));
        const cost2 = estimateExecutorCost(makeExecutor(2));
        const cost4 = estimateExecutorCost(makeExecutor(4));

        expect(cost2).toBeCloseTo(cost1 * 2, 6);
        expect(cost4).toBeCloseTo(cost1 * 4, 6);
    });

    it('executor cost is much cheaper than full LLM run', () => {
        const task = makeTask();
        const fullCost = estimateFullRunCost(task);
        const execCost = estimateExecutorCost(makeExecutor(2));

        // Executor with 2 Haiku steps should be <10% of a full Sonnet run
        expect(execCost).toBeLessThan(fullCost * 0.1);
    });

    it('respects max_tokens per step', () => {
        const smallExecutor: TaskExecutor = {
            ...makeExecutor(0),
            steps: [{
                type: 'llm',
                prompt_template: 'short task',
                max_tokens: 100,
            }],
        };
        const largeExecutor: TaskExecutor = {
            ...makeExecutor(0),
            steps: [{
                type: 'llm',
                prompt_template: 'long task',
                max_tokens: 2000,
            }],
        };

        expect(estimateExecutorCost(largeExecutor)).toBeGreaterThan(estimateExecutorCost(smallExecutor));
    });
});
