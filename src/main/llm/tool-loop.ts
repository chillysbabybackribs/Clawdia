import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { homedir } from 'os';
import * as path from 'path';
import { AnthropicClient } from './client';
import { Message, ImageAttachment, DocumentAttachment, ToolActivityEntry, ToolActivitySummary } from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { buildSystemPrompt, type PromptTier } from './system-prompt';
import { getModelLabel } from '../../shared/models';
import { BROWSER_TOOL_DEFINITIONS, executeTool as executeBrowserTool } from '../browser/tools';
import { LOCAL_TOOL_DEFINITIONS, executeLocalTool, type LocalToolExecutionContext } from '../local/tools';
import { generateSynthesisThought, generateThought } from './thought-generator';
import { classifyIntent } from './intent-router';
import {
  SEQUENTIAL_THINKING_TOOL_DEFINITION,
  executeSequentialThinking,
  resetSequentialThinking,
} from './sequential-thinking';
import type { DocProgressEvent } from '../../shared/types';
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
  isSessionInvalidated,
  clearSessionInvalidated,
} from '../browser/manager';
import { createLogger, perfLog, perfTimer } from '../logger';

const log = createLogger('tool-loop');

const MAX_TOOL_CALLS = 25;
const MAX_TOOL_ITERATIONS = 25;
import { ConversationManager } from './conversation';
// Dynamically reads from ConversationManager so runtime changes apply everywhere
const getMaxHistoryMessages = () => ConversationManager.getMaxPersistedMessages();
const MAX_FINAL_RESPONSE_CONTINUATIONS = 3;
const MAX_TOOL_RESULT_IN_HISTORY = 1000; // chars — roughly 250 tokens
const MAX_TOOL_RESULT_CHARS = 30_000; // hard cap on any single tool result before it enters conversation
const KEEP_FULL_TOOL_RESULTS = 1; // keep last N tool_result messages uncompressed
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((tool) => tool.name));
const ALL_TOOLS = [...BROWSER_TOOL_DEFINITIONS, ...LOCAL_TOOL_DEFINITIONS, SEQUENTIAL_THINKING_TOOL_DEFINITION];
const LOCAL_WRITE_TOOL_NAMES = new Set(['file_write', 'file_edit']);
const EARLY_STREAM_TOOL_NAMES = new Set([
  'file_read',
  'directory_tree',
  'process_manager',
  'browser_search',
  'browser_search_rich',
  'browser_news',
  'browser_shopping',
  'browser_places',
  'browser_images',
  'browser_navigate',
  'browser_read_page',
  'browser_batch',
  'browser_read_tabs',
  'browser_extract',
  'browser_visual_extract',
  'browser_screenshot',
  'cache_read',
]);
const BROWSER_NAVIGATION_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_tab',
]);
const BROWSER_PAGE_STATE_READ_TOOL_NAMES = new Set([
  'browser_read_page',
  'browser_read_tabs',
  'browser_extract',
  'browser_visual_extract',
  'browser_screenshot',
]);
const BROWSER_STATELESS_TOOL_NAMES = new Set([
  'browser_search',
  'browser_batch',
  'browser_search_rich',
  'browser_news',
  'browser_shopping',
  'browser_places',
  'browser_images',
  'cache_read',
]);
const PREFETCH_TTL_MS = 30_000;
const FILE_PREFETCH_PATTERNS = [
  /read\s+([\w./-]+\.\w+)/i,
  /look\s+at\s+([\w./-]+\.\w+)/i,
  /check\s+([\w./-]+\.\w+)/i,
  /open\s+([\w./-]+\.\w+)/i,
  /review\s+([\w./-]+\.\w+)/i,
  /([\w./-]+\.(?:md|txt|json|ts|js|py|yaml|yml|toml|cfg|conf|csv))\b/i,
];
const NAV_PREFETCH_KEYWORDS: Record<string, string> = {
  tweet: 'https://x.com/home',
  'post a tweet': 'https://x.com/home',
  'post on twitter': 'https://x.com/home',
  'post on x': 'https://x.com/home',
  twitter: 'https://x.com/home',
  'x.com': 'https://x.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  reddit: 'https://www.reddit.com',
  linkedin: 'https://www.linkedin.com',
  amazon: 'https://www.amazon.com',
  aws: 'https://console.aws.amazon.com',
};

interface SearchEntry {
  toolName: string;
  tokens: string[];
  signature: string;
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
  localContext?: LocalToolExecutionContext;
}

interface ToolExecutionResult {
  id: string;
  content: string;
}

interface ToolLoopRunContext {
  conversationId: string;
  messageId: string;
}

