/**
 * Content compression pipeline for web page content.
 *
 * Reduces raw page content to a manageable size before it enters the
 * LLM conversation history. This prevents context window overflow
 * (previously 991K chars → 236K tokens for 3 pages).
 *
 * Pipeline steps (in order):
 * 1. Strip HTML to text (preserve heading hierarchy + lists)
 * 2. Remove boilerplate (nav, cookie banners, ads, etc.)
 * 3. Deduplicate repeated paragraphs
 * 4. Collapse whitespace
 * 5. Smart truncation (front-weighted with paragraph boundaries)
 */

import { createLogger } from '../logger';

const log = createLogger('content-compressor');

export interface CompressedContent {
  text: string;
  originalLength: number;
  compressedLength: number;
  compressionRatio: number;
  truncated: boolean;
}

export interface CompressOptions {
  /** Maximum characters in the final output. Default: 20000 */
  maxChars?: number;
  /** Keep heading hierarchy and list structure. Default: true */
  preserveStructure?: boolean;
}

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 5_000;

// --- Step 1: HTML to text ---

// Tags whose content should be removed entirely
const STRIP_CONTENT_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'template',
  'iframe', 'object', 'embed', 'applet',
]);

// Boilerplate container patterns (class/id substrings)
const BOILERPLATE_PATTERNS = [
  'cookie', 'consent', 'gdpr', 'privacy-banner', 'privacy_banner',
  'nav', 'navbar', 'navigation', 'menu', 'sidebar', 'side-bar',
  'footer', 'site-footer', 'page-footer',
  'header', 'site-header', 'page-header', 'masthead', 'top-bar', 'topbar',
  'breadcrumb', 'pagination',
  'social', 'share', 'sharing', 'social-share',
  'comment', 'comments', 'disqus',
  'newsletter', 'subscribe', 'signup', 'sign-up',
  'related', 'recommended', 'also-read', 'more-stories',
  'ad', 'ads', 'advert', 'advertisement', 'sponsor', 'promoted',
  'popup', 'modal', 'overlay', 'banner',
  'author-bio', 'author-info',
  'search-form', 'searchbox',
  'widget', 'widgets',
  'toolbar',
];

// Heading tag names → markdown levels
const HEADING_MAP: Record<string, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
};

function stripHtmlToText(raw: string, preserveStructure: boolean): string {
  // If no HTML tags detected, return as-is
  if (!/<[a-zA-Z][\s\S]*?>/.test(raw)) {
    return raw;
  }

  let result = raw;

  // Remove content of strip tags (script, style, etc.)
  for (const tag of STRIP_CONTENT_TAGS) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi');
    result = result.replace(re, '');
  }

  // Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // Remove boilerplate sections by class/id
  for (const pattern of BOILERPLATE_PATTERNS) {
    // Match elements with class or id containing the pattern
    const re = new RegExp(
      `<(?:div|section|aside|nav|footer|header|form|ul)\\s[^>]*(?:class|id)\\s*=\\s*"[^"]*${pattern}[^"]*"[\\s\\S]*?(?:<\\/(?:div|section|aside|nav|footer|header|form|ul)>)`,
      'gi'
    );
    result = result.replace(re, '');
  }

  if (preserveStructure) {
    // Convert headings to markdown
    for (const [tag, prefix] of Object.entries(HEADING_MAP)) {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
      result = result.replace(re, (_match, content) => {
        const text = content.replace(/<[^>]+>/g, '').trim();
        return text ? `\n\n${prefix}${text}\n\n` : '';
      });
    }

    // Convert list items to bullet points
    result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => {
      const text = content.replace(/<[^>]+>/g, '').trim();
      return text ? `\n- ${text}` : '';
    });

    // Convert <br> and block elements to newlines
    result = result.replace(/<br\s*\/?>/gi, '\n');
    result = result.replace(/<\/(?:p|div|section|article|blockquote|pre|tr|th|td)>/gi, '\n');
    result = result.replace(/<(?:p|div|section|article|blockquote|pre|tr)(?:\s[^>]*)?>/gi, '\n');
  }

  // Strip remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)));

  return result;
}

// --- Step 2: Remove remaining boilerplate text patterns ---

const BOILERPLATE_TEXT_PATTERNS = [
  // Cookie/privacy
  /(?:we use|this (?:site|website) uses?) cookies[\s\S]{0,300}(?:accept|agree|consent|ok|got it)/gi,
  /(?:cookie|privacy) (?:policy|settings|preferences)[\s\S]{0,200}(?:accept|manage|customize)/gi,
  // Newsletter / subscribe
  /(?:sign up|subscribe) (?:to|for) (?:our|the) (?:newsletter|updates|emails?)[\s\S]{0,200}/gi,
  // Share prompts
  /(?:share (?:this|on)|follow us on) (?:facebook|twitter|x|linkedin|instagram|pinterest)/gi,
  // "Related articles" sections
  /(?:related|recommended|you (?:may|might) (?:also )?like|more (?:from|stories)|read next)[\s\S]{0,100}$/gi,
  // Author bios (at end)
  /(?:about the author|written by|posted by|by \w+ \w+)\s*\n[\s\S]{0,300}$/gi,
];

