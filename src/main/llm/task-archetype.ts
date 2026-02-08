/**
 * Task Archetype Classifier — multi-signal weighted scoring.
 *
 * Classifies user messages into task archetypes before the LLM sees them.
 * Each archetype carries a strategy hint (injected into the system prompt)
 * and an execution tier that determines how much of the pipeline to skip.
 *
 * All signal extraction and scoring runs in <1ms total.
 */

import { isToolAvailable } from './tool-bootstrap';
import { findFastPathEntry, findFastPathEntryForUrl, validateAndBuild, type FastPathEntry } from './fast-path-gate';
import { createLogger } from '../logger';

const log = createLogger('task-archetype');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArchetypeId =
  | 'web-search'
  | 'page-read'
  | 'media-extract'
  | 'file-op'
  | 'news-lookup'
  | 'shopping'
  | 'multi-page'
  | 'doc-create'
  | 'site-interact'
  | 'unknown';

export type ExecutionTier =
  | 'deterministic'   // safe shell_exec with known CLI — no LLM needed
  | 'api-only'        // search tools, cache_read — no browser needed
  | 'browser-passive' // navigate + read — no interaction
  | 'browser-active'  // click, type, scroll — full automation
  | 'llm-default';    // no archetype matched — full LLM loop

export interface ToolStep {
  tool: string;
  hint?: string;
}

export interface TaskStrategy {
  archetype: ArchetypeId;
  tier: ExecutionTier;
  score: number;
  steps: ToolStep[];
  systemHint: string;
  extractedParams: Record<string, string>;
  skipBrowserTools: boolean;
  fastPathCommand?: string[];
  fastPathEntry?: FastPathEntry;
}

export interface SignalSet {
  hasUrl: boolean;
  urls: string[];
  urlHost: string | null;
  urlCount: number;
  actionVerbs: Set<string>;
  words: Set<string>;
  urlPath: string | null;
  hasFilePath: boolean;
  knownHostArchetype: ArchetypeId | null;
  toolKeywords: Set<string>;
  hasQuestion: boolean;
  hasRecency: boolean;
  hasDocKeywords: boolean;
  messageLength: number;
}

interface ArchetypeScore {
  archetype: ArchetypeId;
  score: number;
  params: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s)}\]]+/gi;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const ACTION_VERB_SET = new Set([
  'download', 'save', 'extract', 'summarize', 'compare', 'read', 'write',
  'edit', 'create', 'post', 'tweet', 'buy', 'search', 'find', 'look',
  'browse', 'navigate', 'go', 'open', 'visit', 'check', 'click', 'type',
  'login', 'sign', 'send', 'reply', 'like', 'delete', 'remove', 'install',
  'run', 'execute', 'build', 'compile', 'generate', 'make', 'price',
]);

const TOOL_KEYWORD_SET = new Set([
  'yt-dlp', 'ffmpeg', 'curl', 'wget', 'youtube-dl',
]);
const MEDIA_NOUNS = new Set([
  'video', 'videos', 'recording', 'recordings', 'screen', 'screencast', 'clip',
  'loom', 'mp4', 'm3u8', 'hls',
]);
const OUTPUT_DIR_KEYWORDS = [
  { key: 'desktop', dir: 'Desktop' },
  { key: 'downloads', dir: 'Downloads' },
  { key: 'download', dir: 'Downloads' },
  { key: 'documents', dir: 'Documents' },
];

const RECENCY_WORDS = new Set([
  'latest', 'recent', 'today', 'news', 'current', 'trending', 'now',
  'this week', 'this month', 'breaking',
]);

const DOC_KEYWORDS = new Set([
  'pdf', 'docx', 'doc', 'spreadsheet', 'xlsx', 'report', 'resume',
  'proposal', 'whitepaper', 'invoice', 'presentation', 'csv',
]);

const FILE_PATH_RE = /(?:~\/|\.\/|\/home\/|\/tmp\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|[a-zA-Z]:\\)[\w./-]+/;