interface IterationLlmStats {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface CreateDocumentLlmMetrics {
  generationMs: number;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
}

interface PrefetchFileEntry {
  content: string;
  timestamp: number;
}

interface PrefetchNavigationEntry {
  url: string;
  promise: Promise<string>;
  timestamp: number;
}

const prefetchCache: {
  files: Map<string, PrefetchFileEntry>;
  navigation: PrefetchNavigationEntry | null;
} = {
  files: new Map(),
  navigation: null,
};

const SEARCH_TOOL_NAMES = new Set([
  'browser_search',
  'browser_search_rich',
  'browser_news',
  'browser_shopping',
  'browser_places',
  'browser_images',
]);

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'near', 'latest', 'new', 'news',
  'about', 'vs', 'versus', 'today', 'current', 'now',
]);

const DOCUMENT_REQUEST_PATTERN = /\b(docx?|pdf|xlsx?|spreadsheet|report|proposal|resume|whitepaper|generate\s+(a\s+)?document|create\s+(a\s+)?document)\b/i;

function normalizeTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token && !SEARCH_STOPWORDS.has(token))
    )
  ).sort();
}

function makeSearchSignature(tokens: string[]): string {
  return tokens.join('|');
}

function isDuplicateSearch(toolName: string, query: string, history: SearchEntry[]): boolean {
  const tokens = normalizeTokens(query);
  if (!tokens.length) return false;
  const signature = makeSearchSignature(tokens);
  for (const entry of history) {
    // Avoid suppressing distinct search intents across different specialized tools.
    if (entry.toolName !== toolName) continue;
    if (entry.signature === signature) return true;
    if (!entry.tokens.length) continue;
    const overlap = entry.tokens.filter((token) => tokens.includes(token)).length;
    const base = Math.max(entry.tokens.length, tokens.length);
    if (base > 0 && overlap / base >= 0.7) {
      return true;
    }
  }
  return false;
}

function looksLikeDocumentRequest(input: string): boolean {
  return DOCUMENT_REQUEST_PATTERN.test(input);
}

function sumLlmStats(entries: IterationLlmStats[]): CreateDocumentLlmMetrics {
  return entries.reduce<CreateDocumentLlmMetrics>(
    (acc, entry) => {
      acc.generationMs += entry.durationMs;
      acc.iterations += 1;
      acc.tokensIn += entry.inputTokens;
      acc.tokensOut += entry.outputTokens;
      return acc;
    },
    { generationMs: 0, iterations: 0, tokensIn: 0, tokensOut: 0 }
  );
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
 * Detect a tool result that contains an image (e.g. browser_screenshot).
 * Returns a multi-part content array for the Anthropic API tool_result,
 * or null if the result is a normal text string.
 */
function parseImageResult(
  result: string,
): Array<{ type: string; [key: string]: unknown }> | null {
  if (!result.startsWith('{"__clawdia_image_result__":true')) return null;
  try {
    const parsed = JSON.parse(result);
    if (!parsed.__clawdia_image_result__ || !parsed.image_base64) return null;
    const blocks: Array<{ type: string; [key: string]: unknown }> = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.media_type || 'image/png',
          data: parsed.image_base64,
        },
      },
    ];
    if (parsed.text) {
      blocks.push({ type: 'text', text: parsed.text });
    }
    return blocks;
  } catch {
    return null;
  }
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

    // Truncate tool result content in this message.
    // For image results (content is an array), strip the image and keep only text.
    let changed = false;
    const compressed = parsed.map((block: any) => {
      if (block?.type !== 'tool_result') return block;

      // Image tool_result: content is an array with image + text blocks
      if (Array.isArray(block.content)) {
        changed = true;
        const textParts = block.content
          .filter((b: any) => b?.type === 'text' && b?.text)
          .map((b: any) => b.text)
          .join('\n');
        return { ...block, content: textParts || '[screenshot — image stripped from history]' };
      }

      if (
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

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context?: LocalToolExecutionContext,
): Promise<string> {
  if (name === 'sequential_thinking') {
    return executeSequentialThinking(input);
  }

  if (name === 'file_read') {
    const cached = consumePrefetchedFile(input?.path);
    if (cached) return cached;
  }

  if (name === 'browser_navigate') {
    const cached = consumePrefetchedNavigation(input?.url);
    if (cached) return cached;
  }

  if (name.startsWith('browser_')) {
    return executeBrowserTool(name, input);
  }
  if (LOCAL_TOOL_NAMES.has(name)) {
    return executeLocalTool(name, input, context);
  }
  return `Unknown tool: ${name}`;
}

function isFresh(timestamp: number): boolean {
  return Date.now() - timestamp < PREFETCH_TTL_MS;
}

function normalizeFileCachePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('~')) return path.normalize(path.join(homedir(), trimmed.slice(1)));
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.normalize(path.join(homedir(), trimmed));
}

