import { ToolLoopEmitter } from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { TraceStep } from '../../shared/task-types';

/**
 * A ToolLoopEmitter wrapper that forwards all IPC events to an inner emitter
 * (preserving normal UI behaviour) while also capturing an execution trace.
 *
 * This enables trace capture from interactive chat runs — the same data
 * that NullEmitter collects during headless execution, but without
 * suppressing the real renderer traffic.
 */
export class TracingEmitter implements ToolLoopEmitter {
    private readonly inner: ToolLoopEmitter;

    // ── Execution trace state ────────────────────────────────
    private executionTrace: TraceStep[] = [];
    private toolSequence: string[] = [];
    /** Partial trace entries keyed by tool ID, awaiting completion. */
    private pendingTraceEntries: Map<string, Partial<TraceStep> & { toolId: string }> = new Map();
    /** Text emitted by the LLM since the last TOOL_EXEC_COMPLETE. */
    private textSinceLastToolComplete = '';
    /** Whether we've seen at least one tool complete (for first-tool detection). */
    private seenFirstToolComplete = false;
    private traceIndex = 0;

    constructor(inner: ToolLoopEmitter) {
        this.inner = inner;
    }

    send(channel: string, ...args: any[]): void {
        // Forward to inner emitter first so the UI stays live.
        this.inner.send(channel, ...args);

        // ── Trace capture: accumulate streamed text ──
        if (channel === IPC_EVENTS.CHAT_STREAM_TEXT && typeof args[0] === 'string') {
            this.textSinceLastToolComplete += args[0];
        }

        // ── Trace capture: TOOL_EXEC_START ──
        if (channel === IPC_EVENTS.TOOL_EXEC_START && args[0]) {
            const event = args[0] as { toolName: string; toolId: string; args: Record<string, unknown> };
            // Determine LLM-dependency: did the LLM emit reasoning text since the last tool completed?
            const hadReasoningText = this.seenFirstToolComplete
                && this.textSinceLastToolComplete.trim().length > 0;
            this.pendingTraceEntries.set(event.toolId, {
                toolId: event.toolId,
                tool_name: event.toolName,
                tool_input: event.args as Record<string, any>,
                was_llm_dependent: hadReasoningText,
            });
        }

        // ── Trace capture: CHAT_TOOL_ACTIVITY (completion) ──
        if (channel === IPC_EVENTS.CHAT_TOOL_ACTIVITY && args[0]) {
            const entry = args[0] as {
                id: string;
                name: string;
                input: Record<string, unknown>;
                status: string;
                durationMs?: number;
                resultPreview?: string;
            };

            if (entry.status === 'success' || entry.status === 'error') {
                const pending = this.pendingTraceEntries.get(entry.id);
                if (pending) {
                    const step: TraceStep = {
                        index: this.traceIndex++,
                        tool_name: pending.tool_name || entry.name,
                        tool_input: (pending.tool_input || entry.input) as Record<string, any>,
                        tool_result: entry.resultPreview || '',
                        duration_ms: entry.durationMs || 0,
                        was_llm_dependent: pending.was_llm_dependent ?? false,
                    };
                    this.executionTrace.push(step);
                    this.toolSequence.push(step.tool_name);
                    this.pendingTraceEntries.delete(entry.id);
                }
            }
        }

        // ── Trace capture: TOOL_EXEC_COMPLETE — reset text accumulator ──
        if (channel === IPC_EVENTS.TOOL_EXEC_COMPLETE) {
            this.textSinceLastToolComplete = '';
            this.seenFirstToolComplete = true;
        }
    }

    isDestroyed(): boolean {
        return this.inner.isDestroyed();
    }

    /** Get the full execution trace (returns a copy). */
    getExecutionTrace(): TraceStep[] {
        return [...this.executionTrace];
    }

    /** Get the ordered list of tool names invoked (returns a copy). */
    getToolSequence(): string[] {
        return [...this.toolSequence];
    }
}
