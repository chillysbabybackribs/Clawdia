# Clawdia Planner/Executor Architecture — Implementation Prompt

You are implementing a major architectural upgrade to the Clawdia Electron app. This document contains everything you need to build a Planner/Executor/Heartbeat system that will reduce API calls from 25+ to 3-4 for research tasks.

---

## Part 1: Current Codebase Context

### Project Structure
```
/home/dp/Desktop/clawdia/
├── src/
│   ├── main/                     # Electron main process
│   │   ├── llm/
│   │   │   ├── client.ts         # AnthropicClient - API wrapper
│   │   │   ├── tool-loop.ts      # Sequential tool execution loop
│   │   │   └── conversation.ts   # Conversation state management
│   │   ├── browser/
│   │   │   ├── manager.ts        # BrowserView lifecycle & IPC
│   │   │   └── tools.ts          # Browser tool implementations
│   │   ├── main.ts               # App entry, IPC handlers
│   │   └── preload.ts            # Context bridge API
│   ├── renderer/
│   │   ├── main.ts               # UI logic
│   │   ├── index.html            # HTML structure
│   │   └── styles.css            # Styling
│   └── shared/
│       ├── types.ts              # TypeScript interfaces
│       └── ipc-channels.ts       # IPC channel constants
├── package.json
└── tsconfig.main.json
```

### Key Dependencies
- `@anthropic-ai/sdk` (^0.39.0) - Claude API client
- `electron` (^33.0.0) - Desktop framework
- `electron-store` (^8.2.0) - Persistent storage
- Model: `claude-sonnet-4-20250514`

---

### Current Architecture Flow

**Sequential Tool Loop (`src/main/llm/tool-loop.ts`)**:
```
User message → LLM call → if tool_use → execute tool → add to messages → repeat
                        → if no tools → return response
```

The current loop:
1. Takes conversation messages
2. Calls Claude API with streaming
3. Detects tool_use blocks in response
4. Executes each tool sequentially via `BrowserTools.executeTool()`
5. Sends IPC events to renderer for real-time UI updates
6. Adds tool results to message history
7. Loops until no more tool calls (max 25 iterations)

**Problem**: A research task like "Find information about OpenClaw" takes 25+ API calls:
- Navigate to Google → observe → type → submit → wait → extract
- Navigate to GitHub → observe → extract
- Navigate to Wikipedia → observe → extract
- etc.

Each browser action = 1 LLM round trip.

---

### Critical Files to Understand

#### 1. `src/main/llm/client.ts` - AnthropicClient

```typescript
export class AnthropicClient {
  private client: Anthropic;
  private model: string = 'claude-sonnet-4-20250514';

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt: string,
    onText?: (text: string) => void
  ): Promise<LLMResponse> {
    // Streams response, handles tool_use detection
    // If tool_use blocks present, makes a second non-streaming call to get full inputs
    // Returns { content: ContentBlock[], stopReason, model, usage }
  }
}
```

Key insight: Streaming doesn't provide complete tool input JSON, so client makes a second non-streaming request when tools are detected.

#### 2. `src/main/llm/tool-loop.ts` - ToolLoop

```typescript
export class ToolLoop {
  async run(conversationMessages: Message[]): Promise<string> {
    // Max 25 iterations
    // Each iteration: call LLM → stream text → execute tools → repeat
    // Sends IPC events: CHAT_STREAM_TEXT, CHAT_TOOL_START, CHAT_TOOL_RESULT, CHAT_STREAM_END
  }
}
```

The system prompt includes rules for browser tools. This will need a ROUTER_PROMPT variant.

#### 3. `src/main/browser/tools.ts` - BrowserTools

11 browser tools available:
- `browser_navigate(url)` - Go to URL
- `browser_observe(selector?)` - Get page elements (max 15)
- `browser_click(selector|text|x,y)` - Click element
- `browser_type(selector?, text, clear?)` - Type text
- `browser_press_key(key)` - Press keyboard key
- `browser_scroll(direction, amount?)` - Scroll page
- `browser_wait(event, selector?, timeout?)` - Wait for condition
- `browser_extract(selector?, format)` - Extract content (text/links/table/structured)
- `browser_back()` - Go back
- `browser_screenshot()` - Capture page
- `browser_search(url, query)` - All-in-one search (navigate + type + submit + wait)

**Critical**: `browser_search` already combines multiple actions. The executor will leverage this pattern.

#### 4. `src/main/browser/manager.ts` - BrowserView Manager

```typescript
let browserView: BrowserView | null = null;  // Single view currently
let mainWindow: BrowserWindow | null = null;

function ensureBrowserView(): BrowserView { /* lazy creation */ }
export function getWebContents() { return browserView?.webContents || null; }
```

**Constraint**: Currently only ONE BrowserView exists. For parallel execution, need a pool.

#### 5. `src/shared/types.ts` - Core Types

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  toolCalls?: ToolCall[];
}

interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
```

#### 6. `src/shared/ipc-channels.ts` - IPC Constants

```typescript
// Renderer → Main (invoke)
export const IPC = {
  CHAT_SEND, CHAT_STOP, CHAT_NEW, CHAT_LIST, CHAT_LOAD, CHAT_DELETE,
  BROWSER_NAVIGATE, BROWSER_BACK, BROWSER_FORWARD, BROWSER_REFRESH, BROWSER_SET_BOUNDS,
  SETTINGS_GET, SETTINGS_SET,
  WINDOW_MINIMIZE, WINDOW_MAXIMIZE, WINDOW_CLOSE,
};

