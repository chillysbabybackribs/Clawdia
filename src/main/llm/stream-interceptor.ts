// ============================================================================
// STREAM INTERCEPTOR — Detects HTML in LLM output and splits the stream
// ============================================================================

export interface StreamInterceptorState {
  mode: 'detecting' | 'html' | 'chat';
  accumulated: string;
  lastHtmlWriteLen: number;
  preHtmlChat: string;
  htmlComplete: boolean;
  documentOpen: boolean;
}

const DETECTION_LIMIT = 300;
const FENCE_OPEN = /```html\s*\n/i;

/**
 * Create a fresh interceptor state for a new stream.
 */
export function createInterceptor(): StreamInterceptorState {
  return {
    mode: 'detecting',
    accumulated: '',
    lastHtmlWriteLen: 0,
    preHtmlChat: '',
    htmlComplete: false,
    documentOpen: false,
  };
}

/**
 * Decide whether the accumulated text contains an HTML document.
 * Returns 'html' if we see a ```html fence with <!DOCTYPE or <html,
 * 'chat' if we've buffered enough without seeing HTML,
 * or 'detecting' if we need more tokens.
 */
export function detectMode(accumulated: string): 'html' | 'chat' | 'detecting' {
  const trimmed = accumulated.trim();

  // HTML inside a code fence (the expected pattern)
  if (/```html\s*\n\s*<!DOCTYPE/i.test(trimmed) || /```html\s*\n\s*<html/i.test(trimmed)) {
    return 'html';
  }

  // Just a ```html fence open (LLM might not have written <!DOCTYPE yet)
  if (FENCE_OPEN.test(trimmed)) {
    return 'html';
  }

  // Direct HTML without fence
  if (/^\s*<!DOCTYPE\s+html/i.test(trimmed) || /^\s*<html[\s>]/i.test(trimmed)) {
    return 'html';
  }

  // If we've seen enough chars without HTML, it's just chat
  if (trimmed.length > DETECTION_LIMIT) {
    return 'chat';
  }

  return 'detecting';
}

/**
 * Extract HTML content from the accumulated text.
 * Handles both ```html fenced blocks and direct HTML.
 * Returns the text before the HTML (preChat) and the HTML itself.
 */
export function extractHtml(accumulated: string): { preChat: string; html: string } {
  // Check for fenced HTML block
  const fenceMatch = accumulated.match(FENCE_OPEN);
  if (fenceMatch) {
    const fenceStart = fenceMatch.index! + fenceMatch[0].length;
    const preChat = accumulated.slice(0, fenceMatch.index!).trim();

    // Find closing fence
    const afterFence = accumulated.slice(fenceStart);
    const closeMatch = afterFence.match(/\n```(?:\s*\n|$)/);

    if (closeMatch) {
      return { preChat, html: afterFence.slice(0, closeMatch.index!) };
    }
    return { preChat, html: afterFence };
  }

  // Direct HTML
  const htmlMatch = accumulated.match(/<!DOCTYPE\s+html/i) || accumulated.match(/<html[\s>]/i);
  if (htmlMatch) {
    const preChat = accumulated.slice(0, htmlMatch.index!).trim();
    return { preChat, html: accumulated.slice(htmlMatch.index!) };
  }

  return { preChat: '', html: accumulated };
}

/**
 * Check if the accumulated text has a closing fence after the HTML.
 * Returns the index into the full accumulated string where the closing fence is,
 * or -1 if not found.
 */
export function findClosingFence(accumulated: string): number {
  const fenceOpen = accumulated.match(FENCE_OPEN);
  if (!fenceOpen) {
    // No fence, check for </html> as end marker
    const htmlEnd = accumulated.match(/<\/html>\s*$/i);
    return htmlEnd ? htmlEnd.index! + htmlEnd[0].length : -1;
  }

  const afterFenceStart = fenceOpen.index! + fenceOpen[0].length;
  const afterFence = accumulated.slice(afterFenceStart);

  // Look for closing ``` that's on its own line
  const closeMatch = afterFence.match(/\n```(?:\s*\n|$)/);
  return closeMatch ? afterFenceStart + closeMatch.index! : -1;
}

/**
 * Extract any text after the closing fence (post-HTML chat).
 */
export function extractPostChat(accumulated: string): string {
  const fenceOpen = accumulated.match(FENCE_OPEN);
  if (fenceOpen) {
    const afterFenceStart = fenceOpen.index! + fenceOpen[0].length;
    const afterFence = accumulated.slice(afterFenceStart);
    const closeMatch = afterFence.match(/\n```(?:\s*\n|$)/);
    if (closeMatch) {
      const afterClose = afterFence.slice(closeMatch.index! + closeMatch[0].length).trim();
      return afterClose;
    }
    return '';
  }

  // Direct HTML — check after </html>
  const htmlEnd = accumulated.match(/<\/html>\s*/i);
  if (htmlEnd) {
    return accumulated.slice(htmlEnd.index! + htmlEnd[0].length).trim();
  }

  return '';
}
