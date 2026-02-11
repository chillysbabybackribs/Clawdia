import { describe, it, expect } from 'vitest';
import { generateExecutor } from './executor-generator';
import type { PersistentTask, TraceStep } from '../../shared/task-types';

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
    return {
        id: 'task-1',
        description: 'Check HN for AI articles',
        triggerType: 'scheduled',
        triggerConfig: '0 9 * * *',
        executionPlan: '{"prompt":"Check HN"}',
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

function makeTrace(steps: Array<Partial<TraceStep>>): TraceStep[] {
    return steps.map((s, i) => ({
        index: i,
        tool_name: s.tool_name || 'browser_navigate',
        tool_input: s.tool_input || {},
        tool_result: s.tool_result || '',
        duration_ms: s.duration_ms || 100,
        was_llm_dependent: s.was_llm_dependent ?? false,
    }));
}

describe('generateExecutor', () => {
    it('generates an executor from a trace with deterministic steps', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', tool_input: { url: 'https://news.ycombinator.com' } },
            { tool_name: 'browser_extract', tool_input: { schema: { headlines: 'string[]' } }, tool_result: '["h1","h2"]' },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();
        expect(executor!.task_id).toBe('task-1');
        expect(executor!.created_from_run_id).toBe('run-1');
        expect(executor!.stats.deterministic_steps).toBe(2);
        expect(executor!.stats.llm_steps).toBe(1); // Final interpretation step
        expect(executor!.stats.estimated_cost_per_run).toBeGreaterThan(0);

        // Check step types
        const toolSteps = executor!.steps.filter(s => s.type === 'tool');
        expect(toolSteps).toHaveLength(2);
        expect(toolSteps[0].type === 'tool' && toolSteps[0].tool_name).toBe('browser_navigate');
        expect(toolSteps[1].type === 'tool' && toolSteps[1].tool_name).toBe('browser_extract');

        // Final LLM interpretation + result step
        const llmSteps = executor!.steps.filter(s => s.type === 'llm');
        expect(llmSteps).toHaveLength(1);
        const resultStep = executor!.steps.find(s => s.type === 'result');
        expect(resultStep).toBeTruthy();
    });

    it('converts LLM-dependent steps to llm type steps', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', tool_input: { url: 'https://news.ycombinator.com' }, was_llm_dependent: false },
            { tool_name: 'browser_read_page', tool_input: {}, was_llm_dependent: false, tool_result: 'Page content here...' },
            { tool_name: 'browser_extract', tool_input: { query: 'AI articles' }, was_llm_dependent: true },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();
        expect(executor!.stats.deterministic_steps).toBe(2);
        expect(executor!.stats.llm_steps).toBe(2); // 1 trace LLM + 1 final interpretation

        const llmSteps = executor!.steps.filter(s => s.type === 'llm');
        expect(llmSteps).toHaveLength(2);
        expect(executor!.stats.estimated_cost_per_run).toBeGreaterThan(0);
    });

    it('returns null for condition-triggered tasks', () => {
        const task = makeTask({ triggerType: 'condition' });
        const trace = makeTrace([
            { tool_name: 'browser_navigate' },
            { tool_name: 'browser_read_page' },
        ]);

        expect(generateExecutor(task, trace, 'run-1')).toBeNull();
    });

    it('returns null for one-time tasks', () => {
        const task = makeTask({ triggerType: 'one_time' });
        const trace = makeTrace([
            { tool_name: 'browser_navigate' },
            { tool_name: 'browser_read_page' },
        ]);

        expect(generateExecutor(task, trace, 'run-1')).toBeNull();
    });

    it('generates executor from single-step trace', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();
        expect(executor!.stats.deterministic_steps).toBe(1);
    });

    it('returns null for empty trace', () => {
        const task = makeTask();
        expect(generateExecutor(task, [], 'run-1')).toBeNull();
    });

    it('returns null when all steps are LLM-dependent', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_search', was_llm_dependent: true },
            { tool_name: 'browser_extract', was_llm_dependent: true },
            { tool_name: 'browser_read_page', was_llm_dependent: true },
        ]);

        expect(generateExecutor(task, trace, 'run-1')).toBeNull();
    });

    it('assigns store_as for result-bearing tools but not for others', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
            { tool_name: 'browser_click', tool_input: { ref: 'btn-1' } },
            { tool_name: 'browser_read_page', tool_input: {} },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();

        const toolSteps = executor!.steps.filter(s => s.type === 'tool');
        // browser_navigate IS result-bearing → has store_as
        expect(toolSteps[0].type === 'tool' && toolSteps[0].store_as).toBeTruthy();
        // browser_click is not result-bearing → no store_as
        expect(toolSteps[1].type === 'tool' && toolSteps[1].store_as).toBeUndefined();
        // browser_read_page IS result-bearing → has store_as
        expect(toolSteps[2].type === 'tool' && toolSteps[2].store_as).toBeTruthy();
    });

    it('includes a result step referencing the last stored variable', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
            { tool_name: 'browser_extract', tool_input: { schema: {} }, tool_result: 'data' },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();

        const resultStep = executor!.steps.find(s => s.type === 'result');
        expect(resultStep).toBeTruthy();
        expect(resultStep!.type === 'result' && resultStep!.template).toMatch(/\{\{final_answer\}\}/);
    });

    it('sets abort_on_empty_extract when browser_extract is in the trace', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate' },
            { tool_name: 'browser_extract' },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor!.validation.abort_on_empty_extract).toBe(true);
    });

    it('does not set abort_on_empty_extract when no extract in trace', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate' },
            { tool_name: 'browser_read_page' },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor!.validation.abort_on_empty_extract).toBe(false);
    });

    it('produces valid stats totals', () => {
        const task = makeTask();
        const trace = makeTrace([
            { tool_name: 'browser_navigate', was_llm_dependent: false },
            { tool_name: 'browser_read_page', was_llm_dependent: false },
            { tool_name: 'browser_extract', was_llm_dependent: true },
            { tool_name: 'shell_exec', was_llm_dependent: false },
        ]);

        const executor = generateExecutor(task, trace, 'run-1');
        expect(executor).not.toBeNull();
        expect(executor!.stats.deterministic_steps).toBe(3);
        expect(executor!.stats.llm_steps).toBe(2); // 1 trace LLM + 1 final interpretation
        // total_steps includes the result step too
        expect(executor!.stats.total_steps).toBe(executor!.steps.length);
    });
});
