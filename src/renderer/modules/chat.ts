import type { DocumentAttachment, DocumentMeta, ImageAttachment, ToolCall } from '../../shared/types';
import { hideArcade, resetArcadeDismissed, showArcade } from '../arcade/menu';
import { clearPendingAttachments, renderMessageImages, showAttachmentError } from './attachments';
import { closeBrowserMenu, handleOutsideClick, handleSourceLinkClick } from './browser';
import { renderMessageDocuments } from './documents';
import { escapeHtml, handleCodeCopyClick, renderMarkdown } from './markdown';
import {
  appState,
  CHAT_TAB_TITLE_MAX,
  DEFAULT_CHAT_TAB_TITLE,
  MAX_PROMPT_CHARS,
  SCROLL_CHEVRON_EDGE_THRESHOLD_PX,
  SCROLL_CHEVRON_IDLE_TIMEOUT_MS,
  elements,
  type ChatConversation,
  type ChatTab,
} from './state';
import { appendError, handleOutputWheel, hideThinking, isOutputNearBottom, scrollToBottom, setStreaming, showThought, updateOutputAutoFollowState } from './stream';
import { startActivityFeed, renderStaticActivityFeed } from './activity-feed';

// ============================================================
// STRUCTURAL MAP (from pre-split renderer audit)
// ============================================================
// - App bootstrap/setup routing now in `src/renderer/main.ts`.
// - Shared state/DOM bindings in `src/renderer/modules/state.ts`.
// - Setup flow in `src/renderer/modules/setup.ts`.
// - Settings/readme/model picker in `src/renderer/modules/settings.ts`.
// - Browser/menu/address/history/source tabs in `src/renderer/modules/browser.ts`.
// - Attachments pipeline in `src/renderer/modules/attachments.ts`.
// - Markdown/copy helpers in `src/renderer/modules/markdown.ts`.
// - Stream/thinking/error/scroll state in `src/renderer/modules/stream.ts`.
// - Document cards/download cards in `src/renderer/modules/documents.ts`.
// - This file owns chat tabs, conversation loading, send flow, and chat shell init.
// ============================================================

export function initChat(): void {
  const chatScrollRegion = elements.outputEl.parentElement;
  if (chatScrollRegion) {
    setupScrollChevrons(elements.outputEl, chatScrollRegion as HTMLElement);
  }

  elements.sendBtn.addEventListener('click', sendMessage);
  elements.promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });

  elements.cancelBtn.addEventListener('click', () => {
    void window.api.stopGeneration();
    hideThinking();
    setStreaming(false);
  });

  elements.conversationsToggle.addEventListener('click', () => {
    elements.conversationsDropdown.classList.toggle('hidden');
  });

  elements.newConversationBtn.addEventListener('click', async () => {
    await createNewChatTab();
    await loadConversations();
    elements.conversationsDropdown.classList.add('hidden');
  });

  elements.chatTabsContainer?.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      elements.chatTabsContainer.scrollLeft += event.deltaY;
    },
    { passive: false }
  );

  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (!elements.conversationsDropdown.contains(target) && target !== elements.conversationsToggle) {
      elements.conversationsDropdown.classList.add('hidden');
    }
    handleOutsideClick(target);
  });

  elements.outputEl.addEventListener('click', handleSourceLinkClick);
  elements.outputEl.addEventListener('pointerdown', handleFileLinkClick);
  elements.outputEl.addEventListener('click', handleCodeCopyClick);
  elements.outputEl.addEventListener('scroll', updateOutputAutoFollowState, { passive: true });
  elements.outputEl.addEventListener('wheel', handleOutputWheel, { passive: true });
}

function updateEmptyState(): void {
  if (appState.isSetupMode) return;
  const hasMessages = elements.outputEl.children.length > 0;
  if (hasMessages) {
    hideArcade();
  } else {
    showArcade(elements.outputEl);
  }
}

async function handleFileLinkClick(event: Event): Promise<void> {
  const target = (event.target as HTMLElement).closest('a.file-link') as HTMLAnchorElement | null;
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  if (target.dataset.opening === 'true') return;
  const filePath = target.dataset.filePath || target.title || target.textContent || '';
  if (!filePath) return;
  target.dataset.opening = 'true';
  target.classList.add('is-opening');
  const result = await window.api.openFileInApp(filePath);
  target.classList.remove('is-opening');
  target.dataset.opening = 'false';
  if (result?.error) {
    showAttachmentError(result.error);
  }
}

