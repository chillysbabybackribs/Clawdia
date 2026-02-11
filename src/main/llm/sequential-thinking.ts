// ============================================================================
// SEQUENTIAL THINKING TOOL
// ============================================================================
//
// Native implementation of Anthropic's MCP sequential thinking server.
// Provides a structured scratchpad for the LLM to externalize reasoning
// before acting on complex, ambiguous, or destructive operations.
//
// State is per-SequentialThinkingState instance (one per ToolLoop).

import { createLogger } from '../logger';

const log = createLogger('sequential-thinking');

// ---------------------------------------------------------------------------
// Tool definition — matches MCP server's `sequential_thinking` schema exactly
// ---------------------------------------------------------------------------

export const SEQUENTIAL_THINKING_TOOL_DEFINITION = {
  name: 'sequential_thinking',
  description:
    'MANDATORY reasoning tool. You MUST call this BEFORE any other tool when a request involves: ' +
    '(1) Multiple files or components that could affect each other, ' +
    '(2) Refactoring, reorganizing, or restructuring existing code/UI, ' +
    '(3) Any operation the user asks you to "assess", "evaluate", "plan", or "consider", ' +
    '(4) Requests with multiple possible approaches, ' +
    '(5) Destructive or irreversible operations (delete, overwrite, rename). ' +
    'Call this tool FIRST to structure your thinking, THEN investigate with file_read/directory_tree, THEN act. ' +
    'Do NOT use for: simple factual questions, single file reads, direct navigation, or explicit single-step instructions. ' +
    'Each thought can build on, revise, or branch from previous thoughts. ' +
    'You can adjust totalThoughts as your understanding evolves.',
  input_schema: {
    type: 'object' as const,
    properties: {
      thought: {
        type: 'string',
        description: 'Your current thinking step',
      },
      nextThoughtNeeded: {
        type: 'boolean',
        description: 'Whether another thought step is needed',
      },
      thoughtNumber: {
        type: 'integer',
        description: 'Current thought number (starting from 1)',
      },
      totalThoughts: {
        type: 'integer',
        description: 'Estimated total thoughts needed (can be adjusted)',
      },
      isRevision: {
        type: 'boolean',
        description: 'Whether this revises a previous thought',
      },
      revisesThought: {
        type: 'integer',
        description: 'Which thought number is being reconsidered',
      },
      branchFromThought: {
        type: 'integer',
        description: 'Branching point thought number',
      },
      branchId: {
        type: 'string',
        description: 'Branch identifier',
      },
      needsMoreThoughts: {
        type: 'boolean',
        description: 'If more thoughts are needed beyond totalThoughts',
      },
    },
    required: ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts'],
  },
};

// ---------------------------------------------------------------------------
// Per-run state — now encapsulated in a class for concurrency safety
// ---------------------------------------------------------------------------

interface ThoughtEntry {
  thoughtNumber: number;
  thought: string;
  isRevision: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
}

interface SequentialThinkingInput {
  thought: string;
  nextThoughtNeeded: boolean;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
}

/**
 * Per-ToolLoop sequential thinking state.
 * Each ToolLoop creates one instance so concurrent loops don't share state.
 */
export class SequentialThinkingState {
  private thoughtHistory: ThoughtEntry[] = [];
  private branches: Set<string> = new Set();

  reset(): void {
    this.thoughtHistory = [];
    this.branches = new Set();
  }

  execute(input: Record<string, unknown>): string {
    const {
      thought,
      nextThoughtNeeded,
      thoughtNumber,
      totalThoughts,
      isRevision,
      revisesThought,
      branchFromThought,
      branchId,
    } = input as unknown as SequentialThinkingInput;

    if (!thought || typeof thought !== 'string') {
      return JSON.stringify({ error: 'thought is required and must be a string' });
    }
    const safeThoughtNumber = Number.isFinite(thoughtNumber) ? Math.max(1, Math.floor(thoughtNumber)) : 1;
    const safeTotalThoughts = Number.isFinite(totalThoughts) ? Math.max(1, Math.floor(totalThoughts)) : 1;

    if (branchId && branchFromThought) {
      this.branches.add(branchId);
    }

    const entry: ThoughtEntry = {
      thoughtNumber: safeThoughtNumber,
      thought,
      isRevision: isRevision ?? false,
      revisesThought,
      branchFromThought,
      branchId,
    };
    this.thoughtHistory.push(entry);

    const prefix = isRevision
      ? `[revision of #${revisesThought}]`
      : branchId
        ? `[branch: ${branchId} from #${branchFromThought}]`
        : '';
    log.debug(
      `Thought ${safeThoughtNumber}/${safeTotalThoughts} ${prefix}: ${thought.slice(0, 120)}${thought.length > 120 ? '...' : ''}`,
    );

    return JSON.stringify({
      thoughtNumber: safeThoughtNumber,
      totalThoughts: Math.max(safeTotalThoughts, safeThoughtNumber),
      nextThoughtNeeded,
      branches: Array.from(this.branches),
      thoughtHistoryLength: this.thoughtHistory.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy module-level API — delegates to a default instance for backward compat
// ---------------------------------------------------------------------------

const _defaultState = new SequentialThinkingState();

export function executeSequentialThinking(input: Record<string, unknown>): string {
  return _defaultState.execute(input);
}

export function resetSequentialThinking(): void {
  _defaultState.reset();
}
