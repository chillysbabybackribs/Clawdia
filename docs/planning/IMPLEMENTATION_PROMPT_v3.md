# Clawdia Planner/Executor Architecture — Implementation Prompt v3 (FINAL)

You are implementing a major architectural upgrade to the Clawdia Electron app. This document contains everything you need to build a Task Intake → Parallel Evidence → Heartbeat → Synthesis system.

**The goal**: Research tasks go from 25+ API calls / 90+ seconds to 3-4 API calls / 15-25 seconds, with every factual claim linked to a source via `[S#]` citations.

**Read this entire document before writing any code. Build in the exact order specified in Part 6.**

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

**Problem**: A research task takes 25+ API calls (3-5 sec each) = 90+ seconds. Each browser action requires a full LLM round trip.

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

Key insight: Streaming doesn't provide complete tool input JSON, so the client makes a second non-streaming request when tools are detected.

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

**KEEP AS-IS.** Used for the browse route. Do not modify this file.

#### 3. `src/main/browser/tools.ts` - BrowserTools

11 browser tools: browser_navigate, browser_observe, browser_click, browser_type, browser_press_key, browser_scroll, browser_wait, browser_extract, browser_back, browser_screenshot, browser_search.

**KEEP AS-IS.** Used by the browse route's tool loop.

#### 4. `src/main/browser/manager.ts` - BrowserView Manager

```typescript
let browserView: BrowserView | null = null;  // Single view
let mainWindow: BrowserWindow | null = null;
function ensureBrowserView(): BrowserView { /* lazy creation */ }
export function getWebContents() { return browserView?.webContents || null; }
```

**KEEP AS-IS.** This manages the VISIBLE browser the user sees. The new BrowserPool is separate and manages invisible background browsers.

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
export const IPC = {
  CHAT_SEND, CHAT_STOP, CHAT_NEW, CHAT_LIST, CHAT_LOAD, CHAT_DELETE,
  BROWSER_NAVIGATE, BROWSER_BACK, BROWSER_FORWARD, BROWSER_REFRESH, BROWSER_SET_BOUNDS,
  SETTINGS_GET, SETTINGS_SET,
  WINDOW_MINIMIZE, WINDOW_MAXIMIZE, WINDOW_CLOSE,
};

export const IPC_EVENTS = {
  CHAT_STREAM_TEXT, CHAT_STREAM_END, CHAT_TOOL_START, CHAT_TOOL_RESULT, CHAT_ERROR,
  BROWSER_NAVIGATED, BROWSER_TITLE, BROWSER_LOADING, BROWSER_ERROR,
};
```

#### 7. `src/main/main.ts` - App Entry & IPC Handlers

```typescript
ipcMain.handle(IPC.CHAT_SEND, async (_event, conversationId: string, content: string) => {
  // Get/create conversation → Add user message → Get API key
  // Create AnthropicClient + BrowserTools + ToolLoop
  // Run toolLoop.run(conversation.messages)
  // Add assistant response
});
```

---

## Part 2: New Architecture Design

### Core Principle: Two-Step Search

The executor does NOT parse SERPs for content. SERPs are unstable (JS-heavy, layout shifts, personalization). Instead:

1. **Step 1**: Load search URL → harvest organic result links (URLs + titles)
2. **Step 2**: Navigate to actual source pages → extract real content

This means a "search" action produces links, then the executor automatically visits the top N source pages for content extraction. The LLM never sees SERP text.

### Architecture Flow

```
USER MESSAGE
      │
      ▼
