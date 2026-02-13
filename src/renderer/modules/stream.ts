import { hideArcade } from '../arcade/menu';
import { renderMarkdown } from './markdown';
import { cleanupPulseLines, isActivityPulseActive } from './activity-pulse';
import {
  appState,
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  elements,
  MARKDOWN_RENDER_BUSY_TEXT,
} from './state';

export function initStream(): void {
  setupThinkingIndicator();

  window.api.onStreamText((text) => {
    appendStreamText(text);
    // Scroll is now handled inside flushPendingStreamText() AFTER the DOM update
  });

  window.api.onStreamEnd((fullText) => {
    finalizeAssistantMessage(fullText);
    setStreaming(false);
  });

  window.api.onStreamReset(() => {
    resetStreamOutput();
  });

  window.api.onChatError((error) => {
    hideThinking();
    appendError(error.error);
    setStreaming(false);
  });

  window.api.onToolLimitReached((data) => {
    showToolLimitPrompt(data.toolCallCount);
  });
}

export function setStreaming(streaming: boolean): void {
  appState.isStreaming = streaming;
  elements.sendBtn.classList.toggle('hidden', streaming);
  elements.cancelBtn.classList.toggle('hidden', !streaming);
  elements.promptEl.disabled = streaming;
}

/**
 * Tracks whether a programmatic scroll is in progress so the scroll event
 * listener doesn't accidentally disable auto-follow due to timing races.
 */
let programmaticScrollInProgress = false;

export function scrollToBottom(force: boolean = true): void {
  if (!force && !appState.shouldAutoFollowOutput) return;
  programmaticScrollInProgress = true;
  elements.outputEl.scrollTop = elements.outputEl.scrollHeight;
  if (force) appState.shouldAutoFollowOutput = true;
  // Clear the guard after the browser has processed the scroll event.
  // Use rAF to ensure the synchronous scroll event from setting scrollTop
  // has already fired before we re-enable user-scroll detection.
  requestAnimationFrame(() => {
    programmaticScrollInProgress = false;
  });
}

export function isOutputNearBottom(thresholdPx: number = AUTO_SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  const distanceFromBottom = elements.outputEl.scrollHeight - (elements.outputEl.scrollTop + elements.outputEl.clientHeight);
  return distanceFromBottom <= thresholdPx;
}

export function updateOutputAutoFollowState(): void {
  // Ignore scroll events caused by our own programmatic scrollToBottom().
  // These fire synchronously when we set scrollTop and can race with DOM
  // mutations, causing auto-follow to be disabled erroneously.
  if (programmaticScrollInProgress) return;
  appState.shouldAutoFollowOutput = isOutputNearBottom();
}

export function handleOutputWheel(event: WheelEvent): void {
  if (event.deltaY < 0) {
    // User scrolled up — stop auto-following
    appState.shouldAutoFollowOutput = false;
  } else if (event.deltaY > 0) {
    // User scrolled down — re-enable auto-follow if near bottom
    if (isOutputNearBottom()) {
      appState.shouldAutoFollowOutput = true;
    }
  }
}

function ensureThinkingEl(): void {
  if (!appState.thinkingEl || !appState.thinkingEl.parentElement) {
    appState.thinkingEl = document.createElement('div');
    appState.thinkingEl.className = 'thinking-indicator';

    appState.thinkingTextEl = document.createElement('span');
    appState.thinkingTextEl.className = 'thinking-text';
    appState.thinkingEl.appendChild(appState.thinkingTextEl);

    appState.thinkingVisible = false;
    appState.thinkingVisible = false;
    appState.currentThought = '';

    // Create Agent Count Element
    appState.agentCountEl = document.createElement('span');
    appState.agentCountEl.className = 'agent-count';
    appState.agentCountEl.style.display = 'none'; // Hidden by default
    appState.agentCountEl.style.marginLeft = '12px';
    appState.agentCountEl.style.color = 'var(--color-primary)';
    appState.agentCountEl.style.fontSize = '0.9em';
    appState.thinkingEl.appendChild(appState.agentCountEl);
  }

  const userMessages = elements.outputEl.querySelectorAll('.user-message');
  const lastUserMessage = userMessages.length > 0 ? (userMessages[userMessages.length - 1] as HTMLElement) : null;
  if (lastUserMessage) {
    const nextSibling = lastUserMessage.nextSibling;
    if (appState.thinkingEl.parentElement !== elements.outputEl || nextSibling !== appState.thinkingEl) {
      elements.outputEl.insertBefore(appState.thinkingEl, nextSibling);
    }
    return;
  }

  if (appState.thinkingEl.parentElement !== elements.outputEl) {
    elements.outputEl.appendChild(appState.thinkingEl);
  }
}