// Main → Renderer (send)
export const IPC_EVENTS = {
  CHAT_STREAM_TEXT, CHAT_STREAM_END, CHAT_TOOL_START, CHAT_TOOL_RESULT, CHAT_ERROR,
  BROWSER_NAVIGATED, BROWSER_TITLE, BROWSER_LOADING, BROWSER_ERROR,
};
```

#### 7. `src/main/main.ts` - App Entry & IPC Handlers

```typescript
ipcMain.handle(IPC.CHAT_SEND, async (_event, conversationId: string, content: string) => {
  // Get/create conversation
  // Add user message
  // Get API key
  // Create AnthropicClient + BrowserTools + ToolLoop
  // Run toolLoop.run(conversation.messages)
  // Add assistant response
});
```

---

## Part 2: New Architecture Design

### Three-Layer System

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER MESSAGE                                 │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     LAYER 1: ROUTER                                  │
│  Classifies message into one of three routes:                        │
│  • chat → Direct LLM response (no tools)                            │
│  • browse → Single-site sequential (existing tool loop)             │
│  • research → Multi-source parallel (planner/executor)              │
└─────────────────────────────────────────────────────────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
    ┌─────────┐           ┌───────────┐          ┌──────────────┐
    │  CHAT   │           │  BROWSE   │          │  RESEARCH    │
    │ Direct  │           │  Tool     │          │  Planner +   │
    │ Response│           │  Loop     │          │  Executor    │
    └─────────┘           └───────────┘          └──────────────┘
                                                        │
                                                        ▼
                                           ┌──────────────────────┐
                                           │  LAYER 2: PLANNER    │
                                           │  Creates action plan  │
                                           │  (1 API call)        │
                                           └──────────────────────┘
                                                        │
                                                        ▼
                                           ┌──────────────────────┐
                                           │  LAYER 3: EXECUTOR   │
                                           │  Runs actions in     │
                                           │  parallel (no LLM)   │
                                           └──────────────────────┘
                                                        │
                                                        ▼
                                           ┌──────────────────────┐
                                           │  HEARTBEAT           │
                                           │  Checkpoint summary  │
                                           │  → Claude decides:   │
                                           │  continue/done       │
                                           └──────────────────────┘
```

### Route Definitions

**CHAT Route** - Direct response, no browser needed
- "What's the capital of France?"
- "Explain quantum computing"
- "Write a poem about cats"

**BROWSE Route** - Single-site, sequential actions fine
- "Search Amazon for wireless keyboards"
- "Go to news.ycombinator.com and show me the top stories"
- "Navigate to github.com/anthropics/claude-code"

**RESEARCH Route** - Multi-source, benefits from parallel
- "Research OpenClaw and tell me about it"
- "Compare prices for RTX 4090 across Amazon, Newegg, and Best Buy"
- "Find recent news about AI regulation from multiple sources"
- "What are people saying about Claude on Reddit, Twitter, and Hacker News?"

---

## Part 3: File-by-File Implementation Specification

### New Files to Create

```
src/main/
├── llm/
│   ├── router.ts           # NEW - Classify and route messages
│   ├── planner.ts          # NEW - Generate execution plans
│   └── synthesizer.ts      # NEW - Final response generation
├── executor/
│   ├── runner.ts           # NEW - Orchestrate parallel execution
│   ├── actions.ts          # NEW - Action type definitions & handlers
│   └── summarizer.ts       # NEW - Condense results for checkpoints
├── browser/
│   └── pool.ts             # NEW - Browser view pool for parallel exec
```

### Files to Modify

```
src/main/main.ts            # New IPC handlers for research progress
src/main/preload.ts         # New IPC methods for research events
src/shared/types.ts         # New types for plans, actions, checkpoints
src/shared/ipc-channels.ts  # New channels for research progress
src/renderer/main.ts        # Research progress UI
```

### Files to Keep Unchanged

```
src/main/llm/client.ts      # Keep as-is, reuse for all LLM calls
src/main/llm/conversation.ts # Keep as-is
src/main/browser/tools.ts   # Keep as-is, reuse for action execution
```

---

## Part 4: Detailed Implementation

### 4.1 New Types (`src/shared/types.ts` additions)

Add these types to the existing file:

```typescript
// ============================================================================
// ROUTER TYPES
// ============================================================================

export type RouteType = 'chat' | 'browse' | 'research';

export interface RouteDecision {
  route: RouteType;
  confidence: number;
  reasoning: string;
}

// ============================================================================
// PLANNER TYPES
// ============================================================================

export interface ResearchPlan {
  query: string;
  strategy: string;
  actions: PlannedAction[];
}

export interface PlannedAction {
  id: string;
  type: 'search' | 'navigate' | 'extract';
  source: string;  // e.g., "google", "github", "wikipedia", "reddit"
  query?: string;  // for search actions
  url?: string;    // for navigate actions
  extractFormat?: 'text' | 'structured' | 'links';
  priority: number;  // 1 = highest
  dependsOn?: string[];  // action IDs this depends on
}

// ============================================================================
// EXECUTOR TYPES
// ============================================================================

export interface ActionResult {
  actionId: string;
  source: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startedAt?: string;
  completedAt?: string;
  data?: {
    url?: string;
    title?: string;
    contentPreview?: string;
    itemCount?: number;
    items?: Array<{
      title?: string;
      link?: string;
      description?: string;
      price?: string;
    }>;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface ExecutionBatch {
  batchNumber: number;
  actions: PlannedAction[];
  results: ActionResult[];
}

// ============================================================================
// HEARTBEAT TYPES
// ============================================================================

export interface HeartbeatCheckpoint {
  checkpointNumber: number;
  completed: ActionResult[];
  pending: PlannedAction[];
  totalContentTokens: number;
  elapsedSeconds: number;
}

export interface HeartbeatResponse {
  action: 'continue' | 'done' | 'pivot';
  newActions?: PlannedAction[];  // if continuing with new tasks
  pivotReason?: string;  // if pivoting strategy
}

// ============================================================================
// RESEARCH PROGRESS TYPES (for IPC)
// ============================================================================

export interface ResearchProgress {
  phase: 'routing' | 'planning' | 'executing' | 'checkpoint' | 'synthesizing' | 'done';
  message: string;
  actions?: Array<{
    id: string;
    source: string;
    status: ActionResult['status'];
    preview?: string;
  }>;
  checkpointNumber?: number;
}
```

### 4.2 New IPC Channels (`src/shared/ipc-channels.ts` additions)

Add to existing file:

```typescript
// Add to IPC object (Renderer → Main invoke)
export const IPC = {
  // ... existing channels ...

  // Research
  RESEARCH_START: 'research:start',
  RESEARCH_STOP: 'research:stop',
} as const;

// Add to IPC_EVENTS object (Main → Renderer send)
export const IPC_EVENTS = {
  // ... existing channels ...

  // Research progress
  RESEARCH_PROGRESS: 'research:progress',
  RESEARCH_RESULT: 'research:result',
} as const;
```

