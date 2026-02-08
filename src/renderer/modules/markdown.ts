import DOMPurify from 'dompurify';
import {
  appState,
  COPY_BUTTON_SUCCESS_DURATION_MS,
  COPY_ICON_SVG,
  COPY_NOTE_DURATION_MS,
  SAFE_MARKDOWN_RENDER_CHARS,
} from './state';

// ---------------------------------------------------------------------------
// LRU Markdown Cache - avoids re-parsing identical content
// ---------------------------------------------------------------------------
const MARKDOWN_CACHE_MAX_SIZE = 500;
const markdownCache = new Map<string, string>();
const cacheAccessOrder: string[] = [];

function quickHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function getCachedMarkdown(key: string): string | undefined {
  const cached = markdownCache.get(key);
  if (cached) {
    const idx = cacheAccessOrder.indexOf(key);
    if (idx > -1) {
      cacheAccessOrder.splice(idx, 1);
      cacheAccessOrder.push(key);
    }
  }
  return cached;
}

function setCachedMarkdown(key: string, html: string): void {
  while (markdownCache.size >= MARKDOWN_CACHE_MAX_SIZE && cacheAccessOrder.length > 0) {
    const oldest = cacheAccessOrder.shift();
    if (oldest) markdownCache.delete(oldest);
  }
  markdownCache.set(key, html);
  cacheAccessOrder.push(key);
}

export function clearMarkdownCache(): void {
  markdownCache.clear();
  cacheAccessOrder.length = 0;
}

// ---------------------------------------------------------------------------
// DOMPurify configuration — sanitizes LLM-generated HTML before DOM insertion.
// Allows safe markdown elements (headings, lists, links, code blocks, etc.)
// while stripping scripts, event handlers, and dangerous URI schemes.
// ---------------------------------------------------------------------------
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'code', 'pre', 'a', 'li', 'ul', 'ol', 'div', 'span', 'button', 'svg',
    'line', 'img',
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel', 'class', 'title', 'type', 'aria-label',
    'data-source-url', 'data-source-title',
    'data-file-path',
    // SVG attributes for copy-button icon
    'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'd', 'x1', 'y1', 'x2', 'y2',
    // img
    'src', 'alt',
    // inline style (needed for favicon fallback display toggling)
    'style',
  ],
  ALLOW_DATA_ATTR: true,
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

/** Sanitize HTML through DOMPurify. Use for ALL LLM-generated content before innerHTML. */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, PURIFY_CONFIG) as string;
}

export function initMarkdown(): void {
  // No initialization required.
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    const viaMain = await window.api.clipboardWriteText(text);
    if (viaMain?.success) {
      return;
    }
  } catch {
    // Fall back to renderer clipboard paths.
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'absolute';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!copied) {
    throw new Error('Clipboard copy command failed');
  }
}

export function showCopyNote(wrapper: HTMLElement, text: string): void {
  let noteEl = wrapper.querySelector('.code-copy-note') as HTMLSpanElement | null;
  if (!noteEl) {
    noteEl = document.createElement('span');
    noteEl.className = 'code-copy-note';
    wrapper.appendChild(noteEl);
  }

  noteEl.textContent = text;
  noteEl.classList.add('visible');

  const existingTimer = appState.copyNoteHideTimers.get(wrapper);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }
  const nextTimer = window.setTimeout(() => {
    noteEl?.classList.remove('visible');
    appState.copyNoteHideTimers.delete(wrapper);
  }, COPY_NOTE_DURATION_MS);
  appState.copyNoteHideTimers.set(wrapper, nextTimer);
}

