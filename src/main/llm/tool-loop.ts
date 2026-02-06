import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { homedir } from 'os';
import * as path from 'path';
import { AnthropicClient } from './client';
import { Message } from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { buildSystemPrompt } from './system-prompt';
import { getModelLabel } from '../../shared/models';
import { BROWSER_TOOL_DEFINITIONS, executeTool as executeBrowserTool } from '../browser/tools';
import { LOCAL_TOOL_DEFINITIONS, executeLocalTool } from '../local/tools';
import { generateSynthesisThought, generateThought } from './thought-generator';
import {
  createInterceptor,
  detectMode,
  extractHtml,
  findClosingFence,
  extractPostChat,
  StreamInterceptorState,
} from './stream-interceptor';
import {
  createLivePreviewTab,
  writeLiveHtml,
  closeLiveHtml,
} from '../browser/manager';

const MAX_TOOL_CALLS = 25;
const MAX_HISTORY_MESSAGES = 14;
const MAX_TOOL_RESULT_IN_HISTORY = 2000; // chars — roughly 500 tokens
const KEEP_FULL_TOOL_RESULTS = 2; // keep last N tool_result messages uncompressed
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((tool) => tool.name));
const ALL_TOOLS = [...BROWSER_TOOL_DEFINITIONS, ...LOCAL_TOOL_DEFINITIONS];
const LOCAL_WRITE_TOOL_NAMES = new Set(['file_write', 'file_edit']);
const BROWSER_NAVIGATION_TOOL_NAMES = new Set([
  'browser_search',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_tab',
]);
const BROWSER_PAGE_STATE_READ_TOOL_NAMES = new Set([
  'browser_read_page',
  'browser_screenshot',
]);
const BROWSER_STATELESS_TOOL_NAMES = new Set([
  'browser_news',
  'browser_shopping',
  'browser_places',
  'browser_images',
]);

interface SearchEntry {
  tokens: string[];
  raw: string;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ExecutionTask {
  toolCall: ToolCall;
  skip?: string;
}

interface ToolExecutionResult {
  id: string;
  content: string;
}

function normalizeTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    )
  ).sort();
}

function isDuplicateSearch(query: string, history: SearchEntry[]): boolean {
  const tokens = normalizeTokens(query);
  if (!tokens.length) return false;
  for (const entry of history) {
    if (!entry.tokens.length) continue;
    const overlap = entry.tokens.filter((token) => tokens.includes(token)).length;
    const base = Math.max(entry.tokens.length, tokens.length);
    if (base > 0 && overlap / base >= 0.8) {
      return true;
    }
  }
  return false;
}

function makeMessage(role: Message['role'], content: string): Message {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Truncate a tool result string for storage in conversation history.
 * The LLM already saw the full result in the current iteration;
 * subsequent API calls only need a summary.
 */
function truncateForHistory(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_IN_HISTORY) return result;
  const head = result.slice(0, 1400);
  const tail = result.slice(-500);
  const lineCount = (result.match(/\n/g) || []).length;
  return `${head}\n\n[... truncated ${result.length - 1900} chars, ~${lineCount} lines ...]\n\n${tail}`;
}

/**
 * Compress old tool_result messages in the conversation history.
 * Keeps the last KEEP_FULL_TOOL_RESULTS tool_result messages at full size;
 * truncates everything older. This dramatically reduces input tokens
 * on iterations 5+ of a tool loop.
 */
function compressOldToolResults(messages: Message[]): void {
  // Walk backwards to find tool_result messages (stored as JSON arrays)
  let toolResultCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !msg.content.startsWith('[')) continue;

    let parsed: unknown[];
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const hasToolResult = parsed.some(
      (block: any) => block?.type === 'tool_result'
    );
    if (!hasToolResult) continue;

    toolResultCount++;
    if (toolResultCount <= KEEP_FULL_TOOL_RESULTS) continue;

    // Truncate tool result content in this message
    let changed = false;
    const compressed = parsed.map((block: any) => {
      if (
        block?.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length > MAX_TOOL_RESULT_IN_HISTORY
      ) {
        changed = true;
        return { ...block, content: truncateForHistory(block.content) };
      }
      return block;
    });

    if (changed) {
      messages[i] = { ...msg, content: JSON.stringify(compressed) };
    }
  }
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name.startsWith('browser_')) {
    return executeBrowserTool(name, input);
  }
  if (LOCAL_TOOL_NAMES.has(name)) {
    return executeLocalTool(name, input);
  }
  return `Unknown tool: ${name}`;
}