HEURISTIC ROUTER (zero latency, regex-based)
      │
      ├── obvious chat ──────────→ CHAT ROUTE (direct LLM, 0 extra calls)
      ├── has URL / site name ───→ BROWSE ROUTE (existing tool loop)
      └── ambiguous ─────────────→ LLM INTAKE (1 API call)
                                        │
                                        ├── chat ───→ CHAT ROUTE
                                        ├── browse ─→ BROWSE ROUTE
                                        └── research → RESEARCH PIPELINE
                                                            │
                                                            ▼
                                                     ┌─────────────┐
                                                     │  EXECUTOR    │
                                                     │  parallel    │
                                                     │  SERP→source │
                                                     │  extraction  │
                                                     │  (no LLM)   │
                                                     └──────┬──────┘
                                                            │
                                                            ▼
                                                     ┌─────────────┐
                                                     │  HEARTBEAT   │
                                                     │  (1 LLM call)│
                                                     │  continue or │
                                                     │  done        │
                                                     └──────┬──────┘
                                                            │
                                                            ▼
                                                     ┌─────────────┐
                                                     │ SYNTHESIZER  │
                                                     │ (1 LLM call) │
                                                     │ evidence →   │
                                                     │ [S#] cited   │
                                                     │ response     │
                                                     └──────┬──────┘
                                                            │
                                                            ▼
                                                     ┌─────────────┐
                                                     │  COVERAGE    │
                                                     │  CHECK       │
                                                     │(deterministic)│
                                                     └─────────────┘
```

### Route Definitions

**CHAT** — "hello", "explain quantum computing", "write a poem", "what is 2+2"
**BROWSE** — "search amazon for keyboards", "go to github.com/anthropics", any message with a URL
**RESEARCH** — "research OpenClaw", "compare X across sites", "what are people saying about Y", "find information about Z from multiple sources"

---

## Part 3: File-by-File Specification

### New Files

```
src/main/llm/intake.ts          # Heuristic router + LLM intake (merged)
src/main/llm/synthesizer.ts     # Evidence → [S#]-cited response + coverage check
src/main/executor/runner.ts     # Parallel execution with heartbeat + budgets
src/main/executor/actions.ts    # SERP harvesting + source page extraction
src/main/executor/summarizer.ts # Condense for heartbeat + prepare evidence pack
src/main/browser/pool.ts        # Browser view pool (parallel invisible browsers)
```

### Modified Files

```
src/main/main.ts                # Route handling, pipeline wiring
src/main/preload.ts             # Research progress IPC
src/shared/types.ts             # TaskSpec, ActionResult, Evidence types
src/shared/ipc-channels.ts      # RESEARCH_PROGRESS channel
src/renderer/main.ts            # Research progress UI
src/renderer/styles.css         # Research progress styling
```

### Unchanged Files

```
src/main/llm/client.ts          # Reused for all LLM calls
src/main/llm/conversation.ts    # Unchanged
src/main/llm/tool-loop.ts       # Used for browse route
src/main/browser/tools.ts       # Used for browse route
src/main/browser/manager.ts     # Manages visible browser
```

---

## Part 4: Detailed Implementation

### 4.1 Types (`src/shared/types.ts` — ADD to bottom of existing file)

```typescript
// ============================================================================
// TASK INTAKE TYPES
// ============================================================================

export type RouteType = 'chat' | 'browse' | 'research';

export interface IntakeResult {
  route: RouteType;
  taskSpec?: TaskSpec;
}

export interface TaskSpec {
  userGoal: string;
  successCriteria: string[];
  deliverableSchema: string[];
  budget: {
    maxActions: number;       // Total browser navigations allowed (default 10)
    maxBatches: number;       // Heartbeat cycles allowed (default 3)
    maxTimeSeconds: number;   // Wall-clock hard stop (default 60)
  };
  actions: PlannedAction[];
}

export interface PlannedAction {
  id: string;
  type: 'search' | 'navigate';
  source: string;
  query?: string;
  url?: string;
  priority: number;           // 1 = highest; same priority = parallel
}

// ============================================================================
// EVIDENCE TYPES
// ============================================================================

/**
 * Each source gets a stable ID: S1, S2, S3...
 * The synthesizer MUST use [S#] to cite claims.
 */
export interface SourceEvidence {
  sourceId: string;           // "S1", "S2", etc.
  url: string;
  host: string;               // e.g., "en.wikipedia.org"
  title: string;
  retrievedAt: number;        // Date.now()
  rawContent: string;         // Main content, max 3000 chars
  keyFindings: string[];      // Top factual sentences from the page
}

export interface ActionResult {
  actionId: string;
  source: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startedAt?: number;
  completedAt?: number;
  /** Populated on success. May contain multiple SourceEvidence if a search action harvested links. */
  evidence?: SourceEvidence[];
  error?: { code: string; message: string };
}

// ============================================================================
// HEARTBEAT TYPES
// ============================================================================

export interface HeartbeatCheckpoint {
  checkpointNumber: number;
  completedSources: Array<{
    sourceId: string;
    host: string;
    title: string;
    findingsCount: number;
    snippet: string;          // First 200 chars — enough for quality assessment
  }>;
  successCriteria: string[];
  criteriaWithEvidence: string[];
  actionsRemaining: number;
  batchesRemaining: number;
  elapsedSeconds: number;
}

export interface HeartbeatResponse {
  action: 'continue' | 'done';
  newActions?: PlannedAction[];
}

// ============================================================================
// IPC PROGRESS TYPE
// ============================================================================

export interface ResearchProgress {
  phase: 'intake' | 'executing' | 'checkpoint' | 'synthesizing' | 'done';
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

### 4.2 IPC Channels (`src/shared/ipc-channels.ts` — ADD to existing IPC_EVENTS)

```typescript
export const IPC_EVENTS = {
  // ... ALL existing channels stay ...
  RESEARCH_PROGRESS: 'research:progress',
} as const;
```

### 4.3 Browser Pool (`src/main/browser/pool.ts`)

**Key fixes from v2**: 10x10 bounds (not 0x0), background throttling disabled, proper wait queue with timeouts.

```typescript
import { BrowserView, BrowserWindow } from 'electron';

interface PooledBrowser {
  view: BrowserView;
  inUse: boolean;
}

export class BrowserPool {
  private mainWindow: BrowserWindow;
  private pool: PooledBrowser[] = [];
  private maxSize: number;
  private waitQueue: Array<{
    resolve: (wc: Electron.WebContents) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(mainWindow: BrowserWindow, maxSize: number = 4) {
    this.mainWindow = mainWindow;
    this.maxSize = maxSize;
  }

  async acquire(timeoutMs: number = 15000): Promise<Electron.WebContents> {
    // 1. Reuse an idle browser
    const available = this.pool.find(b => !b.inUse);
    if (available) {
      available.inUse = true;
      return available.view.webContents;
    }

    // 2. Create new if under limit
    if (this.pool.length < this.maxSize) {
      const browser = this.createBrowser();
      this.pool.push({ view: browser, inUse: true });
      return browser.webContents;
    }

    // 3. Wait for release with timeout
    return new Promise<Electron.WebContents>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitQueue = this.waitQueue.filter(w => w.resolve !== resolve);
        reject(new Error(`BrowserPool: acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  release(webContents: Electron.WebContents): void {
    const pooled = this.pool.find(b => b.view.webContents === webContents);
    if (!pooled) return;

    if (this.waitQueue.length > 0) {
      // Hand off directly to next waiter
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(pooled.view.webContents);
    } else {
      pooled.inUse = false;
    }
  }

  releaseAll(): void {
    for (const pooled of this.pool) {
      pooled.inUse = false;
    }
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      const free = this.pool.find(b => !b.inUse);
      if (free) {
        free.inUse = true;
        waiter.resolve(free.view.webContents);
      }
    }
  }

  destroy(): void {
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('BrowserPool destroyed'));
    }
    this.waitQueue = [];

    for (const pooled of this.pool) {
      try {
        this.mainWindow.removeBrowserView(pooled.view);
        pooled.view.webContents.close();
      } catch (e) { /* view may already be destroyed */ }
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

    // Attach to window so JS execution works reliably.
    // Use 10x10 off-screen — 0x0 causes rendering/throttling bugs.
    this.mainWindow.addBrowserView(view);
    view.setBounds({ x: -100, y: -100, width: 10, height: 10 });

    // Prevent Electron from throttling background views
    view.webContents.setBackgroundThrottling(false);

    return view;
  }

  getPoolSize(): number { return this.pool.length; }
  getActiveCount(): number { return this.pool.filter(b => b.inUse).length; }
}
```

### 4.4 Action Executor (`src/main/executor/actions.ts`)

**Key design**: Two-step search. Step 1: load SERP, harvest links. Step 2: visit top N source pages, extract content. Also uses smart content extraction (article/main first, text-density fallback).

```typescript
import { PlannedAction, ActionResult, SourceEvidence } from '../../shared/types';
import { BrowserPool } from '../browser/pool';
import { randomUUID } from 'crypto';

// ============================================================================
// SEARCH URL BUILDERS
// ============================================================================

const SEARCH_URL_BUILDERS: Record<string, (query: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  reddit: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}&sort=relevance`,
  hackernews: (q) => `https://hn.algolia.com/?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
};

// Max source pages to visit per search action
const MAX_SOURCES_PER_SEARCH = 3;

// ============================================================================
// ACTION EXECUTOR
// ============================================================================

export class ActionExecutor {
  private pool: BrowserPool;
  private sourceCounter: number = 0;

  constructor(pool: BrowserPool) {
    this.pool = pool;
  }

  /** Reset source ID counter at the start of each research task */
  resetSourceCounter(): void {
    this.sourceCounter = 0;
  }

  private nextSourceId(): string {
    this.sourceCounter++;
    return `S${this.sourceCounter}`;
  }

  async execute(action: PlannedAction): Promise<ActionResult> {
    const result: ActionResult = {
      actionId: action.id,
      source: action.source,
      status: 'running',
      startedAt: Date.now(),
    };

    try {
      if (action.type === 'search') {
        result.evidence = await this.executeSearch(action);
      } else if (action.type === 'navigate') {
        result.evidence = await this.executeNavigate(action);
      } else {
        throw new Error(`Unknown action type: ${action.type}`);
      }

      result.status = 'success';
      result.completedAt = Date.now();
    } catch (error: any) {
      result.status = 'error';
      result.completedAt = Date.now();
      result.error = { code: 'EXECUTION_FAILED', message: error.message };
    }

    return result;
  }