function setupThinkingIndicator(): void {
  ensureThinkingEl();

  if (appState.thinkingListenersBound) return;
  appState.thinkingListenersBound = true;

  window.api.onThinking((thought) => {
    if (isActivityPulseActive()) return;
    const nextThought = thought.trim();
    if (!nextThought) {
      hideThinking();
      return;
    }
    showThought(nextThought);
  });

  // Only hide thinking when visible text actually appears in the chat.
  // The XML filter strips tool calls / thinking blocks, so many stream
  // chunks produce no visible output — we must keep the indicator alive
  // until real user-facing text arrives.

  window.api.onStreamEnd(() => {
    hideThinking();
  });

  // Listen for agent count updates
  if (window.api.onAgentCountUpdate) {
    window.api.onAgentCountUpdate((count) => {
      if (appState.agentCountEl) {
        if (count > 0) {
          appState.agentCountEl.textContent = `Agents: ${count} active`;
          appState.agentCountEl.style.display = 'inline-block';
        } else {
          appState.agentCountEl.style.display = 'none';
        }
      }
    });
  }
}

export function showThought(thought: string): void {
  ensureThinkingEl();
  if (!appState.thinkingEl || !appState.thinkingTextEl) return;
  if (appState.thinkingVisible && thought === appState.currentThought) return;

  if (appState.thinkingHideTimer !== null) {
    window.clearTimeout(appState.thinkingHideTimer);
    appState.thinkingHideTimer = null;
  }

  if (appState.thinkingSwapTimer !== null) {
    window.clearTimeout(appState.thinkingSwapTimer);
    appState.thinkingSwapTimer = null;
  }

  const transitionToken = ++appState.thinkingTransitionToken;
  if (!appState.thinkingVisible) {
    appState.thinkingTextEl.textContent = thought;
    appState.thinkingEl.classList.add('visible');
    appState.thinkingTextEl.classList.add('visible');
  } else {
    appState.thinkingTextEl.classList.remove('visible');
    appState.thinkingSwapTimer = window.setTimeout(() => {
      if (!appState.thinkingTextEl || transitionToken !== appState.thinkingTransitionToken) return;
      appState.thinkingTextEl.textContent = thought;
      appState.thinkingTextEl.classList.add('visible');
    }, 150);
  }

  appState.currentThought = thought;
  appState.thinkingVisible = true;
  scrollToBottom(false);
}

export function hideThinking(): void {
  if (!appState.thinkingEl || !appState.thinkingTextEl) return;

  ++appState.thinkingTransitionToken;

  if (appState.thinkingSwapTimer !== null) {
    window.clearTimeout(appState.thinkingSwapTimer);
    appState.thinkingSwapTimer = null;
  }

  if (appState.thinkingHideTimer !== null) {
    window.clearTimeout(appState.thinkingHideTimer);
    appState.thinkingHideTimer = null;
  }

  appState.thinkingVisible = false;
  appState.currentThought = '';
  appState.thinkingTextEl.classList.remove('visible');
  appState.thinkingEl.classList.remove('visible');

  appState.thinkingHideTimer = window.setTimeout(() => {
    if (!appState.thinkingTextEl || appState.thinkingVisible) return;
    appState.thinkingTextEl.textContent = '';
  }, 300);
}

// ---------------------------------------------------------------------------
// Stream XML filter — strips internal tags that should never appear in chat.
//
// Instead of parsing XML incrementally (fragile with chunk boundaries), we
// accumulate the full stream buffer and apply regex stripping on each flush.
// This reuses the same proven regexes as renderMarkdown().
// ---------------------------------------------------------------------------

/** Regex that matches all XML blocks that should be hidden from chat output. */
const HIDDEN_XML_RE = new RegExp(
  [
    '<thinking>[\\s\\S]*?</thinking>',
    '<function_calls>[\\s\\S]*?</function_calls>',
    '<tool_call>[\\s\\S]*?</tool_call>',
    '<invoke[\\s\\S]*?</invoke>',
    // Standalone closing tags (orphaned when opening was in a prior message)
    '</parameter>',
    '</invoke>',
    '</function_calls>',
    '</tool_call>',
    '</thinking>',
    // Partial opening tags left at stream end
    '<(?:thinking|function_calls|tool_call|invoke)[^>]*$',
  ].join('|'),
  'g'
);

/** How many chars of fullStreamBuffer we already emitted as visible text. */
let streamVisibleEmitted = 0;

function resetStreamFilter(): void {
  streamVisibleEmitted = 0;
}

function resetStreamOutput(): void {
  if (appState.streamFlushRafId !== null) {
    window.cancelAnimationFrame(appState.streamFlushRafId);
    appState.streamFlushRafId = null;
  }
  // Clear the text content but keep the container in the DOM so the chat
  // bubble stays visible during multi-iteration tool loops. Removing the
  // element entirely caused the in-progress response to vanish mid-stream.
  if (appState.streamingContainer) {
    appState.streamingContainer.innerHTML = '';
  }
  appState.currentTextChunk = null;
  appState.pendingStreamTextChunks = [];
  appState.fullStreamBuffer = '';
  resetStreamFilter();
}

/**
 * Given the full accumulated stream buffer, return only the NEW visible
 * text that hasn't been emitted yet. Strips all hidden XML from the full
 * buffer first, then returns the delta since last call.
 */
