// ============================================================================
// SEQUENTIAL THINKING TOOL
// ============================================================================
//
// Native implementation of Anthropic's MCP sequential thinking server.
// Provides a structured scratchpad for the LLM to externalize reasoning
// before acting on complex, ambiguous, or destructive operations.
//
// State is ephemeral per-run (reset at each ToolLoop.run() call).

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
// Per-run state (ephemeral — cleared at each ToolLoop.run())
// ---------------------------------------------------------------------------

interface ThoughtEntry {
  thoughtNumber: number;
  thought: string;
  isRevision: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
}

let thoughtHistory: ThoughtEntry[] = [];
let branches: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

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

export function executeSequentialThinking(
  input: Record<string, unknown>,
): string {
  const {
    thought,
    nextThoughtNeeded,
    thoughtNumber,
    totalThoughts,
    isRevision,
    revisesThought,
    branchFromThought,
    branchId,
    needsMoreThoughts,
  } = input as unknown as SequentialThinkingInput;

  // Validate required fields
  if (!thought || typeof thought !== 'string') {
    return JSON.stringify({ error: 'thought is required and must be a string' });
  }
  if (typeof thoughtNumber !== 'number' || thoughtNumber < 1) {
    return JSON.stringify({ error: 'thoughtNumber must be a positive integer' });
  }
  if (typeof totalThoughts !== 'number' || totalThoughts < 1) {
    return JSON.stringify({ error: 'totalThoughts must be a positive integer' });
  }

  // Track branch
  if (branchId && branchFromThought) {
    branches.add(branchId);
  }

  // Store thought
  const entry: ThoughtEntry = {
    thoughtNumber,
    thought,
    isRevision: isRevision ?? false,
    revisesThought,
    branchFromThought,
    branchId,
  };
  thoughtHistory.push(entry);

  // Debug logging (not visible to user)
  const prefix = isRevision
    ? `[revision of #${revisesThought}]`
    : branchId
      ? `[branch: ${branchId} from #${branchFromThought}]`
      : '';
  log.debug(
    `Thought ${thoughtNumber}/${totalThoughts} ${prefix}: ${thought.slice(0, 120)}${thought.length > 120 ? '...' : ''}`,
  );

  // Return acknowledgment (matches MCP server response shape)
  return JSON.stringify({
    thoughtNumber,
    totalThoughts,
    nextThoughtNeeded,
    branches: Array.from(branches),
    thoughtHistoryLength: thoughtHistory.length,
  });
}

// ---------------------------------------------------------------------------
// Reset — called at start of each ToolLoop.run()
// ---------------------------------------------------------------------------

export function resetSequentialThinking(): void {
  thoughtHistory = [];
  branches = new Set();
}
