import { hideArcade } from '../arcade/menu';
import { renderMarkdown } from './markdown';
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
    scrollToBottom(false);
  });

  window.api.onStreamEnd((fullText) => {
    finalizeAssistantMessage(fullText);
    setStreaming(false);
  });

  window.api.onChatError((error) => {
    hideThinking();
    appendError(error.error);
    setStreaming(false);
  });
}

export function setStreaming(streaming: boolean): void {
  appState.isStreaming = streaming;
  elements.sendBtn.disabled = streaming;
  elements.cancelBtn.disabled = !streaming;
  elements.promptEl.disabled = streaming;
}

export function scrollToBottom(force: boolean = true): void {
  if (!force && !appState.shouldAutoFollowOutput) return;
  elements.outputEl.scrollTop = elements.outputEl.scrollHeight;
  if (force) appState.shouldAutoFollowOutput = true;
}

export function isOutputNearBottom(thresholdPx: number = AUTO_SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  const distanceFromBottom = elements.outputEl.scrollHeight - (elements.outputEl.scrollTop + elements.outputEl.clientHeight);
  return distanceFromBottom <= thresholdPx;
}

export function updateOutputAutoFollowState(): void {
  appState.shouldAutoFollowOutput = isOutputNearBottom();
}

export function handleOutputWheel(event: WheelEvent): void {
  if (event.deltaY < 0) {
    appState.shouldAutoFollowOutput = false;
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
    appState.currentThought = '';
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
    const nextThought = thought.trim();
    if (!nextThought) {
      hideThinking();
      return;
    }
    showThought(nextThought);
  });

  window.api.onStreamText(() => {
    hideThinking();
  });

  window.api.onStreamEnd(() => {
    hideThinking();
  });
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

function startAssistantMessage(): void {
  hideArcade();
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
}

function appendStreamText(text: string): void {
  if (!appState.streamingContainer) {
    startAssistantMessage();
  }

  appState.fullStreamBuffer += text;
  appState.pendingStreamTextChunks.push(text);
  scheduleStreamFlush();
}

function finalizeAssistantMessage(fullText: string): void {
  if (!appState.streamingContainer) return;
  if (appState.streamFlushRafId !== null) {
    window.cancelAnimationFrame(appState.streamFlushRafId);
    appState.streamFlushRafId = null;
  }
  flushPendingStreamText();

  appState.streamingContainer.classList.remove('streaming');
  const finalText = fullText || appState.fullStreamBuffer;
  const target = appState.streamingContainer;
  target.innerHTML = `<div class="markdown-content"><p>${MARKDOWN_RENDER_BUSY_TEXT}</p></div>`;

  window.setTimeout(() => {
    const rendered = renderMarkdown(finalText);
    target.innerHTML = `<div class="markdown-content">${rendered}</div>`;
  }, 0);

  appState.currentTextChunk = null;
  appState.streamingContainer = null;
  appState.pendingStreamTextChunks = [];
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
