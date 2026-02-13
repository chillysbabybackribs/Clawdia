import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import { homedir } from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Page } from 'playwright';
import { AnthropicClient } from './client';
import {
  Message,
  ImageAttachment,
  DocumentAttachment,
  ToolActivityEntry,
  ToolActivitySummary,
  ToolExecStartEvent,
  ToolExecCompleteEvent,
  ToolStepProgressEvent,
  ToolLoopEmitter,
  ToolTimingEvent,
} from '../../shared/types';
import { IPC, IPC_EVENTS } from '../../shared/ipc-channels';
import { buildSystemPrompt, getStaticPrompt, getDynamicPrompt, type PromptTier } from './system-prompt';
import { getModelLabel, getModelConfig } from '../../shared/models';
import { BROWSER_TOOL_DEFINITIONS, executeTool as executeBrowserTool } from '../browser/tools';
import { LOCAL_TOOL_DEFINITIONS, executeLocalTool, type LocalToolExecutionContext } from '../local/tools';
import { generateSynthesisThought, generateThought } from './thought-generator';
import { classifyIntent, classifyToolClass, classifyEnriched, type ToolClass } from './intent-router';
import { strategyCache, type CacheKey } from './strategy-cache';
import { isToolAvailable } from './tool-bootstrap';
import { shouldAuthorize, classifyAction } from '../autonomy-gate';
import { ApprovalDecision, ApprovalRequest } from '../../shared/autonomy';
import { appendAuditEvent } from '../audit/audit-store';
import { redactCommand, redactUrl } from '../../shared/audit-types';
import { validateAndBuild, FAST_PATH_ENTRIES, findFastPathEntryForUrl } from './fast-path-gate';
import { buildStrategyHintBlock } from './system-prompt';
import {
  SEQUENTIAL_THINKING_TOOL_DEFINITION,
  executeSequentialThinking,
  resetSequentialThinking,
  SequentialThinkingState,
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
  getActiveTabUrl,
  exportCookiesForUrl,
} from '../browser/manager';
import { createTaskContext } from '../tasks/task-browser';
import { createLogger, perfLog, perfTimer } from '../logger';

const log = createLogger('tool-loop');

const MAX_TOOL_CALLS = 150;
const MAX_TOOL_ITERATIONS = 150;

/**
 * Detect when the model falsely claims it lacks capabilities it actually has.
 * Matches phrases like "I don't have the ability to", "I can't access your system",
 * "I'm a text-based assistant", "I cannot interact with", etc.
 */
const CAPABILITY_DENIAL_RE = /(?:I\s+(?:don't|do\s+not|can't|cannot|am\s+(?:not\s+able|unable)\s+to)\s+(?:have\s+the\s+ability|actually\s+have|access\s+your|interact\s+with|start\s+servers|open\s+(?:a\s+)?browser|launch\s+app|control\s+(?:the|your)|browse|navigate|run\s+commands|execute)|(?:I'?m\s+(?:a\s+)?text-based|without\s+graphical\s+capabilities|terminal\s+environment\s+without|I\s+lack\s+the\s+(?:ability|capability)|I\s+am\s+unable\s+to\s+(?:access|start|open|launch|browse|interact|navigate|execute|run))|(?:I\s+need\s+to\s+(?:actually\s+)?see\s+what(?:'s|\s+is)\s+open\s+in\s+your\s+browser)|(?:can\s+you\s+tell\s+me\s+which\s+site\/page\s+you\s+want\s+me\s+to\s+verify)|(?:give\s+me\s+the\s+URL\s+so\s+I\s+can\s+review))/i;
import { ConversationManager } from './conversation';
import { store } from '../store';
// Dynamically reads from ConversationManager so runtime changes apply everywhere
const getMaxHistoryMessages = () => ConversationManager.getMaxPersistedMessages();
const MAX_FINAL_RESPONSE_CONTINUATIONS = 3;
const MAX_TOOL_RESULT_IN_HISTORY = 2000; // chars — roughly 500 tokens; retains enough context for synthesis
const MAX_TOOL_RESULT_CHARS = 30_000; // hard cap on any single tool result before it enters conversation
const KEEP_FULL_TOOL_RESULTS = 4; // keep last N tool_result messages uncompressed (was 1 — too aggressive for research tasks)
const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((tool) => tool.name));
import { VAULT_TOOL_DEFINITIONS, executeVaultTool } from '../vault/tools';
import { TASK_TOOL_DEFINITIONS, executeTaskTool } from '../tasks/task-tools';
import { ARCHIVE_TOOL_DEFINITIONS, executeArchiveTool } from '../archive/tools';

const ALL_TOOLS = [...BROWSER_TOOL_DEFINITIONS, ...LOCAL_TOOL_DEFINITIONS, SEQUENTIAL_THINKING_TOOL_DEFINITION, ...VAULT_TOOL_DEFINITIONS, ...TASK_TOOL_DEFINITIONS, ...ARCHIVE_TOOL_DEFINITIONS];
const VAULT_TOOL_NAMES = new Set(VAULT_TOOL_DEFINITIONS.map(t => t.name));
const TASK_TOOL_NAMES = new Set(TASK_TOOL_DEFINITIONS.map(t => t.name));
const ARCHIVE_TOOL_NAMES = new Set(ARCHIVE_TOOL_DEFINITIONS.map(t => t.name));

const LOCAL_WRITE_TOOL_NAMES = new Set(['file_write', 'file_edit']);

// Token usage callback for dashboard executor
let tokenUsageCallback: ((data: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; model: string }) => void) | null = null;

export function setTokenUsageCallback(cb: typeof tokenUsageCallback): void {
  tokenUsageCallback = cb;
}

const MEDIA_EXTRACT_FAST_PATH_MIN_SCORE = 0.8;
const MEDIA_EXTRACT_CDN_DENY_RE = /(MissingKey|Key-Pair-Id|403\s+Forbidden|HTTP\/?1\.\d\s+403|AccessDenied|Forbidden)/i;
const MEDIA_EXTRACT_CURL_FFMPEG_RE = /\b(curl|ffmpeg)\b/i;
const MEDIA_EXTRACT_FFMPEG_RE = /\bffmpeg\b/i;
const MEDIA_EXTRACT_FORBIDDEN_BROWSER_TOOLS = new Set([
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_interact',
  'browser_fill_form',
  'browser_visual_extract',
]);
const MEDIA_EXTRACT_ALLOWED_BROWSER_READ = new Set([
  'browser_navigate',
  'browser_read_page',
  'browser_extract',
  'browser_read_tabs',
  'browser_batch',
  'browser_search',
  'browser_search_rich',
]);
// FFmpeg, curl, wget are now ALLOWED for media processing (v1.0.6+). Only system package managers restricted.
const MEDIA_EXTRACT_FORBIDDEN_SHELL_RE = /\b(xdotool|apt-get|brew|pip|pip3)\b/i;

function isBareHostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || '';
    return path === '/' && !parsed.search;
  } catch {
    return false;
  }
}

function resolveOutputDir(dirHint?: string): string | undefined {
  if (!dirHint) return undefined;
  const lower = dirHint.toLowerCase();
  if (lower === 'desktop') return path.join(homedir(), 'Desktop');
  if (lower === 'downloads' || lower === 'download') return path.join(homedir(), 'Downloads');
  if (lower === 'documents') return path.join(homedir(), 'Documents', 'Clawdia');
  return undefined;
}

function buildYtDlpCommand(
  url: string,
  preferredTool?: string,
  outputDirHint?: string,
): { argv: string[]; timeoutMs: number } | null {
  if (!isToolAvailable('yt-dlp')) return null;
  const entry = findFastPathEntryForUrl(url, preferredTool || 'yt-dlp');
  if (!entry || entry.id !== 'yt-dlp') return null;
  const outputDir = resolveOutputDir(outputDirHint);
  return validateAndBuild(entry, { url, outputDir: outputDir || '' });
}

async function runYtDlpWithCookies(
  url: string,
  safeCmd: { argv: string[]; timeoutMs: number },
): Promise<string> {
  let cookiesPath: string | null = null;
  try {
    cookiesPath = await exportCookiesForUrl(url).catch(() => null);
    const argv = cookiesPath ? [...safeCmd.argv, '--cookies', cookiesPath] : safeCmd.argv;
    return await executeLocalTool('shell_exec', {
      command: argv.join(' '),
      timeout: safeCmd.timeoutMs / 1000,
    });
  } finally {
    if (cookiesPath) {
      try { await fs.unlink(cookiesPath); } catch { /* ignore */ }
    }
  }
}