function createScrollChevron(direction: 'up' | 'down'): HTMLButtonElement {
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = `scroll-chevron scroll-chevron-${direction}`;
  chevron.setAttribute('aria-label', `Scroll ${direction}`);
  chevron.innerHTML =
    direction === 'up'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  return chevron;
}

function setupScrollChevrons(scrollContainer: HTMLElement, positionParent: HTMLElement): void {
  if (positionParent.querySelector('.scroll-chevron-up') || positionParent.querySelector('.scroll-chevron-down')) {
    return;
  }

  const upChevron = createScrollChevron('up');
  const downChevron = createScrollChevron('down');
  positionParent.appendChild(upChevron);
  positionParent.appendChild(downChevron);
  let chevronInteractionActive = true;
  let chevronIdleTimer: number | null = null;

  function updateChevronVisibility(): void {
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const hasOverflow = maxScroll > 0;

    const showUp = hasOverflow && scrollTop > SCROLL_CHEVRON_EDGE_THRESHOLD_PX && chevronInteractionActive;
    const showDown = hasOverflow && scrollTop < maxScroll - SCROLL_CHEVRON_EDGE_THRESHOLD_PX && chevronInteractionActive;

    upChevron.classList.toggle('visible', showUp);
    downChevron.classList.toggle('visible', showDown);
  }

  function scheduleChevronIdle(): void {
    if (chevronIdleTimer !== null) {
      window.clearTimeout(chevronIdleTimer);
    }
    chevronIdleTimer = window.setTimeout(() => {
      chevronInteractionActive = false;
      updateChevronVisibility();
    }, SCROLL_CHEVRON_IDLE_TIMEOUT_MS);
  }

  function markChevronInteractionActive(): void {
    if (!chevronInteractionActive) {
      chevronInteractionActive = true;
      updateChevronVisibility();
    }
    scheduleChevronIdle();
  }

  upChevron.addEventListener('click', () => {
    markChevronInteractionActive();
    appState.shouldAutoFollowOutput = false;
    scrollContainer.scrollBy({ top: -scrollContainer.clientHeight, behavior: 'smooth' });
  });
  upChevron.addEventListener('dblclick', () => {
    markChevronInteractionActive();
    appState.shouldAutoFollowOutput = false;
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });

  downChevron.addEventListener('click', () => {
    markChevronInteractionActive();
    appState.shouldAutoFollowOutput = true;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
  });
  downChevron.addEventListener('dblclick', () => {
    markChevronInteractionActive();
    appState.shouldAutoFollowOutput = true;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
  });

  let ticking = false;
  const scheduleChevronUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      updateChevronVisibility();
      ticking = false;
    });
  };

  scrollContainer.addEventListener('scroll', scheduleChevronUpdate, { passive: true });
  positionParent.addEventListener('pointermove', markChevronInteractionActive, { passive: true });
  positionParent.addEventListener('pointerdown', markChevronInteractionActive, { passive: true });
  positionParent.addEventListener('wheel', markChevronInteractionActive, { passive: true });

  const observer = new MutationObserver(scheduleChevronUpdate);
  observer.observe(scrollContainer, { childList: true, subtree: true, characterData: true });

  const resizeObserver = new ResizeObserver(scheduleChevronUpdate);
  resizeObserver.observe(scrollContainer);

  window.addEventListener('resize', scheduleChevronUpdate);
  scheduleChevronIdle();
  requestAnimationFrame(updateChevronVisibility);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isDefaultConversationTitle(title: string): boolean {
  return !title || title === 'New Conversation' || title === DEFAULT_CHAT_TAB_TITLE;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function deriveChatTabTitleFromText(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return DEFAULT_CHAT_TAB_TITLE;
  return truncate(normalized, CHAT_TAB_TITLE_MAX);
}

function deriveChatTabTitle(conversation: ChatConversation): string {
  const explicitTitle = normalizeWhitespace(conversation.title || '');
  if (explicitTitle && !isDefaultConversationTitle(explicitTitle)) {
    return truncate(explicitTitle, CHAT_TAB_TITLE_MAX);
  }

  const firstUserMessage = conversation.messages.find((message) => message.role === 'user' && normalizeWhitespace(message.content).length > 0);
  if (firstUserMessage) {
    return deriveChatTabTitleFromText(firstUserMessage.content);
  }
  return DEFAULT_CHAT_TAB_TITLE;
}

function getChatTabIndex(conversationId: string): number {
  return appState.openChatTabs.findIndex((tab) => tab.id === conversationId);
}

function getChatTabTitle(conversationId: string): string | null {
  const index = getChatTabIndex(conversationId);
  if (index < 0) return null;
  return appState.openChatTabs[index].title;
}

function setChatTabTitle(conversationId: string, nextTitle: string): void {
  const index = getChatTabIndex(conversationId);
  if (index < 0) return;
  appState.openChatTabs[index].title = deriveChatTabTitleFromText(nextTitle);
}

async function persistChatTabState(): Promise<void> {
  await window.api.saveChatTabState({
    tabIds: appState.openChatTabs.map((tab) => tab.id),
    activeId: appState.activeChatTabId,
  });
}

async function refreshChatTabTitle(conversationId: string): Promise<void> {
  if (!conversationId) return;
  const title = await window.api.getConversationTitle(conversationId);
  if (!title) return;
  const previousTitle = getChatTabTitle(conversationId);
  const nextTitle = deriveChatTabTitleFromText(title);
  if (nextTitle === previousTitle) return;
  setChatTabTitle(conversationId, nextTitle);
  renderChatTabs();
  void persistChatTabState();
}

function renderChatTabs(): void {
  elements.chatTabsContainer.innerHTML = '';

  for (const tab of appState.openChatTabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.conversationId = tab.id;
    button.className = `source-tab${tab.id === appState.activeChatTabId ? ' active' : ''}`;

    const firstLetter = tab.title.charAt(0).toUpperCase() || 'C';
    button.innerHTML = `
      <span class="source-tab-favicon-placeholder" style="display:flex;">${escapeHtml(firstLetter)}</span>
      <span class="source-tab-title">${escapeHtml(tab.title)}</span>
      <button type="button" class="source-tab-close" title="Close tab">
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="2" y1="2" x2="8" y2="8"/>
          <line x1="8" y1="2" x2="2" y2="8"/>
        </svg>
      </button>
    `;

    button.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.source-tab-close')) return;
      void switchChatTab(tab.id);
    });

    button.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });

    button.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      void closeChatTab(tab.id);
    });

    const closeBtn = button.querySelector('.source-tab-close');
    closeBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      void closeChatTab(tab.id);
    });

    elements.chatTabsContainer.appendChild(button);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add-btn';
  addBtn.title = 'New conversation';
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <line x1="7" y1="2" x2="7" y2="12"/>
      <line x1="2" y1="7" x2="12" y2="7"/>
    </svg>
  `;
  addBtn.addEventListener('click', () => {
    void createNewChatTab();
  });
  elements.chatTabsContainer.appendChild(addBtn);
}

function renderConversationMessages(messages: Array<{ role: string; content: string; images?: ImageAttachment[]; documents?: DocumentMeta[]; toolCalls?: ToolCall[] }>): void {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const userEl = appendUserMessage(msg.content, false, msg.images, msg.documents);

      // Hydrate activity feed from toolCalls if present
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        renderStaticActivityFeed(msg.toolCalls, userEl);
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const wrapper = document.createElement('div');
      wrapper.className = 'assistant-content';
      wrapper.innerHTML = renderMarkdown(msg.content);
      elements.outputEl.appendChild(wrapper);
    }
  }
}

async function switchChatTab(
  conversationId: string,
  options: { persistState?: boolean; restoreScroll?: boolean; clearInput?: boolean } = {}
): Promise<void> {
  if (appState.isStreaming && conversationId !== appState.activeChatTabId) return;

  const { persistState = true, restoreScroll = true, clearInput = true } = options;

  if (appState.activeChatTabId) {
    appState.chatScrollPositions.set(appState.activeChatTabId, elements.outputEl.scrollTop);
  }

  const switchToken = ++appState.chatSwitchToken;
  const conversation = await window.api.loadConversation(conversationId);
  if (!conversation) {
    return;
  }
  if (switchToken !== appState.chatSwitchToken) {
    return;
  }

  appState.currentConversationId = conversationId;
  appState.activeChatTabId = conversationId;
  setChatTabTitle(conversationId, deriveChatTabTitle(conversation as ChatConversation));
  renderChatTabs();

  document.dispatchEvent(new CustomEvent('clawdia:conversation:reset'));
  elements.outputEl.innerHTML = '';
  renderConversationMessages(conversation.messages);
  updateEmptyState();

  if (restoreScroll) {
    const savedPosition = appState.chatScrollPositions.get(conversationId);
    if (typeof savedPosition === 'number') {
      elements.outputEl.scrollTop = savedPosition;
    } else {
      scrollToBottom();
    }
  }
  appState.shouldAutoFollowOutput = isOutputNearBottom();

  if (clearInput) {
    elements.promptEl.value = '';
  }

  await loadConversations();
  if (persistState) {
    void persistChatTabState();
  }
}

async function createNewChatTab(): Promise<void> {
  if (appState.isStreaming) return;
  resetArcadeDismissed();
  const conversation = await window.api.newConversation();
  appState.openChatTabs.push({ id: conversation.id, title: DEFAULT_CHAT_TAB_TITLE });
  renderChatTabs();
  await switchChatTab(conversation.id, { persistState: false, restoreScroll: true });
  elements.promptEl.focus();
  void persistChatTabState();
}

async function closeChatTab(conversationId: string): Promise<void> {
  if (appState.isStreaming) return;
  const index = getChatTabIndex(conversationId);
  if (index < 0) return;

  const wasActive = appState.activeChatTabId === conversationId;
  appState.openChatTabs.splice(index, 1);
  appState.chatScrollPositions.delete(conversationId);

  if (appState.openChatTabs.length === 0) {
    appState.currentConversationId = null;
    appState.activeChatTabId = null;
    elements.outputEl.innerHTML = '';
    updateEmptyState();
    await createNewChatTab();
    return;
  }

  if (wasActive) {
    const nextIndex = Math.min(index, appState.openChatTabs.length - 1);
    const nextId = appState.openChatTabs[nextIndex].id;
    await switchChatTab(nextId, { persistState: false, restoreScroll: true });
  } else {
    renderChatTabs();
    await loadConversations();
  }

  void persistChatTabState();
}

async function openConversationInChatTab(conversationId: string): Promise<void> {
  const index = getChatTabIndex(conversationId);
  if (index < 0) {
    const conversation = await window.api.loadConversation(conversationId);
    if (!conversation) return;
    appState.openChatTabs.push({
      id: conversation.id,
      title: deriveChatTabTitle(conversation as ChatConversation),
    });
    renderChatTabs();
  }
  await switchChatTab(conversationId);
}

async function initializeChatTabs(): Promise<void> {
  const [savedState, conversations] = await Promise.all([window.api.getChatTabState(), window.api.listConversations()]);

  const knownConversationIds = new Set(conversations.map((conv: any) => conv.id));
  let tabIds = (savedState?.tabIds || []).filter((id: string) => knownConversationIds.has(id));

  if (tabIds.length === 0) {
    if (conversations.length > 0) {
      tabIds = [conversations[0].id];
    } else {
      const conversation = await window.api.newConversation();
      tabIds = [conversation.id];
    }
  }

  const loaded = await Promise.all(tabIds.map((id: string) => window.api.loadConversation(id)));
  appState.openChatTabs = loaded
    .map((conversation, index) => {
      if (!conversation) return null;
      return {
        id: tabIds[index],
        title: deriveChatTabTitle(conversation as ChatConversation),
      };
    })
    .filter((tab): tab is ChatTab => tab !== null);

  if (appState.openChatTabs.length === 0) {
    const fallback = await window.api.newConversation();
    appState.openChatTabs = [{ id: fallback.id, title: DEFAULT_CHAT_TAB_TITLE }];
  }

  const openTabIds = new Set(appState.openChatTabs.map((tab) => tab.id));
  const preferredActiveId =
    savedState?.activeId && openTabIds.has(savedState.activeId)
      ? savedState.activeId
      : appState.openChatTabs[appState.openChatTabs.length - 1].id;

  renderChatTabs();
  await switchChatTab(preferredActiveId, { persistState: false, restoreScroll: true, clearInput: true });
  await persistChatTabState();
}

export async function ensureChatShellInitialized(): Promise<void> {
  if (appState.hasInitializedChatShell) return;
  await initializeChatTabs();
  appState.hasInitializedChatShell = true;
}

async function sendMessage(): Promise<void> {
  if (appState.isSetupMode) return;
  const content = elements.promptEl.value.trim();
  const hasImages = appState.pendingAttachments.length > 0;
  const hasDocs = appState.pendingDocuments.length > 0;
  const hasAnyAttachments = hasImages || hasDocs;

  if (appState.pendingDocuments.some((d) => d.extractionStatus === 'extracting')) {
    showAttachmentError('Wait for document extraction to finish');
    return;
  }

  if ((!content && !hasAnyAttachments) || appState.isStreaming) return;
  if (content.length > MAX_PROMPT_CHARS) {
    appendError(
      `Message too long (${content.length.toLocaleString()} chars). Max is ${MAX_PROMPT_CHARS.toLocaleString()} chars. Split it into smaller parts.`
    );
    return;
  }

  if (!appState.activeChatTabId) {
    await createNewChatTab();
  }

  if (!appState.currentConversationId) {
    appState.currentConversationId = appState.activeChatTabId;
  }
  if (!appState.currentConversationId) return;

  const images: ImageAttachment[] | undefined = hasImages
    ? appState.pendingAttachments.map((a) => ({
      base64: a.base64,
      mediaType: a.mediaType,
      width: a.width,
      height: a.height,
    }))
    : undefined;

  const documents: DocumentAttachment[] | undefined = hasDocs
    ? appState.pendingDocuments
      .filter((d) => d.extractionStatus === 'done' && d.extractedText)
      .map((d) => ({
        filename: d.filename,
        originalName: d.filename,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        extractedText: d.extractedText!,
        pageCount: d.pageCount,
        sheetNames: d.sheetNames,
        truncated: d.truncated,
      }))
    : undefined;

  const documentMetas: DocumentMeta[] | undefined = documents?.map((d) => ({
    filename: d.filename,
    originalName: d.originalName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    pageCount: d.pageCount,
    sheetNames: d.sheetNames,
    truncated: d.truncated,
  }));

  const userMessageEl = appendUserMessage(content, true, images, documentMetas);
  startActivityFeed(userMessageEl);
  showThought('Thinking...');
  elements.promptEl.value = '';
  elements.promptEl.focus();
  clearPendingAttachments();

  const attachCount = (images?.length || 0) + (documents?.length || 0);
  const displayText = content || (attachCount > 0 ? `[${attachCount} attachment${attachCount > 1 ? 's' : ''}]` : '');
  const activeTitle = getChatTabTitle(appState.currentConversationId);
  if (activeTitle === DEFAULT_CHAT_TAB_TITLE) {
    setChatTabTitle(appState.currentConversationId, displayText);
    renderChatTabs();
    void persistChatTabState();
  }

  setStreaming(true);
  appState.fullStreamBuffer = '';
  const requestMessageId = crypto.randomUUID();

  let result: { conversationId?: string; error?: string } | undefined;
  try {
    result = await window.api.sendMessage(appState.currentConversationId, content, images, documents, requestMessageId);
  } catch (error: unknown) {
    hideThinking();
    appendError(error instanceof Error ? error.message : 'Failed to send message');
    setStreaming(false);
    return;
  }

  if (result?.error) {
    hideThinking();
    appendError(result.error);
    setStreaming(false);
    return;
  }

  if (result?.conversationId) {
    if (result.conversationId !== appState.currentConversationId) {
      const oldIndex = getChatTabIndex(appState.currentConversationId);
      if (oldIndex >= 0) {
        appState.openChatTabs[oldIndex].id = result.conversationId;
      }
    }
    appState.currentConversationId = result.conversationId;
    appState.activeChatTabId = result.conversationId;
  }

  await refreshChatTabTitle(appState.currentConversationId);
  await loadConversations();
}

function appendUserMessage(content: string, shouldScroll: boolean = true, images?: ImageAttachment[], documents?: DocumentMeta[]): HTMLDivElement {
  hideArcade();
  const wrapper = document.createElement('div');
  wrapper.className = 'user-message';

  const label = document.createElement('div');
  label.className = 'user-message-label';
  label.textContent = 'You';
  wrapper.appendChild(label);

  if (images && images.length > 0) {
    renderMessageImages(images, wrapper);
  }

  if (documents && documents.length > 0) {
    renderMessageDocuments(documents, wrapper);
  }

  if (content) {
    const textDiv = document.createElement('div');
    textDiv.className = 'user-message-text';
    textDiv.textContent = content;
    wrapper.appendChild(textDiv);
  }

  elements.outputEl.appendChild(wrapper);
  if (shouldScroll) {
    scrollToBottom();
  }
  return wrapper;
}

async function loadConversations(): Promise<void> {
  const conversations = await window.api.listConversations();
  elements.conversationsList.innerHTML = '';

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.id === appState.activeChatTabId ? 'active' : ''}`;
    item.innerHTML = `<span class="conversation-item-title">${escapeHtml(conv.title)}</span>`;
    item.addEventListener('click', async () => {
      await openConversationInChatTab(conv.id);
      elements.conversationsDropdown.classList.add('hidden');
    });
    elements.conversationsList.appendChild(item);
  }
}

export function resetForSetupMode(): void {
  if (appState.isStreaming) {
    void window.api.stopGeneration();
    hideThinking();
    setStreaming(false);
  }
  elements.conversationsDropdown.classList.add('hidden');
  closeBrowserMenu();
}