/** Map of known hosts to the archetype they most commonly trigger. */
const HOST_ARCHETYPE_MAP: Record<string, ArchetypeId> = {
  'youtube.com': 'media-extract',
  'youtu.be': 'media-extract',
  'loom.com': 'media-extract',
  'vimeo.com': 'media-extract',
  'github.com': 'page-read',
  'stackoverflow.com': 'page-read',
  'reddit.com': 'page-read',
  'wikipedia.org': 'page-read',
  'twitter.com': 'site-interact',
  'x.com': 'site-interact',
  'facebook.com': 'site-interact',
  'instagram.com': 'site-interact',
  'linkedin.com': 'site-interact',
  'amazon.com': 'shopping',
  'ebay.com': 'shopping',
  'walmart.com': 'shopping',
};

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function lookupKnownHost(host: string): ArchetypeId | null {
  // Direct match
  if (HOST_ARCHETYPE_MAP[host]) return HOST_ARCHETYPE_MAP[host];
  // Try stripping subdomain
  const parts = host.split('.');
  if (parts.length > 2) {
    const root = parts.slice(-2).join('.');
    if (HOST_ARCHETYPE_MAP[root]) return HOST_ARCHETYPE_MAP[root];
  }
  return null;
}

export function extractSignals(message: string, currentUrl?: string): SignalSet {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/);
  const wordSet = new Set<string>();
  for (const w of words) {
    const clean = w.replace(/[^a-z0-9]/g, '');
    if (clean) wordSet.add(clean);
  }

  // URLs
  const urls = (message.match(URL_RE) || []) as string[];
  const domainHits = (message.match(DOMAIN_RE) || []) as string[];
  if (domainHits.length > 0 && !EMAIL_RE.test(message)) {
    for (const hit of domainHits) {
      if (urls.some((u) => u.includes(hit))) continue;
      urls.push(`https://${hit}`);
    }
  }
  if (urls.length === 0 && currentUrl) {
    urls.push(currentUrl);
  }
  const hasUrl = urls.length > 0;
  const urlHost = hasUrl ? extractHost(urls[0]) : null;
  let urlPath: string | null = null;
  if (hasUrl) {
    try {
      urlPath = new URL(urls[0]).pathname || '/';
    } catch {
      urlPath = null;
    }
  }

  // Action verbs
  const actionVerbs = new Set<string>();
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, '');
    if (ACTION_VERB_SET.has(clean)) {
      actionVerbs.add(clean);
    }
  }

  // File paths
  const hasFilePath = FILE_PATH_RE.test(message);

  // Known host archetype
  let knownHostArchetype: ArchetypeId | null = null;
  if (urlHost) {
    knownHostArchetype = lookupKnownHost(urlHost);
  }

  // Tool keywords
  const toolKeywords = new Set<string>();
  for (const kw of TOOL_KEYWORD_SET) {
    if (lower.includes(kw)) toolKeywords.add(kw);
  }

  // Question mark
  const hasQuestion = message.trim().endsWith('?');

  // Recency
  let hasRecency = false;
  for (const word of RECENCY_WORDS) {
    if (lower.includes(word)) {
      hasRecency = true;
      break;
    }
  }

  // Document keywords
  let hasDocKeywords = false;
  for (const kw of DOC_KEYWORDS) {
    if (lower.includes(kw)) {
      hasDocKeywords = true;
      break;
    }
  }

  return {
    hasUrl,
    urls,
    urlHost,
    urlCount: urls.length,
    actionVerbs,
    words: wordSet,
    urlPath,
    hasFilePath,
    knownHostArchetype,
    toolKeywords,
    hasQuestion,
    hasRecency,
    hasDocKeywords,
    messageLength: message.length,
  };
}

// ---------------------------------------------------------------------------
// Archetype scorers
// ---------------------------------------------------------------------------