function removeBoilerplateText(text: string): string {
  let result = text;
  for (const pattern of BOILERPLATE_TEXT_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

// --- Step 3: Deduplicate paragraphs ---

function deduplicateParagraphs(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // Normalize for dedup comparison (lowercase, collapse whitespace)
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (key.length < 30) {
      // Short lines are likely headings/bullets — keep even if duplicate
      unique.push(trimmed);
      continue;
    }

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(trimmed);
    }
  }

  return unique.join('\n\n');
}

// --- Step 4: Collapse whitespace ---

function collapseWhitespace(text: string): string {
  return text
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .trim();
}

// --- Step 5: Smart truncation ---

function smartTruncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  // Front 70%, tail 10%, marker in between
  const frontBudget = Math.floor(maxChars * 0.70);
  const tailBudget = Math.floor(maxChars * 0.10);
  const markerBudget = maxChars - frontBudget - tailBudget;

  // Find a paragraph boundary for the front cut
  let frontEnd = frontBudget;
  const nextParagraph = text.indexOf('\n\n', frontBudget - 500);
  if (nextParagraph > 0 && nextParagraph < frontBudget + 200) {
    frontEnd = nextParagraph;
  } else {
    // Fall back to sentence boundary
    const sentenceEnd = text.lastIndexOf('. ', frontBudget);
    if (sentenceEnd > frontBudget - 500) {
      frontEnd = sentenceEnd + 1;
    }
  }

  // Find a paragraph boundary for the tail start
  let tailStart = text.length - tailBudget;
  const prevParagraph = text.lastIndexOf('\n\n', tailStart + 200);
  if (prevParagraph > tailStart - 200 && prevParagraph > frontEnd) {
    tailStart = prevParagraph;
  }

  const removedChars = tailStart - frontEnd;
  const marker = `\n\n[... truncated ${removedChars.toLocaleString()} characters ...]\n\n`;

  // Ensure marker fits within budget
  if (marker.length > markerBudget) {
    // Simple fallback: just hard cut
    const front = text.slice(0, maxChars - 50);
    return {
      text: front + `\n\n[... truncated ...]`,
      truncated: true,
    };
  }

  const front = text.slice(0, frontEnd);
  const tail = text.slice(tailStart);

  return {
    text: front + marker + tail,
    truncated: true,
  };
}

// --- Main compression function ---

export function compressPageContent(
  raw: string,
  options?: CompressOptions,
): CompressedContent {
  const maxChars = Math.max(MIN_MAX_CHARS, options?.maxChars ?? DEFAULT_MAX_CHARS);
  const preserveStructure = options?.preserveStructure !== false;
  const originalLength = raw.length;

  if (originalLength === 0) {
    return {
      text: '',
      originalLength: 0,
      compressedLength: 0,
      compressionRatio: 0,
      truncated: false,
    };
  }

  // Already small enough? Quick path.
  if (originalLength <= maxChars && !/<[a-zA-Z][\s\S]*?>/.test(raw)) {
    const collapsed = collapseWhitespace(raw);
    return {
      text: collapsed,
      originalLength,
      compressedLength: collapsed.length,
      compressionRatio: originalLength > 0
        ? Math.round((1 - collapsed.length / originalLength) * 100)
        : 0,
      truncated: false,
    };
  }

  // Step 1: Strip HTML
  let text = stripHtmlToText(raw, preserveStructure);

  // Step 2: Remove boilerplate text patterns
  text = removeBoilerplateText(text);

  // Step 3: Deduplicate paragraphs
  text = deduplicateParagraphs(text);

  // Step 4: Collapse whitespace
  text = collapseWhitespace(text);

  // Step 5: Smart truncation
  const { text: truncated, truncated: wasTruncated } = smartTruncate(text, maxChars);
  text = truncated;

  const compressedLength = text.length;
  const compressionRatio = originalLength > 0
    ? Math.round((1 - compressedLength / originalLength) * 100)
    : 0;

  log.info(
    `[content-compressor] compressed ${originalLength.toLocaleString()} → ${compressedLength.toLocaleString()} (${compressionRatio}% reduction${wasTruncated ? ', truncated' : ''})`
  );

  return {
    text,
    originalLength,
    compressedLength,
    compressionRatio,
    truncated: wasTruncated,
  };
}