### 4.3 Router (`src/main/llm/router.ts`)

```typescript
import { AnthropicClient } from './client';
import { Message, RouteDecision, RouteType } from '../../shared/types';

// ============================================================================
// ROUTER PROMPT
// ============================================================================

const ROUTER_PROMPT = `You are a message classifier. Analyze the user's message and determine the best route.

## Routes

1. **chat** - Direct conversation, no browser needed
   - Questions with factual answers from your knowledge
   - Creative writing, explanations, code help
   - Anything that doesn't require visiting websites

2. **browse** - Single website interaction
   - "Search Amazon for X"
   - "Go to Y website"
   - "Show me the homepage of Z"
   - Tasks focused on ONE site

3. **research** - Multi-source information gathering
   - "Research X and tell me about it"
   - "Find information about X from multiple sources"
   - "Compare X across different sites"
   - "What are people saying about X"
   - Any query that benefits from checking multiple sources

## Response Format

Respond with ONLY a JSON object:
{
  "route": "chat" | "browse" | "research",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

// ============================================================================
// ROUTER CLASS
// ============================================================================

export class Router {
  private client: AnthropicClient;

  constructor(apiKey: string) {
    this.client = new AnthropicClient(apiKey);
  }

  async classify(userMessage: string): Promise<RouteDecision> {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: userMessage,
        createdAt: new Date().toISOString(),
      },
    ];

    try {
      const response = await this.client.chat(
        messages,
        [],  // No tools for routing
        ROUTER_PROMPT
      );

      // Parse the response
      const textContent = response.content.find(b => b.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return this.defaultRoute();
      }

      const parsed = JSON.parse(textContent.text);
      return {
        route: parsed.route as RouteType,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      console.error('[Router] Classification failed:', error);
      return this.defaultRoute();
    }
  }

  private defaultRoute(): RouteDecision {
    return {
      route: 'browse',  // Default to existing behavior
      confidence: 0.5,
      reasoning: 'Fallback due to classification error',
    };
  }
}
```

### 4.4 Planner (`src/main/llm/planner.ts`)

```typescript
import { AnthropicClient } from './client';
import { Message, ResearchPlan, PlannedAction } from '../../shared/types';
import { randomUUID } from 'crypto';

// ============================================================================
// PLANNER PROMPT
// ============================================================================

const PLANNER_PROMPT = `You are a research planner. Given a user's research query, create an efficient execution plan.

## Available Sources

- **google**: General web search
- **github**: Code repositories, README files, issues
- **wikipedia**: Encyclopedic information
- **reddit**: Community discussions, opinions
- **hackernews**: Tech news, discussions
- **youtube**: Video content, tutorials
- **twitter**: Real-time updates, opinions
- **amazon**: Product information, reviews
- **stackoverflow**: Technical Q&A

## Action Types

1. **search**: Search a source for a query
   - Requires: source, query

2. **navigate**: Go directly to a URL
   - Requires: source, url

3. **extract**: Extract content from current page
   - Requires: source, extractFormat (text|structured|links)
   - Note: Usually follows a search or navigate

## Planning Rules

1. Start with 2-4 high-priority searches in parallel
2. Prioritize authoritative sources for the topic
3. Avoid redundant searches
4. Consider dependencies (extract depends on search/navigate)
5. Max 6 actions per plan

## Response Format

Respond with ONLY a JSON object:
{
  "query": "the user's research question",
  "strategy": "brief description of approach",
  "actions": [
    {
      "type": "search",
      "source": "google",
      "query": "search query",
      "priority": 1
    },
    {
      "type": "search",
      "source": "github",
      "query": "search query",
      "priority": 1
    }
  ]
}`;

// ============================================================================
// PLANNER CLASS
// ============================================================================

export class Planner {
  private client: AnthropicClient;

  constructor(apiKey: string) {
    this.client = new AnthropicClient(apiKey);
  }

  async createPlan(userMessage: string): Promise<ResearchPlan> {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: `Create a research plan for: "${userMessage}"`,
        createdAt: new Date().toISOString(),
      },
    ];

    try {
      const response = await this.client.chat(
        messages,
        [],  // No tools for planning
        PLANNER_PROMPT
      );

      const textContent = response.content.find(b => b.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        return this.defaultPlan(userMessage);
      }

      const parsed = JSON.parse(textContent.text);

      // Add IDs to actions
      const actions: PlannedAction[] = parsed.actions.map((a: any, idx: number) => ({
        id: randomUUID(),
        type: a.type,
        source: a.source,
        query: a.query,
        url: a.url,
        extractFormat: a.extractFormat,
        priority: a.priority || idx + 1,
        dependsOn: a.dependsOn,
      }));

      return {
        query: parsed.query,
        strategy: parsed.strategy,
        actions,
      };
    } catch (error) {
      console.error('[Planner] Plan creation failed:', error);
      return this.defaultPlan(userMessage);
    }
  }

  private defaultPlan(userMessage: string): ResearchPlan {
    return {
      query: userMessage,
      strategy: 'Default search strategy',
      actions: [
        {
          id: randomUUID(),
          type: 'search',
          source: 'google',
          query: userMessage,
          priority: 1,
        },
      ],
    };
  }
}
```

### 4.5 Executor (`src/main/executor/runner.ts`)

```typescript
import { BrowserWindow } from 'electron';
import {
  PlannedAction,
  ActionResult,
  ExecutionBatch,
  HeartbeatCheckpoint,
  HeartbeatResponse,
  ResearchPlan,
  ResearchProgress
} from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { BrowserPool } from '../browser/pool';
import { ActionExecutor } from './actions';
import { Summarizer } from './summarizer';
import { AnthropicClient } from '../llm/client';

// ============================================================================
// HEARTBEAT PROMPT
// ============================================================================

const HEARTBEAT_PROMPT = `You are reviewing research progress. Based on the results so far, decide next steps.

## Checkpoint Format

You will receive:
- completed: Array of completed action results with content previews
- pending: Array of pending actions
- totalContentTokens: Approximate tokens of gathered content
- elapsedSeconds: Time elapsed

## Decision Options

1. **continue**: Results are insufficient, add more search actions
2. **done**: Have enough information to synthesize a response
3. **pivot**: Current strategy isn't working, try different approach

## Response Format

Respond with ONLY a JSON object:
{
  "action": "continue" | "done" | "pivot",
  "newActions": [...],  // only if action is "continue"
  "pivotReason": "..."  // only if action is "pivot"
}`;