export function handleCodeCopyClick(event: MouseEvent): void {
  const btn = (event.target as Element).closest('.code-copy-btn') as HTMLButtonElement | null;
  if (!btn) return;
  event.preventDefault();
  const wrapper = btn.closest('.code-block-wrapper') as HTMLElement | null;
  const codeEl = wrapper?.querySelector('code');
  if (!codeEl) return;
  btn.classList.add('is-clicked');
  window.setTimeout(() => btn.classList.remove('is-clicked'), 120);

  void copyTextToClipboard(codeEl.textContent || '')
    .then(() => {
      btn.classList.add('is-copied');
      const existingTimer = appState.copyButtonStateTimers.get(btn);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      const nextTimer = window.setTimeout(() => {
        btn.classList.remove('is-copied');
        appState.copyButtonStateTimers.delete(btn);
      }, COPY_BUTTON_SUCCESS_DURATION_MS);
      appState.copyButtonStateTimers.set(btn, nextTimer);

      if (wrapper) {
        showCopyNote(wrapper, 'Copied');
      }
    })
    .catch((error) => {
      console.error('[Renderer] failed to copy code block:', error);
    });
}

export function renderMarkdown(text: string, skipCache = false): string {
  // Check cache first (skip during streaming for partial content)
  const cacheKey = quickHash(text);
  if (!skipCache) {
    const cached = getCachedMarkdown(cacheKey);
    if (cached) return cached;
  }

  // Strip ALL tool call and thinking blocks - they should NEVER be visible in chat
  let cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '')
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<invoke[\s\S]*?<\/antml:invoke>/g, '')
    .trim();

  if (cleaned.length > SAFE_MARKDOWN_RENDER_CHARS) {
    const result = `<pre>${escapeHtml(cleaned)}</pre>`;
    if (!skipCache) setCachedMarkdown(cacheKey, result);
    return result;
  }

  let html = escapeHtml(cleaned)
    .replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_match, _language, code) =>
        `<div class="code-block-wrapper"><button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code">${COPY_ICON_SVG}</button><pre><code>${code}</code></pre></div>`
    )
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  html = html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    let display = match;
    try {
      const parsed = new URL(match);
      const host = parsed.hostname;
      let rest = parsed.pathname.replace(/\/$/, '');
      if (rest.length > 20) {
        rest = rest.slice(0, 20) + '…';
      }
      display = `${host}${rest}${parsed.search ? parsed.search : ''}`;
    } catch {
      // Ignore parse failures.
    }

    return `<a href="${match}" class="source-link" data-source-url="${match}" data-source-title="${escapeHtml(display)}" title="${escapeHtml(match)}" target="_blank" rel="noreferrer">${escapeHtml(
      display
    )}</a>`;
  });

  html = linkifyFilePaths(html);

  const result = sanitizeHtml(`<p>${html}</p>`);
  if (!skipCache) setCachedMarkdown(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// File path linkify — turns file paths into clickable links for openFile
// ---------------------------------------------------------------------------
const FILE_PATH_RE = /(?:~\/|\/)(?:[^\s<>"']+\.[A-Za-z0-9]{2,8})|[A-Za-z]:\\(?:[^\\\s<>"']+\\)+[^\\\s<>"']+\.[A-Za-z0-9]{2,8}/g;

function linkifyFilePaths(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }

  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text || !FILE_PATH_RE.test(text)) {
      FILE_PATH_RE.lastIndex = 0;
      continue;
    }
    FILE_PATH_RE.lastIndex = 0;
    const parentEl = node.parentElement;
    if (parentEl && (parentEl.closest('pre') || parentEl.closest('a'))) {
      continue;
    }
    const isInlineCode = Boolean(parentEl?.closest('code'));

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      const filePath = match[0];
      const start = match.index;
      if (start > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }

      const link = document.createElement('a');
      link.className = isInlineCode ? 'file-link code-link' : 'file-link';
      link.dataset.filePath = filePath;
      link.setAttribute('href', '#');
      link.setAttribute('aria-label', `Open ${filePath}`);
      link.title = filePath;
      const parts = filePath.split(/[\\/]/);
      link.textContent = parts[parts.length - 1] || filePath;
      frag.appendChild(link);

      lastIndex = start + filePath.length;
    }

    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.parentNode?.replaceChild(frag, node);
  }

  return container.innerHTML;
}