function normalizeUrlForPrefetch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('about:')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function consumePrefetchedFile(inputPath: unknown): string | null {
  const normalized = normalizeFileCachePath(inputPath);
  if (!normalized) return null;
  const cached = prefetchCache.files.get(normalized);
  if (!cached) return null;
  if (!isFresh(cached.timestamp)) {
    prefetchCache.files.delete(normalized);
    return null;
  }
  prefetchCache.files.delete(normalized);
  return cached.content;
}

function consumePrefetchedNavigation(inputUrl: unknown): Promise<string> | null {
  const normalized = normalizeUrlForPrefetch(inputUrl);
  const cached = prefetchCache.navigation;
  if (!normalized || !cached) return null;
  if (!isFresh(cached.timestamp)) {
    prefetchCache.navigation = null;
    return null;
  }
  if (cached.url !== normalized) return null;
  prefetchCache.navigation = null;
  return cached.promise;
}

function clearExpiredPrefetchEntries(): void {
  for (const [key, value] of prefetchCache.files.entries()) {
    if (!isFresh(value.timestamp)) {
      prefetchCache.files.delete(key);
    }
  }
  if (prefetchCache.navigation && !isFresh(prefetchCache.navigation.timestamp)) {
    prefetchCache.navigation = null;
  }
}

function extractFirstPrefetchFile(message: string): string | null {
  for (const pattern of FILE_PREFETCH_PATTERNS) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    return match[1].trim();
  }
  return null;
}

function detectPrefetchNavigation(message: string): string | null {
  const lower = message.toLowerCase();
  for (const [keyword, url] of Object.entries(NAV_PREFETCH_KEYWORDS)) {
    if (lower.includes(keyword)) return url;
  }
  return null;
}

function prefetchFromMessage(message: string): void {
  // REVERTED FOR STABILITY:
  // Prefetching was causing side effects (e.g. speculative browser_navigate)
  // before the model explicitly committed to tool calls. Keep this disabled
  // in stabilization mode; explicit tool execution remains unchanged.
  void message;
}

export function clearPrefetchCache(): void {
  prefetchCache.files.clear();
  prefetchCache.navigation = null;
}

/** Patterns that suggest a response references tool results. */
const TOOL_CLAIM_RE = /✅|passed|returned|response was|file contains|screenshot shows|navigated to|search results|found \d+ results?|the page shows|according to the (page|site|website)|I (read|searched|navigated|opened|fetched|checked|found|visited)/i;