// ============================================================================
// EXECUTOR RUNNER
// ============================================================================

export class ExecutorRunner {
  private browserPool: BrowserPool;
  private actionExecutor: ActionExecutor;
  private summarizer: Summarizer;
  private client: AnthropicClient;
  private mainWindow: BrowserWindow;
  private stopped = false;
  private allResults: ActionResult[] = [];

  constructor(
    apiKey: string,
    browserPool: BrowserPool,
    mainWindow: BrowserWindow
  ) {
    this.browserPool = browserPool;
    this.actionExecutor = new ActionExecutor(browserPool);
    this.summarizer = new Summarizer();
    this.client = new AnthropicClient(apiKey);
    this.mainWindow = mainWindow;
  }

  stop(): void {
    this.stopped = true;
    this.browserPool.releaseAll();
  }

  async execute(plan: ResearchPlan): Promise<ActionResult[]> {
    this.stopped = false;
    this.allResults = [];
    const startTime = Date.now();
    let checkpointNumber = 0;
    let pendingActions = [...plan.actions];

    this.sendProgress({
      phase: 'executing',
      message: `Starting ${plan.actions.length} actions...`,
      actions: plan.actions.map(a => ({
        id: a.id,
        source: a.source,
        status: 'pending',
      })),
    });

    while (pendingActions.length > 0 && !this.stopped) {
      // Get next batch of independent actions (same priority, no unsatisfied deps)
      const batch = this.getNextBatch(pendingActions);

      if (batch.length === 0) {
        console.warn('[Executor] No executable actions, breaking');
        break;
      }

      // Execute batch in parallel
      const batchResults = await this.executeBatch(batch);
      this.allResults.push(...batchResults);

      // Remove completed actions from pending
      const completedIds = new Set(batchResults.map(r => r.actionId));
      pendingActions = pendingActions.filter(a => !completedIds.has(a.id));

      // Heartbeat checkpoint
      checkpointNumber++;
      const checkpoint: HeartbeatCheckpoint = {
        checkpointNumber,
        completed: this.allResults,
        pending: pendingActions,
        totalContentTokens: this.summarizer.estimateTokens(this.allResults),
        elapsedSeconds: (Date.now() - startTime) / 1000,
      };

      this.sendProgress({
        phase: 'checkpoint',
        message: `Checkpoint ${checkpointNumber}: reviewing ${this.allResults.length} results...`,
        checkpointNumber,
        actions: this.allResults.map(r => ({
          id: r.actionId,
          source: r.source,
          status: r.status,
          preview: r.data?.contentPreview?.slice(0, 100),
        })),
      });

      // Get heartbeat decision
      const decision = await this.heartbeat(checkpoint, plan.query);

      if (decision.action === 'done') {
        console.log('[Executor] Heartbeat says done');
        break;
      }

      if (decision.action === 'continue' && decision.newActions) {
        pendingActions.push(...decision.newActions);
      }

      if (decision.action === 'pivot') {
        console.log('[Executor] Pivot requested:', decision.pivotReason);
        // For now, just stop. Could implement pivot logic later.
        break;
      }
    }

    return this.allResults;
  }

  private getNextBatch(pending: PlannedAction[]): PlannedAction[] {
    // Find minimum priority among pending
    const minPriority = Math.min(...pending.map(a => a.priority));

    // Get all actions with that priority and satisfied dependencies
    const completedIds = new Set(this.allResults.map(r => r.actionId));

    return pending.filter(a => {
      if (a.priority !== minPriority) return false;
      if (a.dependsOn) {
        return a.dependsOn.every(depId => completedIds.has(depId));
      }
      return true;
    });
  }

  private async executeBatch(actions: PlannedAction[]): Promise<ActionResult[]> {
    // Execute all actions in parallel
    const promises = actions.map(action => this.executeAction(action));
    return Promise.all(promises);
  }

  private async executeAction(action: PlannedAction): Promise<ActionResult> {
    this.sendProgress({
      phase: 'executing',
      message: `Executing ${action.type} on ${action.source}...`,
      actions: [{
        id: action.id,
        source: action.source,
        status: 'running',
      }],
    });

    const result = await this.actionExecutor.execute(action);

    this.sendProgress({
      phase: 'executing',
      message: result.status === 'success'
        ? `✓ ${action.source} complete`
        : `✗ ${action.source} failed`,
      actions: [{
        id: action.id,
        source: action.source,
        status: result.status,
        preview: result.data?.contentPreview?.slice(0, 100),
      }],
    });

    return result;
  }

  private async heartbeat(
    checkpoint: HeartbeatCheckpoint,
    originalQuery: string
  ): Promise<HeartbeatResponse> {
    const messages = [
      {
        id: 'system-context',
        role: 'user' as const,
        content: `Original research query: "${originalQuery}"

Checkpoint ${checkpoint.checkpointNumber}:
${JSON.stringify(checkpoint, null, 2)}`,
        createdAt: new Date().toISOString(),
      },
    ];

    try {
      const response = await this.client.chat(messages, [], HEARTBEAT_PROMPT);
      const textContent = response.content.find(b => b.type === 'text');

      if (!textContent || textContent.type !== 'text') {
        return { action: 'done' };
      }

      return JSON.parse(textContent.text);
    } catch (error) {
      console.error('[Executor] Heartbeat failed:', error);
      return { action: 'done' };  // Default to done on error
    }
  }

  private sendProgress(progress: ResearchProgress): void {
    this.mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, progress);
  }
}
```

### 4.6 Action Executor (`src/main/executor/actions.ts`)

```typescript
import { PlannedAction, ActionResult } from '../../shared/types';
import { BrowserPool } from '../browser/pool';

// ============================================================================
// SOURCE URL MAPPINGS
// ============================================================================

const SOURCE_URLS: Record<string, string> = {
  google: 'https://www.google.com',
  github: 'https://github.com',
  wikipedia: 'https://en.wikipedia.org',
  reddit: 'https://www.reddit.com',
  hackernews: 'https://news.ycombinator.com',
  youtube: 'https://www.youtube.com',
  twitter: 'https://twitter.com',
  amazon: 'https://www.amazon.com',
  stackoverflow: 'https://stackoverflow.com',
};