export class ToolLoop {
  private window: BrowserWindow;
  private client: AnthropicClient;
  private aborted = false;
  /** True if the response was streamed chunk-by-chunk to the renderer. */
  streamed = false;
  /** Promise queue that serializes all async browser writes. */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Tracks how many chars of post-HTML chat text have been emitted. */
  private postChatEmitted = 0;

  constructor(window: BrowserWindow, client: AnthropicClient) {
    this.window = window;
    this.client = client;
  }

  abort(): void {
    this.aborted = true;
  }

  async run(userMessage: string, history: Message[]): Promise<string> {
    this.aborted = false;
    this.streamed = false;
    this.writeQueue = Promise.resolve();
    this.postChatEmitted = 0;
    this.emitThinking(generateSynthesisThought(0));

    const totalStart = performance.now();
    console.time('[Perf] Total request');

    const promptStart = performance.now();
    const modelLabel = getModelLabel(this.client.getModel());
    const systemPrompt = buildSystemPrompt() + `\n\nYou are running as Claude ${modelLabel}.`;
    console.log(`[Perf] System prompt: ${(performance.now() - promptStart).toFixed(1)}ms`);

    const histStart = performance.now();
    const messages = this.trimHistory(history);
    messages.push(makeMessage('user', userMessage));
    console.log(`[Perf] History assembly: ${(performance.now() - histStart).toFixed(1)}ms (${messages.length} messages)`);

    const searchHistory: SearchEntry[] = [];
    let toolCallCount = 0;

    for (let iteration = 0; iteration < MAX_TOOL_CALLS + 2; iteration++) {
      if (this.aborted) {
        this.emitThinking('');
        return '[Stopped]';
      }

      if (toolCallCount >= MAX_TOOL_CALLS) {
        const text = await this.forceFinalResponseAtToolLimit(messages, systemPrompt);
        this.emitThinking('');
        console.timeEnd('[Perf] Total request');
        console.log(`[Perf] Total wall time: ${(performance.now() - totalStart).toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`);
        return text;
      }

      if (toolCallCount === MAX_TOOL_CALLS - 5) {
        messages.push(
          makeMessage(
            'user',
            '[SYSTEM: Approaching tool limit. Prioritize breadth — address ALL parts of the user\'s request. Do not give up or ask permission to continue.]'
          )
        );
      }

      const tools = toolCallCount >= MAX_TOOL_CALLS ? [] : ALL_TOOLS;

      // Set up streaming with HTML interception
      const interceptor = createInterceptor();
      let streamedFullText = '';

      // Only use the onText callback for streaming;
      // it fires synchronously per text_delta chunk
      const onText = (chunk: string) => {
        if (this.window.isDestroyed()) return;
        streamedFullText += chunk;
        this.handleStreamChunk(chunk, interceptor);
      };

      // Compress old tool results before sending — keeps last 2 at full size,
      // truncates everything older to ~2000 chars. Saves 50-70% input tokens on later iterations.
      compressOldToolResults(messages);

      // Use lower max_tokens for intermediate tool-decision calls (tools available).
      // The LLM only needs ~300 tokens to emit tool_use blocks.
      // Final response call (no tools) gets full 4096.
      const maxTokens = tools.length > 0 ? 1024 : 4096;
      const apiLabel = `[Perf] API call #${iteration + 1}`;
      console.time(apiLabel);
      const response = await this.client.chat(messages, tools, systemPrompt, onText, { maxTokens });
      console.timeEnd(apiLabel);
      console.log(`[Perf] API call #${iteration + 1} tokens: in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);
      if (this.aborted) {
        this.emitThinking('');
        if (interceptor.documentOpen) {
          this.enqueue(() => closeLiveHtml());
          this.emitLiveHtmlEnd();
        }
        await this.writeQueue;
        return '[Stopped]';
      }

      const toolCalls = this.extractToolCalls(response);
      console.log(`[ToolLoop] iteration=${iteration}, toolCalls=${toolCalls.length}, streamedText=${streamedFullText.length}, mode=${interceptor.mode}, docOpen=${interceptor.documentOpen}`);
      if (toolCalls.length === 0) {
        // Final response — finish any open HTML stream
        await this.finishStream(interceptor);
        this.emitThinking('');
        if (streamedFullText) {
          this.streamed = true;
        }
        console.timeEnd('[Perf] Total request');
        console.log(`[Perf] Total wall time: ${(performance.now() - totalStart).toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`);
        return this.extractText(response).trim();
      }

      // Tool calls found — the LLM sometimes emits text before tool_use blocks.
      // That text was streamed to the renderer; it's harmless but we don't need to act on it.
      // Reset the write queue for the next iteration.
      this.writeQueue = Promise.resolve();
      messages.push(makeMessage('assistant', JSON.stringify(response.content)));

      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

      // Build execution tasks, handling search dedup inline
      const execTasks: ExecutionTask[] = [];
      for (const toolCall of toolCalls) {
        if (toolCall.name === 'browser_search') {
          const query = String(toolCall.input?.query || '');
          if (query && isDuplicateSearch(query, searchHistory)) {
            execTasks.push({ toolCall, skip: 'You already searched for something very similar. Use your previous results.' });
            continue;
          }
          if (query) {
            searchHistory.push({ tokens: normalizeTokens(query), raw: query });
          }
        }
        execTasks.push({ toolCall });
      }

      // Execute all tool calls concurrently
      toolCallCount += execTasks.length;
      if (execTasks.length > 0) {
        this.emitThinking(generateThought(execTasks[0].toolCall.name, execTasks[0].toolCall.input));
      }

      const toolsStart = performance.now();
      const results = await this.executeToolsParallel(execTasks);
      console.log(`[Perf] All tools (parallel): ${(performance.now() - toolsStart).toFixed(0)}ms`);

      if (this.aborted) {
        this.emitThinking('');
        return '[Stopped]';
      }

      const resultMap = new Map(results.map((r) => [r.id, r.content]));
      for (const toolCall of toolCalls) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: resultMap.get(toolCall.id) || 'Tool execution failed',
        });
      }

      this.emitThinking(generateSynthesisThought(toolCallCount));
      messages.push(makeMessage('user', JSON.stringify(toolResults)));
    }

    const text = await this.forceFinalResponseAtToolLimit(messages, systemPrompt);
    this.emitThinking('');
    console.timeEnd('[Perf] Total request');
    console.log(`[Perf] Total wall time: ${(performance.now() - totalStart).toFixed(0)}ms, iterations: ${MAX_TOOL_CALLS + 2}, toolCalls: ${toolCallCount}`);
    return text;
  }

  // -------------------------------------------------------------------------
  // Write queue — serializes all async browser writes
  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch((err) => {
      console.warn('[ToolLoop] Write queue error:', err?.message || err);
    });
  }

  // -------------------------------------------------------------------------
  // Tool scheduling — parallel where safe, sequential where stateful
  // -------------------------------------------------------------------------

  private getLocalWritePath(toolCall: ToolCall): string | null {
    if (!LOCAL_WRITE_TOOL_NAMES.has(toolCall.name)) return null;
    const rawPath = toolCall.input?.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
    const trimmed = rawPath.trim();
    if (trimmed.startsWith('~')) return path.normalize(path.join(homedir(), trimmed.slice(1)));
    if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
    return path.normalize(path.join(homedir(), trimmed));
  }

  private async runToolTask(task: ExecutionTask): Promise<ToolExecutionResult> {
    const { toolCall, skip } = task;
    if (this.aborted) return { id: toolCall.id, content: '[Stopped]' };
    if (skip) return { id: toolCall.id, content: skip };

    const tStart = performance.now();
    try {
      const result = await executeTool(toolCall.name, toolCall.input);
      console.log(`[Perf] Tool: ${toolCall.name}: ${(performance.now() - tStart).toFixed(0)}ms (${result.length} chars)`);
      return { id: toolCall.id, content: result };
    } catch (error: any) {
      console.log(`[Perf] Tool: ${toolCall.name}: ${(performance.now() - tStart).toFixed(0)}ms (error)`);
      return { id: toolCall.id, content: `Tool error: ${error?.message || 'unknown error'}` };
    }
  }

  private async runSequentialToolTasks(tasks: ExecutionTask[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const task of tasks) {
      results.push(await this.runToolTask(task));
    }
    return results;
  }

  private extractSettledValues<T>(settled: PromiseSettledResult<T>[], label: string): T[] {
    const values: T[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        values.push(item.value);
      } else {
        console.warn(`[ToolLoop] ${label} task rejected:`, item.reason);
      }
    }
    return values;
  }

  private async executeToolsParallel(execTasks: ExecutionTask[]): Promise<ToolExecutionResult[]> {
    const immediate: ToolExecutionResult[] = [];
    const localParallel: ExecutionTask[] = [];
    const localWriteUnknownPath: ExecutionTask[] = [];
    const localWriteGroups = new Map<string, ExecutionTask[]>();
    const browserSequential: ExecutionTask[] = [];

    for (const task of execTasks) {
      if (task.skip) {
        immediate.push({ id: task.toolCall.id, content: task.skip });
        continue;
      }

      const toolName = task.toolCall.name;
      if (
        BROWSER_NAVIGATION_TOOL_NAMES.has(toolName) ||
        BROWSER_PAGE_STATE_READ_TOOL_NAMES.has(toolName) ||
        (toolName.startsWith('browser_') && !BROWSER_STATELESS_TOOL_NAMES.has(toolName))
      ) {
        browserSequential.push(task);
        continue;
      }

      if (!LOCAL_TOOL_NAMES.has(toolName)) {
        localParallel.push(task);
        continue;
      }

      const writePath = this.getLocalWritePath(task.toolCall);
      if (writePath) {
        const group = localWriteGroups.get(writePath);
        if (group) {
          group.push(task);
        } else {
          localWriteGroups.set(writePath, [task]);
        }
      } else if (LOCAL_WRITE_TOOL_NAMES.has(toolName)) {
        localWriteUnknownPath.push(task);
      } else {
        localParallel.push(task);
      }
    }

    const localParallelPromise = Promise.allSettled(localParallel.map((task) => this.runToolTask(task)))
      .then((settled) => this.extractSettledValues(settled, 'local parallel'));

    const localWriteGroupsPromise = Promise.allSettled(
      Array.from(localWriteGroups.values()).map((group) => this.runSequentialToolTasks(group))
    ).then((settledGroups) => this.extractSettledValues(settledGroups, 'local write group').flat());

    const localWriteUnknownPromise = this.runSequentialToolTasks(localWriteUnknownPath);
    const browserSequentialPromise = this.runSequentialToolTasks(browserSequential);

    const [parallelResults, groupedWriteResults, unknownWriteResults, browserResults] = await Promise.all([
      localParallelPromise,
      localWriteGroupsPromise,
      localWriteUnknownPromise,
      browserSequentialPromise,
    ]);

    return [
      ...immediate,
      ...parallelResults,
      ...groupedWriteResults,
      ...unknownWriteResults,
      ...browserResults,
    ];
  }

  // -------------------------------------------------------------------------
  // Stream interception — routes chunks to chat or browser
  // -------------------------------------------------------------------------

  private handleStreamChunk(chunk: string, state: StreamInterceptorState): void {
    state.accumulated += chunk;

    // --- DETECTION PHASE ---
    if (state.mode === 'detecting') {
      const detection = detectMode(state.accumulated);

      if (detection === 'html') {
        state.mode = 'html';
        const { preChat } = extractHtml(state.accumulated);
        state.preHtmlChat = preChat;
        console.log(`[StreamInterceptor] HTML detected, preChat="${preChat.slice(0, 60)}", accumulated=${state.accumulated.length} chars`);

        if (preChat) {
          this.emitStreamText(preChat);
        }

        this.emitThinking('Building in the browser...');
        this.emitLiveHtmlStart();

        // Open live preview and write initial HTML — serialized via queue
        this.enqueue(async () => {
          try {
            await createLivePreviewTab();
            state.documentOpen = true;

            const { html } = extractHtml(state.accumulated);
            if (html) {
              await writeLiveHtml(html);
              state.lastHtmlWriteLen = html.length;
            }
          } catch (err: any) {
            console.warn('[ToolLoop] Failed to open live preview:', err?.message);
            state.mode = 'chat';
            this.emitStreamText(state.accumulated);
          }
        });
        return;
      }

      if (detection === 'chat') {
        state.mode = 'chat';
        console.log(`[StreamInterceptor] Chat mode, accumulated=${state.accumulated.length} chars`);
        this.emitStreamText(state.accumulated);
        return;
      }

      // Still detecting — buffer without displaying
      return;
    }

    // --- HTML MODE ---
    if (state.mode === 'html') {
      const closingIdx = findClosingFence(state.accumulated);
      if (closingIdx >= 0 && !state.htmlComplete) {
        state.htmlComplete = true;
        console.log(`[StreamInterceptor] Closing fence found at ${closingIdx}, total=${state.accumulated.length}`);

        // Flush remaining HTML and close the document — serialized via queue
        this.enqueue(async () => {
          await this.flushHtml(state);
          if (state.documentOpen) {
            await closeLiveHtml();
            state.documentOpen = false;
            this.emitLiveHtmlEnd();
          }
        });

        // Emit any post-fence chat text
        const postChat = extractPostChat(state.accumulated);
        if (postChat) {
          this.postChatEmitted = postChat.length;
          this.emitStreamText(postChat);
        }

        state.mode = 'chat';
        return;
      }

      // Queue incremental HTML writes (serialized, no concurrent writes)
      this.enqueue(() => this.flushHtml(state));
      return;
    }

    // --- CHAT MODE ---
    if (state.mode === 'chat') {
      if (state.htmlComplete) {
        // After HTML, emit only new post-fence text (avoid double-emission)
        const postChat = extractPostChat(state.accumulated);
        const newLen = postChat.length;
        if (newLen > this.postChatEmitted) {
          this.emitStreamText(postChat.slice(this.postChatEmitted));
          this.postChatEmitted = newLen;
        }
      } else {
        this.emitStreamText(chunk);
      }
    }
  }

  private async flushHtml(state: StreamInterceptorState): Promise<void> {
    if (!state.documentOpen) return;
    const { html } = extractHtml(state.accumulated);
    if (html.length > state.lastHtmlWriteLen) {
      const newContent = html.slice(state.lastHtmlWriteLen);
      state.lastHtmlWriteLen = html.length;
      await writeLiveHtml(newContent);
    }
  }

  private async finishStream(state: StreamInterceptorState): Promise<void> {
    // If still detecting when stream ends, flush buffer to chat
    if (state.mode === 'detecting') {
      if (state.accumulated) {
        this.emitStreamText(state.accumulated);
      }
      return;
    }

    // If HTML was streaming but never closed properly (no closing fence), close it
    if (state.documentOpen) {
      this.enqueue(async () => {
        await this.flushHtml(state);
        if (state.documentOpen) {
          await closeLiveHtml();
          state.documentOpen = false;
          this.emitLiveHtmlEnd();
        }
      });
    }

    // Wait for all queued writes to complete
    await this.writeQueue;
  }

  // -------------------------------------------------------------------------
  // IPC emission helpers
  // -------------------------------------------------------------------------

  private emitThinking(thought: string): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IPC_EVENTS.CHAT_THINKING, thought);
  }

  private emitStreamText(text: string): void {
    if (this.window.isDestroyed() || !text) return;
    this.window.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
  }

  private emitLiveHtmlStart(): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IPC_EVENTS.CHAT_LIVE_HTML_START);
  }

  private emitLiveHtmlEnd(): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IPC_EVENTS.CHAT_LIVE_HTML_END);
  }

  // -------------------------------------------------------------------------
  // Response parsing helpers
  // -------------------------------------------------------------------------

  private extractToolCalls(response: any): ToolCall[] {
    if (!response?.content || !Array.isArray(response.content)) return [];
    return response.content
      .filter((block: any) => block?.type === 'tool_use')
      .map((block: any) => ({
        id: String(block.id),
        name: String(block.name),
        input: (block.input || {}) as Record<string, unknown>,
      }));
  }

  private extractText(response: any): string {
    if (!response?.content || !Array.isArray(response.content)) return '';
    return response.content
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => String(block.text || ''))
      .join('\n');
  }

  private trimHistory(messages: Message[]): Message[] {
    if (messages.length <= MAX_HISTORY_MESSAGES) return [...messages];
    return messages.slice(-MAX_HISTORY_MESSAGES);
  }

  private async forceFinalResponseAtToolLimit(messages: Message[], systemPrompt: string): Promise<string> {
    messages.push(
      makeMessage(
        'user',
        '[SYSTEM: Tool limit reached. Respond now with answers for ALL parts of the user\'s request using information already gathered. Do not mention limits or ask to continue.]'
      )
    );
    const finalResponse = await this.client.chat(messages, [], systemPrompt, undefined, { maxTokens: 4096 });
    return this.extractText(finalResponse).trim();
  }
}