  /**
   * TWO-STEP SEARCH:
   * 1. Load SERP → harvest organic result links
   * 2. Visit top N source pages → extract content from each
   *
   * Returns multiple SourceEvidence items (one per visited page).
   */
  private async executeSearch(action: PlannedAction): Promise<SourceEvidence[]> {
    if (!action.query) throw new Error('Search action requires query');

    const builder = SEARCH_URL_BUILDERS[action.source];
    if (!builder) throw new Error(`Unknown search source: ${action.source}`);

    // STEP 1: Load SERP and harvest links
    const serpUrl = builder(action.query);
    let browser: Electron.WebContents | null = null;
    let harvestedLinks: Array<{ url: string; title: string }> = [];

    try {
      browser = await this.pool.acquire();
      await this.navigateWithTimeout(browser, serpUrl, 12000);
      await this.sleep(2000); // Let SERP JS render

      harvestedLinks = await this.harvestSerpLinks(browser, action.source);
    } catch (error: any) {
      console.warn(`[ActionExecutor] SERP harvest failed for ${action.source}:`, error.message);
      // If SERP harvest fails, fall back to extracting the SERP page itself
      if (browser) {
        try {
          const fallback = await this.extractSourcePage(browser);
          this.pool.release(browser);
          return fallback ? [fallback] : [];
        } catch (e) { /* ignore */ }
      }
    } finally {
      if (browser) this.pool.release(browser);
    }

    if (harvestedLinks.length === 0) {
      return [];
    }

    // STEP 2: Visit top N source pages in parallel
    const toVisit = harvestedLinks.slice(0, MAX_SOURCES_PER_SEARCH);
    const evidencePromises = toVisit.map(link => this.visitSourcePage(link.url));
    const evidenceResults = await Promise.all(evidencePromises);

    // Filter out failures
    return evidenceResults.filter((e): e is SourceEvidence => e !== null);
  }

  /**
   * NAVIGATE action: go directly to a URL and extract content.
   * Returns a single SourceEvidence.
   */
  private async executeNavigate(action: PlannedAction): Promise<SourceEvidence[]> {
    const url = action.url;
    if (!url) throw new Error('Navigate action requires url');

    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    const evidence = await this.visitSourcePage(fullUrl);
    return evidence ? [evidence] : [];
  }

  /**
   * Visit a single page, extract content, return SourceEvidence.
   * Acquires and releases its own browser from the pool.
   */
  private async visitSourcePage(url: string): Promise<SourceEvidence | null> {
    let browser: Electron.WebContents | null = null;

    try {
      browser = await this.pool.acquire();
      await this.navigateWithTimeout(browser, url, 12000);
      await this.sleep(1500);

      return await this.extractSourcePage(browser);
    } catch (error: any) {
      console.warn(`[ActionExecutor] Failed to extract ${url}:`, error.message);
      return null;
    } finally {
      if (browser) this.pool.release(browser);
    }
  }

  /**
   * Extract content from the current page in the browser.
   * Uses smart extraction: article/main first, text-density fallback, then body.
   */
  private async extractSourcePage(browser: Electron.WebContents): Promise<SourceEvidence> {
    const data = await browser.executeJavaScript(`
      (function() {
        // Smart content extraction: find main content, not nav/footer garbage
        function getMainContent() {
          // Priority 1: semantic elements
          const semantic = document.querySelector('article, main, [role="main"], #content, #main-content, .post-content, .article-body, .entry-content');
          if (semantic && semantic.innerText.trim().length > 200) {
            return semantic.innerText.trim();
          }

          // Priority 2: highest text-density div
          const divs = Array.from(document.querySelectorAll('div, section'));
          let best = null;
          let bestScore = 0;
          for (const div of divs) {
            const text = div.innerText || '';
            const textLen = text.trim().length;
            const childCount = div.children.length || 1;
            // Score: text length penalized by nesting depth
            const depth = div.querySelectorAll('*').length;
            const score = textLen / Math.max(depth, 1);
            if (textLen > 200 && score > bestScore) {
              bestScore = score;
              best = div;
            }
          }
          if (best && best.innerText.trim().length > 200) {
            return best.innerText.trim();
          }

          // Priority 3: body fallback
          return (document.body.innerText || document.body.textContent || '').trim();
        }

        const content = getMainContent();
        // Clean: collapse whitespace, limit length
        const cleaned = content.replace(/\\s+/g, ' ').slice(0, 5000);

        return {
          url: window.location.href,
          host: window.location.hostname,
          title: document.title || '',
          text: cleaned,
        };
      })()
    `);

    return {
      sourceId: this.nextSourceId(),
      url: data.url,
      host: data.host,
      title: data.title,
      retrievedAt: Date.now(),
      rawContent: data.text.slice(0, 3000),
      keyFindings: this.extractFindings(data.text),
    };
  }

  /**
   * Harvest organic result links from a SERP page.
   * Uses different strategies per search engine.
   */
  private async harvestSerpLinks(
    browser: Electron.WebContents,
    source: string
  ): Promise<Array<{ url: string; title: string }>> {
    const links = await browser.executeJavaScript(`
      (function() {
        const results = [];
        const seen = new Set();

        // Strategy: find heading links in the main results area.
        // Works for Google, Bing, DuckDuckGo, and most search engines.
        const candidates = document.querySelectorAll('h3 a[href], h2 a[href], a h3, [data-header-feature] a[href]');

        for (const el of candidates) {
          const anchor = el.tagName === 'A' ? el : el.closest('a');
          if (!anchor) continue;

          let href = anchor.href;
          if (!href || href.startsWith('javascript:')) continue;

          // Skip internal/nav links
          if (href.includes('google.com/search') ||
              href.includes('google.com/url') ||
              href.includes('accounts.google') ||
              href.includes('support.google') ||
              href.includes('maps.google')) continue;

          // For Google, extract actual URL from redirect
          try {
            const url = new URL(href);
            if (url.hostname.includes('google') && url.searchParams.has('url')) {
              href = url.searchParams.get('url');
            } else if (url.hostname.includes('google') && url.searchParams.has('q') && url.pathname === '/url') {
              href = url.searchParams.get('q');
            }
          } catch (e) {}

          if (!href || seen.has(href)) continue;
          seen.add(href);

          const title = (anchor.innerText || anchor.textContent || '').trim();
          if (title.length > 3 && href.startsWith('http')) {
            results.push({ url: href, title: title.slice(0, 150) });
          }

          if (results.length >= 8) break;
        }

        // Fallback: if heading strategy failed, try all external links
        if (results.length < 2) {
          const allLinks = document.querySelectorAll('a[href^="http"]');
          for (const a of allLinks) {
            const href = a.href;
            const host = new URL(href).hostname;
            // Skip search engine's own links
            if (host.includes('google') || host.includes('bing') ||
                host.includes('reddit.com/search') || host.includes('github.com/search')) continue;
            if (seen.has(href)) continue;
            seen.add(href);

            const title = (a.innerText || '').trim();
            if (title.length > 3 && title.length < 200) {
              results.push({ url: href, title: title.slice(0, 150) });
            }
            if (results.length >= 8) break;
          }
        }

        return results;
      })()
    `);

    return links || [];
  }

  /**
   * Extract key findings from page text.
   * Heuristic: split into sentences, return the most informative ones.
   */
  private extractFindings(text: string): string[] {
    const sentences = text
      .split(/[.!?]\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 30 && s.length < 400)
      // Filter out obvious boilerplate
      .filter(s => {
        const lower = s.toLowerCase();
        return !lower.startsWith('skip to') &&
               !lower.startsWith('sign in') &&
               !lower.startsWith('cookie') &&
               !lower.startsWith('accept') &&
               !lower.startsWith('we use') &&
               !lower.includes('privacy policy') &&
               !lower.includes('terms of service') &&
               !lower.includes('subscribe to');
      });

    // Return first 8 meaningful sentences
    // These are the "facts" the synthesizer can cite
    return sentences.slice(0, 8);
  }

