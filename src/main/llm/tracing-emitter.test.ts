import { describe, it, expect, vi } from 'vitest';
import { TracingEmitter } from './tracing-emitter';
import { IPC_EVENTS } from '../../shared/ipc-channels';

describe('TracingEmitter', () => {
    it('forwards all send() calls to the inner emitter', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);
        tracing.send('test:channel', 'arg1', 'arg2');
        expect(inner.send).toHaveBeenCalledWith('test:channel', 'arg1', 'arg2');
    });

    it('delegates isDestroyed() to the inner emitter', () => {
        const inner = { send: vi.fn(), isDestroyed: () => true };
        const tracing = new TracingEmitter(inner);
        expect(tracing.isDestroyed()).toBe(true);
    });

    it('captures execution trace from IPC events', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        tracing.send(IPC_EVENTS.TOOL_EXEC_START, {
            toolName: 'browser_navigate', toolId: 'tool-1',
            args: { url: 'https://example.com' },
        });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, {
            id: 'tool-1', name: 'browser_navigate',
            input: { url: 'https://example.com' },
            status: 'success', durationMs: 500, resultPreview: 'Page loaded',
        });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        const trace = tracing.getExecutionTrace();
        expect(trace).toHaveLength(1);
        expect(trace[0].tool_name).toBe('browser_navigate');
        expect(trace[0].tool_input).toEqual({ url: 'https://example.com' });
        expect(trace[0].was_llm_dependent).toBe(false);
    });

    it('marks steps as LLM-dependent when text is emitted between tools', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        // First tool
        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_navigate', toolId: 't1', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't1', name: 'browser_navigate', input: {}, status: 'success', durationMs: 100 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        // LLM emits reasoning text
        tracing.send(IPC_EVENTS.CHAT_STREAM_TEXT, 'Let me extract the data now...');

        // Second tool (should be marked LLM-dependent)
        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_extract', toolId: 't2', args: { selector: '.title' } });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't2', name: 'browser_extract', input: { selector: '.title' }, status: 'success', durationMs: 200 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        const trace = tracing.getExecutionTrace();
        expect(trace).toHaveLength(2);
        expect(trace[0].was_llm_dependent).toBe(false);
        expect(trace[1].was_llm_dependent).toBe(true);
    });

    it('returns tool sequence names', () => {
        const inner = { send: vi.fn(), isDestroyed: () => false };
        const tracing = new TracingEmitter(inner);

        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_navigate', toolId: 't1', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't1', name: 'browser_navigate', input: {}, status: 'success', durationMs: 100 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        tracing.send(IPC_EVENTS.TOOL_EXEC_START, { toolName: 'browser_extract', toolId: 't2', args: {} });
        tracing.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, { id: 't2', name: 'browser_extract', input: {}, status: 'success', durationMs: 200 });
        tracing.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, {});

        expect(tracing.getToolSequence()).toEqual(['browser_navigate', 'browser_extract']);
    });
});