const SOURCE_SEARCH_URLS: Record<string, (query: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  reddit: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  hackernews: (q) => `https://hn.algolia.com/?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  twitter: (q) => `https://twitter.com/search?q=${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
};

// ============================================================================
// ACTION EXECUTOR
// ============================================================================

export class ActionExecutor {
  private browserPool: BrowserPool;

  constructor(browserPool: BrowserPool) {
    this.browserPool = browserPool;
  }

  async execute(action: PlannedAction): Promise<ActionResult> {
    const startTime = new Date().toISOString();
    const result: ActionResult = {
      actionId: action.id,
      source: action.source,
      status: 'running',
      startedAt: startTime,
    };

    try {
      // Acquire a browser from the pool
      const browser = await this.browserPool.acquire();

      switch (action.type) {
        case 'search':
          await this.executeSearch(browser, action, result);
          break;
        case 'navigate':
          await this.executeNavigate(browser, action, result);
          break;
        case 'extract':
          await this.executeExtract(browser, action, result);
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }

      result.status = 'success';
      result.completedAt = new Date().toISOString();

      // Release browser back to pool
      this.browserPool.release(browser);
    } catch (error: any) {
      result.status = 'error';
      result.completedAt = new Date().toISOString();
      result.error = {
        code: 'EXECUTION_FAILED',
        message: error.message,
      };
    }

    return result;
  }

  private async executeSearch(
    browser: Electron.WebContents,
    action: PlannedAction,
    result: ActionResult
  ): Promise<void> {
    if (!action.query) {
      throw new Error('Search action requires query');
    }

    const searchUrl = SOURCE_SEARCH_URLS[action.source];
    if (!searchUrl) {
      throw new Error(`Unknown search source: ${action.source}`);
    }

    const url = searchUrl(action.query);

    // Navigate to search URL
    await browser.loadURL(url);
    await this.sleep(2000);  // Wait for results

    // Extract content
    const content = await this.extractPageContent(browser);
    result.data = {
      url: browser.getURL(),
      title: browser.getTitle(),
      contentPreview: content.slice(0, 1500),
      itemCount: this.countItems(content),
    };
  }

  private async executeNavigate(
    browser: Electron.WebContents,
    action: PlannedAction,
    result: ActionResult
  ): Promise<void> {
    const url = action.url || SOURCE_URLS[action.source];
    if (!url) {
      throw new Error('Navigate action requires url or valid source');
    }

    await browser.loadURL(url);
    await this.sleep(1500);

    const content = await this.extractPageContent(browser);
    result.data = {
      url: browser.getURL(),
      title: browser.getTitle(),
      contentPreview: content.slice(0, 1500),
    };
  }

  private async executeExtract(
    browser: Electron.WebContents,
    action: PlannedAction,
    result: ActionResult
  ): Promise<void> {
    const format = action.extractFormat || 'text';

    if (format === 'structured') {
      const items = await this.extractStructured(browser);
      result.data = {
        url: browser.getURL(),
        title: browser.getTitle(),
        items,
        itemCount: items.length,
      };
    } else {
      const content = await this.extractPageContent(browser);
      result.data = {
        url: browser.getURL(),
        title: browser.getTitle(),
        contentPreview: content.slice(0, 2000),
      };
    }
  }

  private async extractPageContent(browser: Electron.WebContents): Promise<string> {
    return browser.executeJavaScript(`
      (function() {
        const text = document.body.innerText || document.body.textContent || '';
        return text.replace(/\\s+/g, ' ').trim().slice(0, 5000);
      })()
    `);
  }

  private async extractStructured(browser: Electron.WebContents): Promise<any[]> {
    return browser.executeJavaScript(`
      (function() {
        const items = [];
        const containers = [
          '[data-component-type="s-search-result"]',
          '.s-result-item',
          '.g',
          '.result',
          'article',
          '.card',
          '.product',
        ];

        let found = [];
        for (const sel of containers) {
          found = document.querySelectorAll(sel);
          if (found.length >= 2) break;
        }

        for (let i = 0; i < Math.min(found.length, 10); i++) {
          const item = found[i];
          const titleEl = item.querySelector('h2, h3, h4, [class*="title"], a[href]');
          const priceEl = item.querySelector('[class*="price"]');
          const linkEl = item.querySelector('a[href]');
          const descEl = item.querySelector('[class*="description"], p');

          if (titleEl) {
            items.push({
              title: titleEl.innerText?.trim().slice(0, 100),
              price: priceEl?.innerText?.trim().slice(0, 30),
              link: linkEl?.href,
              description: descEl?.innerText?.trim().slice(0, 150),
            });
          }
        }
        return items;
      })()
    `);
  }

