import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorRunner } from './executor-runner';
import type { TaskExecutor, ExecutorStep } from '../../shared/task-types';

// Mock browser tools
vi.mock('../browser/tools', () => ({
    executeTool: vi.fn(async (name: string, input: any) => {
        if (name === 'browser_navigate') return `Navigated to ${input.url}`;
        if (name === 'browser_read_page') return 'Page content: Hello World headlines here';
        if (name === 'browser_extract') return JSON.stringify(['headline1', 'headline2', 'headline3']);
        return `Result from ${name}`;
    }),
}));

// Mock local tools
vi.mock('../local/tools', () => ({
    executeLocalTool: vi.fn(async (name: string, input: any) => {
        if (name === 'shell_exec') return `Output of: ${input.command}`;
        if (name === 'file_read') return `Contents of ${input.path}`;
        return `Local result from ${name}`;
    }),
}));

// Mock logger
vi.mock('../logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

function makeMockClient() {
    return {
        complete: vi.fn(async (messages: any[], options: any) => ({
            text: 'Haiku summary: filtered to 2 AI articles',
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        })),
    } as any;
}

function makeExecutor(steps: ExecutorStep[]): TaskExecutor {
    return {
        id: 'exec-1',
        task_id: 'task-1',
        version: 1,
        created_at: 1000,
        created_from_run_id: 'run-1',
        steps,
        validation: {
            expect_result: true,
            max_duration_ms: 30000,
            required_variables: [],
            abort_on_empty_extract: false,
        },
        stats: {
            total_steps: steps.length,
            deterministic_steps: steps.filter(s => s.type === 'tool').length,
            llm_steps: steps.filter(s => s.type === 'llm').length,
            estimated_cost_per_run: 0.002,
        },
    };
}

describe('ExecutorRunner', () => {
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
        client = makeMockClient();
        vi.clearAllMocks();
    });

    it('executes a simple tool-only executor', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' }, store_as: 'nav_result' },
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {}, store_as: 'page_content' },
            { type: 'result', template: '{{page_content}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        expect(result.result).toBe('Page content: Hello World headlines here');
    });

    it('executes LLM steps with Haiku', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://news.ycombinator.com' } },
            { type: 'tool', tool_name: 'browser_extract', tool_input: { schema: {} }, store_as: 'headlines' },
            { type: 'llm', prompt_template: 'Filter these headlines for AI: {{headlines}}', store_as: 'filtered', max_tokens: 500 },
            { type: 'result', template: '{{filtered}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        expect(result.result).toBe('Haiku summary: filtered to 2 AI articles');
        expect(client.complete).toHaveBeenCalledOnce();

        // Verify the prompt was interpolated with the headlines variable
        const callArgs = client.complete.mock.calls[0];
        expect(callArgs[0][0].content).toContain('["headline1","headline2","headline3"]');
    });

    it('routes shell_exec to executeLocalTool', async () => {
        const { executeLocalTool } = await import('../local/tools');

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'shell_exec', tool_input: { command: 'echo hello' }, store_as: 'output' },
            { type: 'result', template: '{{output}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        expect(result.result).toBe('Output of: echo hello');
        expect(executeLocalTool).toHaveBeenCalledWith('shell_exec', { command: 'echo hello' });
    });

    it('routes browser_* to executeTool', async () => {
        const { executeTool } = await import('../browser/tools');

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
        ]);

        const runner = new ExecutorRunner(client);
        await runner.run(executor);

        expect(executeTool).toHaveBeenCalledWith('browser_navigate', { url: 'https://example.com' }, null);
    });

    it('interpolates variables in tool inputs', async () => {
        const { executeTool } = await import('../browser/tools');

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' }, store_as: 'nav' },
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: '{{nav}}/page2' } },
        ]);

        const runner = new ExecutorRunner(client);
        await runner.run(executor);

        // Second call should have interpolated the variable
        expect(executeTool).toHaveBeenCalledTimes(2);
        const secondCall = (executeTool as any).mock.calls[1];
        expect(secondCall[1].url).toBe('Navigated to https://example.com/page2');
    });

    it('returns failure when a tool throws (after retry exhaustion)', async () => {
        const { executeTool } = await import('../browser/tools');
        // Both attempts must fail to exhaust retries
        (executeTool as any)
            .mockRejectedValueOnce(new Error('Selector not found'))
            .mockRejectedValueOnce(new Error('Selector not found'));

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://broken.com' } },
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {} },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(false);
        expect(result.failedAt).toBe(0);
        expect(result.reason).toBe('step_error');
    });

    it('returns failure when expect condition fails', async () => {
        const executor = makeExecutor([
            {
                type: 'tool',
                tool_name: 'browser_read_page',
                tool_input: {},
                store_as: 'content',
                expect: { contains_text: 'NONEXISTENT_TEXT_XYZ' },
            },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(false);
        expect(result.failedAt).toBe(0);
        expect(result.reason).toBe('expect_failed');
    });

    it('passes expect condition when text is found', async () => {
        const executor = makeExecutor([
            {
                type: 'tool',
                tool_name: 'browser_read_page',
                tool_input: {},
                store_as: 'content',
                expect: { contains_text: 'Hello World' },
            },
            { type: 'result', template: '{{content}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
    });

    it('handles condition step with abort', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {}, store_as: 'content' },
            { type: 'condition', expression: '{{missing_var}} != empty', on_true: 'abort', message: 'No data found' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('step_error');
    });

    it('condition passes when variable exists', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {}, store_as: 'content' },
            { type: 'condition', expression: '{{content}} != empty', on_true: 'continue' },
            { type: 'result', template: '{{content}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
    });

    it('uses fallback result when no result step exists', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' } },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        expect(result.result).toBe('Task completed');
    });

    it('uses summary variable as fallback when available', async () => {
        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {}, store_as: 'summary' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        expect(result.result).toBe('Page content: Hello World headlines here');
    });

    it('handles min_results expect with JSON array', async () => {
        const executor = makeExecutor([
            {
                type: 'tool',
                tool_name: 'browser_extract',
                tool_input: { schema: {} },
                store_as: 'items',
                expect: { min_results: 2 },
            },
            { type: 'result', template: '{{items}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        // browser_extract mock returns 3 items, min is 2 → passes
        expect(result.success).toBe(true);
    });

    it('fails min_results when array is too small', async () => {
        const { executeTool } = await import('../browser/tools');
        (executeTool as any).mockResolvedValueOnce(JSON.stringify(['only_one']));

        const executor = makeExecutor([
            {
                type: 'tool',
                tool_name: 'browser_extract',
                tool_input: { schema: {} },
                expect: { min_results: 5 },
            },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('expect_failed');
    });
});

describe('ExecutorRunner retry logic', () => {
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
        client = makeMockClient();
        vi.clearAllMocks();
    });

    it('retries a failed step once before succeeding', async () => {
        const { executeTool } = await import('../browser/tools');

        // First call fails, second call (retry) succeeds via default mock
        (executeTool as any).mockRejectedValueOnce(new Error('Transient network error'));

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://example.com' }, store_as: 'nav' },
            { type: 'result', template: '{{nav}}' },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(true);
        // executeTool should have been called twice for the first step (1 failure + 1 retry success)
        expect(executeTool).toHaveBeenCalledTimes(2);
    });

    it('aborts after retry exhaustion (2 failures)', async () => {
        const { executeTool } = await import('../browser/tools');

        // Both attempts fail
        (executeTool as any)
            .mockRejectedValueOnce(new Error('Persistent failure'))
            .mockRejectedValueOnce(new Error('Persistent failure'));

        const executor = makeExecutor([
            { type: 'tool', tool_name: 'browser_navigate', tool_input: { url: 'https://broken.com' } },
            { type: 'tool', tool_name: 'browser_read_page', tool_input: {} },
        ]);

        const runner = new ExecutorRunner(client);
        const result = await runner.run(executor);

        expect(result.success).toBe(false);
        expect(result.failedAt).toBe(0);
        expect(result.reason).toBe('step_error');
    });
});