function scoreMediaExtract(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.urls.length > 0) params.url = s.urls[0];
  if (s.urlHost === 'loom.com' || s.urlHost?.endsWith('.loom.com')) {
    params.fastPathTool = 'yt-dlp';
  }
  for (const entry of OUTPUT_DIR_KEYWORDS) {
    if (s.words.has(entry.key)) {
      params.outputDir = entry.dir;
      break;
    }
  }

  // Known media host + download verb = very strong
  const hasMediaVerb = s.actionVerbs.has('download') || s.actionVerbs.has('extract') || s.actionVerbs.has('save');
  const hasMediaNoun = [...MEDIA_NOUNS].some((n) => s.words.has(n));
  if (s.knownHostArchetype === 'media-extract' && hasMediaVerb) {
    score = 0.95;
  } else if (s.knownHostArchetype === 'media-extract') {
    // Media host without explicit download verb — could be "watch" or "summarize"
    score = 0.6;
  } else if (hasMediaVerb && s.hasUrl) {
    score = 0.8;
  } else if (hasMediaVerb && hasMediaNoun) {
    score = 0.8;
  } else if (hasMediaNoun && s.hasUrl) {
    score = 0.7;
  }

  // Instagram reels/posts/stories are media-heavy; boost if URL path matches.
  if (s.urlHost?.endsWith('instagram.com') && s.urlPath) {
    if (/^\/(reel|reels|p|tv|stories)\//i.test(s.urlPath) && hasMediaVerb) {
      score = Math.max(score, 0.9);
    }
  }

  // Tool keywords boost
  if (s.toolKeywords.has('yt-dlp') || s.toolKeywords.has('youtube-dl')) {
    score = Math.max(score, 0.9);
  }

  return { archetype: 'media-extract', score, params };
}

function scoreWebSearch(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.hasQuestion && !s.hasUrl && s.messageLength > 20) {
    score = 0.7;
  } else if ((s.actionVerbs.has('search') || s.actionVerbs.has('find') || s.actionVerbs.has('look')) && !s.hasUrl) {
    score = 0.75;
  } else if (s.hasQuestion && !s.hasUrl) {
    score = 0.5;
  }

  // Downweight if file path present (more likely file-op)
  if (s.hasFilePath) score *= 0.5;

  return { archetype: 'web-search', score, params };
}

function scorePageRead(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.urls.length > 0) params.url = s.urls[0];

  const readVerbs = new Set(['read', 'summarize', 'extract', 'check']);
  const hasReadVerb = [...s.actionVerbs].some((v) => readVerbs.has(v));

  if (s.hasUrl && hasReadVerb && !s.actionVerbs.has('download')) {
    score = 0.85;
  } else if (s.hasUrl && s.knownHostArchetype === 'page-read') {
    score = 0.7;
  } else if (s.hasUrl && s.actionVerbs.size === 0) {
    // Just a URL with no verbs — likely wants to read it
    score = 0.6;
  }

  return { archetype: 'page-read', score, params };
}

function scoreFileOp(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  const fileVerbs = new Set(['read', 'write', 'edit', 'create', 'delete', 'remove']);
  const hasFileVerb = [...s.actionVerbs].some((v) => fileVerbs.has(v));

  if (s.hasFilePath && hasFileVerb) {
    score = 0.85;
  } else if (s.hasFilePath) {
    score = 0.5;
  }

  return { archetype: 'file-op', score, params };
}

function scoreNewsLookup(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.hasRecency && s.hasQuestion && !s.hasUrl) {
    score = 0.75;
  } else if (s.hasRecency && !s.hasUrl) {
    score = 0.55;
  }

  return { archetype: 'news-lookup', score, params };
}

function scoreShopping(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  const shopVerbs = new Set(['buy', 'price']);

  if ([...s.actionVerbs].some((v) => shopVerbs.has(v)) && !s.hasUrl) {
    score = 0.7;
  } else if (s.knownHostArchetype === 'shopping') {
    score = 0.6;
  }

  return { archetype: 'shopping', score, params };
}