  private countItems(content: string): number {
    // Rough estimate of result count
    const matches = content.match(/\d+\s*results?/i);
    if (matches) {
      const num = parseInt(matches[0]);
      if (!isNaN(num)) return num;
    }
    return 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 4.7 Browser Pool (`src/main/browser/pool.ts`)

```typescript
import { BrowserView, BrowserWindow } from 'electron';

// ============================================================================
// BROWSER POOL
// ============================================================================

interface PooledBrowser {
  view: BrowserView;
  inUse: boolean;
}

export class BrowserPool {
  private mainWindow: BrowserWindow;
  private pool: PooledBrowser[] = [];
  private maxSize: number;
  private acquiring: Promise<Electron.WebContents>[] = [];

  constructor(mainWindow: BrowserWindow, maxSize: number = 4) {
    this.mainWindow = mainWindow;
    this.maxSize = maxSize;
  }

  async acquire(): Promise<Electron.WebContents> {
    // Find an available browser
    const available = this.pool.find(b => !b.inUse);
    if (available) {
      available.inUse = true;
      return available.view.webContents;
    }

    // Create new browser if under limit
    if (this.pool.length < this.maxSize) {
      const browser = this.createBrowser();
      this.pool.push({ view: browser, inUse: true });
      return browser.webContents;
    }

    // Wait for one to become available
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const available = this.pool.find(b => !b.inUse);
        if (available) {
          clearInterval(check);
          available.inUse = true;
          resolve(available.view.webContents);
        }
      }, 100);
    });
  }

  release(webContents: Electron.WebContents): void {
    const pooled = this.pool.find(b => b.view.webContents === webContents);
    if (pooled) {
      pooled.inUse = false;
    }
  }

  releaseAll(): void {
    for (const pooled of this.pool) {
      pooled.inUse = false;
    }
  }

  destroy(): void {
    for (const pooled of this.pool) {
      this.mainWindow.removeBrowserView(pooled.view);
      pooled.view.webContents.close();
    }
    this.pool = [];
  }

  private createBrowser(): BrowserView {
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // Don't add to window - these are headless for parallel execution
    // The pool browsers run in background, not visible to user

    return view;
  }

  getPoolSize(): number {
    return this.pool.length;
  }

  getActiveCount(): number {
    return this.pool.filter(b => b.inUse).length;
  }
}
```

### 4.8 Summarizer (`src/main/executor/summarizer.ts`)

```typescript
import { ActionResult } from '../../shared/types';

// ============================================================================
// SUMMARIZER
// ============================================================================

export class Summarizer {
  /**
   * Estimate token count for results
   * Rough approximation: 1 token ≈ 4 characters
   */
  estimateTokens(results: ActionResult[]): number {
    let totalChars = 0;

    for (const result of results) {
      if (result.data) {
        totalChars += JSON.stringify(result.data).length;
      }
    }

    return Math.ceil(totalChars / 4);
  }

  /**
   * Condense results for heartbeat checkpoint
   * Keeps essential info while reducing size
   */
  condenseForCheckpoint(results: ActionResult[]): ActionResult[] {
    return results.map(r => ({
      ...r,
      data: r.data ? {
        url: r.data.url,
        title: r.data.title,
        contentPreview: r.data.contentPreview?.slice(0, 500),
        itemCount: r.data.itemCount,
        items: r.data.items?.slice(0, 3).map(item => ({
          title: item.title?.slice(0, 50),
          price: item.price,
          link: item.link,
        })),
      } : undefined,
    }));
  }

  /**
   * Prepare full content for synthesis
   */
  prepareForSynthesis(results: ActionResult[]): string {
    const sections: string[] = [];

    for (const result of results) {
      if (result.status !== 'success' || !result.data) continue;

      let section = `## Source: ${result.source}\n`;
      section += `URL: ${result.data.url}\n`;
      section += `Title: ${result.data.title}\n\n`;

      if (result.data.items && result.data.items.length > 0) {
        section += 'Items found:\n';
        for (const item of result.data.items) {
          section += `- ${item.title}`;
          if (item.price) section += ` (${item.price})`;
          section += '\n';
          if (item.description) section += `  ${item.description}\n`;
        }
      } else if (result.data.contentPreview) {
        section += result.data.contentPreview + '\n';
      }

      sections.push(section);
    }

    return sections.join('\n---\n\n');
  }
}
```

### 4.9 Synthesizer (`src/main/llm/synthesizer.ts`)

```typescript
import { BrowserWindow } from 'electron';
import { AnthropicClient } from './client';
import { ActionResult, Message, ResearchProgress } from '../../shared/types';
import { Summarizer } from '../executor/summarizer';
import { IPC_EVENTS } from '../../shared/ipc-channels';

// ============================================================================
// SYNTHESIZER PROMPT
// ============================================================================

const SYNTHESIZER_PROMPT = `You are a research synthesizer. Given gathered information from multiple sources, create a comprehensive, well-organized response.

## Guidelines

1. Synthesize information across sources - don't just list what each source said
2. Highlight key findings and patterns
3. Note any conflicting information
4. Be concise but thorough
5. Use markdown formatting for readability
6. Cite sources when making specific claims

## Response Format

Provide a natural, conversational response that directly answers the user's research question. Use headers, lists, and other formatting as appropriate.`;

// ============================================================================
// SYNTHESIZER CLASS
// ============================================================================

export class Synthesizer {
  private client: AnthropicClient;
  private summarizer: Summarizer;
  private mainWindow: BrowserWindow;

  constructor(apiKey: string, mainWindow: BrowserWindow) {
    this.client = new AnthropicClient(apiKey);
    this.summarizer = new Summarizer();
    this.mainWindow = mainWindow;
  }

  async synthesize(
    originalQuery: string,
    results: ActionResult[]
  ): Promise<string> {
    this.sendProgress({
      phase: 'synthesizing',
      message: 'Synthesizing research findings...',
    });

    const gatheredContent = this.summarizer.prepareForSynthesis(results);

    const messages: Message[] = [
      {
        id: 'context',
        role: 'user',
        content: `Research query: "${originalQuery}"

Gathered information from ${results.filter(r => r.status === 'success').length} sources:

${gatheredContent}

Please synthesize this information into a comprehensive response.`,
        createdAt: new Date().toISOString(),
      },
    ];

    let fullResponse = '';

    const response = await this.client.chat(
      messages,
      [],  // No tools for synthesis
      SYNTHESIZER_PROMPT,
      (text) => {
        fullResponse += text;
        this.mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
      }
    );

    const textContent = response.content.find(b => b.type === 'text');
    if (textContent && textContent.type === 'text') {
      fullResponse = textContent.text;
    }

    this.sendProgress({
      phase: 'done',
      message: 'Research complete',
    });

    return fullResponse;
  }

  private sendProgress(progress: ResearchProgress): void {
    this.mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, progress);
  }
}
```

### 4.10 Main Integration (`src/main/main.ts` modifications)

Add these imports and modifications to the existing file:

```typescript
// Add imports at top
import { Router } from './llm/router';
import { Planner } from './llm/planner';
import { Synthesizer } from './llm/synthesizer';
import { ExecutorRunner } from './executor/runner';
import { BrowserPool } from './browser/pool';

// Add global state
let browserPool: BrowserPool | null = null;
let executorRunner: ExecutorRunner | null = null;