function getVisibleDelta(fullBuffer: string): string {
  const cleaned = fullBuffer.replace(HIDDEN_XML_RE, '');
  if (cleaned.length <= streamVisibleEmitted) return '';

  // Don't emit text that ends with a partial `<` — it could be the start
  // of a hidden tag. Hold it back until more data arrives.
  const lastAngle = cleaned.lastIndexOf('<');
  const safeEnd = (lastAngle > streamVisibleEmitted) ? lastAngle : cleaned.length;
  if (safeEnd <= streamVisibleEmitted) return '';

  const delta = cleaned.slice(streamVisibleEmitted, safeEnd);
  streamVisibleEmitted = safeEnd;
  return delta;
}

function startAssistantMessage(): void {
  hideArcade();
  resetStreamFilter();
  appState.streamingContainer = document.createElement('div');
  appState.streamingContainer.className = 'assistant-content streaming';
  elements.outputEl.appendChild(appState.streamingContainer);
  appState.currentTextChunk = null;
}

function scheduleStreamFlush(): void {
  if (appState.streamFlushRafId !== null) return;
  appState.streamFlushRafId = window.requestAnimationFrame(() => {
    appState.streamFlushRafId = null;
    flushPendingStreamText();
  });
}

function flushPendingStreamText(): void {
  if (appState.pendingStreamTextChunks.length === 0) return;
  if (!appState.streamingContainer) {
    startAssistantMessage();
  }
  if (!appState.currentTextChunk) {
    appState.currentTextChunk = document.createElement('span');
    appState.currentTextChunk.className = 'text-chunk';
    appState.streamingContainer!.appendChild(appState.currentTextChunk);
  }
  const batch = appState.pendingStreamTextChunks.join('');
  appState.pendingStreamTextChunks = [];
  appState.currentTextChunk.appendChild(document.createTextNode(batch));
  // Scroll AFTER the DOM update so scrollHeight reflects the new content
  scrollToBottom(false);
}

function appendStreamText(text: string): void {
  appState.fullStreamBuffer += text;
  const delta = getVisibleDelta(appState.fullStreamBuffer);
  if (!delta) return; // All XML / thinking — nothing visible yet

  // First visible text — create the container and hide the thinking indicator
  if (!appState.streamingContainer) {
    startAssistantMessage();
  }
  hideThinking();
  appState.pendingStreamTextChunks.push(delta);
  scheduleStreamFlush();
}

function finalizeAssistantMessage(fullText: string): void {
  if (!appState.streamingContainer) return;
  if (appState.streamFlushRafId !== null) {
    window.cancelAnimationFrame(appState.streamFlushRafId);
    appState.streamFlushRafId = null;
  }
  flushPendingStreamText();
  cleanupPulseLines();

  appState.streamingContainer.classList.remove('streaming');
  const finalText = fullText || appState.fullStreamBuffer;
  const target = appState.streamingContainer;
  target.innerHTML = '<div class="markdown-content"><p>' + MARKDOWN_RENDER_BUSY_TEXT + '</p></div>';

  // Capture auto-follow intent BEFORE clearing streamingContainer so
  // the scroll after markdown render honours the user's position.
  const shouldFollow = appState.shouldAutoFollowOutput;

  window.setTimeout(() => {
    const rendered = renderMarkdown(finalText);
    target.innerHTML = '<div class="markdown-content">' + rendered + '</div>';
    // Scroll AFTER the markdown render which may change the container height
    // significantly (code blocks, lists, tables, etc.).
    if (shouldFollow) {
      scrollToBottom(true);
    }
  }, 0);

  appState.currentTextChunk = null;
  appState.streamingContainer = null;
  appState.pendingStreamTextChunks = [];
  appState.fullStreamBuffer = '';
  resetStreamFilter();
  // Scroll now for the "Rendering response..." placeholder, and again
  // after the real markdown lands (in the setTimeout above).
  scrollToBottom(false);
}

export function appendError(message: string): void {
  hideArcade();
  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  elements.outputEl.appendChild(errorEl);
  scrollToBottom(false);
}

function showToolLimitPrompt(toolCallCount: number): void {
  // Remove any existing prompt
  const existing = document.querySelector('.tool-limit-prompt');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.className = 'tool-limit-prompt';

  const text = document.createElement('span');
  text.className = 'tool-limit-prompt-text';
  text.textContent = `Used ${toolCallCount} tool calls. Continue working?`;

  const continueBtn = document.createElement('button');
  continueBtn.className = 'tool-limit-btn tool-limit-continue';
  continueBtn.textContent = 'Continue';
  continueBtn.onclick = () => {
    container.remove();
    window.api.respondToToolLimit(true);
  };

  const stopBtn = document.createElement('button');
  stopBtn.className = 'tool-limit-btn tool-limit-stop';
  stopBtn.textContent = 'Finish up';
  stopBtn.onclick = () => {
    container.remove();
    window.api.respondToToolLimit(false);
  };

  container.appendChild(text);
  container.appendChild(continueBtn);
  container.appendChild(stopBtn);
  elements.outputEl.appendChild(container);
  scrollToBottom(true);
}