function scoreMultiPage(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.urlCount >= 2) {
    score = 0.75;
  }
  if (s.actionVerbs.has('compare') && s.urlCount >= 2) {
    score = 0.85;
  } else if (s.actionVerbs.has('compare')) {
    score = 0.6;
  }

  if (s.urls.length > 0) params.url = s.urls[0];

  return { archetype: 'multi-page', score, params };
}

function scoreDocCreate(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  const createVerbs = new Set(['create', 'generate', 'make', 'build', 'write']);
  const hasCreateVerb = [...s.actionVerbs].some((v) => createVerbs.has(v));

  if (s.hasDocKeywords && hasCreateVerb) {
    score = 0.85;
  } else if (s.hasDocKeywords) {
    score = 0.4;
  }

  return { archetype: 'doc-create', score, params };
}

function scoreSiteInteract(s: SignalSet): ArchetypeScore {
  let score = 0;
  const params: Record<string, string> = {};

  if (s.urls.length > 0) params.url = s.urls[0];

  const interactVerbs = new Set([
    'click', 'type', 'post', 'tweet', 'login', 'sign', 'send', 'reply', 'like',
  ]);
  const hasInteractVerb = [...s.actionVerbs].some((v) => interactVerbs.has(v));

  if (s.hasUrl && hasInteractVerb) {
    score = 0.8;
  } else if (s.knownHostArchetype === 'site-interact' && hasInteractVerb) {
    score = 0.8;
  } else if (s.knownHostArchetype === 'site-interact') {
    score = 0.5;
  }

  return { archetype: 'site-interact', score, params };
}

// ---------------------------------------------------------------------------
// Strategy builder
// ---------------------------------------------------------------------------

const ARCHETYPE_SCORERS: Array<(s: SignalSet) => ArchetypeScore> = [
  scoreMediaExtract,
  scoreWebSearch,
  scorePageRead,
  scoreFileOp,
  scoreNewsLookup,
  scoreShopping,
  scoreMultiPage,
  scoreDocCreate,
  scoreSiteInteract,
];

function buildSystemHint(archetype: ArchetypeId, params: Record<string, string>): string {
  switch (archetype) {
    case 'media-extract':
      return `Task: download media. Use shell_exec with yt-dlp. Target URL: ${params.url || 'see message'}. Output to ~/Downloads/. Do NOT use browser tools. Do NOT use ffmpeg or re-encode — conversion is a separate explicit step.`;
    case 'web-search':
      return 'Task: web search. Use browser_search or browser_search_rich with a concise query. Read snippets first; only click into results if snippets lack the answer.';
    case 'page-read':
      return `Task: read/summarize a web page. Use browser_navigate to ${params.url || 'the URL'}, then browser_read_page or browser_extract. One search is enough.`;
    case 'file-op':
      return 'Task: local file operation. Use file_read, file_write, file_edit, or shell_exec as appropriate. No browser tools needed.';
    case 'news-lookup':
      return 'Task: recent news lookup. Use browser_news with a focused query. Read snippets; respond immediately if they answer the question.';
    case 'shopping':
      return 'Task: price/product lookup. Use browser_shopping with a focused query. Include results and respond.';
    case 'multi-page':
      return 'Task: multi-page comparison. Use browser_batch to fetch all URLs in one call, then compare.';
    case 'doc-create':
      return 'Task: document creation. Use create_document tool with appropriate format and content.';
    case 'site-interact':
      return `Task: interactive site action. Navigate to ${params.url || 'the URL'} with browser_navigate, then use browser_click/browser_type to interact.`;
    default:
      return '';
  }
}