function filterMediaExtractTools(tools: typeof ALL_TOOLS, allowBrowserAuth: boolean): typeof ALL_TOOLS {
  return tools.filter((t) => {
    if (!t.name.startsWith('browser_')) return true;
    if (MEDIA_EXTRACT_FORBIDDEN_BROWSER_TOOLS.has(t.name)) return false;
    if (allowBrowserAuth) {
      return MEDIA_EXTRACT_ALLOWED_BROWSER_READ.has(t.name);
    }
    return MEDIA_EXTRACT_ALLOWED_BROWSER_READ.has(t.name);
  });
}

async function executeTool_deprecated(
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

  if (VAULT_TOOL_NAMES.has(name)) {
    return executeVaultTool(name, input);
  }

  if (TASK_TOOL_NAMES.has(name)) {
    return executeTaskTool(name, input);
  }

  if (ARCHIVE_TOOL_NAMES.has(name)) {
    return executeArchiveTool(name, input);
  }

  if (LOCAL_TOOL_NAMES.has(name)) {
    return executeLocalTool(name, input, context);
  }
  return `Unknown tool: ${name}`;
}
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
  'browser_interact',
  'browser_fill_form',
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

const HYBRID_HEADLESS_TOOL_NAMES = new Set([
  'browser_read_page',
  'browser_extract',
  'browser_visual_extract',
  'browser_batch',
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
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
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
): Array<{ type: string;[key: string]: unknown }> | null {
  if (!result.startsWith('{"__clawdia_image_result__":true')) return null;
  try {
    const parsed = JSON.parse(result);
    if (!parsed.__clawdia_image_result__ || !parsed.image_base64) return null;
    const blocks: Array<{ type: string;[key: string]: unknown }> = [
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
  const MAX = MAX_TOOL_RESULT_IN_HISTORY;
  const SEPARATOR_BUDGET = 60; // room for "[... truncated N chars, ~N lines ...]" line
  const TAIL_RATIO = 0.3;
  const tail = Math.floor((MAX - SEPARATOR_BUDGET) * TAIL_RATIO);
  const head = MAX - SEPARATOR_BUDGET - tail;
  const lineCount = (result.match(/\n/g) || []).length;
  const truncated = result.length - head - tail;
  return `${result.slice(0, head)}\n\n[... truncated ${truncated} chars, ~${lineCount} lines ...]\n\n${result.slice(-tail)}`;
}

/**
 * Compress old tool_result messages in the conversation history.
 * Keeps the last KEEP_FULL_TOOL_RESULTS tool_result messages at full size;
 * truncates everything older. This dramatically reduces input tokens
 * on iterations 5+ of a tool loop.
 */
// WeakSet to track messages already compressed — avoids re-parsing JSON on every iteration
const compressedMessages = new WeakSet<Message>();

function compressOldToolResults(messages: Message[]): void {
  // Walk backwards to find tool_result messages (stored as JSON arrays)
  let toolResultCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !msg.content.startsWith('[')) continue;

    // Skip if already compressed in a previous iteration
    if (compressedMessages.has(msg)) {
      toolResultCount++;
      continue;
    }

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
      const newMsg = { ...msg, content: JSON.stringify(compressed) };
      messages[i] = newMsg;
      compressedMessages.add(newMsg);
    } else {
      // Mark as checked even if no changes needed — skip JSON.parse next time
      compressedMessages.add(msg);
    }
  }
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context?: LocalToolExecutionContext,
  isolatedPage?: Page | null,
  thinkingState?: SequentialThinkingState,
): Promise<string> {
  if (name === 'sequential_thinking') {
    // Use per-instance thinking state if provided, else fall back to global
    return thinkingState ? thinkingState.execute(input) : executeSequentialThinking(input);
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
    return executeBrowserTool(name, input, isolatedPage);
  }

  if (VAULT_TOOL_NAMES.has(name)) {
    return executeVaultTool(name, input);
  }

  if (TASK_TOOL_NAMES.has(name)) {
    return executeTaskTool(name, input);
  }

  if (ARCHIVE_TOOL_NAMES.has(name)) {
    return executeArchiveTool(name, input);
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
  private emitter: ToolLoopEmitter;
  private client: AnthropicClient;
  private aborted = false;
  private abortController: AbortController | null = null;
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
  private activeTools = new Set<AbortController>();
  private runContext: ToolLoopRunContext | null = null;
  private runStartedAt = 0;
  private documentProgressEnabled = false;
  /** Tracks all tool calls executed in this run for the activity panel. */
  private activityLog: ToolActivityEntry[] = [];
  /** True if any visible text was streamed to the renderer in this run. */
  private hasStreamedText = false;
  /** Tracks consecutive failures per tool+target to detect repeated errors. */
  private failureTracker = new Map<string, { count: number; lastError: string }>();

  // ---- Heartbeat: keeps thinking indicator alive during long runs ----
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentPhase: 'api-calling' | 'tools-running' | 'synthesizing' = 'api-calling';
  private heartbeatCycleIndex = 0;

  /**
   * Isolated Playwright Page for headless task execution.
   * When set, browser tools use this page instead of the interactive BrowserView page.
   * Session invalidation checks are skipped for isolated contexts.
   */
  private _isolatedPage: Page | null = null;

  /** Per-instance sequential thinking state (no global sharing). */
  private thinkingState = new SequentialThinkingState();

  /** Per-instance prefetch cache (no global sharing). */
  private instancePrefetchCache: {
    files: Map<string, PrefetchFileEntry>;
    navigation: PrefetchNavigationEntry | null;
  } = { files: new Map(), navigation: null };

  constructor(emitter: ToolLoopEmitter, client: AnthropicClient) {
    this.emitter = emitter;
    this.client = client;
  }

  /**
   * Set an isolated Playwright Page for headless task execution.
   * Must be called before run(). When set:
   * - Browser tools use this page instead of the interactive BrowserView
   * - Session invalidation checks are skipped (isolated contexts don't use the shared CDP session)
   * - Prefetch cache and sequential thinking state are per-instance (already guaranteed by instance fields)
   */
  setIsolatedPage(page: Page): void {
    this._isolatedPage = page;
  }

  abort(): void {
    this.aborted = true;
    this.stopHeartbeat();
    this.abortController?.abort();
    for (const ctrl of this.activeTools) {
      ctrl.abort();
    }
    this.activeTools.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatCycleIndex = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.aborted || this.emitter.isDestroyed()) {
        this.stopHeartbeat();
        return;
      }
      const elapsedSec = Math.round((performance.now() - this.runStartedAt) / 1000);
      const apiMessages = [
        'Thinking...',
        'Analyzing...',
        'Working through this...',
        'Processing...',
      ];
      const toolMessages = [
        'Running tools...',
        'Working...',
        'Executing tasks...',
        'Making progress...',
      ];
      const synthMessages = [
        'Putting it together...',
        'Reviewing findings...',
        'Synthesizing...',
        'Wrapping up...',
      ];
      let pool: string[];
      switch (this.currentPhase) {
        case 'api-calling': pool = apiMessages; break;
        case 'tools-running': pool = toolMessages; break;
        case 'synthesizing': pool = synthMessages; break;
      }
      const base = pool[this.heartbeatCycleIndex % pool.length];
      const suffix = elapsedSec > 10 ? ` (${elapsedSec}s)` : '';
      this.emitThinking(base + suffix);
      this.heartbeatCycleIndex++;
    }, 12_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    this.hasStreamedText = false;
    this.failureTracker.clear();
    // Only manage session invalidation for interactive loops (no isolatedPage).
    // Headless loops with isolated pages don't share the BrowserView CDP session.
    if (!this._isolatedPage) {
      clearSessionInvalidated(); // Clear stale signals from prior runs
    }
    this.thinkingState.reset(); // Fresh per-instance thinking state
    resetSequentialThinking(); // Also reset legacy global state for interactive loops
    this.emitThinking(generateSynthesisThought(0));
    this.currentPhase = 'api-calling';
    this.startHeartbeat();
    if (this.documentProgressEnabled) {
      this.emitDocProgress({
        stage: 'generating',
        stageLabel: 'Writing content...',
        stageNumber: 1,
        totalStages: 5,
      });
    }

    const totalStart = performance.now();
    let toolFailures = 0;
    const modelLabel = getModelLabel(this.client.getModel());
    const currentUrl = getActiveTabUrl() || undefined;

    // Build split prompts: static (cached) + dynamic (uncached, small)
    const promptStart = performance.now();
    const autonomyMode = (store.get('autonomyMode') as string) || 'guided';
    const minimalStatic = getStaticPrompt('minimal', autonomyMode);
    const standardStatic = getStaticPrompt('standard', autonomyMode);
    const dynamicPrompt = getDynamicPrompt(modelLabel, currentUrl, userMessage, autonomyMode);
    const promptMs = performance.now() - promptStart;
    if (promptMs > 5) log.info(`[Perf] getDynamicPrompt: ${promptMs.toFixed(1)}ms`);

    // Combined prompts for backward-compat paths (forceFinalResponse, etc.)
    const minimalPrompt = minimalStatic + '\n\n' + dynamicPrompt;
    const standardPrompt = standardStatic + '\n\n' + dynamicPrompt;
    let systemPrompt = standardStatic; // default static portion, may switch to minimal
    let systemDynamic = dynamicPrompt; // always passed separately

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

    // ---- ARCHETYPE CLASSIFICATION + FAST PATH ----
    const historyForRouter = history.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }));
    const enriched = classifyEnriched(augmentedMessage, historyForRouter, currentUrl);
    const cacheKey: CacheKey = {
      archetype: enriched.strategy.archetype,
      primaryHost: enriched.strategy.extractedParams.url
        ? (() => { try { return new URL(enriched.strategy.extractedParams.url).hostname.replace(/^www\./, ''); } catch { return null; } })()
        : null,
      toolClass: enriched.toolClass,
    };
    const mediaExtractUrl = enriched.strategy.extractedParams.url;
    const mediaExtractPreferredTool = enriched.strategy.extractedParams.fastPathTool;
    const mediaExtractOutputDir = enriched.strategy.extractedParams.outputDir;
    const isMediaExtractHighConfidence =
      enriched.strategy.archetype === 'media-extract' &&
      enriched.strategy.score >= MEDIA_EXTRACT_FAST_PATH_MIN_SCORE &&
      !!mediaExtractUrl;
    let mediaExtractFastPathAttempted = false;
    let mediaExtractAuthFallbackHint = false;
    let mediaExtractFallbackUsed = false;
    let mediaExtractAuthFallbackHintApplied = false;
    const applyMediaExtractAuthFallbackHint = () => {
      if (mediaExtractAuthFallbackHintApplied) return;
      mediaExtractAuthFallbackHintApplied = true;
      systemDynamic += buildStrategyHintBlock(
        'Media download failed or yt-dlp unavailable. Do NOT retry curl/ffmpeg variants. Use browser tools to access the authenticated page, extract the media URL, then download. Avoid screenshots unless absolutely necessary.'
      );
    };

    const setupMs = performance.now() - totalStart;
    if (setupMs > 10) log.info(`[Perf] Pre-API setup: ${setupMs.toFixed(1)}ms (prompt=${promptMs.toFixed(1)} hist=${histMs.toFixed(1)} classify=${(performance.now() - totalStart - promptMs - histMs).toFixed(1)})`);

    // DETERMINISTIC FAST PATH — bypass LLM entirely for known CLI tasks
    if (isMediaExtractHighConfidence && mediaExtractUrl) {
      mediaExtractFastPathAttempted = true;
      if (isBareHostUrl(mediaExtractUrl)) {
        log.info('[FastPath] media-extract URL is a bare host; skipping yt-dlp and using browser-auth flow');
        mediaExtractAuthFallbackHint = true;
        applyMediaExtractAuthFallbackHint();
      } else {
        const preExtractorMs = performance.now() - totalStart;
        perfLog('media-extract', 'pre-extractor-delay', preExtractorMs, {
          tool: 'yt-dlp',
          host: (() => { try { return new URL(mediaExtractUrl).hostname.replace(/^www\./, ''); } catch { return null; } })(),
          confidence: enriched.strategy.score,
        });

        const safeCmd = buildYtDlpCommand(mediaExtractUrl, mediaExtractPreferredTool, mediaExtractOutputDir);
        if (safeCmd) {
          log.info(`[FastPath] media-extract (high confidence) → ${safeCmd.argv.join(' ')}`);
          this.emitThinking('Executing directly...');
          try {
            const result = await runYtDlpWithCookies(mediaExtractUrl, safeCmd);
            const totalMs = performance.now() - totalStart;
            perfLog('media-extract', 'total', totalMs, { tool: 'yt-dlp', success: true });
            strategyCache.record(cacheKey, ['shell_exec'], 0, totalMs, true);
            this.stopHeartbeat();
            this.emitThinking('');
            this.emitToolLoopComplete(1, totalMs, 0);
            return result;
          } catch (err: any) {
            const totalMs = performance.now() - totalStart;
            perfLog('media-extract', 'total', totalMs, { tool: 'yt-dlp', success: false });
            log.warn(`[FastPath] yt-dlp failed: ${err?.message}, falling back to browser-auth`);
            mediaExtractAuthFallbackHint = true;
            applyMediaExtractAuthFallbackHint();
          }
        } else {
          log.info('[FastPath] yt-dlp unavailable or not allowed for URL, falling back to browser-auth');
          mediaExtractAuthFallbackHint = true;
          applyMediaExtractAuthFallbackHint();
        }
      }
    }

    if (
      enriched.strategy.tier === 'deterministic' &&
      enriched.strategy.fastPathCommand &&
      enriched.strategy.fastPathEntry
    ) {
      const isMediaExtractLowConfidence =
        enriched.strategy.archetype === 'media-extract' &&
        enriched.strategy.score < MEDIA_EXTRACT_FAST_PATH_MIN_SCORE;
      if (!mediaExtractFastPathAttempted && !isMediaExtractLowConfidence) {
        const entry = enriched.strategy.fastPathEntry;
        const safeCmd = validateAndBuild(entry, {
          url: enriched.strategy.extractedParams.url || '',
        });
        if (safeCmd) {
          log.info(`[FastPath] ${enriched.strategy.archetype} → ${safeCmd.argv.join(' ')}`);
          this.emitThinking('Executing directly...');
          try {
            const result = await executeLocalTool('shell_exec', {
              command: safeCmd.argv.join(' '),
              timeout: safeCmd.timeoutMs / 1000,
            });
            const totalMs = performance.now() - totalStart;
            strategyCache.record(cacheKey, ['shell_exec'], 0, totalMs, true);
            this.stopHeartbeat();
            this.emitThinking('');
            this.emitToolLoopComplete(1, totalMs, 0);
            return result;
          } catch (err: any) {
            log.warn(`[FastPath] execution failed: ${err?.message}, falling back to LLM loop`);
            // Fall through to normal LLM loop
          }
        } else {
          log.warn(`[FastPath] safety gate rejected, falling back to LLM loop`);
        }
      }
    }

    // STRATEGY HINT — inject into dynamic prompt for score >= 0.5
    if (enriched.strategy.score >= 0.5 && enriched.strategy.archetype !== 'unknown') {
      const hint = enriched.strategy.systemHint;
      const cachedHint = strategyCache.getHint(cacheKey);
      const hintBlock = buildStrategyHintBlock(hint + (cachedHint ? '\n' + cachedHint : ''));
      if (hintBlock) {
        systemDynamic += hintBlock;
      }
    }
    if (mediaExtractAuthFallbackHint) {
      applyMediaExtractAuthFallbackHint();
    }

    // TASK CREATION NUDGE — when persistent task signals are detected and history is
    // short (new conversation), inject a direct instruction into the messages array.
    // System prompt hints alone are insufficient on the first turn of a new conversation;
    // the model tends to describe the task instead of calling task_create.
    if (enriched.strategy.systemHint?.includes('task_create') && history.length < 4) {
      messages.push(makeMessage('user',
        '[System] IMPORTANT: The user is requesting a persistent/recurring task. You MUST call the task_create tool right now. Do NOT describe what you would do — call the tool immediately.'
      ));
      messages.push(makeMessage('assistant', 'I\'ll create that task for you now.'));
    }

    const searchHistory: SearchEntry[] = [];
    let toolCallCount = 0;
    const finalResponseParts: string[] = [];
    let continuationCount = 0;
    const llmStatsByIteration: IterationLlmStats[] = [];
    /** Track all tool names used across iterations for strategy cache. */
    const allToolNamesUsed: string[] = [];

    let maxIterations = MAX_TOOL_ITERATIONS;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (this.aborted) {
        this.emitThinking('');
        return '[Stopped]';
      }

      // Check if the browser session was externally invalidated (tab closed, CDP died, etc.)
      // Only relevant for interactive loops — headless loops with isolated pages are independent.
      if (!this._isolatedPage && isSessionInvalidated()) {
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
        // Ask the user if they want to continue
        const shouldContinue = await this.askUserToContinue(toolCallCount);
        if (shouldContinue) {
          toolCallCount = 0; // Reset counter for another round
          log.info(`User chose to continue — tool call counter reset`);
          messages.push(
            makeMessage(
              'user',
              '[SYSTEM: The user has granted you additional tool calls. Continue working on the task. Pick up where you left off.]'
            )
          );
        } else {
          const text = await this.forceFinalResponseAtToolLimit(messages, systemPrompt, systemDynamic);
          this.stopHeartbeat();
          this.emitThinking('');
          this.emitToolActivitySummary(text);
          const totalMs = performance.now() - totalStart; log.info(`Total wall time: ${totalMs.toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`); perfLog("tool-loop", "total-wall-time", totalMs, { iterations: iteration + 1, toolCalls: toolCallCount });
          return text;
        }
      }

      if (toolCallCount === MAX_TOOL_CALLS - 5) {
        messages.push(
          makeMessage(
            'user',
            '[SYSTEM: Approaching tool limit. Prioritize breadth — address ALL parts of the user\'s request. If you have not finished, you will be able to continue.]'
          )
        );
      }

      // Deterministic intent router: on the FIRST iteration (no tools used yet),
      // classify the user message. If it's purely conversational, skip tool
      // definitions entirely — saves ~3000-4000 tokens and speeds up the API call.
      let tools: typeof ALL_TOOLS | [] = [];
      if (toolCallCount >= MAX_TOOL_CALLS) {
        tools = [];
      } else if (iteration === 0 && enriched.intent === 'chat-only') {
        tools = [];
        systemPrompt = minimalStatic; // Use minimal prompt for chat-only (~800 tokens vs ~2K)
        log.info('Intent router: chat-only — using minimal prompt, skipping tool definitions');
        perfLog('intent-router', 'route-chat-only', 0, { message: augmentedMessage.slice(0, 80) });
      } else {
        // On first iteration, try to narrow the tool set by intent class.
        // After iteration 0, always provide all tools (the LLM may need both).
        if (iteration === 0) {
          const toolClass = enriched.toolClass;
          let filteredTools = ALL_TOOLS as typeof ALL_TOOLS;
          if (toolClass === 'browser') {
            const ALWAYS_INCLUDE_LOCAL = new Set(['create_document']);
            filteredTools = ALL_TOOLS.filter(t => !LOCAL_TOOL_NAMES.has(t.name) || t.name === 'shell_exec' || ALWAYS_INCLUDE_LOCAL.has(t.name) || TASK_TOOL_NAMES.has(t.name) || ARCHIVE_TOOL_NAMES.has(t.name));
            log.info(`Intent router: browser-only — ${filteredTools.length} tools (skipped ${ALL_TOOLS.length - filteredTools.length} local, kept task tools)`);
          } else if (toolClass === 'local') {
            filteredTools = ALL_TOOLS.filter(t => LOCAL_TOOL_NAMES.has(t.name) || t.name === 'sequential_thinking' || TASK_TOOL_NAMES.has(t.name) || ARCHIVE_TOOL_NAMES.has(t.name));
            log.info(`Intent router: local-only — ${filteredTools.length} tools (skipped ${ALL_TOOLS.length - filteredTools.length} browser, kept task tools)`);
          }

          // If archetype says skip browser tools, additionally filter
          if (enriched.strategy.skipBrowserTools && toolClass !== 'local') {
            filteredTools = filteredTools.filter(t => !t.name.startsWith('browser_') || t.name === 'browser_search' || t.name === 'browser_search_rich');
            log.info(`Archetype ${enriched.strategy.archetype}: filtered to ${filteredTools.length} tools (browser tools skipped)`);
          }

          if (enriched.strategy.archetype === 'media-extract') {
            filteredTools = filterMediaExtractTools(filteredTools, mediaExtractAuthFallbackHint);
            log.info(`Archetype media-extract: restricted browser tools to non-visual read/extract (count=${filteredTools.length})`);
          }

          tools = filteredTools;
        } else {
          tools = ALL_TOOLS;
          if (enriched.strategy.archetype === 'media-extract') {
            tools = filterMediaExtractTools(tools as typeof ALL_TOOLS, mediaExtractAuthFallbackHint);
            log.info(`Archetype media-extract: restricted browser tools to non-visual read/extract (count=${tools.length})`);
          }
        }
      }

      // Set up streaming with HTML interception
      const interceptor = createInterceptor();
      let streamedFullText = '';

      // Only use the onText callback for streaming;
      // it fires synchronously per text_delta chunk
      const onText = (chunk: string) => {
        if (this.emitter.isDestroyed()) return;
        streamedFullText += chunk;
        this.handleStreamChunk(chunk, interceptor);
      };

      // Compress old tool results before sending — keeps last 2 at full size,
      // truncates everything older to ~2000 chars. Saves 50-70% input tokens on later iterations.
      compressOldToolResults(messages);

      // First pass keeps a full budget for quality; intermediate tool loops stay small for speed.
      const maxTokens = this.getMaxTokens(tools.length > 0, toolCallCount);
      this.currentPhase = 'api-calling';
      this.abortController = new AbortController();
      const apiStart = performance.now();
      let response;
      try {
        // Enable compaction and context editing for models that support them
        const currentModelConfig = getModelConfig(this.client.getModel());
        const allowContextManagement = Boolean(currentModelConfig?.supportsCompaction && currentModelConfig?.tier !== 'opus');
        response = await this.client.chat(messages, tools, systemPrompt, onText, {
          maxTokens,
          signal: this.abortController.signal,
          dynamicSystemPrompt: systemDynamic,
          enableCompaction: allowContextManagement,
          enableContextEditing: allowContextManagement, // same gate as compaction for now
          // Speculative tool execution: start running tools as soon as the model
          // finishes streaming each tool_use block. By the time the full API
          // response arrives, fast tools (shell_exec, file_read, etc.) are already
          // done. The regular tool-loop phase checks earlyToolResults first and
          // reuses the result instead of re-executing.
          onToolUse: (toolUse) => {
            // Only speculatively execute safe, stateless, read-only tools.
            // Browser nav / clicks / writes could have side effects if the model
            // later decides to change plan in a subsequent tool_use block.
            // shell_exec excluded: goes through autonomy gate and may require approval.
            // Running it speculatively would bypass the approval check.
            const SPECULATIVE_SAFE = new Set([
              'file_read', 'directory_tree', 'process_manager',
              'browser_search', 'browser_news', 'browser_shopping',
              'browser_places', 'browser_images', 'browser_search_rich',
              'cache_read', 'sequential_thinking', 'memory_search',
            ]);
            if (SPECULATIVE_SAFE.has(toolUse.name)) {
              log.debug(`Speculative exec starting: ${toolUse.name} (id=${toolUse.id})`);
              const promise = this.startEarlyToolExecution(toolUse);
              return promise;
            }
            return undefined;
          },
        });
      } catch (err: any) {
        // AbortError from AbortController — user cancelled
        if (err?.name === 'AbortError' || err?.name === 'APIUserAbortError' || this.aborted) {
          log.info('API call aborted by user');
          this.stopHeartbeat();
          this.emitThinking('');
          return '[Stopped]';
        }
        throw err;
      }
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
      // Emit route info to renderer for transparency
      if (!this.emitter.isDestroyed()) {
        this.emitter.send(IPC_EVENTS.CHAT_ROUTE_INFO, {
          model: response.model,
          iteration: iteration + 1,
          inputTokens: rIn || 0,
          outputTokens: rOut || 0,
          cacheReadTokens: cRead || 0,
          durationMs: Math.round(apiDurationMs),
        });
        this.emitter.send(IPC_EVENTS.TOKEN_USAGE_UPDATE, {
          inputTokens: rIn || 0,
          outputTokens: rOut || 0,
          cacheReadTokens: cRead || 0,
          cacheCreateTokens: cWrite || 0,
          model: response.model,
          timestamp: Date.now(),
        });
      }
      // Forward to dashboard executor for session cost tracking
      tokenUsageCallback?.({
        inputTokens: rIn || 0,
        outputTokens: rOut || 0,
        cacheReadTokens: cRead || 0,
        cacheCreateTokens: cWrite || 0,
        model: response.model,
      });
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
        this.stopHeartbeat();
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
        // TASK CREATION RETRY — if the LLM was supposed to call task_create but
        // returned text instead (common hallucination: writes a fake task ID in prose),
        // re-inject its response as context and force one more iteration.
        if (
          iteration === 0 &&
          toolCallCount === 0 &&
          enriched.strategy.systemHint?.includes('task_create') &&
          responseText &&
          !responseText.includes('[Stopped]')
        ) {
          log.warn('[TaskRetry] LLM returned text instead of calling task_create — forcing retry');
          const assistantContent = response.content && response.content.length > 0
            ? response.content
            : [{ type: 'text', text: responseText }];
          messages.push(makeMessage('assistant', JSON.stringify(assistantContent)));
          messages.push(makeMessage('user',
            '[System] ERROR: You did NOT call the task_create tool. You wrote a text response instead. The task was NOT created. You MUST call the task_create tool NOW. Do not respond with text — use the tool.'
          ));
          // Clear streamed text so the retry response replaces it
          finalResponseParts.length = 0;
          this.hasStreamedText = false;
          continue;
        }

        // CAPABILITY DENIAL RETRY — detect when the model hallucinates that it
        // lacks abilities it actually has (browser, shell, file system, etc.).
        // Common with smaller models like Haiku that ignore system prompt instructions.
        // Only retry once (iteration < 2) and only when tools were provided.
        if (
          iteration < 2 &&
          tools.length > 0 &&
          responseText &&
          CAPABILITY_DENIAL_RE.test(responseText)
        ) {
          log.warn(`[CapabilityDenial] Model falsely claimed it cannot do something — forcing retry (iteration=${iteration})`);
          const assistantContent = response.content && response.content.length > 0
            ? response.content
            : [{ type: 'text', text: responseText }];
          messages.push(makeMessage('assistant', JSON.stringify(assistantContent)));
          messages.push(makeMessage('user',
            '[System] CORRECTION: Your previous response is WRONG. You DO have full browser control, local system access via shell_exec, and file system access. You are NOT a text-based assistant — you are an agent with tools. Review your available tools and USE THEM to fulfill the user\'s request. Do not apologize or ask clarifying questions — take action NOW.'
          ));
          finalResponseParts.length = 0;
          this.hasStreamedText = false;
          // Also ensure we're using the full standard prompt, not minimal
          systemPrompt = standardStatic;
          continue;
        }

        if (responseText) {
          finalResponseParts.push(responseText);
        }

        // If the model was truncated by max_tokens, continue seamlessly.
        // Do NOT finalize the stream yet — the continuation will keep appending
        // to the same streaming container, preventing duplicate chat bubbles.
        const willContinue = response.stopReason === 'max_tokens' && continuationCount < MAX_FINAL_RESPONSE_CONTINUATIONS;
        if (willContinue) {
          continuationCount += 1;
          const contContent = response.content && response.content.length > 0
            ? response.content
            : [{ type: 'text', text: '[Processing...]' }];
          messages.push(makeMessage('assistant', JSON.stringify(contContent)));
          messages.push(
            makeMessage(
              'user',
              '[SYSTEM: Your previous response was cut off by a token limit. Continue exactly where you left off, with no repetition. Do not re-state what you already said. Finish all remaining required sections.]'
            )
          );
          this.emitThinking(`Continuing response (${continuationCount})...`);
          continue;
        }

        // Truly final response — finish any open HTML stream
        await this.finishStream(interceptor);
        if (streamedFullText) {
          this.streamed = true;
        }

        this.stopHeartbeat();
        this.emitThinking('');
        const finalText = finalResponseParts.join('\n').trim();
        this.emitToolActivitySummary(finalText);
        const totalMs = performance.now() - totalStart; log.info(`Total wall time: ${totalMs.toFixed(0)}ms, iterations: ${iteration + 1}, toolCalls: ${toolCallCount}`); perfLog("tool-loop", "total-wall-time", totalMs, { iterations: iteration + 1, toolCalls: toolCallCount });
        // Record successful strategy for future hint generation
        strategyCache.record(cacheKey, allToolNamesUsed, iteration + 1, totalMs, true);
        this.emitToolLoopComplete(toolCallCount, totalMs, toolFailures);
        return finalText;
      }

      continuationCount = 0;

      // Tool calls found — reset the streamed-text flag for the next iteration
      // but do NOT emit a stream reset to the renderer. The old emitStreamReset()
      // cleared the chat bubble between iterations, causing visible flickering.
      // The final response replaces all streamed content anyway via
      // finalizeAssistantMessage(), so intermediate text is harmless.
      this.hasStreamedText = false;

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
        content: string | Array<{ type: string;[key: string]: unknown }>;
      }> = [];

      // Build execution tasks, handling search dedup inline
      const execTasks: ExecutionTask[] = [];
      const currentAutonomyMode = (store.get('autonomyMode') as string) || 'guided';
      for (const toolCall of toolCalls) {
        if (
          currentAutonomyMode !== 'unrestricted' &&
          enriched.strategy.archetype === 'media-extract' &&
          MEDIA_EXTRACT_FORBIDDEN_BROWSER_TOOLS.has(toolCall.name)
        ) {
          execTasks.push({
            toolCall,
            skip: 'Visual browser actions are disabled for media extraction. Use read/extract tools or yt-dlp.',
          });
          continue;
        }
        if (
          currentAutonomyMode !== 'unrestricted' &&
          toolCall.name === 'shell_exec' &&
          enriched.strategy.archetype === 'media-extract'
        ) {
          const cmd = String(toolCall.input?.command || '');
          if (MEDIA_EXTRACT_FORBIDDEN_SHELL_RE.test(cmd)) {
            execTasks.push({
              toolCall,
              skip: 'Direct curl/ffmpeg/install/automation commands are disabled for media extraction. Use yt-dlp.',
            });
            continue;
          }
        }
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
      // Track tool names for strategy cache
      for (const t of execTasks) {
        if (!t.skip) allToolNamesUsed.push(t.toolCall.name);
      }
      if (execTasks.length > 0) {
        this.emitThinking(generateThought(execTasks[0].toolCall.name, execTasks[0].toolCall.input));
      }

      this.currentPhase = 'tools-running';
      const toolsStart = performance.now();
      const results = await this.executeToolsParallel(execTasks);
      const toolsBatchMs = performance.now() - toolsStart;
      log.debug(`All tools (parallel): ${toolsBatchMs.toFixed(0)}ms`);
      perfLog('tool-loop', `tools-batch-iter-${iteration + 1}`, toolsBatchMs, { count: toolCalls.length });

      if (this.aborted) {
        this.stopHeartbeat();
        this.emitThinking('');
        return '[Stopped]';
      }

      const resultMap = new Map(results.map((r) => [r.id, r.content]));
      let errorNudge: string | null = null;
      for (const toolCall of toolCalls) {
        const rawResult = resultMap.get(toolCall.id);
        let resultContent = (rawResult && rawResult.trim() !== '') ? rawResult : 'Tool execution failed';
        const recorded = this.activityLog.find((e) => e.id === toolCall.id);
        if (recorded?.status === 'error' || recorded?.status === 'warning') {
          if (recorded?.status === 'error') toolFailures += 1;

          // Track repeated failures per tool+target to inject recovery guidance
          const target = String(toolCall.input?.command || toolCall.input?.url || toolCall.input?.query || '').slice(0, 80);
          const failKey = `${toolCall.name}:${target}`;
          const existing = this.failureTracker.get(failKey);
          const count = (existing?.count || 0) + 1;
          this.failureTracker.set(failKey, { count, lastError: resultContent.slice(0, 200) });

          if (count === 2) {
            errorNudge = `[System] The tool "${toolCall.name}" has failed twice on a similar target. Consider a different approach — use a different tool, change the URL/command, or simplify the request.`;
          } else if (count >= 3) {
            errorNudge = `[System] "${toolCall.name}" has failed ${count} times on a similar target. This is likely a structural issue, not a transient one. STOP retrying the same approach. Try: (1) a completely different tool, (2) break the task into smaller steps, (3) verify the target exists first with a simpler check, or (4) report what you found so far and ask the user for guidance.`;
          }
        } else {
          // Clear failure tracker on success for this tool
          const target = String(toolCall.input?.command || toolCall.input?.url || toolCall.input?.query || '').slice(0, 80);
          this.failureTracker.delete(`${toolCall.name}:${target}`);
        }

        if (
          enriched.strategy.archetype === 'media-extract' &&
          toolCall.name === 'shell_exec'
        ) {
          const cmd = String(toolCall.input?.command || '');
          if (
            !mediaExtractFallbackUsed &&
            MEDIA_EXTRACT_CURL_FFMPEG_RE.test(cmd) &&
            MEDIA_EXTRACT_CDN_DENY_RE.test(resultContent)
          ) {
            mediaExtractFallbackUsed = true;
            if (mediaExtractUrl) {
              const preExtractorMs = performance.now() - totalStart;
              perfLog('media-extract', 'pre-extractor-delay', preExtractorMs, { tool: 'yt-dlp', fallback: true });
              const safeCmd = buildYtDlpCommand(mediaExtractUrl, mediaExtractPreferredTool, mediaExtractOutputDir);
              if (safeCmd) {
                log.warn('[MediaExtract] CDN auth error detected — falling back to yt-dlp');
                try {
                  const fallbackResult = await runYtDlpWithCookies(mediaExtractUrl, safeCmd);
                  const totalMs = performance.now() - totalStart;
                  perfLog('media-extract', 'fallback-total', totalMs, { tool: 'yt-dlp', success: true });
                  resultContent =
                    `${resultContent}\n\n[Fast-path fallback via yt-dlp]\n${fallbackResult}`;
                } catch (err: any) {
                  const totalMs = performance.now() - totalStart;
                  perfLog('media-extract', 'fallback-total', totalMs, { tool: 'yt-dlp', success: false });
                  log.warn(`[MediaExtract] yt-dlp fallback failed: ${err?.message}`);
                  mediaExtractAuthFallbackHint = true;
                  applyMediaExtractAuthFallbackHint();
                  resultContent =
                    `${resultContent}\n\n[Fast-path fallback failed — use browser-auth capture to extract the media URL]`;
                }
              } else {
                mediaExtractAuthFallbackHint = true;
                applyMediaExtractAuthFallbackHint();
                resultContent =
                  `${resultContent}\n\n[yt-dlp unavailable — use browser-auth capture to extract the media URL]`;
              }
            } else {
              mediaExtractAuthFallbackHint = true;
              applyMediaExtractAuthFallbackHint();
              resultContent =
                `${resultContent}\n\n[Media URL missing — use browser-auth capture to extract the media URL]`;
            }
          }
        }

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
            if (docResult.__clawdia_document__ && !this.emitter.isDestroyed()) {
              const notifyStart = performance.now();
              this.emitter.send(IPC_EVENTS.CHAT_DOCUMENT_CREATED, {
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

      this.currentPhase = 'synthesizing';
      this.emitThinking(generateSynthesisThought(toolCallCount));
      // Guard: never push an empty tool_results array — would cause empty content error
      if (toolResults.length > 0) {
        messages.push(makeMessage('user', JSON.stringify(toolResults)));
      } else {
        log.warn('[SANITIZE] No tool results to push — adding placeholder');
        messages.push(makeMessage('user', '[All tool results were empty]'));
      }

      // Inject error recovery nudge after tool results so the LLM sees it
      if (errorNudge) {
        log.info(`[ErrorRecovery] Injecting nudge: ${errorNudge.slice(0, 100)}`);
        messages.push(makeMessage('user', errorNudge));
      }
    }

    // Iteration limit reached — force a final response
    log.warn(`Iteration limit (${maxIterations}) reached, toolCalls: ${toolCallCount}`);
    const text = await this.forceFinalResponseAtToolLimit(messages, systemPrompt, systemDynamic);
    this.stopHeartbeat();
    this.emitThinking('');
    this.emitToolActivitySummary(text);
    const totalMsMax = performance.now() - totalStart;
    log.warn(`Total wall time: ${totalMsMax.toFixed(0)}ms, iterations: ${maxIterations}, toolCalls: ${toolCallCount} — exceeded max iterations`);
    perfLog('tool-loop', 'total-wall-time-MAX', totalMsMax, { iterations: maxIterations, toolCalls: toolCallCount });
    this.emitToolLoopComplete(toolCallCount, totalMsMax, toolFailures);
    return text;
  }

  // -------------------------------------------------------------------------
  // Write queue — serializes all async browser writes
  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(fn).catch((err) => {
      log.warn('Write queue error:', err?.message || err);
    });
  }

  private emitToolOutput(toolId: string, chunk: string): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_OUTPUT, { toolId, chunk });
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

  private shouldUseHybridHeadlessTool(toolCall: ToolCall): boolean {
    if (this._isolatedPage) return false;
    if (!HYBRID_HEADLESS_TOOL_NAMES.has(toolCall.name)) return false;

    if (toolCall.name === 'browser_read_page') {
      const explicitUrl = toolCall.input?.url;
      return typeof explicitUrl === 'string' && explicitUrl.trim().length > 0;
    }

    // Keep browser_extract/browser_visual_extract on the interactive page when
    // no explicit URL is provided because they may depend on transient DOM state
    // produced by prior clicks/types in this same iteration.
    if (toolCall.name === 'browser_extract' || toolCall.name === 'browser_visual_extract') {
      const explicitUrl = toolCall.input?.url;
      return typeof explicitUrl === 'string' && explicitUrl.trim().length > 0;
    }

    return true;
  }

  private getHybridTargetUrl(toolCall: ToolCall): string | undefined {
    const directUrl = toolCall.input?.url;
    if (typeof directUrl === 'string' && directUrl.trim()) return directUrl.trim();

    if (toolCall.name === 'browser_batch') {
      const operations = toolCall.input?.operations;
      if (Array.isArray(operations)) {
        for (const op of operations) {
          const candidate = (op as any)?.url;
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      }
    }

    const activeUrl = getActiveTabUrl();
    return activeUrl || undefined;
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
      this.emitToolExecStart({
        toolId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.input,
        timestamp: entry.startedAt,
      });
      this.emitToolExecComplete({
        toolId: toolCall.id,
        status: 'success',
        duration: 0,
        summary: 'skipped',
      });
      return { id: toolCall.id, content: skip };
    }

    // --- PHASE TIMING ---
    const t1_received = performance.now();
    const tStart = t1_received;
    const toolAbortController = new AbortController();
    this.activeTools.add(toolAbortController);
    let t2_classified = t1_received;
    let t3_approved = t1_received;
    let t4_spawned = t1_received;
    let t5_firstOutput: number | undefined;
    let firstOutputCaptured = false;

    // --- AUTONOMY GATE CHECK ---
    const conversationId = this.runContext?.conversationId || 'default';
    const requestApproval = this.runContext?.requestApproval;
    const autonomyMode = (store.get('autonomyMode') as string) || 'guided';

    if (requestApproval && !skip) {
      // shouldAuthorize: classifyAction (sync regex ~0.1ms) then optional approval wait (async IPC)
      const auth = await shouldAuthorize(toolCall.name, toolCall.input, conversationId, requestApproval);
      t2_classified = performance.now(); // classify + approve combined (can't split without gate refactor)
      t3_approved = t2_classified;
      if (!auth.allowed) {
        const denyMsg = auth.error || 'Autonomy mode restricted this action.';
        const entry: ToolActivityEntry = {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          status: 'error',
          error: denyMsg,
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
        };
        this.activityLog.push(entry);
        this.emitToolActivity(entry);
        this.emitToolExecStart({
          toolId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.input,
          timestamp: entry.startedAt,
        });
        this.emitToolExecComplete({
          toolId: toolCall.id,
          status: 'error',
          duration: 0,
          summary: denyMsg,
        });
        this.activeTools.delete(toolAbortController);

        // Audit: tool_denied
        {
          const rawCmd = (toolCall.name === 'shell_exec') ? String(toolCall.input.command || '') : '';
          const rawUrl = String(toolCall.input.url || '');
          appendAuditEvent({
            ts: Date.now(),
            kind: 'tool_denied',
            conversationId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            risk: classifyAction(toolCall.name, toolCall.input).risk,
            riskReason: denyMsg,
            outcome: 'denied',
            commandPreview: rawCmd ? redactCommand(rawCmd) : undefined,
            urlPreview: rawUrl ? redactUrl(rawUrl) : undefined,
          });
        }

        return { id: toolCall.id, content: `ERROR: ${denyMsg}` };
      }
    }
    // ----------------------------

    const entry: ToolActivityEntry = {
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      status: 'running',
      startedAt: Date.now(),
    };
    this.activityLog.push(entry);
    this.emitToolActivity(entry);
    this.emitToolExecStart({
      toolId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.input,
      timestamp: entry.startedAt,
    });

    // --- SPAWN WATCHDOG: warn if we haven't started executing after 2s ---
    let spawnReached = false;
    const watchdogTimer = setTimeout(() => {
      if (!spawnReached) {
        log.warn(`[Watchdog] Tool ${toolCall.name} (${toolCall.id.slice(0, 8)}) has not reached spawn after 2000ms. Phases: classify=${(t2_classified - t1_received).toFixed(0)}ms approve=${(t3_approved - t2_classified).toFixed(0)}ms`);
      }
    }, 2000);

    let hybridCleanup: (() => Promise<void>) | null = null;
    let hybridPage: Page | null = null;
    if (this.shouldUseHybridHeadlessTool(toolCall)) {
      try {
        const targetUrl = this.getHybridTargetUrl(toolCall);
        const hybrid = await createTaskContext(targetUrl ? { targetUrl } : undefined);
        if (hybrid) {
          hybridPage = hybrid.page;
          hybridCleanup = hybrid.cleanup;
          log.info(`[Hybrid] ${toolCall.name} (${toolCall.id.slice(0, 8)}) running in isolated headless context`);
        } else {
          log.warn(`[Hybrid] Failed to allocate isolated context for ${toolCall.name}; falling back to interactive browser session`);
        }
      } catch (err: any) {
        log.warn(`[Hybrid] Could not create isolated context for ${toolCall.name}: ${err?.message || err}`);
      }
    }

    // --- EXECUTION WITH TIMEOUT PROMPT ---
    const executeOnce = async () => {
      const localCtx = {
        ...task.localContext,
        onOutput: (chunk: string) => {
          if (!firstOutputCaptured) {
            t5_firstOutput = performance.now();
            firstOutputCaptured = true;
          }
          this.emitToolOutput(toolCall.id, chunk);
        },
        signal: toolAbortController.signal,
      };

      t4_spawned = performance.now();
      spawnReached = true;

      const earlyStarted = this.earlyToolResults.get(toolCall.id);
      if (earlyStarted) {
        this.earlyToolResults.delete(toolCall.id);
        return await earlyStarted;
      }

      const executionPage = hybridPage ?? this._isolatedPage;
      return await executeTool(toolCall.name, toolCall.input, localCtx, executionPage, this.thinkingState);
    };

    const defaultTimeoutSeconds = autonomyMode === 'unrestricted' ? 300 : 60;
    const clientTimeoutSeconds = Number(toolCall.input?.timeout) || 0;
    const timeoutMs = (clientTimeoutSeconds > 0 ? clientTimeoutSeconds : defaultTimeoutSeconds) * 1000;

    let result: string;
    let completed = false;

    try {
      const runWithPrompts = async (): Promise<string> => {
        while (!completed) {
          let timeoutId: any;
          const execPromise = executeOnce().then(res => {
            if (timeoutId) clearTimeout(timeoutId);
            return res;
          });
          const timeoutPromise = new Promise<string>((resolve) => {
            timeoutId = setTimeout(() => resolve('__CLAWDIA_TIMEOUT__'), timeoutMs);
          });

          const winner = await Promise.race([execPromise, timeoutPromise]);
          if (winner === '__CLAWDIA_TIMEOUT__' && !completed) {
            log.info(`Tool ${toolCall.name} (${toolCall.id}) still running after ${timeoutMs}ms`);
            if (requestApproval) {
              const decision = await requestApproval({
                requestId: randomUUID(),
                tool: toolCall.name,
                risk: 'ELEVATED',
                reason: 'Command is taking longer than expected.',
                detail: `The command is still running after ${Math.round(timeoutMs / 1000)}s. Do you want to continue waiting or cancel it?`,
                autonomyMode: autonomyMode as any,
                createdAt: Date.now(),
                expiresAt: Date.now() + 30000,
              });

              if (decision === 'APPROVE' || decision === 'TASK' || decision === 'ALWAYS') {
                log.info(`User chose to continue ${toolCall.name}`);
                // Loop again to wait another timeout period
                continue;
              } else {
                log.info(`User chose to cancel ${toolCall.name}`);
                toolAbortController.abort();
                return '[Cancelled by user]';
              }
            } else {
              // No approval solicitor — continue
              continue;
            }
          } else {
            completed = true;
            return winner;
          }
        }
        return '[Error in timeout loop]';
      };

      result = await runWithPrompts();
      completed = true;
      // Guard: ensure tool result is never empty
      if (!result || result.trim() === '') {
        log.warn(`[SANITIZE] Tool ${toolCall.name} returned empty result — substituting placeholder`);
        result = '[Tool completed with no output]';
      }
      const t6_finished = performance.now();
      clearTimeout(watchdogTimer);
      const toolMs = t6_finished - tStart;
      log.debug(`Tool: ${toolCall.name}: ${toolMs.toFixed(0)}ms (${result.length} chars)`);
      perfLog('tool-exec', toolCall.name, toolMs, { chars: result.length });

      // Emit timing event
      this.emitToolTiming({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        t1_received,
        t2_classified,
        t3_approved,
        t4_spawned,
        t5_firstOutput,
        t6_finished,
        durations: {
          classify: t2_classified - t1_received,
          approve: t3_approved - t2_classified,
          spawn: t4_spawned - t3_approved,
          firstOutput: t5_firstOutput !== undefined ? t5_firstOutput - t4_spawned : undefined,
          execute: t6_finished - t4_spawned,
          total: t6_finished - t1_received,
        },
      });

      // Safety net: hard-cap any single tool result to prevent context overflow.
      // Skip for image results — they contain base64 data sent as image content blocks,
      // not as text tokens, so they don't inflate the context window the same way.
      const isImageResult = result.startsWith('{"__clawdia_image_result__":true');
      if (!isImageResult && result.length > MAX_TOOL_RESULT_CHARS) {
        log.warn(`Tool result from ${toolCall.name} exceeds limit: ${result.length} chars, truncating to ${MAX_TOOL_RESULT_CHARS}`);
        result = result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[... result truncated from ${result.length} chars to ${MAX_TOOL_RESULT_CHARS} ...]`;
      }

      // Detect shell_exec soft failures — the tool returns a string (no throw)
      // but the output contains error markers indicating the command failed.
      const isShellKilled = toolCall.name === 'shell_exec' && /\[Process killed/.test(result);
      const isShellError = toolCall.name === 'shell_exec' && /\[Error: /.test(result);
      const isShellNonZero = toolCall.name === 'shell_exec' && /\[Exit code: [1-9]\d*\]/.test(result);

      // Distinguish true errors from non-zero-exit warnings:
      // - Killed processes and [Error:] markers are always hard errors.
      // - Non-zero exit codes are only hard errors if the command produced no
      //   useful stdout (just stderr / exit marker). Diagnostic tools like curl,
      //   nmap, openssl often exit non-zero but return perfectly valid output.
      const hasUsefulOutput = toolCall.name === 'shell_exec' && result.length > 0 &&
        !/^\s*(\[stderr\]\n[\s\S]*)?\[Exit code: \d+\]\s*$/.test(result);

      const isShellHardFail = isShellKilled || isShellError || (isShellNonZero && !hasUsefulOutput);
      const isShellSoftFail = isShellNonZero && !isShellHardFail;

      const effectiveStatus: 'success' | 'error' | 'warning' =
        isShellHardFail ? 'error' :
        isShellSoftFail ? 'warning' :
        'success';

      entry.status = effectiveStatus;
      entry.completedAt = Date.now();
      entry.durationMs = Math.round(toolMs);
      entry.resultPreview = result.slice(0, 200);
      let shellStderr: string[] | undefined;
      if (isShellHardFail || isShellSoftFail) {
        entry.error = result.match(/\[(Exit code: \d+|Process killed[^\]]*|Error: [^\]]*)\]/)?.[0] || 'Command failed';
        // Extract stderr section from shell output if present
        const stderrMatch = result.match(/\[stderr\]\n([\s\S]*?)(?:\n\n\[|$)/);
        if (stderrMatch?.[1]) {
          shellStderr = stderrMatch[1].split('\n').filter(Boolean);
        }
      }
      this.emitToolActivity(entry);
      this.emitToolExecComplete({
        toolId: toolCall.id,
        status: effectiveStatus,
        duration: entry.durationMs,
        summary: entry.resultPreview ?? '[Tool completed]',
        ...(shellStderr ? { stderr: shellStderr } : {}),
      });

      // Audit: tool_executed
      {
        const rawCmd = (toolCall.name === 'shell_exec') ? String(toolCall.input.command || '') : '';
        const rawUrl = String(toolCall.input.url || '');
        const exitMatch = result.match(/\[Exit code: (\d+)\]/);
        appendAuditEvent({
          ts: Date.now(),
          kind: 'tool_executed',
          conversationId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          risk: classifyAction(toolCall.name, toolCall.input).risk,
          outcome: effectiveStatus === 'error' ? 'blocked' : 'executed',
          durationMs: entry.durationMs,
          exitCode: exitMatch ? parseInt(exitMatch[1], 10) : (effectiveStatus === 'success' ? 0 : undefined),
          commandPreview: rawCmd ? redactCommand(rawCmd) : undefined,
          urlPreview: rawUrl ? redactUrl(rawUrl) : undefined,
          errorPreview: (isShellHardFail || isShellSoftFail) ? entry.error : undefined,
        });
      }

      return { id: toolCall.id, content: result };
    } catch (error: any) {
      clearTimeout(watchdogTimer);
      const toolErrMs = performance.now() - tStart;
      log.warn(`Tool ${toolCall.name} failed: ${error?.message || 'unknown error'}`);
      perfLog('tool-exec', toolCall.name + ' (ERROR)', toolErrMs);

      const idx = this.activityLog.findIndex(e => e.id === toolCall.id);
      if (idx >= 0) {
        this.activityLog[idx].status = 'error';
        this.activityLog[idx].completedAt = Date.now();
        this.activityLog[idx].durationMs = Math.round(toolErrMs);
        this.activityLog[idx].error = error?.message || 'unknown error';
        this.emitToolActivity(this.activityLog[idx]);
      }

      this.emitToolExecComplete({
        toolId: toolCall.id,
        status: 'error',
        duration: Math.round(toolErrMs),
        summary: error?.message || 'unknown error',
      });

      if (toolCall.name === 'create_document') {
        this.emitDocProgress({
          stage: 'error',
          stageLabel: 'Document generation failed',
          stageNumber: 5,
          totalStages: 5,
          error: error?.message || 'Document generation failed',
        });
      }

      return { id: toolCall.id, content: `Error: ${error?.message || 'Tool execution failed'}` };
    } finally {
      if (hybridCleanup) {
        await hybridCleanup().catch((err: any) => {
          log.warn(`[Hybrid] Failed to clean up isolated context for ${toolCall.name}: ${err?.message || err}`);
        });
      }
      this.activeTools.delete(toolAbortController);
    }
  }

  private getMaxTokens(isToolLoopIteration: boolean, toolCallCount: number): number {
    // First iteration (iteration 0) always gets full budget — could be a final
    // response with no tools, or a long first tool plan.
    // Intermediate iterations (tool loops) get a reduced budget — the model just
    // needs to emit tool_use blocks (~100-300 tokens). Smaller max_tokens means
    // faster inference because the model stops planning for 4096 output tokens.
    // Final response after tools: full budget restored (isToolLoopIteration=false).
    if (!isToolLoopIteration) return 8192;
    if (toolCallCount === 0) return 8192; // first call — could be direct response
    // Document creation needs a large budget — the entire doc content goes into
    // the tool_use JSON input. Give full budget when document generation is active.
    if (this.documentProgressEnabled) return 8192;
    return 4096; // intermediate: tool_use + text preamble — 1536 was causing truncation
  }

  private startEarlyToolExecution(toolCall: ToolCall): Promise<string> {
    const existing = this.earlyToolResults.get(toolCall.id);
    if (existing) return existing;

    const run = async () => {
      const result = await executeTool(toolCall.name, toolCall.input, undefined, this._isolatedPage, this.thinkingState);
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
      const hybridHeadlessCandidate = this.shouldUseHybridHeadlessTool(task.toolCall);
      if (
        !hybridHeadlessCandidate && (
          BROWSER_NAVIGATION_TOOL_NAMES.has(toolName) ||
          BROWSER_PAGE_STATE_READ_TOOL_NAMES.has(toolName) ||
          (toolName.startsWith('browser_') && !BROWSER_STATELESS_TOOL_NAMES.has(toolName))
        )
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

    // Log parallel execution stats
    const totalTasks = execTasks.length;
    const parallelCount = localParallel.length;
    const seqCount = browserSequential.length;
    if (totalTasks > 1) {
      log.info(`[Parallel] ${totalTasks} tools: ${parallelCount} parallel, ${seqCount} browser-seq, ${localWriteGroups.size} write-groups, ${localWriteUnknownPath.length} write-unknown`);
    }

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
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.CHAT_THINKING, thought);
  }

  private emitDocProgress(progress: Omit<DocProgressEvent, 'conversationId' | 'messageId' | 'elapsedMs'> | DocProgressEvent): void {
    if (this.emitter.isDestroyed() || !this.runContext) return;
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
    this.emitter.send(IPC_EVENTS.DOC_PROGRESS, payload);
  }

  private emitStreamText(text: string): void {
    if (this.emitter.isDestroyed() || !text) return;
    this.hasStreamedText = true;
    this.emitter.send(IPC_EVENTS.CHAT_STREAM_TEXT, text);
  }

  private emitStreamReset(): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.CHAT_STREAM_RESET);
  }

  private emitLiveHtmlStart(): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.CHAT_LIVE_HTML_START);
  }

  private emitLiveHtmlEnd(): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.CHAT_LIVE_HTML_END);
  }

  private emitToolActivity(entry: ToolActivityEntry): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, entry);
  }

  private emitToolExecStart(payload: ToolExecStartEvent): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_EXEC_START, payload);
  }

  private emitToolExecComplete(payload: ToolExecCompleteEvent): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_EXEC_COMPLETE, payload);
  }

  private emitToolStepProgress(payload: ToolStepProgressEvent): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_STEP_PROGRESS, payload);
  }

  private emitToolLoopComplete(totalTools: number, totalDuration: number, failures: number): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_LOOP_COMPLETE, { totalTools, totalDuration, failures });
  }

  private emitToolTiming(timing: ToolTimingEvent): void {
    if (this.emitter.isDestroyed()) return;
    this.emitter.send(IPC_EVENTS.TOOL_TIMING, timing);
    // Also log as structured line for main process debugging
    const d = timing.durations;
    log.info(`[Timing] ${timing.toolName} (${timing.toolCallId.slice(0, 8)}): classify=${d.classify.toFixed(0)}ms approve=${d.approve.toFixed(0)}ms spawn=${d.spawn.toFixed(0)}ms exec=${d.execute.toFixed(0)}ms total=${d.total.toFixed(0)}ms${d.firstOutput !== undefined ? ` firstOutput=${d.firstOutput.toFixed(0)}ms` : ''}`);
  }

  private emitToolActivitySummary(responseText: string): void {
    if (this.emitter.isDestroyed()) return;
    const summary: ToolActivitySummary = {
      totalCalls: this.activityLog.length,
      entries: this.activityLog,
      fabricationWarning: detectFabrication(responseText, this.activityLog.length) ?? undefined,
    };
    this.emitter.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY_SUMMARY, summary);
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

  private async forceFinalResponseAtToolLimit(messages: Message[], systemPrompt: string, dynamicPrompt?: string): Promise<string> {
    messages.push(
      makeMessage(
        'user',
        '[SYSTEM: Tool limit reached. Respond now with answers for ALL parts of the user\'s request using information already gathered. Do not mention limits or ask to continue.]'
      )
    );
    this.abortController = new AbortController();
    const finalResponse = await this.client.chat(messages, [], systemPrompt, undefined, {
      maxTokens: 4096,
      signal: this.abortController.signal,
      dynamicSystemPrompt: dynamicPrompt,
    });
    return this.extractText(finalResponse).trim();
  }

  /**
   * Ask the user whether to continue after hitting the tool call limit.
   * Emits an IPC event to the renderer and waits for a response.
   * Returns true if user wants to continue, false to stop.
   * Auto-stops after 120 seconds with no response.
   */
  private askUserToContinue(toolCallCount: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.emitter.isDestroyed()) {
        resolve(false);
        return;
      }

      const TIMEOUT_MS = 120_000; // 2 minutes
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        ipcMain.removeHandler(IPC.CHAT_CONTINUE_RESPONSE);
      };

      // Send the prompt to the renderer
      this.emitter.send(IPC_EVENTS.CHAT_TOOL_LIMIT_REACHED, {
        toolCallCount,
        maxToolCalls: MAX_TOOL_CALLS,
      });

      // Listen for the user's response
      ipcMain.handleOnce(IPC.CHAT_CONTINUE_RESPONSE, (_event, payload: { continue: boolean }) => {
        cleanup();
        log.info(`User responded to tool limit prompt: continue=${payload.continue}`);
        resolve(payload.continue);
        return { ok: true };
      });

      // Timeout — auto-stop if user doesn't respond
      setTimeout(() => {
        if (!resolved) {
          log.info('Tool limit continue prompt timed out — forcing finish');
          cleanup();
          resolve(false);
        }
      }, TIMEOUT_MS);

      // If aborted while waiting, stop
      if (this.aborted) {
        cleanup();
        resolve(false);
      }
    });
  }
}
