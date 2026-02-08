/**
 * Deterministic intent router — classifies user messages BEFORE calling the API.
 *
 * If the message is purely conversational (no tools needed), we call the API
 * with tools=[] — eliminating ~3000-4000 tokens of tool definitions from the
 * payload and letting the model respond faster (no tool-use planning overhead).
 *
 * This is a cheap pre-filter. False negatives (routing to "tools" when none
 * are needed) cost nothing — it's the status quo. False positives (routing to
 * "no-tools" when tools ARE needed) would be bad, so we err heavily on the
 * side of including tools. If in doubt, return 'tools'.
 */

import { createLogger, perfLog } from '../logger';
import { classifyArchetype, type TaskStrategy } from './task-archetype';

const log = createLogger('intent-router');

export type Intent = 'tools' | 'chat-only';

// ============================================================================
// TOOL-SIGNAL PATTERNS — if ANY match, we route to 'tools'
// ============================================================================

/** Direct action verbs that almost always need tools */
const ACTION_VERBS = /\b(search|find|look\s+up|google|browse|navigate|go\s+to|open|visit|check|read|write|create|edit|delete|remove|install|run|execute|build|compile|deploy|push|pull|commit|clone|download|upload|post|tweet|send|reply|like|repost|subscribe|unsubscribe|grep|cat|ls|cd|mkdir|mv|cp|rm|pip|npm|apt|brew|curl|wget|ssh|scp|git|docker|make|kill|restart|start|stop|monitor|close|dismiss|click|scroll|type|press|clear|shut|hide|show|minimize|maximize|resize|refresh|reload|select|hover|drag|drop|focus|tap|swipe)\b/i;

/** File/path references */
const FILE_PATTERNS = /(?:~\/|\.\/|\/home\/|\/tmp\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|[a-zA-Z]:\\)[\w./-]+|\b[\w-]+\.(?:ts|js|py|rs|go|java|cpp|c|h|css|html|json|yaml|yml|toml|md|txt|csv|xml|sql|sh|bash|zsh|log|conf|cfg|env|lock|dockerfile|makefile)\b/i;

/** URL references */
const URL_PATTERNS = /https?:\/\/[^\s]+|(?:www\.)[^\s]+|\b(?:x\.com|twitter\.com|github\.com|gmail\.com|linkedin\.com|reddit\.com|facebook\.com|youtube\.com|amazon\.com|stackoverflow\.com)\b/i;