// Modify the CHAT_SEND handler:
ipcMain.handle(IPC.CHAT_SEND, async (_event, conversationId: string, content: string) => {
  if (!mainWindow) return { error: 'No window' };

  // Get or create conversation
  let conversation = conversationManager.get(conversationId);
  if (!conversation) {
    conversation = conversationManager.create();
  }

  // Add user message
  conversationManager.addMessage(conversation.id, {
    role: 'user',
    content,
  });

  // Get API key
  const apiKey = store.get('anthropic_api_key') as string | undefined;
  if (!apiKey) {
    mainWindow.webContents.send('chat:error', { error: 'No API key configured' });
    return { error: 'No API key' };
  }

  try {
    // STEP 1: Route the message
    const router = new Router(apiKey);
    const routeDecision = await router.classify(content);
    console.log(`[Main] Route decision: ${routeDecision.route} (${routeDecision.confidence})`);

    let response: string;

    switch (routeDecision.route) {
      case 'chat':
        // Direct LLM response, no tools
        response = await handleChatRoute(apiKey, conversation.messages);
        break;

      case 'browse':
        // Existing sequential tool loop
        response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
        break;

      case 'research':
        // New planner/executor pipeline
        response = await handleResearchRoute(apiKey, content, mainWindow);
        break;

      default:
        response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
    }

    // Add assistant response
    conversationManager.addMessage(conversation.id, {
      role: 'assistant',
      content: response,
    });

    return { conversationId: conversation.id };
  } catch (error: any) {
    mainWindow.webContents.send('chat:error', { error: error.message });
    return { error: error.message };
  }
});

// Add route handlers
async function handleChatRoute(apiKey: string, messages: Message[]): Promise<string> {
  const client = new AnthropicClient(apiKey);
  let fullResponse = '';

  const response = await client.chat(
    messages,
    [],  // No tools
    'You are a helpful assistant. Respond naturally and helpfully.',
    (text) => {
      fullResponse += text;
      mainWindow?.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
    }
  );

  mainWindow?.webContents.send(IPC_EVENTS.CHAT_STREAM_END, fullResponse);
  return fullResponse;
}

async function handleBrowseRoute(
  apiKey: string,
  messages: Message[],
  mainWindow: BrowserWindow
): Promise<string> {
  const llmClient = new AnthropicClient(apiKey);
  const browserTools = new BrowserTools();
  toolLoop = new ToolLoop(llmClient, browserTools, mainWindow);
  return toolLoop.run(messages);
}

async function handleResearchRoute(
  apiKey: string,
  query: string,
  mainWindow: BrowserWindow
): Promise<string> {
  // Initialize browser pool if needed
  if (!browserPool) {
    browserPool = new BrowserPool(mainWindow, 4);
  }

  // Plan
  mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, {
    phase: 'planning',
    message: 'Creating research plan...',
  });

  const planner = new Planner(apiKey);
  const plan = await planner.createPlan(query);
  console.log('[Main] Research plan:', plan);

  // Execute
  executorRunner = new ExecutorRunner(apiKey, browserPool, mainWindow);
  const results = await executorRunner.execute(plan);

  // Synthesize
  const synthesizer = new Synthesizer(apiKey, mainWindow);
  const response = await synthesizer.synthesize(query, results);

  mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_END, response);
  return response;
}

// Add stop handler for research
ipcMain.handle(IPC.CHAT_STOP, async () => {
  if (toolLoop) {
    toolLoop.stop();
  }
  if (executorRunner) {
    executorRunner.stop();
  }
  return { stopped: true };
});
```

### 4.11 Preload Updates (`src/main/preload.ts` additions)

Add to the existing api object:

```typescript
// Add to api object
onResearchProgress: (callback: (progress: ResearchProgress) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress);
  ipcRenderer.on(IPC_EVENTS.RESEARCH_PROGRESS, handler);
  return () => ipcRenderer.removeListener(IPC_EVENTS.RESEARCH_PROGRESS, handler);
},
```

### 4.12 Renderer UI Updates (`src/renderer/main.ts` additions)

Add to the type declarations:

```typescript
// Add to Window.api interface
onResearchProgress: (callback: (progress: {
  phase: string;
  message: string;
  actions?: Array<{
    id: string;
    source: string;
    status: string;
    preview?: string;
  }>;
  checkpointNumber?: number;
}) => void) => () => void;
```

Add research progress UI:

```typescript
// Add state variable
let researchProgressContainer: HTMLDivElement | null = null;

// Add to setupChatListeners()
window.api.onResearchProgress((progress) => {
  updateResearchProgress(progress);
});

// Add new function
function updateResearchProgress(progress: {
  phase: string;
  message: string;
  actions?: Array<{
    id: string;
    source: string;
    status: string;
    preview?: string;
  }>;
  checkpointNumber?: number;
}) {
  // Create or get progress container
  if (!researchProgressContainer) {
    researchProgressContainer = document.createElement('div');
    researchProgressContainer.className = 'research-progress';
    outputEl.appendChild(researchProgressContainer);
    scrollToBottom();
  }

  // Build progress HTML
  let html = `<div class="research-phase">${progress.message}</div>`;

  if (progress.actions && progress.actions.length > 0) {
    html += '<div class="research-actions">';
    for (const action of progress.actions) {
      const icon = action.status === 'success' ? '✓'
                 : action.status === 'error' ? '✗'
                 : action.status === 'running' ? '⟳'
                 : '○';
      const statusClass = `action-${action.status}`;
      html += `
        <div class="research-action ${statusClass}">
          <span class="action-icon">${icon}</span>
          <span class="action-source">${escapeHtml(action.source)}</span>
          ${action.preview ? `<span class="action-preview">${escapeHtml(action.preview)}</span>` : ''}
        </div>
      `;
    }
    html += '</div>';
  }

  if (progress.checkpointNumber) {
    html += `<div class="research-checkpoint">◆ Checkpoint ${progress.checkpointNumber}</div>`;
  }

  researchProgressContainer.innerHTML = html;
  scrollToBottom();

  // Clear container when done
  if (progress.phase === 'done' || progress.phase === 'synthesizing') {
    researchProgressContainer = null;
  }
}
```

Add CSS for research progress (add to `src/renderer/styles.css`):

```css
/* Research Progress */
.research-progress {
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  margin-bottom: 12px;
}

.research-phase {
  color: #888;
  font-size: 13px;
  margin-bottom: 8px;
}

.research-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.research-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  font-size: 12px;
}

.action-icon {
  width: 16px;
  text-align: center;
}