function detectFabrication(responseText: string, toolCallCount: number): string | null {
  if (toolCallCount > 0) return null; // Tools were actually called
  if (!responseText || responseText.length < 20) return null;
  if (TOOL_CLAIM_RE.test(responseText)) {
    return 'Response references tool results but no tools were invoked during this turn.';
  }
  return null;
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
  /** Serializes speculative tool execution started from stream-time tool_use blocks. */
  private earlyToolQueue: Promise<void> = Promise.resolve();
  /** Holds stream-started tool execution promises keyed by tool_use id. */
  private earlyToolResults = new Map<string, Promise<string>>();
  private runContext: ToolLoopRunContext | null = null;
  private runStartedAt = 0;
  private documentProgressEnabled = false;
  /** Tracks all tool calls executed in this run for the activity panel. */
  private activityLog: ToolActivityEntry[] = [];

  constructor(window: BrowserWindow, client: AnthropicClient) {
    this.window = window;
    this.client = client;
  }

  abort(): void {
    this.aborted = true;
  }

  async run(
    userMessage: string,
    history: Message[],
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
    context?: ToolLoopRunContext,
  ): Promise<string> {
    this.aborted = false;
    this.streamed = false;
    this.writeQueue = Promise.resolve();
    this.postChatEmitted = 0;
    this.earlyToolQueue = Promise.resolve();
    this.earlyToolResults = new Map();
    this.runContext = context ?? null;
    this.runStartedAt = performance.now();
    this.documentProgressEnabled = looksLikeDocumentRequest(userMessage);
    this.activityLog = [];
    clearSessionInvalidated(); // Clear stale signals from prior runs
    resetSequentialThinking(); // Fresh thinking state per run
    this.emitThinking(generateSynthesisThought(0));
    if (this.documentProgressEnabled) {
      this.emitDocProgress({
        stage: 'generating',
        stageLabel: 'Writing content...',
        stageNumber: 1,
        totalStages: 5,
      });
    }

    const totalStart = performance.now();
    const modelLabel = getModelLabel(this.client.getModel());
    
    // Build both prompt tiers upfront (cheap string ops)
    // We pick which to use based on intent classification in the loop
    const minimalPrompt = buildSystemPrompt({ tier: 'minimal', modelLabel });
    const standardPrompt = buildSystemPrompt({ tier: 'standard', modelLabel });
    let systemPrompt = standardPrompt; // default, may switch to minimal for chat-only

    const histStart = performance.now();
    const messages = this.trimHistory(history);
    
    // Compress old tool results in history BEFORE first API call
    compressOldToolResults(messages);

    // Prepend document text to the user message so the LLM sees document content
    let augmentedMessage = userMessage;
    if (documents && documents.length > 0) {
      const docParts: string[] = [];
      for (const doc of documents) {
        const sizeMB = (doc.sizeBytes / (1024 * 1024)).toFixed(1);
        const meta = [doc.mimeType, `${sizeMB} MB`];
        if (doc.pageCount) meta.push(`${doc.pageCount} pages`);
        if (doc.sheetNames?.length) meta.push(`sheets: ${doc.sheetNames.join(', ')}`);
        docParts.push(`--- Document: ${doc.originalName} (${meta.join(', ')}) ---\n${doc.extractedText}\n---`);
      }
      augmentedMessage = docParts.join('\n\n') + '\n\n' + userMessage;
    }

    const userMsg = makeMessage('user', augmentedMessage);
    if (images && images.length > 0) {
      userMsg.images = images;
    }
    messages.push(userMsg);
    const histMs = performance.now() - histStart;
    log.debug(`History assembly: ${histMs.toFixed(1)}ms (${messages.length} messages)`);
    perfLog('tool-loop', 'history-assembly', histMs, { messageCount: messages.length });
    prefetchFromMessage(userMessage);

    const searchHistory: SearchEntry[] = [];
    let toolCallCount = 0;
    const finalResponseParts: string[] = [];
    let continuationCount = 0;
    const llmStatsByIteration: IterationLlmStats[] = [];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (this.aborted) {
        this.emitThinking('');
        return '[Stopped]';
      }

      // Check if the browser session was externally invalidated (tab closed, CDP died, etc.)
      if (isSessionInvalidated()) {
        clearSessionInvalidated();
        log.warn('Browser session invalidated between iterations');
        // Don't crash — let the LLM know and continue
        messages.push(
          makeMessage(
            'user',
            '[SYSTEM: The browser tab was closed or the browser session was lost. Please ask the user to navigate to a page first before using browser tools.]'
          )
        );
      }

      if (toolCallCount >= MAX_TOOL_CALLS) {
        const text = await this.forceFinalResponseAtToolLimit(messages, systemPrompt);
        this.emitThinking('');
        this.emitToolActivitySummary(text);
        const totalMs = performance.now() - totalStart; log.info(`Total wall time: ${totalMs.toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`); perfLog("tool-loop", "total-wall-time", totalMs, { iterations: iteration + 1, toolCalls: toolCallCount });
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

      // Deterministic intent router: on the FIRST iteration (no tools used yet),
      // classify the user message. If it's purely conversational, skip tool
      // definitions entirely — saves ~3000-4000 tokens and speeds up the API call.
      let tools: typeof ALL_TOOLS | [] = [];
      if (toolCallCount >= MAX_TOOL_CALLS) {
        tools = [];
      } else if (iteration === 0 && classifyIntent(augmentedMessage, history.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))) === 'chat-only') {
        tools = [];
        systemPrompt = minimalPrompt; // Use minimal prompt for chat-only (~800 tokens vs ~2K)
        log.info('Intent router: chat-only — using minimal prompt, skipping tool definitions');
        perfLog('intent-router', 'route-chat-only', 0, { message: augmentedMessage.slice(0, 80) });
      } else {
        tools = ALL_TOOLS;
      }

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

      // First pass keeps a full budget for quality; intermediate tool loops stay small for speed.
      const maxTokens = this.getMaxTokens(tools.length > 0, toolCallCount);
      const apiStart = performance.now();
      const response = await this.client.chat(messages, tools, systemPrompt, onText, {
        maxTokens,
        // Speculative tool execution: start running tools as soon as the model
        // finishes streaming each tool_use block. By the time the full API
        // response arrives, fast tools (shell_exec, file_read, etc.) are already
        // done. The regular tool-loop phase checks earlyToolResults first and
        // reuses the result instead of re-executing.
        onToolUse: (toolUse) => {
          // Only speculatively execute safe, stateless, read-only tools.
          // Browser nav / clicks / writes could have side effects if the model
          // later decides to change plan in a subsequent tool_use block.
          const SPECULATIVE_SAFE = new Set([
            'shell_exec', 'file_read', 'directory_tree', 'process_manager',
            'browser_search', 'browser_news', 'browser_shopping',
            'browser_places', 'browser_images', 'browser_search_rich',
            'cache_read', 'sequential_thinking',
          ]);
          if (SPECULATIVE_SAFE.has(toolUse.name)) {
            log.debug(`Speculative exec starting: ${toolUse.name} (id=${toolUse.id})`);
            const promise = this.startEarlyToolExecution(toolUse);
            return promise;
          }
          return undefined;
        },
      });
      const apiDurationMs = performance.now() - apiStart;
      const { inputTokens: rIn, outputTokens: rOut, cacheReadInputTokens: cRead, cacheCreationInputTokens: cWrite } = response.usage;
      llmStatsByIteration.push({
        durationMs: apiDurationMs,
        inputTokens: rIn || 0,
        outputTokens: rOut || 0,
        cacheReadInputTokens: cRead || 0,
        cacheCreationInputTokens: cWrite || 0,
      });
      log.info(`API call #${iteration + 1}: ${apiDurationMs.toFixed(0)}ms, tokens: in=${rIn} out=${rOut} cache_read=${cRead} cache_write=${cWrite}`);
      if ((rIn || 0) > 150_000) {
        log.warn(`High input token count: ${rIn} — approaching context limit`);
      }
      perfLog('tool-loop', `api-call-${iteration + 1}`, apiDurationMs, {
        inputTokens: rIn,
        outputTokens: rOut,
        cacheReadInputTokens: cRead,
        cacheCreationInputTokens: cWrite,
        maxTokens,
      });
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
      const responseText = this.extractText(response).trim();
      log.debug(`iteration=${iteration}, toolCalls=${toolCalls.length}, streamedText=${streamedFullText.length}, mode=${interceptor.mode}, docOpen=${interceptor.documentOpen}`);

      // Diagnostic: detect when the LLM skips deliberation on assessment-type requests
      if (iteration === 0 && toolCalls.length > 0) {
        const hasThinking = toolCalls.some(tc => tc.name === 'sequential_thinking');
        if (!hasThinking) {
          const ASSESSMENT_RE = /\b(assess|evaluate|plan|consider|what might break|refactor|restructure|reorganize|before making|first check|think through)\b/i;
          if (ASSESSMENT_RE.test(augmentedMessage)) {
            log.warn('Assessment signal detected in user message but sequential_thinking was not invoked');
          }
        }
      }
      if (toolCalls.length === 0) {
        // Final response — finish any open HTML stream
        await this.finishStream(interceptor);
        if (streamedFullText) {
          this.streamed = true;
        }
        if (responseText) {
          finalResponseParts.push(responseText);
        }

        // If the model was truncated by max_tokens, continue seamlessly.
        if (response.stopReason === 'max_tokens' && continuationCount < MAX_FINAL_RESPONSE_CONTINUATIONS) {
          continuationCount += 1;
          const contContent = response.content && response.content.length > 0
            ? response.content
            : [{ type: 'text', text: '[Processing...]' }];
          messages.push(makeMessage('assistant', JSON.stringify(contContent)));
          messages.push(
            makeMessage(
              'user',
              '[SYSTEM: Your previous response was cut off by a token limit. Continue exactly where you left off, with no repetition. Finish all remaining required sections.]'
            )
          );
          this.emitThinking(`Continuing response (${continuationCount})...`);
          continue;
        }

        this.emitThinking('');
        const finalText = finalResponseParts.join('\n').trim();
        this.emitToolActivitySummary(finalText);
        const totalMs = performance.now() - totalStart; log.info(`Total wall time: ${totalMs.toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`); perfLog("tool-loop", "total-wall-time", totalMs, { iterations: iteration + 1, toolCalls: toolCallCount });
        return finalText;
      }

      continuationCount = 0;

      // Tool calls found — the LLM sometimes emits text before tool_use blocks.
      // That text was streamed to the renderer; it's harmless but we don't need to act on it.
      // Reset the write queue for the next iteration.
      this.writeQueue = Promise.resolve();
      // Guard: ensure assistant message always has non-empty content.
      // An empty content array would cause a 400 error from the Anthropic API.
      const assistantContent = response.content && response.content.length > 0
        ? response.content
        : [{ type: 'text', text: '[Processing...]' }];
      messages.push(makeMessage('assistant', JSON.stringify(assistantContent)));

      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string | Array<{ type: string; [key: string]: unknown }>;
      }> = [];

      // Build execution tasks, handling search dedup inline
      const execTasks: ExecutionTask[] = [];
      for (const toolCall of toolCalls) {
        if (SEARCH_TOOL_NAMES.has(toolCall.name)) {
          const query = String(toolCall.input?.query || '');
          if (query && isDuplicateSearch(toolCall.name, query, searchHistory)) {
            execTasks.push({ toolCall, skip: 'You already searched for something very similar. Use your previous results.' });
            continue;
          }
          if (query) {
            const tokens = normalizeTokens(query);
            searchHistory.push({
              toolName: toolCall.name,
              tokens,
              signature: makeSearchSignature(tokens),
              raw: query,
            });
          }
        }
        if (toolCall.name === 'create_document') {
          this.documentProgressEnabled = true;
          this.emitDocProgress({
            stage: 'generating',
            stageLabel: 'Writing content...',
            stageNumber: 1,
            totalStages: 5,
          });
          const llmMetrics = sumLlmStats(llmStatsByIteration);
          execTasks.push({
            toolCall,
            localContext: {
              conversationId: this.runContext?.conversationId,
              messageId: this.runContext?.messageId,
              llmMetrics,
              onDocProgress: (event) => this.emitDocProgress(event),
            },
          });
          continue;
        }
        execTasks.push({ toolCall });
      }

      // Execute all tool calls concurrently
      // Exclude sequential_thinking from the tool call counter — it's a reasoning
      // scratchpad with zero side effects and shouldn't eat into MAX_TOOL_CALLS.
      const countableTools = execTasks.filter(t => t.toolCall.name !== 'sequential_thinking').length;
      toolCallCount += countableTools;
      if (execTasks.length > 0) {
        this.emitThinking(generateThought(execTasks[0].toolCall.name, execTasks[0].toolCall.input));
      }

      const toolsStart = performance.now();
      const results = await this.executeToolsParallel(execTasks);
      const toolsBatchMs = performance.now() - toolsStart;
      log.debug(`All tools (parallel): ${toolsBatchMs.toFixed(0)}ms`);
      perfLog('tool-loop', `tools-batch-iter-${iteration + 1}`, toolsBatchMs, { count: toolCalls.length });

      if (this.aborted) {
        this.emitThinking('');
        return '[Stopped]';
      }

      const resultMap = new Map(results.map((r) => [r.id, r.content]));
      for (const toolCall of toolCalls) {
        const rawResult = resultMap.get(toolCall.id);
        const resultContent = (rawResult && rawResult.trim() !== '') ? rawResult : 'Tool execution failed';
        if (toolCall.name === 'create_document' && resultContent.startsWith('[Error creating document:')) {
          this.emitDocProgress({
            stage: 'error',
            stageLabel: 'Document generation failed',
            stageNumber: 5,
            totalStages: 5,
            error: resultContent.replace('[Error creating document:', '').replace(/\]$/, '').trim(),
          });
        }

        // Detect create_document tool results and emit IPC event
        if (toolCall.name === 'create_document') {
          try {
            const docResult = JSON.parse(resultContent);
            if (docResult.__clawdia_document__ && !this.window.isDestroyed()) {
              const notifyStart = performance.now();
              this.window.webContents.send(IPC_EVENTS.CHAT_DOCUMENT_CREATED, {
                filePath: docResult.filePath,
                filename: docResult.filename,
                sizeBytes: docResult.sizeBytes,
                format: docResult.format,
              });
              const notifyMs = performance.now() - notifyStart;
              const timing = docResult.timing || {};
              const totalMs = Number(timing.totalMs || 0) + notifyMs;
              const llmMs = Number(timing.phase1LlmGenerationMs || 0);
              const parseMs = Number(timing.phase2ContentParsingMs || 0);
              const assemblyMs = Number(timing.phase3DocumentAssemblyMs || 0);
              const writeMs = Number(timing.phase4FileWriteMs || 0);
              const bottlenecks = [
                { label: 'LLM generation', value: llmMs },
                { label: 'Content parsing', value: parseMs },
                { label: 'Document assembly', value: assemblyMs },
                { label: 'File write', value: writeMs },
                { label: 'Renderer notification', value: notifyMs },
              ];
              const bottleneck = bottlenecks.reduce((max, item) => (item.value > max.value ? item : max), bottlenecks[0]);
              const bottleneckPct = totalMs > 0 ? (bottleneck.value / totalMs) * 100 : 0;
              log.info(
                `[DOC-TIMING] Document created: "${docResult.filename}"\n` +
                `  Total: ${(totalMs / 1000).toFixed(2)}s\n` +
                `  Phase 1 - LLM generation: ${(llmMs / 1000).toFixed(2)}s (${Number(timing.llmIterations || 0)} iterations, ${Number(timing.llmTokensIn || 0)} tokens in, ${Number(timing.llmTokensOut || 0)} tokens out)\n` +
                `  Phase 2 - Content parsing: ${(parseMs / 1000).toFixed(2)}s\n` +
                `  Phase 3 - Document assembly: ${(assemblyMs / 1000).toFixed(2)}s\n` +
                `  Phase 4 - File write: ${(writeMs / 1000).toFixed(2)}s\n` +
                `  Phase 5 - Renderer notification: ${(notifyMs / 1000).toFixed(2)}s\n` +
                `  Bottleneck: ${bottleneck.label} (${bottleneckPct.toFixed(1)}%)`
              );
              this.emitDocProgress({
                stage: 'complete',
                stageLabel: 'Done',
                stageNumber: 5,
                totalStages: 5,
                detail: docResult.filename,
                filename: docResult.filename,
                writeCompletedAtMs: Date.now(),
              });
            }
          } catch {
            // Non-JSON tool result (usually error text) — ignore.
          }
        }

        // Detect image results (e.g. browser_screenshot) and build multi-part
        // tool_result content with image + text blocks for the Anthropic API.
        const imageContent = parseImageResult(resultContent);
        if (imageContent) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: imageContent,
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: resultContent,
          });
        }
      }

      this.emitThinking(generateSynthesisThought(toolCallCount));
      // Guard: never push an empty tool_results array — would cause empty content error
      if (toolResults.length > 0) {
        messages.push(makeMessage('user', JSON.stringify(toolResults)));
      } else {
        log.warn('[SANITIZE] No tool results to push — adding placeholder');
        messages.push(makeMessage('user', '[All tool results were empty]'));
      }
    }

    this.emitThinking('');
    this.emitToolActivitySummary('');
    const totalMsMax = performance.now() - totalStart; log.warn(`Total wall time: ${totalMsMax.toFixed(0)}ms, iterations: ${MAX_TOOL_ITERATIONS}, toolCalls: ${toolCallCount} — exceeded max iterations`); perfLog("tool-loop", "total-wall-time-MAX", totalMsMax, { iterations: MAX_TOOL_ITERATIONS, toolCalls: toolCallCount });
    throw new Error(
      `Tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations for this message. Please try a narrower request.`
    );
  }

  // -------------------------------------------------------------------------
  // Write queue — serializes all async browser writes
  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch((err) => {
      log.warn('Write queue error:', err?.message || err);
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
    if (skip) {
      const entry: ToolActivityEntry = {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        status: 'skipped',
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        resultPreview: skip.slice(0, 120),
      };
      this.activityLog.push(entry);
      this.emitToolActivity(entry);
      return { id: toolCall.id, content: skip };
    }

    const tStart = performance.now();
    const entry: ToolActivityEntry = {
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      status: 'running',
      startedAt: Date.now(),
    };
    this.activityLog.push(entry);
    this.emitToolActivity(entry);

    try {
      const earlyStarted = this.earlyToolResults.get(toolCall.id);
      let result = earlyStarted
        ? await earlyStarted
        : await executeTool(toolCall.name, toolCall.input, task.localContext);
      // Guard: ensure tool result is never empty
      if (!result || result.trim() === '') {
        log.warn(`[SANITIZE] Tool ${toolCall.name} returned empty result — substituting placeholder`);
        result = '[Tool completed with no output]';
      }
      const toolMs = performance.now() - tStart;
      log.debug(`Tool: ${toolCall.name}: ${toolMs.toFixed(0)}ms (${result.length} chars)`);
      perfLog('tool-exec', toolCall.name, toolMs, { chars: result.length });

      // Safety net: hard-cap any single tool result to prevent context overflow.
      // Skip for image results — they contain base64 data sent as image content blocks,
      // not as text tokens, so they don't inflate the context window the same way.
      const isImageResult = result.startsWith('{"__clawdia_image_result__":true');
      if (!isImageResult && result.length > MAX_TOOL_RESULT_CHARS) {
        log.warn(`Tool result from ${toolCall.name} exceeds limit: ${result.length} chars, truncating to ${MAX_TOOL_RESULT_CHARS}`);
        result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[... result truncated from ${result.length} chars to ${MAX_TOOL_RESULT_CHARS} ...]`;
      }

      entry.status = 'success';
      entry.completedAt = Date.now();
      entry.durationMs = Math.round(toolMs);
      entry.resultPreview = result.slice(0, 200);
      this.emitToolActivity(entry);

      return { id: toolCall.id, content: result };
    } catch (error: any) {
      const toolErrMs = performance.now() - tStart;
      log.warn(`Tool: ${toolCall.name}: ${toolErrMs.toFixed(0)}ms (error)`);
      perfLog('tool-exec', toolCall.name + ' (ERROR)', toolErrMs);

      entry.status = 'error';
      entry.completedAt = Date.now();
      entry.durationMs = Math.round(toolErrMs);
      entry.error = error?.message || 'unknown error';
      this.emitToolActivity(entry);

      if (toolCall.name === 'create_document') {
        this.emitDocProgress({
          stage: 'error',
          stageLabel: 'Document generation failed',
          stageNumber: 5,
          totalStages: 5,
          error: error?.message || 'unknown error',
        });
      }
      return { id: toolCall.id, content: `Tool error: ${error?.message || 'unknown error'}` };
    }
  }

  private getMaxTokens(isToolLoopIteration: boolean, toolCallCount: number): number {
    // First iteration (iteration 0) always gets full budget — could be a final
    // response with no tools, or a long first tool plan.
    // Intermediate iterations (tool loops) get a reduced budget — the model just
    // needs to emit tool_use blocks (~100-300 tokens). Smaller max_tokens means
    // faster inference because the model stops planning for 4096 output tokens.
    // Final response after tools: full budget restored (isToolLoopIteration=false).
    if (!isToolLoopIteration) return 4096;
    if (toolCallCount === 0) return 4096; // first call — could be direct response
    return 2048; // intermediate tool loop — model just emits tool_use blocks
  }

  private startEarlyToolExecution(toolCall: ToolCall): Promise<string> {
    const existing = this.earlyToolResults.get(toolCall.id);
    if (existing) return existing;

    const run = async () => {
      const result = await executeTool(toolCall.name, toolCall.input);
      return result;
    };

    const promise = this.earlyToolQueue.then(run, run);
    this.earlyToolQueue = promise.then(() => undefined, () => undefined);
    this.earlyToolResults.set(toolCall.id, promise);
    return promise;
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
        log.warn(`${label} task rejected:`, item.reason);
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
    const detection = detectMode(state.accumulated);

    if (detection === 'html' && state.mode !== 'html' && !state.htmlComplete) {
      const wasDetecting = state.mode === 'detecting';
      state.mode = 'html';
      const { preChat } = extractHtml(state.accumulated);
      state.preHtmlChat = preChat;
      log.debug(`HTML detected, preChat="${preChat.slice(0, 60)}", accumulated=${state.accumulated.length} chars`);

      if (wasDetecting && preChat) {
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
          log.warn('Failed to open live preview:', err?.message);
          state.mode = 'chat';
          this.emitStreamText(state.accumulated);
        }
      });
      return;
    }

    // --- DETECTION PHASE ---
    if (state.mode === 'detecting') {
      if (detection === 'chat') {
        state.mode = 'chat';
        log.debug(`Chat mode, accumulated=${state.accumulated.length} chars`);
        this.emitStreamText(state.accumulated);
      }
      // Still detecting or just switched to chat — buffer without displaying
      return;
    }

    // --- HTML MODE ---
    if (state.mode === 'html') {
      const closingIdx = findClosingFence(state.accumulated);
      if (closingIdx >= 0 && !state.htmlComplete) {
        state.htmlComplete = true;
        log.debug(`Closing fence found at ${closingIdx}, total=${state.accumulated.length}`);

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

  private emitDocProgress(progress: Omit<DocProgressEvent, 'conversationId' | 'messageId' | 'elapsedMs'> | DocProgressEvent): void {
    if (this.window.isDestroyed() || !this.runContext) return;
    const elapsedMs = performance.now() - this.runStartedAt;
    const payload: DocProgressEvent = {
      conversationId: this.runContext.conversationId,
      messageId: this.runContext.messageId,
      stage: progress.stage,
      stageLabel: progress.stageLabel,
      stageNumber: progress.stageNumber,
      totalStages: progress.totalStages,
      elapsedMs: 'elapsedMs' in progress ? progress.elapsedMs : elapsedMs,
      detail: progress.detail,
      filename: progress.filename,
      error: progress.error,
      writeCompletedAtMs: progress.writeCompletedAtMs,
    };
    this.window.webContents.send(IPC_EVENTS.DOC_PROGRESS, payload);
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

  private emitToolActivity(entry: ToolActivityEntry): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, entry);
  }

  private emitToolActivitySummary(responseText: string): void {
    if (this.window.isDestroyed()) return;
    const summary: ToolActivitySummary = {
      totalCalls: this.activityLog.length,
      entries: this.activityLog,
      fabricationWarning: detectFabrication(responseText, this.activityLog.length) ?? undefined,
    };
    this.window.webContents.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY_SUMMARY, summary);
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

  /**
   * Trim history to stay under 5000 tokens.
   * Uses ~4 chars per token approximation.
   */
  private trimHistory(messages: Message[]): Message[] {
    const MAX_HISTORY_TOKENS = 5000;
    const CHARS_PER_TOKEN = 4;
    const maxChars = MAX_HISTORY_TOKENS * CHARS_PER_TOKEN;

    // Work backwards, keeping recent messages until we hit the token limit
    const result: Message[] = [];
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgChars = typeof msg.content === 'string' 
        ? msg.content.length 
        : JSON.stringify(msg.content).length;
      
      if (totalChars + msgChars > maxChars && result.length > 0) {
        break;
      }
      totalChars += msgChars;
      result.unshift(msg);
    }

    if (result.length < messages.length) {
      log.info(`Trimmed history from ${messages.length} to ${result.length} messages (~${Math.round(totalChars / CHARS_PER_TOKEN)} tokens)`);
    }

    return result;
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