function buildSteps(archetype: ArchetypeId): ToolStep[] {
  switch (archetype) {
    case 'media-extract':
      return [{ tool: 'shell_exec', hint: 'yt-dlp (no re-encode)' }];
    case 'web-search':
      return [{ tool: 'browser_search', hint: 'concise query' }];
    case 'page-read':
      return [
        { tool: 'browser_navigate', hint: 'go to URL' },
        { tool: 'browser_read_page', hint: 'extract content' },
      ];
    case 'file-op':
      return [{ tool: 'file_read', hint: 'read file' }];
    case 'news-lookup':
      return [{ tool: 'browser_news', hint: 'recent query' }];
    case 'shopping':
      return [{ tool: 'browser_shopping', hint: 'product query' }];
    case 'multi-page':
      return [{ tool: 'browser_batch', hint: 'batch fetch URLs' }];
    case 'doc-create':
      return [{ tool: 'create_document', hint: 'generate document' }];
    case 'site-interact':
      return [
        { tool: 'browser_navigate', hint: 'go to URL' },
        { tool: 'browser_click', hint: 'interact' },
      ];
    default:
      return [];
  }
}

function determineTier(archetype: ArchetypeId, signals: SignalSet): ExecutionTier {
  if (archetype === 'media-extract') {
    // Can we use a fast-path CLI tool?
    const url = signals.urls[0];
    if (url && findFastPathEntry(url)) {
      return 'deterministic';
    }
    return 'llm-default'; // Fall through to LLM to figure out approach
  }

  if (archetype === 'web-search' || archetype === 'news-lookup' || archetype === 'shopping') {
    return 'api-only';
  }

  if (archetype === 'page-read' || archetype === 'multi-page') {
    return 'browser-passive';
  }

  if (archetype === 'site-interact') {
    return 'browser-active';
  }

  if (archetype === 'file-op' || archetype === 'doc-create') {
    return 'api-only'; // local tools only
  }

  return 'llm-default';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a user message into a task archetype with strategy.
 */
export function classifyArchetype(
  message: string,
  _history: Array<{ role: string; content: string }>,
  currentUrl?: string,
): TaskStrategy {
  const start = performance.now();
  const signals = extractSignals(message, currentUrl);

  // Score all archetypes
  const scores = ARCHETYPE_SCORERS.map((scorer) => scorer(signals));

  // Pick highest score
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  // Minimum threshold
  if (!best || best.score < 0.4) {
    const elapsed = performance.now() - start;
    log.debug(`archetype=unknown score=0 (${elapsed.toFixed(2)}ms)`);
    return {
      archetype: 'unknown',
      tier: 'llm-default',
      score: 0,
      steps: [],
      systemHint: '',
      extractedParams: {},
      skipBrowserTools: false,
    };
  }

  const archetype = best.archetype;
  const tier = determineTier(archetype, signals);
  const steps = buildSteps(archetype);
  const systemHint = buildSystemHint(archetype, best.params);

  // Determine if browser tools can be skipped
  const skipBrowserTools = tier === 'deterministic' || archetype === 'file-op';

  // Build fast-path command if deterministic
  let fastPathCommand: string[] | undefined;
  let fastPathEntry: FastPathEntry | undefined;
  if (tier === 'deterministic' && signals.urls[0]) {
    const preferredTool = best.params.fastPathTool;
    const entry = preferredTool
      ? findFastPathEntryForUrl(signals.urls[0], preferredTool)
      : findFastPathEntry(signals.urls[0]);
    if (entry) {
      const validated = validateAndBuild(entry, {
        url: signals.urls[0],
      });
      if (validated) {
        fastPathCommand = validated.argv;
        fastPathEntry = entry;
      }
    }
  }

  const elapsed = performance.now() - start;
  log.debug(`archetype=${archetype} score=${best.score.toFixed(2)} tier=${tier} (${elapsed.toFixed(2)}ms)`);

  return {
    archetype,
    tier,
    score: best.score,
    steps,
    systemHint,
    extractedParams: best.params,
    skipBrowserTools,
    fastPathCommand,
    fastPathEntry,
  };
}
