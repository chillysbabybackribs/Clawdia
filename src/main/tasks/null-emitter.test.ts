import { describe, it, expect, beforeEach } from 'vitest';
import { NullEmitter } from './null-emitter';
import { IPC_EVENTS } from '../../shared/ipc-channels';

describe('NullEmitter trace capture', () => {
    let emitter: NullEmitter;

    beforeEach(() => {
        emitter = new NullEmitter();
    });

    it('captures a single deterministic tool call', () => {
        // Simulate: LLM immediately calls a tool (no reasoning text)
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
            timestamp: Date.now(),
        });

        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success',
            startedAt: Date.now() - 200,
            completedAt: Date.now(),
            durationMs: 200,
            resultPreview: 'Navigated to example.com',
        });

        emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
            toolId: 'tool-1',
            status: 'success',
            duration: 200,
            summary: 'Navigated to example.com',
        });

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].index).toBe(0);
        expect(trace[0].tool_name).toBe('browser_navigate');
        expect(trace[0].tool_input).toEqual({ url: 'https://example.com' });
        expect(trace[0].tool_result).toBe('Navigated to example.com');
        expect(trace[0].duration_ms).toBe(200);
        expect(trace[0].was_llm_dependent).toBe(false);
    });

    it('detects LLM-dependent steps when reasoning text is emitted', () => {
        // First tool (deterministic)
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://news.ycombinator.com' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://news.ycombinator.com' },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 150,
            resultPreview: 'Page loaded',
        });
        emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
            toolId: 'tool-1',
            status: 'success',
            duration: 150,
            summary: 'Page loaded',
        });

        // LLM emits reasoning text between tool calls
        emitter.send(IPC_EVENTS.CHAT_STREAM_TEXT, 'Let me analyze the page content and extract the headlines...');

        // Second tool (LLM-dependent — reasoning text was emitted)
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_extract',
            toolId: 'tool-2',
            args: { schema: { headlines: 'string[]' } },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-2',
            name: 'browser_extract',
            input: { schema: { headlines: 'string[]' } },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 340,
            resultPreview: '["Headline 1", "Headline 2"]',
        });
        emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
            toolId: 'tool-2',
            status: 'success',
            duration: 340,
            summary: '["Headline 1", "Headline 2"]',
        });

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(2);
        expect(trace[0].was_llm_dependent).toBe(false);
        expect(trace[1].was_llm_dependent).toBe(true);
    });

    it('marks first tool as not LLM-dependent even if there is initial text', () => {
        // LLM says something before the first tool call
        emitter.send(IPC_EVENTS.CHAT_STREAM_TEXT, 'I will navigate to the page now.');

        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 100,
            resultPreview: 'Done',
        });
        emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
            toolId: 'tool-1',
            status: 'success',
            duration: 100,
            summary: 'Done',
        });

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(1);
        // First tool is never LLM-dependent (no previous TOOL_EXEC_COMPLETE)
        expect(trace[0].was_llm_dependent).toBe(false);
    });

    it('consecutive tools without reasoning text are all deterministic', () => {
        for (let i = 1; i <= 3; i++) {
            emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
                toolName: `browser_click`,
                toolId: `tool-${i}`,
                args: { ref: `btn-${i}` },
                timestamp: Date.now(),
            });
            emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
                id: `tool-${i}`,
                name: 'browser_click',
                input: { ref: `btn-${i}` },
                status: 'success',
                startedAt: Date.now(),
                durationMs: 50,
                resultPreview: 'Clicked',
            });
            emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
                toolId: `tool-${i}`,
                status: 'success',
                duration: 50,
                summary: 'Clicked',
            });
        }

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(3);
        expect(trace.every(s => s.was_llm_dependent === false)).toBe(true);
    });

    it('only whitespace between tools does not count as reasoning', () => {
        // First tool
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 100,
            resultPreview: 'Done',
        });
        emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {
            toolId: 'tool-1',
            status: 'success',
            duration: 100,
            summary: 'Done',
        });

        // Only whitespace/newlines emitted
        emitter.send(IPC_EVENTS.CHAT_STREAM_TEXT, '  \n  ');

        // Second tool
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_read_page',
            toolId: 'tool-2',
            args: {},
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-2',
            name: 'browser_read_page',
            input: {},
            status: 'success',
            startedAt: Date.now(),
            durationMs: 200,
            resultPreview: 'Page content...',
        });

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(2);
        expect(trace[1].was_llm_dependent).toBe(false);
    });

    it('ignores running/skipped status entries (only captures success/error)', () => {
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
            timestamp: Date.now(),
        });

        // Running status — should not create a trace entry
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'running',
            startedAt: Date.now(),
        });

        // Not yet completed
        expect(emitter.getExecutionTrace()).toHaveLength(0);

        // Now success
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 100,
            resultPreview: 'Done',
        });

        expect(emitter.getExecutionTrace()).toHaveLength(1);
    });

    it('captures error tool results in trace', () => {
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_click',
            toolId: 'tool-1',
            args: { ref: 'missing-element' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_click',
            input: { ref: 'missing-element' },
            status: 'error',
            startedAt: Date.now(),
            durationMs: 50,
            error: 'Element not found',
        });

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].tool_name).toBe('browser_click');
        expect(trace[0].tool_result).toBe(''); // No resultPreview on errors
    });

    it('returns a defensive copy from getExecutionTrace', () => {
        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'shell_exec',
            toolId: 'tool-1',
            args: { command: 'echo hello' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'shell_exec',
            input: { command: 'echo hello' },
            status: 'success',
            startedAt: Date.now(),
            durationMs: 10,
            resultPreview: 'hello',
        });

        const trace1 = emitter.getExecutionTrace();
        const trace2 = emitter.getExecutionTrace();
        expect(trace1).not.toBe(trace2);
        expect(trace1).toEqual(trace2);
    });

    it('still tracks toolCallCount and tokens alongside trace', () => {
        emitter.send(IPC_EVENTS.TOKEN_USAGE_UPDATE, {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 200,
        });

        emitter.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate',
            toolId: 'tool-1',
            args: { url: 'https://example.com' },
            timestamp: Date.now(),
        });
        emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1',
            name: 'browser_navigate',
            input: {},
            status: 'success',
            startedAt: Date.now(),
            durationMs: 100,
            resultPreview: 'Done',
        });

        const summary = emitter.getSummary();
        expect(summary.toolCallCount).toBe(1);
        expect(summary.inputTokens).toBe(500);
        expect(summary.outputTokens).toBe(100);

        const trace = emitter.getExecutionTrace();
        expect(trace).toHaveLength(1);
    });
});
