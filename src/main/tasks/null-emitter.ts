
import { ToolLoopEmitter } from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { TraceStep } from '../../shared/task-types';

export interface CapturedEmission {
    channel: string;
    args: any[];
    timestamp: number;
}

/**
 * A ToolLoopEmitter that captures all IPC emissions in memory
 * instead of sending them to a renderer window.
 * Used by HeadlessToolRunner for background task execution.
 */
export class NullEmitter implements ToolLoopEmitter {
    readonly captured: CapturedEmission[] = [];
    finalResponse = '';
    streamedText = '';
    toolCallCount = 0;
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;

    // ── Execution trace capture ──────────────────────────────
    private executionTrace: TraceStep[] = [];
    /** Partial trace entries keyed by tool ID, awaiting completion. */
    private pendingTraceEntries: Map<string, Partial<TraceStep> & { toolId: string }> = new Map();
    /** Text emitted by the LLM since the last TOOL_EXEC_COMPLETE. */
    private textSinceLastToolComplete = '';
    /** Whether we've seen at least one tool complete (for first-tool detection). */
    private seenFirstToolComplete = false;
    private traceIndex = 0;

    send(channel: string, ...args: any[]): void {
        this.captured.push({ channel, args, timestamp: Date.now() });

        // Capture streamed text fragments
        if (channel === IPC_EVENTS.CHAT_STREAM_TEXT && typeof args[0] === 'string') {
            this.streamedText += args[0];
            this.textSinceLastToolComplete += args[0];
        }

        // Capture the final complete response
        if (channel === IPC_EVENTS.CHAT_STREAM_END && typeof args[0] === 'string') {
            this.finalResponse = args[0];
        }

        // Track token usage
        if (channel === IPC_EVENTS.TOKEN_USAGE_UPDATE && args[0]) {
            const data = args[0];
            this.inputTokens += (data.inputTokens || 0);
            this.outputTokens += (data.outputTokens || 0);
            this.cacheReadTokens += (data.cacheReadTokens || 0);
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
                this.toolCallCount++;
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
        return false;
    }

    /** Get a summary of what was captured. */
    getSummary(): {
        finalResponse: string;
        toolCallCount: number;
        inputTokens: number;
        outputTokens: number;
        emissionCount: number;
    } {
        return {
            finalResponse: this.finalResponse || this.streamedText,
            toolCallCount: this.toolCallCount,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            emissionCount: this.captured.length,
        };
    }

    /** Get the full execution trace for executor generation. */
    getExecutionTrace(): TraceStep[] {
        return [...this.executionTrace];
    }
}