  private async navigateWithTimeout(
    browser: Electron.WebContents,
    url: string,
    timeoutMs: number
  ): Promise<void> {
    await Promise.race([
      browser.loadURL(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Navigation timeout: ${url}`)), timeoutMs)
      ),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 4.5 Summarizer (`src/main/executor/summarizer.ts`)

Builds heartbeat checkpoints and prepares the evidence pack for synthesis with `[S#]` source IDs.

```typescript
import { ActionResult, SourceEvidence, TaskSpec, HeartbeatCheckpoint } from '../../shared/types';

export class Summarizer {

  /**
   * Collect ALL SourceEvidence from all results into a flat array.
   * Each search action can produce multiple SourceEvidence items.
   */
  getAllEvidence(results: ActionResult[]): SourceEvidence[] {
    const all: SourceEvidence[] = [];
    for (const result of results) {
      if (result.status === 'success' && result.evidence) {
        all.push(...result.evidence);
      }
    }
    return all;
  }

  /**
   * Build heartbeat checkpoint. Keeps data small for the LLM.
   */
  buildCheckpoint(
    checkpointNumber: number,
    results: ActionResult[],
    taskSpec: TaskSpec,
    startTime: number
  ): HeartbeatCheckpoint {
    const allEvidence = this.getAllEvidence(results);

    // Determine which criteria have supporting evidence
    const criteriaWithEvidence = taskSpec.successCriteria.filter(criterion => {
      const words = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      return allEvidence.some(ev => {
        const content = ev.rawContent.toLowerCase();
        const hits = words.filter(w => content.includes(w)).length;
        return hits >= Math.ceil(words.length * 0.4);
      });
    });

    return {
      checkpointNumber,
      completedSources: allEvidence.map(ev => ({
        sourceId: ev.sourceId,
        host: ev.host,
        title: ev.title,
        findingsCount: ev.keyFindings.length,
        snippet: ev.rawContent.slice(0, 200),
      })),
      successCriteria: taskSpec.successCriteria,
      criteriaWithEvidence,
      actionsRemaining: taskSpec.budget.maxActions - results.length,
      batchesRemaining: taskSpec.budget.maxBatches - checkpointNumber,
      elapsedSeconds: (Date.now() - startTime) / 1000,
    };
  }

  /**
   * Prepare full evidence pack for synthesis.
   * Each source is labeled with [S#] so the synthesizer can cite them.
   */
  prepareForSynthesis(results: ActionResult[], taskSpec: TaskSpec): string {
    const sections: string[] = [];

    // Task context
    sections.push(`## Research Goal\n${taskSpec.userGoal}`);
    sections.push(`## Required Sections\n${taskSpec.deliverableSchema.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    sections.push(`## Success Criteria (MUST address each)\n${taskSpec.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
    sections.push('---');

    // Evidence from each source with [S#] labels
    const allEvidence = this.getAllEvidence(results);

    sections.push(`## Sources (${allEvidence.length} total)\n`);

    for (const ev of allEvidence) {
      let section = `### [${ev.sourceId}] ${ev.title}\n`;
      section += `Host: ${ev.host}\n`;
      section += `URL: ${ev.url}\n\n`;

      if (ev.keyFindings.length > 0) {
        section += `Key findings:\n`;
        for (const finding of ev.keyFindings) {
          section += `- ${finding}\n`;
        }
        section += '\n';
      }

      section += `Content excerpt:\n${ev.rawContent}\n`;
      sections.push(section);
    }

    // Source reference table at the end
    sections.push('---');
    sections.push('## Source Reference');
    for (const ev of allEvidence) {
      sections.push(`[${ev.sourceId}] ${ev.host} — ${ev.url}`);
    }

    return sections.join('\n\n');
  }
}
```

### 4.6 Executor Runner (`src/main/executor/runner.ts`)

Orchestrates parallel execution with budget enforcement and heartbeat checkpoints.

```typescript
import { BrowserWindow } from 'electron';
import {
  PlannedAction, ActionResult, TaskSpec,
  HeartbeatResponse, ResearchProgress,
} from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { BrowserPool } from '../browser/pool';
import { ActionExecutor } from './actions';
import { Summarizer } from './summarizer';
import { AnthropicClient } from '../llm/client';
import { Message } from '../../shared/types';
import { randomUUID } from 'crypto';

// ============================================================================
// HEARTBEAT PROMPT
// ============================================================================

const HEARTBEAT_PROMPT = `You review research progress and decide whether to continue or stop.

## Input

You receive:
- successCriteria: what the response must cover
- criteriaWithEvidence: which criteria have supporting evidence so far
- completedSources: summary of each source visited
- actionsRemaining / batchesRemaining: budget left
- elapsedSeconds: time spent so far

## Decision rules

1. If ALL criteria have evidence → done
2. If budget is low (actionsRemaining ≤ 1 or batchesRemaining ≤ 0) → done
3. If elapsed > 40 seconds → done
4. If key criteria are MISSING evidence AND budget remains → continue with TARGETED actions

## Response format

Respond with ONLY valid JSON. No explanation, no markdown fences.

To stop: {"action":"done"}

To continue (max 3 new actions):
{"action":"continue","newActions":[{"type":"search","source":"...","query":"...","priority":1}]}

## Rules for newActions
- Target the MISSING criteria specifically
- Do NOT repeat sources already visited (check completedSources hosts)
- Use specific queries, not generic ones`;

// ============================================================================
// EXECUTOR RUNNER
// ============================================================================

export class ExecutorRunner {
  private pool: BrowserPool;
  private actionExecutor: ActionExecutor;
  private summarizer: Summarizer;
  private client: AnthropicClient;
  private mainWindow: BrowserWindow;
  private stopped = false;
  private allResults: ActionResult[] = [];

  constructor(apiKey: string, pool: BrowserPool, mainWindow: BrowserWindow) {
    this.pool = pool;
    this.actionExecutor = new ActionExecutor(pool);
    this.summarizer = new Summarizer();
    this.client = new AnthropicClient(apiKey);
    this.mainWindow = mainWindow;
  }

  stop(): void {
    this.stopped = true;
    this.pool.releaseAll();
  }

  async execute(taskSpec: TaskSpec): Promise<ActionResult[]> {
    this.stopped = false;
    this.allResults = [];
    this.actionExecutor.resetSourceCounter();
    const startTime = Date.now();
    let batchCount = 0;
    let totalActionsExecuted = 0;
    let pendingActions = [...taskSpec.actions];

    this.sendProgress({
      phase: 'executing',
      message: `Searching ${pendingActions.length} sources...`,
      actions: pendingActions.map(a => ({
        id: a.id, source: a.source, status: 'pending' as const,
      })),
    });

    while (pendingActions.length > 0 && !this.stopped) {
      // === BUDGET GATES ===
      if (batchCount >= taskSpec.budget.maxBatches) {
        console.log('[Executor] Budget: max batches');
        break;
      }
      if (totalActionsExecuted >= taskSpec.budget.maxActions) {
        console.log('[Executor] Budget: max actions');
        break;
      }
      if ((Date.now() - startTime) / 1000 >= taskSpec.budget.maxTimeSeconds) {
        console.log('[Executor] Budget: time limit');
        break;
      }

      // Get next batch (all actions with the lowest priority)
      const batch = this.getNextBatch(pendingActions);
      if (batch.length === 0) break;

      // Cap to remaining budget
      const budgetLeft = taskSpec.budget.maxActions - totalActionsExecuted;
      const cappedBatch = batch.slice(0, budgetLeft);

      // Update UI: running
      for (const action of cappedBatch) {
        this.sendProgress({
          phase: 'executing',
          message: `Searching ${action.source}...`,
          actions: [{ id: action.id, source: action.source, status: 'running' }],
        });
      }

      // === EXECUTE BATCH IN PARALLEL ===
      const batchResults = await Promise.all(
        cappedBatch.map(action => this.actionExecutor.execute(action))
      );

      this.allResults.push(...batchResults);
      totalActionsExecuted += cappedBatch.length;

      // Remove executed from pending
      const executedIds = new Set(cappedBatch.map(a => a.id));
      pendingActions = pendingActions.filter(a => !executedIds.has(a.id));
      batchCount++;

      // Update UI: results
      for (const r of batchResults) {
        const evidenceCount = r.evidence?.length || 0;
        const preview = r.evidence?.[0]?.keyFindings[0]?.slice(0, 80);
        this.sendProgress({
          phase: 'executing',
          message: r.status === 'success'
            ? `✓ ${r.source} (${evidenceCount} sources)`
            : `✗ ${r.source}: ${r.error?.message || 'failed'}`,
          actions: [{ id: r.actionId, source: r.source, status: r.status, preview }],
        });
      }

      // === HEARTBEAT CHECKPOINT ===
      // Skip if this was the last allowed batch
      if (batchCount >= taskSpec.budget.maxBatches) break;
      if (totalActionsExecuted >= taskSpec.budget.maxActions) break;
      if (pendingActions.length === 0) {
        // No more pending — but heartbeat might add some
      }

      const checkpoint = this.summarizer.buildCheckpoint(
        batchCount, this.allResults, taskSpec, startTime
      );

      this.sendProgress({
        phase: 'checkpoint',
        message: `Checkpoint ${batchCount}: ${checkpoint.criteriaWithEvidence.length}/${taskSpec.successCriteria.length} criteria covered`,
        checkpointNumber: batchCount,
      });

      const decision = await this.heartbeat(checkpoint, taskSpec.userGoal);

      if (decision.action === 'done') {
        console.log('[Executor] Heartbeat: done');
        break;
      }

      if (decision.action === 'continue' && decision.newActions?.length) {
        const newActions: PlannedAction[] = decision.newActions.map(a => ({
          ...a,
          id: a.id || randomUUID(),
          priority: a.priority || 1,
        }));
        pendingActions.push(...newActions);

        this.sendProgress({
          phase: 'executing',
          message: `Going deeper: ${newActions.length} more searches...`,
          actions: newActions.map(a => ({
            id: a.id, source: a.source, status: 'pending' as const,
          })),
        });
      }
    }

    return this.allResults;
  }

  private getNextBatch(pending: PlannedAction[]): PlannedAction[] {
    if (pending.length === 0) return [];
    const minPriority = Math.min(...pending.map(a => a.priority));
    return pending.filter(a => a.priority === minPriority);
  }

  private async heartbeat(checkpoint: any, goal: string): Promise<HeartbeatResponse> {
    const messages: Message[] = [{
      id: 'hb',
      role: 'user',
      content: `Original goal: "${goal}"\n\nCheckpoint:\n${JSON.stringify(checkpoint, null, 2)}`,
      createdAt: new Date().toISOString(),
    }];

    try {
      const response = await this.client.chat(messages, [], HEARTBEAT_PROMPT);
      const text = response.content.find(b => b.type === 'text');
      if (!text || text.type !== 'text') return { action: 'done' };

      const cleaned = text.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('[Executor] Heartbeat failed:', error);
      return { action: 'done' };
    }
  }

  private sendProgress(progress: ResearchProgress): void {
    this.mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, progress);
  }
}
```

### 4.7 Intake (`src/main/llm/intake.ts`)

Heuristic router (zero latency) + LLM intake (one call for classification + TaskSpec). Includes basic validation on LLM output.

```typescript
import { AnthropicClient } from './client';
import { Message, IntakeResult, TaskSpec, PlannedAction, RouteType } from '../../shared/types';
import { randomUUID } from 'crypto';

// ============================================================================
// HEURISTIC ROUTER — zero latency
// ============================================================================

const URL_PATTERN = /https?:\/\/[^\s]+/i;
const SITE_NAMES = /\b(amazon|ebay|google|github|reddit|youtube|twitter|wikipedia|hacker\s*news|stackoverflow|yelp|netflix)\b/i;
const BROWSE_VERBS = /\b(go to|navigate to|open|visit|show me|search\s+\w+\s+for|look up on|check out)\b/i;
const RESEARCH_SIGNALS = /\b(research|compare across|find info|find information|from multiple|what are people saying|comprehensive|in-depth|deep dive|tell me everything|gather information|investigate)\b/i;
const CHAT_SIGNALS = /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|what is|explain|write|help me write|create|generate|how do i|how does|what does|can you)\b/i;

export function heuristicRoute(message: string): RouteType | null {
  const trimmed = message.trim().toLowerCase();

  if (trimmed.length < 15 && !URL_PATTERN.test(message) && !SITE_NAMES.test(message)) {
    return 'chat';
  }
  if (URL_PATTERN.test(message)) return 'browse';
  if (RESEARCH_SIGNALS.test(message)) return 'research';
  if (BROWSE_VERBS.test(message) && SITE_NAMES.test(message)) return 'browse';
  if (BROWSE_VERBS.test(message)) return 'browse';
  if (CHAT_SIGNALS.test(message) && !SITE_NAMES.test(message)) return 'chat';

  return null; // Ambiguous — needs LLM
}

// ============================================================================
// LLM INTAKE PROMPT
// ============================================================================

const INTAKE_PROMPT = `You are a task intake system. Classify the user's message and, if it's research, produce a TaskSpec.

## Routes

- **chat**: Answerable from knowledge, creative writing, coding, conversation. No browser needed.
- **browse**: Interaction with ONE website. Searching a site, navigating a URL, reading a page.
- **research**: Needs MULTIPLE sources. Comparing, investigating, comprehensive overviews, gathering opinions.

## Response format

For chat or browse, respond with ONLY:
{"route":"chat"} or {"route":"browse"}

For research, respond with ONLY:
{
  "route":"research",
  "taskSpec":{
    "userGoal":"one sentence",
    "successCriteria":["criterion 1","criterion 2","criterion 3"],
    "deliverableSchema":["Section 1","Section 2","Section 3"],
    "actions":[
      {"type":"search","source":"google","query":"...","priority":1},
      {"type":"search","source":"wikipedia","query":"...","priority":1}
    ]
  }
}

## TaskSpec rules

- successCriteria: 3-6 things the response MUST cover. Drives "done" detection.
- deliverableSchema: Section titles for the final response. Maps to criteria.
- actions: 2-5 searches. Same priority = run in parallel.
- Available sources: google, github, wikipedia, reddit, hackernews, youtube, amazon, stackoverflow
- Prioritize authoritative sources for the topic.

## Examples

"hello" → {"route":"chat"}
"search amazon for keyboards" → {"route":"browse"}
"what is OpenClaw and how do I use it" → research with criteria: ["What OpenClaw is","How to install it","Key features","How to use it"]

Respond with ONLY valid JSON. No explanation, no markdown fences.`;

// ============================================================================
// INTAKE CLASS
// ============================================================================

export class Intake {
  private client: AnthropicClient;

  constructor(apiKey: string) {
    this.client = new AnthropicClient(apiKey);
  }

  async process(userMessage: string): Promise<IntakeResult> {
    // Step 1: Heuristic (zero latency)
    const heuristic = heuristicRoute(userMessage);
    if (heuristic === 'chat') return { route: 'chat' };
    if (heuristic === 'browse') return { route: 'browse' };

    // Step 2: LLM intake (research detected by heuristic, or ambiguous)
    return this.llmIntake(userMessage);
  }

  private async llmIntake(userMessage: string): Promise<IntakeResult> {
    const messages: Message[] = [{
      id: 'user-1',
      role: 'user',
      content: userMessage,
      createdAt: new Date().toISOString(),
    }];

    try {
      const response = await this.client.chat(messages, [], INTAKE_PROMPT);
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') return { route: 'browse' };

      const cleaned = textBlock.text
        .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.route === 'chat') return { route: 'chat' };
      if (parsed.route === 'browse') return { route: 'browse' };

      if (parsed.route === 'research' && parsed.taskSpec) {
        return { route: 'research', taskSpec: this.validateTaskSpec(parsed.taskSpec, userMessage) };
      }

      return { route: 'browse' };
    } catch (error) {
      console.error('[Intake] Failed:', error);
      return { route: 'browse' };
    }
  }

  /**
   * Validate and sanitize the LLM's TaskSpec output.
   * Ensures required fields exist, types are correct, and budgets are set.
   */
  private validateTaskSpec(raw: any, fallbackGoal: string): TaskSpec {
    // Validate actions
    const actions: PlannedAction[] = [];
    if (Array.isArray(raw.actions)) {
      for (const a of raw.actions) {
        if (!a.type || !a.source) continue;
        if (a.type === 'search' && !a.query) continue;
        if (a.type === 'navigate' && !a.url) continue;

        actions.push({
          id: randomUUID(),
          type: a.type === 'navigate' ? 'navigate' : 'search',
          source: String(a.source),
          query: a.query ? String(a.query) : undefined,
          url: a.url ? String(a.url) : undefined,
          priority: typeof a.priority === 'number' ? a.priority : 1,
        });
      }
    }

    // Fallback: if no valid actions, do a Google search
    if (actions.length === 0) {
      actions.push({
        id: randomUUID(),
        type: 'search',
        source: 'google',
        query: fallbackGoal,
        priority: 1,
      });
    }

    // Cap actions at 5 in initial plan
    const cappedActions = actions.slice(0, 5);

    // Validate criteria
    let criteria = Array.isArray(raw.successCriteria)
      ? raw.successCriteria.filter((c: any) => typeof c === 'string' && c.length > 0)
      : [];
    if (criteria.length === 0) criteria = [fallbackGoal];

    let schema = Array.isArray(raw.deliverableSchema)
      ? raw.deliverableSchema.filter((s: any) => typeof s === 'string' && s.length > 0)
      : [];
    if (schema.length === 0) schema = ['Overview'];

    return {
      userGoal: typeof raw.userGoal === 'string' ? raw.userGoal : fallbackGoal,
      successCriteria: criteria,
      deliverableSchema: schema,
      budget: {
        maxActions: 10,
        maxBatches: 3,
        maxTimeSeconds: 60,
      },
      actions: cappedActions,
    };
  }
}
```

### 4.8 Synthesizer (`src/main/llm/synthesizer.ts`)

**Key change from v2**: Enforced `[S#]` citation format. Every factual sentence must cite its source.

```typescript
import { BrowserWindow } from 'electron';
import { AnthropicClient } from './client';
import { ActionResult, TaskSpec, ResearchProgress, Message } from '../../shared/types';
import { Summarizer } from '../executor/summarizer';
import { IPC_EVENTS } from '../../shared/ipc-channels';

// ============================================================================
// SYNTHESIZER PROMPT — enforces [S#] citations
// ============================================================================

const SYNTHESIZER_PROMPT = `You are a research synthesizer. Create a comprehensive response using ONLY the provided evidence.

## CITATION RULES (mandatory)

1. Every factual sentence MUST end with a source citation: [S1], [S2], etc.
2. If a fact is supported by multiple sources, cite all: [S1][S3]
3. If you make an inference not directly from a source, mark it as (inference) with no citation.
4. If a success criterion cannot be answered from the evidence, explicitly state: "This could not be determined from available sources."
5. Do NOT add information from your general knowledge. Only use the provided evidence.

## STRUCTURE RULES

1. Use the deliverableSchema section titles as markdown ## headers.
2. Address EVERY success criterion — the user expects each to be covered.
3. When sources disagree, note the disagreement and cite both.
4. Be thorough but concise.

## SOURCES SECTION

At the end of your response, include:

## Sources
- [S1] description — URL
- [S2] description — URL
(for every source you cited)

## Example of correct citation style

OpenClaw is an open-source autonomous AI assistant that runs locally on user devices [S1]. It was originally released in November 2025 under the name Clawbot [S1][S3]. The project gained over 100,000 GitHub stars within two months of release [S2]. Some security researchers have raised concerns about its broad system access (inference).`;

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

  async synthesize(taskSpec: TaskSpec, results: ActionResult[]): Promise<string> {
    this.sendProgress({
      phase: 'synthesizing',
      message: 'Synthesizing research findings...',
    });

    const evidencePack = this.summarizer.prepareForSynthesis(results, taskSpec);

    const messages: Message[] = [{
      id: 'synthesis',
      role: 'user',
      content: `Research query: "${taskSpec.userGoal}"\n\n${evidencePack}\n\nSynthesize this into a comprehensive, cited response.`,
      createdAt: new Date().toISOString(),
    }];

    let fullResponse = '';

    const response = await this.client.chat(
      messages, [], SYNTHESIZER_PROMPT,
      (text) => {
        fullResponse += text;
        this.mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
      }
    );

    const textContent = response.content.find(b => b.type === 'text');
    if (textContent && textContent.type === 'text') {
      fullResponse = textContent.text;
    }

    // Coverage check
    const coverage = this.checkCoverage(fullResponse, taskSpec);
    console.log(`[Synthesizer] Coverage: ${coverage.coveredCount}/${taskSpec.successCriteria.length}`);
    if (coverage.missingCriteria.length > 0) {
      console.warn('[Synthesizer] Missing criteria:', coverage.missingCriteria);
    }

    // Citation check
    const citations = this.checkCitations(fullResponse, results);
    console.log(`[Synthesizer] Citations found: ${citations.citedSources.length}, uncited sources: ${citations.uncitedSources.length}`);

    this.sendProgress({
      phase: 'done',
      message: `Research complete. ${coverage.coveredCount}/${taskSpec.successCriteria.length} criteria covered, ${citations.citedSources.length} sources cited.`,
    });

    return fullResponse;
  }

  /**
   * Deterministic coverage check.
   * Does the response address each success criterion?
   */
  private checkCoverage(
    response: string,
    taskSpec: TaskSpec
  ): { coveredCount: number; missingCriteria: string[] } {
    const lower = response.toLowerCase();
    const missing: string[] = [];

    for (const criterion of taskSpec.successCriteria) {
      const words = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const hits = words.filter(w => lower.includes(w)).length;
      if (hits < Math.ceil(words.length * 0.4)) {
        missing.push(criterion);
      }
    }

    return {
      coveredCount: taskSpec.successCriteria.length - missing.length,
      missingCriteria: missing,
    };
  }

  /**
   * Check which [S#] citations appear in the response.
   */
  private checkCitations(
    response: string,
    results: ActionResult[]
  ): { citedSources: string[]; uncitedSources: string[] } {
    const allEvidence = this.summarizer.getAllEvidence(results);
    const allIds = allEvidence.map(e => e.sourceId);

    const cited = allIds.filter(id => response.includes(`[${id}]`));
    const uncited = allIds.filter(id => !response.includes(`[${id}]`));

    return { citedSources: cited, uncitedSources: uncited };
  }

  private sendProgress(progress: ResearchProgress): void {
    this.mainWindow.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, progress);
  }
}
```

### 4.9 Main Integration (`src/main/main.ts`)

**CRITICAL**: Read the existing main.ts first. Only ADD imports, ADD globals, REPLACE the CHAT_SEND handler, and ADD the route handler functions. Do not delete or modify anything else.

Also: the existing code may have a `toolLoop` variable scoped inside the handler or as a module-level variable. Check this. Both `toolLoop` and `executorRunner` must be accessible from the CHAT_STOP handler.

```typescript
// ============================================================================
// ADD IMPORTS (at top of file, alongside existing imports)
// ============================================================================
import { Intake } from './llm/intake';
import { Synthesizer } from './llm/synthesizer';
import { ExecutorRunner } from './executor/runner';
import { BrowserPool } from './browser/pool';
import { TaskSpec, ResearchProgress } from '../shared/types';

// ============================================================================
// ADD MODULE-LEVEL GLOBALS (near existing globals)
// Ensure toolLoop is also module-level if it isn't already.
// ============================================================================
let browserPool: BrowserPool | null = null;
let activeExecutor: ExecutorRunner | null = null;
// If toolLoop isn't already module-level, move it here:
// let activeToolLoop: ToolLoop | null = null;

// ============================================================================
// REPLACE the CHAT_SEND handler
// ============================================================================
ipcMain.handle(IPC.CHAT_SEND, async (_event, conversationId: string, content: string) => {
  if (!mainWindow) return { error: 'No window' };

  let conversation = conversationManager.get(conversationId);
  if (!conversation) {
    conversation = conversationManager.create();
  }

  conversationManager.addMessage(conversation.id, { role: 'user', content });

  const apiKey = store.get('anthropic_api_key') as string | undefined;
  if (!apiKey) {
    mainWindow.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: 'No API key configured' });
    return { error: 'No API key' };
  }

  try {
    const intake = new Intake(apiKey);
    const result = await intake.process(content);
    console.log(`[Main] Route: ${result.route}`);

    let response: string;

    switch (result.route) {
      case 'chat':
        response = await handleChatRoute(apiKey, conversation.messages, mainWindow);
        break;
      case 'browse':
        response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
        break;
      case 'research':
        response = await handleResearchRoute(apiKey, content, result.taskSpec!, mainWindow);
        break;
      default:
        response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
    }

    conversationManager.addMessage(conversation.id, { role: 'assistant', content: response });
    return { conversationId: conversation.id };
  } catch (error: any) {
    console.error('[Main] Error:', error);
    mainWindow.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: error.message });
    return { error: error.message };
  }
});

// ============================================================================
// ROUTE HANDLERS (add as new functions)
// ============================================================================

async function handleChatRoute(
  apiKey: string,
  messages: Message[],
  win: BrowserWindow
): Promise<string> {
  const client = new AnthropicClient(apiKey);
  let fullResponse = '';

  const response = await client.chat(
    messages, [],
    'You are a helpful AI assistant. Respond naturally and helpfully.',
    (text) => {
      fullResponse += text;
      win.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
    }
  );

  const textContent = response.content.find(b => b.type === 'text');
  if (textContent && textContent.type === 'text') fullResponse = textContent.text;

  win.webContents.send(IPC_EVENTS.CHAT_STREAM_END, fullResponse);
  return fullResponse;
}

async function handleBrowseRoute(
  apiKey: string,
  messages: Message[],
  win: BrowserWindow
): Promise<string> {
  const llmClient = new AnthropicClient(apiKey);
  const browserTools = new BrowserTools();
  // Store reference for CHAT_STOP. Adjust variable name to match your existing code.
  const loop = new ToolLoop(llmClient, browserTools, win);
  // If you have a module-level toolLoop variable, assign it:
  // activeToolLoop = loop;
  return loop.run(messages);
}

async function handleResearchRoute(
  apiKey: string,
  query: string,
  taskSpec: TaskSpec,
  win: BrowserWindow
): Promise<string> {
  if (!browserPool) {
    browserPool = new BrowserPool(win, 4);
  }

  win.webContents.send(IPC_EVENTS.RESEARCH_PROGRESS, {
    phase: 'intake',
    message: `Planning: ${taskSpec.actions.length} sources to search, ${taskSpec.successCriteria.length} criteria to cover`,
  } as ResearchProgress);

  console.log('[Research] TaskSpec:', JSON.stringify(taskSpec, null, 2));

  activeExecutor = new ExecutorRunner(apiKey, browserPool, win);
  const results = await activeExecutor.execute(taskSpec);
  activeExecutor = null;

  const successCount = results.filter(r => r.status === 'success').length;
  console.log(`[Research] Done: ${successCount}/${results.length} actions succeeded`);

  const synthesizer = new Synthesizer(apiKey, win);
  const response = await synthesizer.synthesize(taskSpec, results);

  win.webContents.send(IPC_EVENTS.CHAT_STREAM_END, response);
  return response;
}

// ============================================================================
// MODIFY CHAT_STOP handler (ensure both tool loop and executor can be stopped)
// ============================================================================
ipcMain.handle(IPC.CHAT_STOP, async () => {
  // Stop existing tool loop if running (adjust variable name to your code)
  // if (activeToolLoop) { activeToolLoop.stop(); activeToolLoop = null; }
  if (activeExecutor) {
    activeExecutor.stop();
    activeExecutor = null;
  }
  return { stopped: true };
});
```

### 4.10 Preload (`src/main/preload.ts` — ADD to existing api object)

```typescript
onResearchProgress: (callback: (progress: any) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress);
  ipcRenderer.on('research:progress', handler);
  return () => ipcRenderer.removeListener('research:progress', handler);
},
```

### 4.11 Renderer (`src/renderer/main.ts` — ADD research progress UI)

Add to `window.api` type:

```typescript
onResearchProgress: (callback: (progress: {
  phase: string;
  message: string;
  actions?: Array<{ id: string; source: string; status: string; preview?: string }>;
  checkpointNumber?: number;
}) => void) => () => void;
```

Add state + handler:

```typescript
// ============================================================================
// RESEARCH PROGRESS
// ============================================================================

let researchContainer: HTMLDivElement | null = null;
let knownActions: Map<string, { source: string; status: string; preview?: string }> = new Map();

// Wire up in your initialization (setupChatListeners or equivalent):
window.api.onResearchProgress((progress) => {
  renderResearchProgress(progress);
});

function renderResearchProgress(progress: {
  phase: string;
  message: string;
  actions?: Array<{ id: string; source: string; status: string; preview?: string }>;
  checkpointNumber?: number;
}) {
  if (!researchContainer) {
    researchContainer = document.createElement('div');
    researchContainer.className = 'research-progress';
    outputEl.appendChild(researchContainer);
    knownActions = new Map();
    scrollToBottom();
  }

  // Accumulate action states
  if (progress.actions) {
    for (const a of progress.actions) {
      knownActions.set(a.id, { source: a.source, status: a.status, preview: a.preview });
    }
  }

  let html = '';

  // Phase
  const label: Record<string, string> = {
    intake: '◇ Planning...',
    executing: '◈ Searching...',
    checkpoint: '◆ Reviewing...',
    synthesizing: '◈ Writing...',
    done: '● Done',
  };
  html += `<div class="rp-phase">${label[progress.phase] || progress.message}</div>`;

  // Actions
  if (knownActions.size > 0) {
    html += '<div class="rp-actions">';
    for (const [, a] of knownActions) {
      const icons: Record<string, string> = { pending: '○', running: '◌', success: '✓', error: '✗' };
      html += `<div class="rp-action rp-${a.status}">
        <span class="rp-icon">${icons[a.status] || '○'}</span>
        <span class="rp-source">${a.source}</span>
        ${a.preview ? `<span class="rp-preview">${a.preview}</span>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  if (progress.checkpointNumber) {
    html += `<div class="rp-checkpoint">◆ Checkpoint ${progress.checkpointNumber}</div>`;
  }

  researchContainer.innerHTML = html;
  scrollToBottom();

  if (progress.phase === 'done' || progress.phase === 'synthesizing') {
    researchContainer = null;
    knownActions = new Map();
  }
}

// Utility (add if not already present)
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

### 4.12 CSS (`src/renderer/styles.css` — ADD to bottom)

```css
/* Research Progress */
.research-progress {
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  margin-bottom: 12px;
  border-left: 2px solid rgba(255, 255, 255, 0.08);
}

.rp-phase {
  color: #888;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
}

.rp-actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rp-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.rp-icon { width: 14px; text-align: center; }
.rp-pending .rp-icon { color: #555; }
.rp-running .rp-icon { color: #888; animation: rp-pulse 1.5s ease-in-out infinite; }
.rp-success .rp-icon { color: #6a6; }
.rp-error .rp-icon { color: #a55; }

.rp-source { color: #aaa; min-width: 90px; }

.rp-preview {
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.rp-checkpoint {
  margin-top: 6px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  color: #777;
  font-size: 11px;
}

@keyframes rp-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
```

---

## Part 5: All System Prompts (reference)

| Prompt | Location | Purpose | Output format |
|--------|----------|---------|---------------|
| INTAKE_PROMPT | `intake.ts` | Classify + TaskSpec | JSON only |
| HEARTBEAT_PROMPT | `runner.ts` | Continue/done decision | JSON only |
| SYNTHESIZER_PROMPT | `synthesizer.ts` | Evidence → cited response | Markdown with [S#] |
| Chat system prompt | `main.ts` handleChatRoute | General chat | Free text |
| Browse system prompt | `tool-loop.ts` (existing) | Browser tool instructions | Free text |

---

## Part 6: Build Order

**Build exactly in this order. Verify at each step before proceeding.**

### Phase 1: Types + IPC (5 min)
1. Add all types to `src/shared/types.ts`
2. Add `RESEARCH_PROGRESS` to `src/shared/ipc-channels.ts`
3. **Verify**: `npm run build:main` compiles

### Phase 2: Browser Pool (10 min)
1. Create `src/main/browser/pool.ts`
2. **Verify**: Temporary test — acquire 2 browsers, navigate both to different URLs, release both. No crashes.

### Phase 3: Action Executor (20 min)
1. Create `src/main/executor/actions.ts`
2. **Verify**: Execute a single Google search action. Check that:
   - SERP links are harvested (console.log the links)
   - Source pages are visited
   - evidence[] has multiple SourceEvidence items with sourceIds

### Phase 4: Summarizer (10 min)
1. Create `src/main/executor/summarizer.ts`
2. **Verify**: Pass mock ActionResults to `prepareForSynthesis()`. Check output has [S#] labels.

### Phase 5: Intake (15 min)
1. Create `src/main/llm/intake.ts`
2. **Verify heuristic**:
   - `"hello"` → chat
   - `"go to amazon.com"` → browse
   - `"https://github.com"` → browse
   - `"research OpenClaw"` → research
   - `"what are people saying about Claude"` → research
3. **Verify LLM intake**: process("research Claude AI") returns TaskSpec with criteria and actions

### Phase 6: Executor Runner (15 min)
1. Create `src/main/executor/runner.ts`
2. **Verify**: Execute a 2-action plan. Check parallel start (both actions begin near-simultaneously). Check heartbeat fires.

### Phase 7: Synthesizer (10 min)
1. Create `src/main/llm/synthesizer.ts`
2. **Verify**: Pass real results to synthesize(). Check response contains [S#] citations. Check Sources section at bottom.

### Phase 8: Integration (15 min)
1. Modify `src/main/main.ts`
2. Modify `src/main/preload.ts`
3. Modify `src/renderer/main.ts`
4. Add CSS to `src/renderer/styles.css`
5. **Verify**: `npm run build` compiles clean

### Phase 9: End-to-End (10 min)
1. **Chat**: "What is 2+2?" → Direct response, no browser, no progress UI
2. **Browse**: "Search Amazon for keyboards" → Tool loop, browser visible
3. **Research**: "Research Claude AI and how to use it" → Should show:
   - Progress: planning → searching (parallel) → checkpoint → synthesizing
   - Response with [S#] citations and Sources section
   - Total: 3-4 API calls, under 30 seconds

---

## Part 7: Error Handling Summary

| Component | Failure | Recovery |
|-----------|---------|----------|
| Heuristic router | Can't fail | Returns null → LLM intake |
| LLM intake | API error / JSON parse | Default to browse route |
| Intake validation | Bad TaskSpec fields | Sanitize + fallback values |
| Browser pool acquire | Timeout (15s) | Action fails, others continue |
| Navigation | Timeout (12s) | Action fails with error |
| SERP harvest | No links found | Fall back to SERP page text |
| Source page extract | JS error / timeout | Return null, skip source |
| Heartbeat | API error / JSON parse | Default to "done" |
| Synthesis | API error | Return error message to user |
| Coverage check | Low coverage | Log warning (don't block) |
| Citation check | Low citations | Log warning (don't block) |

---

## Part 8: Performance Expectations

| Route | API Calls | Wall Time | Token Cost |
|-------|-----------|-----------|------------|
| Chat (heuristic) | 1 | ~2s | Low |
| Chat (LLM routed) | 2 | ~5s | Low |
| Browse | Same as before | Same | Same |
| Research | 3-4 | 15-25s | Medium |

Research breakdown:
1. Intake (0-1 call, heuristic may handle)
2. Parallel browser execution (0 calls, ~5-8s)
3. Heartbeat (1 call, ~3s)
4. Synthesis (1 call, ~5-8s streaming)

---

## Implementation Checklist

- [ ] Types in `src/shared/types.ts`
- [ ] IPC channel in `src/shared/ipc-channels.ts`
- [ ] `src/main/browser/pool.ts`
- [ ] `src/main/executor/actions.ts`
- [ ] `src/main/executor/summarizer.ts`
- [ ] `src/main/llm/intake.ts`
- [ ] `src/main/executor/runner.ts`
- [ ] `src/main/llm/synthesizer.ts`
- [ ] Modified `src/main/main.ts`
- [ ] Modified `src/main/preload.ts`
- [ ] Modified `src/renderer/main.ts`
- [ ] CSS in `src/renderer/styles.css`
- [ ] Test: chat route
- [ ] Test: browse route
- [ ] Test: research route (citations present, sources section, <30s)