/** Web/browser intent signals */
const WEB_SIGNALS = /\b(website|webpage|web\s*page|browser|tab|bookmark|url|link|search\s+(?:for|about)|latest\s+news|current\s+(?:price|weather|time|status|version)|how\s+much\s+(?:does|is|are)|what(?:'s|\s+is)\s+the\s+(?:price|cost|weather|time|status)|news\s+about|trending|stock\s+price|score|schedule|hours|directions|map|near\s+(?:me|here)|restaurants?|stores?|shops?|popup|pop-?up|banner|cookie\s*(?:banner|consent|notice)|overlay|dialog|modal|sidebar|menu|dropdown|tooltip|notification\s*(?:bar|banner)|captcha|ads?|advertisement|blocker)\b/i;

/** System/local intent signals */
const SYSTEM_SIGNALS = /\b(file|folder|directory|package|process|port|server|terminal|shell|command|script|code|function|class|variable|module|component|project|repo|repository|branch|merge|rebase|stash|diff|log|debug|error|warning|stack\s*trace|crash|memory|cpu|disk|permission|windows?|desktop|clipboard|notification|battery|volume|brightness|wifi|bluetooth|uptime|hostname|kernel|swap|pid|daemon|cron|service|systemctl|journalctl)\b/i;

/** Document creation signals */
const DOCUMENT_SIGNALS = /\b(generate|create|make|build|write)\s+(a\s+)?(document|report|spreadsheet|pdf|docx?|xlsx?|csv|presentation|resume|proposal|whitepaper|letter|invoice|receipt)\b/i;

/** Image/media signals */
const MEDIA_SIGNALS = /\b(image|picture|photo|screenshot|show\s+me|what\s+does\s+.+\s+look\s+like)\b/i;

/** Notification/social media check signals */
const NOTIFICATION_SIGNALS = /\b(notifications?|messages?|inbox|dms?|direct\s+messages?|mentions?|timeline|feed|emails?|unread)\b/i;

/** Demonstrative references to visible elements — "that popup", "this button", etc. */
const DEMONSTRATIVE_SIGNALS = /\b(that|this|the)\s+(popup|pop-?up|button|link|banner|dialog|modal|overlay|element|thing|icon|image|box|card|panel|form|field|input|menu|dropdown|sidebar|notification|ad|window|tab|page)\b/i;

/** Shopping/price signals */
const SHOPPING_SIGNALS = /\b(buy|purchase|order|price|cost|cheap|expensive|deal|discount|coupon|sale|compare\s+prices?|under\s+\$|best\s+.+\s+for)\b/i;

// ============================================================================
// CHAT-ONLY PATTERNS — strong signals that NO tools are needed
// ============================================================================

/** Pure conversational / follow-up patterns */
const CHAT_ONLY_STRONG = /^(thanks?|thank\s+you|ok(ay)?|got\s+it|cool|nice|great|perfect|awesome|understood|makes?\s+sense|i\s+see|interesting|wow|haha?|lol|hmm+|sure|yep|yeah|yes|no|nah|nope|right|exactly|correct|agreed|good\s+point)[.!?\s]*$/i;

/** Questions about what was just said (no tools needed) */
const FOLLOW_UP_QUESTIONS = /^(what\s+do\s+you\s+mean|can\s+you\s+explain|explain\s+(that|this|it)|why\s+(is\s+that|did\s+you)|how\s+does\s+that\s+work|what('s|\s+is)\s+the\s+difference|tell\s+me\s+more|go\s+on|continue|elaborate|clarify|rephrase|simplify|summarize\s+(that|this|it|what)|what\s+are\s+the\s+(pros|cons|benefits|drawbacks|advantages|disadvantages)|in\s+what\s+way|compared\s+to\s+what|what\s+about)\b/i;

/** Pure opinion/advice questions (no external data needed) */
const OPINION_QUESTIONS = /^(what\s+(?:do\s+you\s+think|would\s+you\s+(?:recommend|suggest)|should\s+i)|should\s+(?:i|we)|do\s+you\s+(?:think|agree|prefer|recommend)|is\s+it\s+(?:worth|better|good|bad|okay|fine)|how\s+should\s+i|which\s+(?:should|would\s+you|is\s+better|do\s+you))\b/i;

/** General knowledge / conceptual questions (model already knows) */
const KNOWLEDGE_QUESTIONS = /^(what\s+is\s+(a|an|the)\s+\w+|who\s+(is|was|were)\s+|explain\s+(the\s+)?concept|define\s+|what\s+does\s+.+\s+mean$|how\s+does\s+.+\s+work$|what\s+are\s+(the\s+)?(types|kinds|categories)\s+of)\b/i;

// ============================================================================
// CONTEXTUAL SIGNALS — check conversation history
// ============================================================================

/** If recent assistant messages used tools, the user might need tools again */
function recentHistoryUsedTools(history: Array<{ role: string; content: string }>): boolean {
  // Look at last 4 messages for tool-use indicators
  const recent = history.slice(-4);
  for (const msg of recent) {
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      // If assistant output contains file contents, search results, etc., tools were used
      if (/```[\s\S]{100,}```/.test(msg.content)) return true;
      if (/\[File:/.test(msg.content)) return true;
    }
  }
  return false;
}

// ============================================================================
// MAIN ROUTER
// ============================================================================

/**
 * Classify a user message as needing tools or being chat-only.
 *
 * The router is deliberately conservative — it only returns 'chat-only' when
 * it's highly confident no tools are needed. Any ambiguity → 'tools'.
 */
export function classifyIntent(
  userMessage: string,
  history: Array<{ role: string; content: string }> = []
): Intent {
  const start = performance.now();
  const msg = userMessage.trim();

  // Empty or very short messages are usually conversational
  if (msg.length === 0) {
    logResult('chat-only', 'empty', start);
    return 'chat-only';
  }

  // ---- TOOL SIGNALS (check first — any match → 'tools') ----

  // Attachments / documents always need tools
  if (msg.includes('--- Document:')) {
    logResult('tools', 'document-attachment', start);
    return 'tools';
  }

  if (ACTION_VERBS.test(msg)) {
    logResult('tools', 'action-verb', start);
    return 'tools';
  }

  if (FILE_PATTERNS.test(msg)) {
    logResult('tools', 'file-path', start);
    return 'tools';
  }

  if (URL_PATTERNS.test(msg)) {
    logResult('tools', 'url-reference', start);
    return 'tools';
  }

  if (WEB_SIGNALS.test(msg)) {
    logResult('tools', 'web-signal', start);
    return 'tools';
  }

  if (SYSTEM_SIGNALS.test(msg)) {
    logResult('tools', 'system-signal', start);
    return 'tools';
  }

  if (DOCUMENT_SIGNALS.test(msg)) {
    logResult('tools', 'document-creation', start);
    return 'tools';
  }

  if (MEDIA_SIGNALS.test(msg)) {
    logResult('tools', 'media-signal', start);
    return 'tools';
  }

  if (NOTIFICATION_SIGNALS.test(msg)) {
    logResult('tools', 'notification-signal', start);
    return 'tools';
  }

  if (SHOPPING_SIGNALS.test(msg)) {
    logResult('tools', 'shopping-signal', start);
    return 'tools';
  }

  if (DEMONSTRATIVE_SIGNALS.test(msg)) {
    logResult('tools', 'demonstrative-signal', start);
    return 'tools';
  }

  // ---- CHAT-ONLY SIGNALS ----

  if (CHAT_ONLY_STRONG.test(msg)) {
    logResult('chat-only', 'conversational-ack', start);
    return 'chat-only';
  }

  if (FOLLOW_UP_QUESTIONS.test(msg)) {
    logResult('chat-only', 'follow-up-question', start);
    return 'chat-only';
  }

  if (OPINION_QUESTIONS.test(msg)) {
    logResult('chat-only', 'opinion-question', start);
    return 'chat-only';
  }

  if (KNOWLEDGE_QUESTIONS.test(msg)) {
    // Knowledge questions that mention specific current things might need search
    if (/\b(202[0-9]|latest|current|today|yesterday|this\s+(week|month|year)|right\s+now)\b/i.test(msg)) {
      logResult('tools', 'knowledge-needs-recency', start);
      return 'tools';
    }
    logResult('chat-only', 'knowledge-question', start);
    return 'chat-only';
  }

  // Short messages (under 15 chars) without tool signals are likely conversational
  if (msg.length < 15 && !/[?]/.test(msg)) {
    logResult('chat-only', 'short-no-question', start);
    return 'chat-only';
  }

  // ---- AMBIGUOUS — default to tools (safe fallback) ----

  // If it's a question with a question mark but didn't match any pattern above,
  // it might be asking something that needs search/tools
  if (msg.includes('?')) {
    logResult('tools', 'unmatched-question', start);
    return 'tools';
  }

  // Longer messages with imperative tone are likely requesting action
  if (msg.length > 50) {
    logResult('tools', 'long-imperative', start);
    return 'tools';
  }

  // Medium messages that didn't match anything — lean toward chat-only
  // since all tool-signal patterns failed
  logResult('chat-only', 'no-signals-detected', start);
  return 'chat-only';
}

function logResult(intent: Intent, reason: string, startMs: number): void {
  const elapsed = performance.now() - startMs;
  log.debug(`intent=${intent} reason=${reason} (${elapsed.toFixed(2)}ms)`);
  perfLog('intent-router', `classify-${intent}`, elapsed, { reason });
}

// ============================================================================
// TOOL CLASS ROUTER — which tool subset is likely needed?
// ============================================================================

export type ToolClass = 'browser' | 'local' | 'all';

/**
 * Classify whether a message needs browser tools, local tools, or both.
 * Conservative: defaults to 'all' when ambiguous.
 */
export function classifyToolClass(message: string): ToolClass {
  const msg = message.trim();
  if (!msg) return 'all';

  const hasBrowser = WEB_SIGNALS.test(msg) || URL_PATTERNS.test(msg) ||
                     SHOPPING_SIGNALS.test(msg) || NOTIFICATION_SIGNALS.test(msg) ||
                     MEDIA_SIGNALS.test(msg) || DEMONSTRATIVE_SIGNALS.test(msg);
  const hasLocal = FILE_PATTERNS.test(msg) || SYSTEM_SIGNALS.test(msg) ||
                   DOCUMENT_SIGNALS.test(msg);

  if (hasBrowser && !hasLocal) return 'browser';
  if (hasLocal && !hasBrowser) return 'local';
  return 'all';
}

// ============================================================================
// ENRICHED INTENT — combines intent, tool class, and task archetype
// ============================================================================

export interface EnrichedIntent {
  intent: Intent;
  toolClass: ToolClass;
  strategy: TaskStrategy;
}

/**
 * Classify a user message with full archetype enrichment.
 * Wraps classifyIntent + classifyToolClass + classifyArchetype into one call.
 */
export function classifyEnriched(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  currentUrl?: string,
): EnrichedIntent {
  const intent = classifyIntent(userMessage, history);
  const toolClass = classifyToolClass(userMessage);

  const strategy: TaskStrategy =
    intent === 'tools'
      ? classifyArchetype(userMessage, history, currentUrl)
      : {
          archetype: 'unknown',
          tier: 'llm-default',
          score: 0,
          steps: [],
          systemHint: '',
          extractedParams: {},
          skipBrowserTools: false,
        };

  return { intent, toolClass, strategy };
}