.action-pending .action-icon { color: #666; }
.action-running .action-icon { color: #f90; animation: spin 1s linear infinite; }
.action-success .action-icon { color: #4a4; }
.action-error .action-icon { color: #a44; }

.action-source {
  font-weight: 500;
  min-width: 100px;
}

.action-preview {
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.research-checkpoint {
  margin-top: 8px;
  color: #f90;
  font-size: 12px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

---

## Part 5: Build Order & Verification

### Phase 1: Types & IPC (10 min)

1. **Add types to `src/shared/types.ts`**
   - Add RouteDecision, ResearchPlan, PlannedAction, ActionResult, ExecutionBatch, HeartbeatCheckpoint, HeartbeatResponse, ResearchProgress

2. **Add channels to `src/shared/ipc-channels.ts`**
   - Add RESEARCH_PROGRESS to IPC_EVENTS

3. **Verify**: Run `npm run build:main` - should compile without errors

### Phase 2: Router (15 min)

1. **Create `src/main/llm/router.ts`**
   - Implement Router class with classify() method
   - Use minimal LLM call with constrained output

2. **Test manually**:
   - Add temporary test in main.ts
   - Verify "hello" routes to chat
   - Verify "search amazon for keyboards" routes to browse
   - Verify "research openai competitors" routes to research

### Phase 3: Planner (15 min)

1. **Create `src/main/llm/planner.ts`**
   - Implement Planner class with createPlan() method
   - Return structured plan with actions

2. **Test manually**:
   - Log plan output for "research claude ai"
   - Verify plan has 2-4 actions with proper sources

### Phase 4: Browser Pool (20 min)

1. **Create `src/main/browser/pool.ts`**
   - Implement BrowserPool with acquire/release
   - Max 4 concurrent browsers

2. **Test manually**:
   - Create pool, acquire 4 browsers
   - Verify 5th acquire waits
   - Release one, verify 5th proceeds

### Phase 5: Action Executor (25 min)

1. **Create `src/main/executor/actions.ts`**
   - Implement ActionExecutor with execute() method
   - Handle search, navigate, extract action types

2. **Create `src/main/executor/summarizer.ts`**
   - Implement token estimation
   - Implement content condensing

3. **Test manually**:
   - Execute single search action
   - Verify result has content preview

### Phase 6: Executor Runner (25 min)

1. **Create `src/main/executor/runner.ts`**
   - Implement batch execution logic
   - Implement heartbeat checkpoint
   - Send progress events

2. **Test manually**:
   - Execute 2-action plan
   - Verify parallel execution
   - Verify heartbeat decision

### Phase 7: Synthesizer (15 min)

1. **Create `src/main/llm/synthesizer.ts`**
   - Implement synthesis from gathered results
   - Stream response to renderer

2. **Test manually**:
   - Synthesize from mock results
   - Verify markdown output

### Phase 8: Integration (20 min)

1. **Modify `src/main/main.ts`**
   - Add route handling logic
   - Wire up planner → executor → synthesizer

2. **Modify `src/main/preload.ts`**
   - Add onResearchProgress handler

3. **Modify `src/renderer/main.ts`**
   - Add research progress UI

4. **Add CSS to `src/renderer/styles.css`**
   - Research progress styling

### Phase 9: End-to-End Testing (15 min)

1. **Test chat route**:
   - "What is 2+2?" - Should get direct response, no browser

2. **Test browse route**:
   - "Search Amazon for keyboards" - Should use existing tool loop

3. **Test research route**:
   - "Research Claude AI and its competitors" - Should:
     - Show planning message
     - Show multiple parallel actions
     - Show checkpoint
     - Show synthesis
     - Complete in 3-4 API calls

---

## Part 6: Error Handling

### Router Errors
- If classification fails, default to `browse` route (existing behavior)
- Log error for debugging

### Planner Errors
- If plan creation fails, use default single-Google-search plan
- Log error for debugging

### Executor Errors
- Individual action failures don't stop execution
- Failed actions marked with error status
- Heartbeat can decide to retry or move on

### Browser Pool Errors
- If browser creation fails, throw error
- If all browsers crash, release and recreate

### Synthesis Errors
- If synthesis fails, return raw gathered content as fallback
- Show error message to user

---

## Part 7: Performance Expectations

### Before (Sequential)
- Research task: 25+ API calls
- Time: 90+ seconds
- Token usage: High (repetitive context)

### After (Planner/Executor)
- Research task: 3-4 API calls
  1. Router (classify)
  2. Planner (create plan)
  3. Heartbeat (checkpoint)
  4. Synthesizer (final response)
- Time: 15-20 seconds
- Token usage: Lower (focused context per call)

---

## Part 8: Future Enhancements (Not in scope)

1. **Caching**: Cache search results to avoid duplicate fetches
2. **Retries**: Automatic retry for failed actions
3. **Pivot Logic**: Implement actual pivot behavior when heartbeat suggests
4. **Visual Browser**: Show one of the pool browsers to user during research
5. **Action Composition**: Support more complex action sequences
6. **Custom Sources**: User-configurable research sources

---

## Implementation Checklist

- [ ] Add types to src/shared/types.ts
- [ ] Add IPC channels to src/shared/ipc-channels.ts
- [ ] Create src/main/llm/router.ts
- [ ] Create src/main/llm/planner.ts
- [ ] Create src/main/llm/synthesizer.ts
- [ ] Create src/main/browser/pool.ts
- [ ] Create src/main/executor/actions.ts
- [ ] Create src/main/executor/summarizer.ts
- [ ] Create src/main/executor/runner.ts
- [ ] Modify src/main/main.ts (add route handling)
- [ ] Modify src/main/preload.ts (add research progress)
- [ ] Modify src/renderer/main.ts (add research UI)
- [ ] Add CSS to src/renderer/styles.css
- [ ] Test chat route
- [ ] Test browse route
- [ ] Test research route
- [ ] End-to-end verification

---

## Summary

This implementation transforms Clawdia from a sequential tool loop into an intelligent three-tier system:

1. **Router**: Fast classification to choose the optimal execution path
2. **Planner**: Single LLM call to create a parallel execution plan
3. **Executor**: No-LLM parallel browser automation with heartbeat checkpoints
4. **Synthesizer**: Final LLM call to create cohesive response

The result: Research tasks that previously took 25+ API calls now complete in 3-4 calls, with parallel browser execution reducing wall-clock time from 90+ seconds to 15-20 seconds.
