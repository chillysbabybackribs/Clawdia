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

// ---------------------------------------------------------------------------
// Generate friendly, shortened display text for URLs
// ---------------------------------------------------------------------------
function generateFriendlyUrlDisplay(urlString: string): string {
  try {
    const url = new URL(urlString);
    const host = url.hostname.replace('www.', '');

    // GitHub releases: /owner/repo/releases/tag/vX.Y.Z → "GitHub Release vX.Y.Z"
    const ghReleaseMatch = url.pathname.match(/^\/(\w+)\/(\w+)\/releases\/tag\/(v[\d.]+)/);
    if (host === 'github.com' && ghReleaseMatch) {
      return `GitHub Release ${ghReleaseMatch[3]}`;
    }

    // GitHub repo: /owner/repo → "GitHub: owner/repo"
    const ghRepoMatch = url.pathname.match(/^\/(\w+)\/(\w+)(?:\/)?$/);
    if (host === 'github.com' && ghRepoMatch) {
      return `GitHub: ${ghRepoMatch[1]}/${ghRepoMatch[2]}`;
    }

    // GitHub PRs/issues: /owner/repo/pull|issues/N → "GitHub PR #N" or "GitHub Issue #N"
    const ghPrMatch = url.pathname.match(/^\/(\w+)\/(\w+)\/(pull|issues)\/(\d+)/);
    if (host === 'github.com' && ghPrMatch) {
      const type = ghPrMatch[3] === 'pull' ? 'PR' : 'Issue';
      return `GitHub ${type} #${ghPrMatch[4]}`;
    }

    // Twitter/X tweets: /user/status/ID → "Tweet from @user"
    const xTweetMatch = url.pathname.match(/^\/(\w+)\/status\/(\d+)/);
    if ((host === 'twitter.com' || host === 'x.com') && xTweetMatch) {
      return `Tweet from @${xTweetMatch[1]}`;
    }

    // Twitter/X profile: /user → "@user on Twitter"
    const xProfileMatch = url.pathname.match(/^\/(\w+)(?:\/)?$/);
    if ((host === 'twitter.com' || host === 'x.com') && xProfileMatch && url.pathname !== '/home' && url.pathname !== '/') {
      return `@${xProfileMatch[1]} on ${host === 'x.com' ? 'X' : 'Twitter'}`;
    }

    // Default fallback: truncated pathname if available
    let display = host;
    const path = url.pathname.replace(/^\/$/, '').replace(/\/$/, '');
    if (path.length > 0) {
      const truncated = path.length > 25 ? path.slice(0, 25) + '…' : path;
      display = `${host}${truncated}`;
    }

    return display;
  } catch {
    // If URL parsing fails, return the original
    return urlString;
  }
}

// ---------------------------------------------------------------------------
// Initialization (called from main.ts at startup)
// ---------------------------------------------------------------------------
export function initMarkdown(): void {
  // No initialization required — cache and DOMPurify are ready at import time.
}

// ---------------------------------------------------------------------------
// Markdown rendering with link shortening
// ---------------------------------------------------------------------------
export function renderMarkdown(text: string, skipCache: boolean = false): string {
  if (!text) return '';
  if (text.length > SAFE_MARKDOWN_RENDER_CHARS) {
    return escapeHtml(text);
  }

  const cacheKey = quickHash(text);
  const cached = getCachedMarkdown(cacheKey);
  if (cached) return cached;

  // Extract URLs from raw text BEFORE escaping so they aren't mangled
  // (escapeHtml turns & → &amp; which breaks query strings)
  const urlPlaceholders: { placeholder: string; url: string }[] = [];
  let textWithPlaceholders = text.replace(/(https?:\/\/[^\s<]+)/g, (match, _p1, offset) => {
    const placeholder = `\x00URL${offset}\x00`;
    urlPlaceholders.push({ placeholder, url: match });
    return placeholder;
  });

  let html = escapeHtml(textWithPlaceholders);

  // Basic markdown
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^### (.+?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+?)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+?)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Restore URLs as proper link elements with clean (un-escaped) href/data attrs
  for (const { placeholder, url } of urlPlaceholders) {
    const display = generateFriendlyUrlDisplay(url);
    const link = `<a href="${escapeHtml(url)}" class="source-link" data-source-url="${escapeHtml(url)}" data-source-title="${escapeHtml(display)}" title="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(display)}</a>`;
    html = html.replace(placeholder, link);
  }

  html = linkifyFilePaths(html);

  const result = sanitizeHtml(`<p>${html}</p>`);
  if (!skipCache) setCachedMarkdown(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// HTML sanitization
// ---------------------------------------------------------------------------
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['strong', 'em', 'code', 'p', 'br', 'h1', 'h2', 'h3', 'li', 'a', 'span', 'div'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title', 'data-source-url', 'data-source-title', 'data-file-path', 'aria-label'],
  });
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Code copy functionality
// ---------------------------------------------------------------------------
export async function copyToClipboard(text: string): Promise<void> {
  try {
    // On Electron, use native copy
    if (window.electronAPI?.copy) {
      await window.electronAPI.copy(text);
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

  const wrapper = btn.closest('.code-wrapper') as HTMLElement | null;
  if (!wrapper) return;

  const codeBlock = wrapper.querySelector('code');
  if (!codeBlock) return;

  const text = codeBlock.textContent || '';
  copyToClipboard(text).then(() => {
    showCopyNote(wrapper, 'Copied!');
  });
}

// ---------------------------------------------------------------------------
// File path linkify — turns file paths into clickable links for openFile
// ---------------------------------------------------------------------------
function linkifyFilePaths(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;

  const filePathPattern = /\/[^\s<]*\/[^\s<]*\.[a-zA-Z0-9]+/g;

  function processNode(node: Node): void {
    if (node.nodeType === 3) {
      // Text node
      const text = node.textContent || '';
      const matches = Array.from(text.matchAll(filePathPattern));
      if (matches.length === 0) return;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;

      for (const match of matches) {
        const filePath = match[0];
        const start = match.index!;

        if (start > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        }

        const link = document.createElement('a');
        const isCodeLink = node.parentNode?.nodeName === 'CODE';
        link.className = isCodeLink ? 'code-link' : 'file-link';
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
    } else if (node.nodeType === 1) {
      // Element node
      const children = Array.from(node.childNodes);
      children.forEach(processNode);
    }
  }

  processNode(container);

  return container.innerHTML;
}
