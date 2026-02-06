import type { BrowserTabInfo, ResearchSourcePreview, ResearchProgress, FrequentSiteEntry } from '../shared/types';

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  interface Window {
    api: {
      // Chat
      sendMessage: (conversationId: string, content: string) => Promise<{ conversationId?: string; error?: string }>;
      stopGeneration: () => Promise<{ stopped: boolean }>;
      newConversation: () => Promise<{ id: string; title: string }>;
      listConversations: () => Promise<Array<{ id: string; title: string; updatedAt: string }>>;
      loadConversation: (id: string) => Promise<{ id: string; title: string; messages: Array<{ role: string; content: string }> } | undefined>;
      deleteConversation: (id: string) => Promise<{ deleted: boolean }>;
      getConversationTitle: (id: string) => Promise<string>;
      getChatTabState: () => Promise<{ tabIds: string[]; activeId: string | null }>;
      saveChatTabState: (state: { tabIds: string[]; activeId: string | null }) => Promise<{ success: boolean }>;

      // Chat events
      onStreamText: (callback: (text: string) => void) => () => void;
      onStreamEnd: (callback: (fullText: string) => void) => () => void;
      onThinking: (callback: (thought: string) => void) => () => void;
      onToolStart: (callback: (data: { id: string; name: string; input: unknown }) => void) => () => void;
      onToolResult: (callback: (data: { id: string; result: string; isError: boolean }) => void) => () => void;
      onChatError: (callback: (error: { error: string }) => void) => () => void;
      onLiveHtmlStart: (callback: () => void) => () => void;
      onLiveHtmlEnd: (callback: () => void) => () => void;
      onResearchProgress: (callback: (progress: ResearchProgress) => void) => () => void;
      getFrequentSites: () => Promise<FrequentSiteEntry[]>;
      onFrequentSitesUpdate: (callback: (entries: FrequentSiteEntry[]) => void) => () => void;

      // Browser
      browserNavigate: (url: string) => Promise<{ success: boolean; error?: string }>;
      browserBack: () => Promise<{ success: boolean }>;
      browserForward: () => Promise<{ success: boolean }>;
      browserRefresh: () => Promise<{ success: boolean }>;
      browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }>;
      browserTabNew: (url?: string) => Promise<{ success: boolean; tabId: string }>;
      browserTabList: () => Promise<{ success: boolean; tabs: BrowserTabInfo[] }>;
      browserTabSwitch: (tabId: string) => Promise<{ success: boolean }>;
      browserTabClose: (tabId: string) => Promise<{ success: boolean }>;

      // Browser events
      onBrowserNavigated: (callback: (url: string) => void) => () => void;
      onBrowserTitle: (callback: (title: string) => void) => () => void;
      onBrowserLoading: (callback: (loading: boolean) => void) => () => void;
      onBrowserError: (callback: (error: string) => void) => () => void;
      onTabsUpdated: (callback: (tabs: BrowserTabInfo[]) => void) => () => void;

      // Settings
      getSettings: () => Promise<{
        anthropic_api_key: string;
        serper_api_key: string;
        brave_api_key: string;
        serpapi_api_key: string;
        bing_api_key: string;
        search_backend: string;
      }>;
      setSetting: (key: string, value: string) => Promise<{ success: boolean }>;

      // Window
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
    };
  }
}

// ============================================================================
// STATE
// ============================================================================

let isStreaming = false;
let currentConversationId: string | null = null;
let streamingContainer: HTMLDivElement | null = null;
let currentTextChunk: HTMLSpanElement | null = null;
let fullStreamBuffer = ''; // For final markdown rendering
let thinkingEl: HTMLDivElement | null = null;
let thinkingTextEl: HTMLSpanElement | null = null;
let currentThought = '';
let thinkingVisible = false;
let thinkingTransitionToken = 0;
let thinkingHideTimer: number | null = null;
let thinkingSwapTimer: number | null = null;
let researchContainer: HTMLDivElement | null = null;
let knownActions: Map<
  string,
  {
    source: string;
    status: string;
    preview?: string;
    executionStatus?: string;
    reason?: string;
    producedSources?: ResearchSourcePreview[];
  }
> = new Map();
let sourceTabs: Map<string, ResearchSourcePreview> = new Map();
let activeSourceId: string | null = null;
let frequentSites: FrequentSiteEntry[] = [];
let shouldAutoFollowOutput = true;

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 50;
const SCROLL_CHEVRON_EDGE_THRESHOLD_PX = 50;
const SCROLL_CHEVRON_IDLE_TIMEOUT_MS = 2200;

const MANUAL_TAB_PREFIX = 'manual-tab-';
const DEFAULT_TAB_ID = `${MANUAL_TAB_PREFIX}google-home`;
const DEFAULT_TAB_URL = 'https://www.google.com';
const DEFAULT_TAB_TITLE = 'Google';
const EMPTY_TAB_URL = '';
const EMPTY_TAB_TITLE = 'New Tab';
const DEFAULT_CHAT_TAB_TITLE = 'New Chat';
const CHAT_TAB_TITLE_MAX = 25;

type ChatConversation = {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string }>;
};

type ChatTab = {
  id: string;
  title: string;
};

let openChatTabs: ChatTab[] = [];
let activeChatTabId: string | null = null;
const chatScrollPositions = new Map<string, number>();
let chatSwitchToken = 0;

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const outputEl = document.getElementById('output')!;
const chatTabsContainer = document.getElementById('chat-tabs') as HTMLDivElement;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;

const conversationsToggle = document.getElementById('conversations-toggle')!;
const conversationsDropdown = document.getElementById('conversations-dropdown')!;
const conversationsList = document.getElementById('conversations-list')!;
const newConversationBtn = document.getElementById('new-conversation-btn')!;

const settingsToggle = document.getElementById('settings-toggle')!;
const settingsModal = document.getElementById('settings-modal')!;
const settingsClose = document.getElementById('settings-close')!;
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
const serperKeyInput = document.getElementById('serper-key') as HTMLInputElement;
const braveKeyInput = document.getElementById('brave-key') as HTMLInputElement;
const serpapiKeyInput = document.getElementById('serpapi-key') as HTMLInputElement;
const bingKeyInput = document.getElementById('bing-key') as HTMLInputElement;
const searchBackendSelect = document.getElementById('search-backend-select') as HTMLSelectElement;
const saveSettingsBtn = document.getElementById('save-settings')!;

const browserToggle = document.getElementById('browser-toggle')!;
const panelContainer = document.getElementById('panel-container')!;
const browserUrlInput = document.getElementById('browser-url') as HTMLInputElement;
const browserGoBtn = document.getElementById('browser-go')!;
const browserBackBtn = document.getElementById('browser-back')!;
const browserForwardBtn = document.getElementById('browser-forward')!;
const browserReloadBtn = document.getElementById('browser-reload')!;
const sourceTabsContainer = document.getElementById('source-tabs') as HTMLDivElement;
const frequentSitesContainer = document.getElementById('frequent-sites') as HTMLDivElement | null;

// Panel window controls
const panelMinBtn = document.getElementById('panel-min-btn');
const panelMaxBtn = document.getElementById('panel-max-btn');
const panelCloseBtn = document.getElementById('panel-close-btn');

function createScrollChevron(direction: 'up' | 'down'): HTMLButtonElement {
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = `scroll-chevron scroll-chevron-${direction}`;
  chevron.setAttribute('aria-label', `Scroll ${direction}`);
  chevron.innerHTML = direction === 'up'
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
    shouldAutoFollowOutput = false;
    scrollContainer.scrollBy({
      top: -scrollContainer.clientHeight,
      behavior: 'smooth',
    });
  });
  upChevron.addEventListener('dblclick', () => {
    markChevronInteractionActive();
    shouldAutoFollowOutput = false;
    scrollContainer.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  });

  downChevron.addEventListener('click', () => {
    markChevronInteractionActive();
    shouldAutoFollowOutput = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth',
    });
  });
  downChevron.addEventListener('dblclick', () => {
    markChevronInteractionActive();
    shouldAutoFollowOutput = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth',
    });
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

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  const chatScrollRegion = outputEl.parentElement;
  if (chatScrollRegion) {
    setupScrollChevrons(outputEl, chatScrollRegion as HTMLElement);
  }
  setupEventListeners();
  setupChatListeners();
  setupThinkingIndicator();
  setupBrowserListeners();

  // Sync browser bounds immediately — must happen before any awaits
  // so the BrowserView gets positioned even if Playwright is slow to connect.
  requestAnimationFrame(() => syncBrowserBounds());

  await ensureLandingTab();
  await initializeChatTabs();
  await hydrateFrequentSites();
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  // Send message
  sendBtn.addEventListener('click', sendMessage);
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Cancel
  cancelBtn.addEventListener('click', () => {
    window.api.stopGeneration();
    hideThinking();
    setStreaming(false);
  });

  // Conversations dropdown
  conversationsToggle.addEventListener('click', () => {
    conversationsDropdown.classList.toggle('hidden');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!conversationsDropdown.contains(e.target as Node) && e.target !== conversationsToggle) {
      conversationsDropdown.classList.add('hidden');
    }
  });

  // New conversation
  newConversationBtn.addEventListener('click', async () => {
    await createNewChatTab();
    await loadConversations();
    conversationsDropdown.classList.add('hidden');
  });

  // Chat tab horizontal wheel scrolling
  chatTabsContainer?.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      chatTabsContainer.scrollLeft += event.deltaY;
    },
    { passive: false }
  );

  // Settings
  settingsToggle.addEventListener('click', async () => {
    settingsModal.classList.remove('hidden');
    try {
      const settings = await window.api.getSettings();
      searchBackendSelect.value = settings.search_backend || 'serper';
    } catch { /* ignore */ }
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  settingsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const keyPairs: [HTMLInputElement, string][] = [
      [apiKeyInput, 'anthropic_api_key'],
      [serperKeyInput, 'serper_api_key'],
      [braveKeyInput, 'brave_api_key'],
      [serpapiKeyInput, 'serpapi_api_key'],
      [bingKeyInput, 'bing_api_key'],
    ];
    for (const [input, storeKey] of keyPairs) {
      const val = input.value.trim();
      if (val) {
        await window.api.setSetting(storeKey, val);
        input.value = '';
      }
    }
    await window.api.setSetting('search_backend', searchBackendSelect.value);
    settingsModal.classList.add('hidden');
  });

  // Browser panel toggle
  browserToggle.addEventListener('click', () => {
    panelContainer.classList.toggle('hidden');
    if (!panelContainer.classList.contains('hidden')) {
      syncBrowserBounds();
    }
  });

  // Browser controls
  browserGoBtn.addEventListener('click', navigateBrowser);
  browserUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      navigateBrowser();
    }
  });

  browserBackBtn.addEventListener('click', () => window.api.browserBack());
  browserForwardBtn.addEventListener('click', () => window.api.browserForward());
  browserReloadBtn.addEventListener('click', () => window.api.browserRefresh());

  // Panel window controls
  panelMinBtn?.addEventListener('click', () => window.api.windowMinimize());
  panelMaxBtn?.addEventListener('click', () => window.api.windowMaximize());
  panelCloseBtn?.addEventListener('click', () => window.api.windowClose());

  // Window controls (chat header)
  document.getElementById('min-btn')?.addEventListener('click', () => window.api.windowMinimize());
  document.getElementById('max-btn')?.addEventListener('click', () => window.api.windowMaximize());
  document.getElementById('close-btn')?.addEventListener('click', () => window.api.windowClose());

  // Sync browser bounds on resize
  window.addEventListener('resize', syncBrowserBounds);

  // Also observe height changes in the panel header area (e.g. controls wrapping)
  // so the BrowserView repositions when the toolbar grows/shrinks.
  const browserControlsEl = panelContainer.querySelector('.browser-controls');
  const tabStripEl = panelContainer.querySelector('.tab-strip');
  if (browserControlsEl || tabStripEl) {
    const headerObserver = new ResizeObserver(() => syncBrowserBounds());
    if (browserControlsEl) headerObserver.observe(browserControlsEl);
    if (tabStripEl) headerObserver.observe(tabStripEl);
  }

  outputEl.addEventListener('click', handleSourceLinkClick);
  outputEl.addEventListener('click', handleCodeCopyClick);
  outputEl.addEventListener('scroll', updateOutputAutoFollowState, { passive: true });
  outputEl.addEventListener('wheel', handleOutputWheel, { passive: true });
}

// ============================================================================
// CHAT LISTENERS
// ============================================================================

function setupChatListeners() {
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

  window.api.onResearchProgress((progress) => {
    renderResearchProgress(progress);
  });

  window.api.onLiveHtmlStart(() => {
    // Ensure browser panel is visible so user can watch the page build
    if (panelContainer.classList.contains('hidden')) {
      panelContainer.classList.remove('hidden');
      syncBrowserBounds();
    }
  });

  window.api.onLiveHtmlEnd(() => {
    // Page is complete — nothing special needed, thinking indicator
    // will be cleared when the stream ends
  });
}

// ============================================================================
// THINKING INDICATOR
// ============================================================================

function setupThinkingIndicator() {
  if (thinkingEl) return;

  const inputSection = document.querySelector('.input-section');
  if (!inputSection || !inputSection.parentElement) return;

  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-indicator';

  thinkingTextEl = document.createElement('span');
  thinkingTextEl.className = 'thinking-text';
  thinkingEl.appendChild(thinkingTextEl);

  inputSection.parentElement.insertBefore(thinkingEl, inputSection);

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

function showThought(thought: string) {
  if (!thinkingEl || !thinkingTextEl) return;
  if (thinkingVisible && thought === currentThought) return;

  if (thinkingHideTimer !== null) {
    window.clearTimeout(thinkingHideTimer);
    thinkingHideTimer = null;
  }

  if (thinkingSwapTimer !== null) {
    window.clearTimeout(thinkingSwapTimer);
    thinkingSwapTimer = null;
  }

  const transitionToken = ++thinkingTransitionToken;
  if (!thinkingVisible) {
    thinkingTextEl.textContent = thought;
    thinkingEl.classList.add('visible');
    thinkingTextEl.classList.add('visible');
  } else {
    thinkingTextEl.classList.remove('visible');
    thinkingSwapTimer = window.setTimeout(() => {
      if (!thinkingTextEl || transitionToken !== thinkingTransitionToken) return;
      thinkingTextEl.textContent = thought;
      thinkingTextEl.classList.add('visible');
    }, 150);
  }

  currentThought = thought;
  thinkingVisible = true;
}

function hideThinking() {
  if (!thinkingEl || !thinkingTextEl) return;

  ++thinkingTransitionToken;

  if (thinkingSwapTimer !== null) {
    window.clearTimeout(thinkingSwapTimer);
    thinkingSwapTimer = null;
  }

  if (thinkingHideTimer !== null) {
    window.clearTimeout(thinkingHideTimer);
    thinkingHideTimer = null;
  }

  thinkingVisible = false;
  currentThought = '';
  thinkingTextEl.classList.remove('visible');
  thinkingEl.classList.remove('visible');

  thinkingHideTimer = window.setTimeout(() => {
    if (!thinkingTextEl || thinkingVisible) return;
    thinkingTextEl.textContent = '';
  }, 300);
}

// ============================================================================
// BROWSER LISTENERS
// ============================================================================

function setupBrowserListeners() {
  window.api.onBrowserNavigated((url) => {
    browserUrlInput.value = url;
  });

  window.api.onBrowserTitle((title) => {
    if (activeSourceId && sourceTabs.has(activeSourceId)) {
      const tab = sourceTabs.get(activeSourceId)!;
      tab.title = title || tab.title;
      renderSourceTabs();
    }
  });

  window.api.onBrowserLoading((loading) => {
    browserReloadBtn.textContent = loading ? '⏹' : '↻';
  });

  window.api.onBrowserError((error) => {
    console.error('[Browser]', error);
  });

  window.api.onTabsUpdated((tabs) => {
    applyTabsUpdate(tabs);
  });

  void window.api.browserTabList().then((result) => {
    if (result?.success) {
      applyTabsUpdate(result.tabs || []);
    }
  });
}

function applyTabsUpdate(tabs: BrowserTabInfo[]) {
  const nextTabs = new Map<string, ResearchSourcePreview>();
  let nextActive: string | null = null;

  for (const tab of tabs) {
    const host = !tab.url || tab.url === 'about:blank' ? '' : getHostFromUrl(tab.url);
    nextTabs.set(tab.id, {
      sourceId: tab.id,
      title: tab.title || host || EMPTY_TAB_TITLE,
      host,
      url: tab.url || '',
      sourceKind: 'serp',
      reason: '',
    });
    if (tab.active) {
      nextActive = tab.id;
      if (tab.url) {
        browserUrlInput.value = tab.url;
      } else {
        browserUrlInput.value = '';
      }
    }
  }

  sourceTabs = nextTabs;
  activeSourceId = nextActive;
  renderSourceTabs();
}

async function hydrateFrequentSites() {
  const entries = await window.api.getFrequentSites();
  updateFrequentSites(entries);
  window.api.onFrequentSitesUpdate((updated) => updateFrequentSites(updated));
}

function updateFrequentSites(entries: FrequentSiteEntry[]) {
  frequentSites = entries ?? [];
  renderFrequentSites();
}

function renderFrequentSites() {
  if (!frequentSitesContainer) return;
  frequentSitesContainer.innerHTML = '';
  const toRender = frequentSites.slice(0, 8);
  for (const entry of toRender) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'frequent-site-btn';
    button.textContent = entry.host;
    const title = entry.title ? `${entry.title} — ${entry.url}` : entry.url;
    button.title = title;
    button.addEventListener('click', () => navigateToFrequentSite(entry));
    frequentSitesContainer.appendChild(button);
  }
}

function renderResearchProgress(progress: ResearchProgress) {
  if (!researchContainer) {
    researchContainer = document.createElement('div');
    researchContainer.className = 'research-progress';
    outputEl.appendChild(researchContainer);
    knownActions = new Map();
    scrollToBottom(false);
  }

  if (progress.phase === 'intake') {
    clearResearchTabs();
    activeSourceId = null;
    void ensureLandingTab();
  }

  if (progress.sources && progress.sources.length > 0) {
    handleResearchSources(progress.sources);
  }

  if (progress.activeSourceId) {
    ensureSourceTabForSourceId(progress.activeSourceId);
  } else if (progress.activeSourceUrl) {
    void ensureSourceTabForUrl(progress.activeSourceUrl);
  }

  if (progress.actions) {
    for (const action of progress.actions) {
      knownActions.set(action.id, {
        source: action.source,
        status: action.status,
        preview: action.preview,
        executionStatus: action.executionStatus,
        reason: action.reason,
        producedSources: action.producedSources,
      });
    }
  }

  const label: Record<string, string> = {
    intake: '◇ Planning...',
    executing: '◈ Searching...',
    checkpoint: '◆ Reviewing...',
    synthesizing: '◈ Writing...',
    done: '● Done',
  };

  let html = `<div class="rp-phase">${escapeHtml(label[progress.phase] || progress.message)}</div>`;

  if (knownActions.size > 0) {
    // data preserved for future UI/insights; no display needed right now
  }
  if (progress.gateStatus) {
    const statusClass = progress.gateStatus.ok ? 'rp-gate-ok' : 'rp-gate-blocked';
    const statusText = progress.gateStatus.ok
      ? `Gate satisfied: ${progress.gateStatus.eligibleCount} sources across ${progress.gateStatus.hostCount} hosts`
      : `Gate blocked: ${progress.gateStatus.reasons.join('; ')}`;
    html += `<div class="rp-gate ${statusClass}">
      <span class="rp-gate-label">${escapeHtml(statusText)}</span>
    </div>`;
  }

  if (progress.checkpointNumber) {
    html += `<div class="rp-checkpoint">◆ Checkpoint ${progress.checkpointNumber}</div>`;
  }

  researchContainer.innerHTML = html;
  scrollToBottom(false);

  if (progress.phase === 'done' || progress.phase === 'synthesizing') {
    researchContainer = null;
    knownActions = new Map();
  }
}

function handleResearchSources(sources: ResearchSourcePreview[]) {
  if (sources.length === 0) return;
  if (!panelContainer.classList.contains('hidden')) {
    return;
  }
  panelContainer.classList.remove('hidden');
}

function clearResearchTabs() {
  // Tabs are now driven by main process state.
}

async function ensureLandingTab() {
  const listed = await window.api.browserTabList();
  const tabs = listed?.tabs || [];
  if (tabs.length === 0) {
    await window.api.browserTabNew(DEFAULT_TAB_URL);
    return;
  }
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (active?.url && active.url !== 'about:blank') return;
  await window.api.browserNavigate(DEFAULT_TAB_URL);
}

function handleAddTabClick() {
  void window.api.browserTabNew();
}

function closeSourceTab(sourceId: string) {
  void window.api.browserTabClose(sourceId);
}

function isManualTabId(id: string): boolean {
  return id.startsWith(MANUAL_TAB_PREFIX);
}

function getHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getSimpleDomain(host: string): string {
  // Remove www. prefix
  let domain = host.replace(/^www\./, '');
  // Extract just the domain name (remove TLD like .com, .org, .co.uk, etc.)
  const parts = domain.split('.');
  if (parts.length >= 2) {
    // Handle cases like co.uk, com.au, etc.
    const secondLast = parts[parts.length - 2];
    if (secondLast === 'co' || secondLast === 'com' || secondLast === 'org' || secondLast === 'net') {
      return parts.length > 2 ? parts[parts.length - 3] : parts[0];
    }
    return parts[parts.length - 2];
  }
  return parts[0] || domain;
}

function getFaviconUrl(host: string): string {
  // Use Google's favicon service for reliable favicons
  const cleanHost = host.replace(/^www\./, '');
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(cleanHost)}&sz=32`;
}

function getSourceKindLabel(kind?: string): string {
  switch (kind) {
    case 'official_docs':
      return 'Official';
    case 'repo_canonical':
      return 'Canonical repo';
    case 'repo_noncanonical':
      return 'Repo (non-canonical)';
    case 'content_primary':
      return 'Primary content';
    case 'content_secondary':
      return 'Secondary content';
    case 'forum':
      return 'Forum';
    case 'search_results':
      return 'Search results';
    case 'docs_meta':
      return 'Docs meta';
    case 'serp':
      return 'SERP';
    default:
      return 'Source';
  }
}

function getSourceKindClass(kind?: string): string {
  switch (kind) {
    case 'official_docs':
      return 'kind-official';
    case 'repo_canonical':
      return 'kind-repo-canonical';
    case 'repo_noncanonical':
      return 'kind-repo-noncanonical';
    case 'content_primary':
      return 'kind-content-primary';
    case 'content_secondary':
      return 'kind-content-secondary';
    case 'forum':
      return 'kind-forum';
    default:
      return 'kind-generic';
  }
}

function ensureSourceTabForSourceId(sourceId: string) {
  if (!sourceId) return;
  const tab = sourceTabs.get(sourceId);
  if (tab) {
    setActiveSourceTab(sourceId);
  }
}

function renderSourceTabs() {
  if (!sourceTabsContainer) return;
  if (sourceTabs.size === 0) {
    sourceTabsContainer.innerHTML = '';
    sourceTabsContainer.classList.add('hidden');
    return;
  }

  sourceTabsContainer.classList.remove('hidden');
  sourceTabsContainer.innerHTML = '';

  const tabsArray = Array.from(sourceTabs.values());

  for (const tab of tabsArray) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sourceId = tab.sourceId;
    button.className = `source-tab${tab.sourceId === activeSourceId ? ' active' : ''}`;

    const isEmptyTab = !tab.url && !tab.host;
    if (isEmptyTab) {
      button.innerHTML = `
        <span class="source-tab-favicon-placeholder" style="display:flex;">+</span>
        <span class="source-tab-title">${escapeHtml(EMPTY_TAB_TITLE)}</span>
        <button type="button" class="source-tab-close" title="Close tab">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2" y1="2" x2="8" y2="8"/>
            <line x1="8" y1="2" x2="2" y2="8"/>
          </svg>
        </button>
      `;
    } else {
      const fullHost = tab.host || getHostFromUrl(tab.url || '');
      const displayName = getSimpleDomain(fullHost);
      const faviconUrl = getFaviconUrl(fullHost);
      const firstLetter = displayName.charAt(0).toUpperCase();
      button.innerHTML = `
        <img class="source-tab-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
        <span class="source-tab-favicon-placeholder" style="display:none;">${firstLetter}</span>
        <span class="source-tab-title">${escapeHtml(displayName)}</span>
        <button type="button" class="source-tab-close" title="Close tab">
          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="2" y1="2" x2="8" y2="8"/>
            <line x1="8" y1="2" x2="2" y2="8"/>
          </svg>
        </button>
      `;
    }

    // Handle click on the tab itself (not the close button)
    button.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.source-tab-close')) {
        setActiveSourceTab(tab.sourceId);
      }
    });

    // Handle close button click
    const closeBtn = button.querySelector('.source-tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSourceTab(tab.sourceId);
      });
    }

    sourceTabsContainer.appendChild(button);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add-btn';
  addBtn.title = 'New tab';
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <line x1="7" y1="2" x2="7" y2="12"/>
      <line x1="2" y1="7" x2="12" y2="7"/>
    </svg>
  `;
  addBtn.addEventListener('click', handleAddTabClick);
  sourceTabsContainer.appendChild(addBtn);
}

function setActiveSourceTab(sourceId: string) {
  const tab = sourceTabs.get(sourceId);
  if (!tab) return;

  activeSourceId = sourceId;
  renderSourceTabs();
  void window.api.browserTabSwitch(sourceId);

  if (!tab.url) {
    browserUrlInput.value = '';
    browserUrlInput.focus();
  } else {
    browserUrlInput.value = tab.url;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function ensureSourceTabForUrl(url: string, title?: string) {
  const finalUrl = url.trim();
  const existing = Array.from(sourceTabs.values()).find((source) => source.url === finalUrl);
  if (existing) {
    setActiveSourceTab(existing.sourceId);
    return;
  }

  if (!finalUrl) return;
  await window.api.browserTabNew(finalUrl);
}

function handleCodeCopyClick(event: MouseEvent) {
  const btn = (event.target as HTMLElement).closest('.code-copy-btn') as HTMLButtonElement | null;
  if (!btn) return;
  event.preventDefault();
  const wrapper = btn.closest('.code-block-wrapper');
  const codeEl = wrapper?.querySelector('code');
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }, 1500);
  });
}

function handleSourceLinkClick(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest('a.source-link') as HTMLAnchorElement | null;
  if (!target) return;
  event.preventDefault();
  const url = target.dataset.sourceUrl;
  const title = target.dataset.sourceTitle;
  if (!url) return;
  void ensureSourceTabForUrl(url, title);
}

// ============================================================================
// CHAT FUNCTIONS
// ============================================================================

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isDefaultConversationTitle(title: string): boolean {
  return !title || title === 'New Conversation' || title === DEFAULT_CHAT_TAB_TITLE;
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
  return openChatTabs.findIndex((tab) => tab.id === conversationId);
}

function getChatTabTitle(conversationId: string): string | null {
  const index = getChatTabIndex(conversationId);
  if (index < 0) return null;
  return openChatTabs[index].title;
}

function setChatTabTitle(conversationId: string, nextTitle: string): void {
  const index = getChatTabIndex(conversationId);
  if (index < 0) return;
  openChatTabs[index].title = deriveChatTabTitleFromText(nextTitle);
}

async function persistChatTabState(): Promise<void> {
  await window.api.saveChatTabState({
    tabIds: openChatTabs.map((tab) => tab.id),
    activeId: activeChatTabId,
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

function renderChatTabs() {
  if (!chatTabsContainer) return;
  chatTabsContainer.innerHTML = '';

  for (const tab of openChatTabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.conversationId = tab.id;
    button.className = `source-tab${tab.id === activeChatTabId ? ' active' : ''}`;

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

    chatTabsContainer.appendChild(button);
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
  chatTabsContainer.appendChild(addBtn);
}

function renderConversationMessages(messages: Array<{ role: string; content: string }>) {
  for (const msg of messages) {
    if (msg.role === 'user') {
      appendUserMessage(msg.content, false);
      continue;
    }
    if (msg.role === 'assistant') {
      const wrapper = document.createElement('div');
      wrapper.className = 'assistant-content';
      wrapper.innerHTML = renderMarkdown(msg.content);
      outputEl.appendChild(wrapper);
    }
  }
}

async function switchChatTab(
  conversationId: string,
  options: { persistState?: boolean; restoreScroll?: boolean; clearInput?: boolean } = {}
): Promise<void> {
  if (isStreaming && conversationId !== activeChatTabId) return;

  const {
    persistState = true,
    restoreScroll = true,
    clearInput = true,
  } = options;

  if (activeChatTabId) {
    chatScrollPositions.set(activeChatTabId, outputEl.scrollTop);
  }

  const switchToken = ++chatSwitchToken;
  const conversation = await window.api.loadConversation(conversationId);
  if (!conversation) {
    return;
  }
  if (switchToken !== chatSwitchToken) {
    return;
  }

  currentConversationId = conversationId;
  activeChatTabId = conversationId;
  setChatTabTitle(conversationId, deriveChatTabTitle(conversation as ChatConversation));
  renderChatTabs();

  outputEl.innerHTML = '';
  renderConversationMessages(conversation.messages);

  if (restoreScroll) {
    const savedPosition = chatScrollPositions.get(conversationId);
    if (typeof savedPosition === 'number') {
      outputEl.scrollTop = savedPosition;
    } else {
      scrollToBottom();
    }
  }
  shouldAutoFollowOutput = isOutputNearBottom();

  if (clearInput) {
    promptEl.value = '';
  }

  await loadConversations();
  if (persistState) {
    void persistChatTabState();
  }
}

async function createNewChatTab(): Promise<void> {
  if (isStreaming) return;
  const conversation = await window.api.newConversation();
  openChatTabs.push({
    id: conversation.id,
    title: DEFAULT_CHAT_TAB_TITLE,
  });
  renderChatTabs();
  await switchChatTab(conversation.id, { persistState: false, restoreScroll: true });
  promptEl.focus();
  void persistChatTabState();
}

async function closeChatTab(conversationId: string): Promise<void> {
  if (isStreaming) return;
  const index = getChatTabIndex(conversationId);
  if (index < 0) return;

  const wasActive = activeChatTabId === conversationId;
  openChatTabs.splice(index, 1);
  chatScrollPositions.delete(conversationId);

  if (openChatTabs.length === 0) {
    currentConversationId = null;
    activeChatTabId = null;
    outputEl.innerHTML = '';
    await createNewChatTab();
    return;
  }

  if (wasActive) {
    const nextIndex = Math.min(index, openChatTabs.length - 1);
    const nextId = openChatTabs[nextIndex].id;
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
    openChatTabs.push({
      id: conversation.id,
      title: deriveChatTabTitle(conversation as ChatConversation),
    });
    renderChatTabs();
  }
  await switchChatTab(conversationId);
}

async function initializeChatTabs() {
  const [savedState, conversations] = await Promise.all([
    window.api.getChatTabState(),
    window.api.listConversations(),
  ]);

  const knownConversationIds = new Set(conversations.map((conv) => conv.id));
  let tabIds = (savedState?.tabIds || []).filter((id) => knownConversationIds.has(id));

  if (tabIds.length === 0) {
    if (conversations.length > 0) {
      tabIds = [conversations[0].id];
    } else {
      const conversation = await window.api.newConversation();
      tabIds = [conversation.id];
    }
  }

  const loaded = await Promise.all(tabIds.map((id) => window.api.loadConversation(id)));
  openChatTabs = loaded
    .map((conversation, index) => {
      if (!conversation) return null;
      return {
        id: tabIds[index],
        title: deriveChatTabTitle(conversation as ChatConversation),
      };
    })
    .filter((tab): tab is ChatTab => tab !== null);

  if (openChatTabs.length === 0) {
    const fallback = await window.api.newConversation();
    openChatTabs = [{ id: fallback.id, title: DEFAULT_CHAT_TAB_TITLE }];
  }

  const openTabIds = new Set(openChatTabs.map((tab) => tab.id));
  const preferredActiveId = savedState?.activeId && openTabIds.has(savedState.activeId)
    ? savedState.activeId
    : openChatTabs[openChatTabs.length - 1].id;

  renderChatTabs();
  await switchChatTab(preferredActiveId, { persistState: false, restoreScroll: true, clearInput: true });
  await persistChatTabState();
}

async function sendMessage() {
  const content = promptEl.value.trim();
  if (!content || isStreaming) return;

  if (!activeChatTabId) {
    await createNewChatTab();
  }

  if (!currentConversationId) {
    currentConversationId = activeChatTabId;
  }
  if (!currentConversationId) return;

  appendUserMessage(content);
  promptEl.value = '';

  const activeTitle = getChatTabTitle(currentConversationId);
  if (activeTitle === DEFAULT_CHAT_TAB_TITLE) {
    setChatTabTitle(currentConversationId, content);
    renderChatTabs();
    void persistChatTabState();
  }

  setStreaming(true);
  fullStreamBuffer = '';

  const result = await window.api.sendMessage(currentConversationId, content);
  if (result?.conversationId) {
    if (result.conversationId !== currentConversationId) {
      const oldIndex = getChatTabIndex(currentConversationId);
      if (oldIndex >= 0) {
        openChatTabs[oldIndex].id = result.conversationId;
      }
    }
    currentConversationId = result.conversationId;
    activeChatTabId = result.conversationId;
  }

  await refreshChatTabTitle(currentConversationId);
  await loadConversations();
}

function setStreaming(streaming: boolean) {
  isStreaming = streaming;
  sendBtn.disabled = streaming;
  cancelBtn.disabled = !streaming;
  promptEl.disabled = streaming;
}

function appendUserMessage(content: string, shouldScroll: boolean = true) {
  const wrapper = document.createElement('div');
  wrapper.className = 'user-message';
  wrapper.innerHTML = `
    <div class="user-message-label">You</div>
    <div class="user-message-text">${escapeHtml(content)}</div>
  `;
  outputEl.appendChild(wrapper);
  if (shouldScroll) {
    scrollToBottom();
  }
}

function startAssistantMessage() {
  streamingContainer = document.createElement('div');
  streamingContainer.className = 'assistant-content streaming';
  outputEl.appendChild(streamingContainer);
  currentTextChunk = null;
}

function appendStreamText(text: string) {
  // Start container if needed
  if (!streamingContainer) {
    startAssistantMessage();
  }

  // Accumulate for final markdown render
  fullStreamBuffer += text;

  // If no current text chunk, create one
  if (!currentTextChunk) {
    currentTextChunk = document.createElement('span');
    currentTextChunk.className = 'text-chunk';
    streamingContainer!.appendChild(currentTextChunk);
  }

  // Append text to current chunk
  currentTextChunk.textContent += text;
}

function finalizeAssistantMessage(fullText: string) {
  if (!streamingContainer) return;

  streamingContainer.classList.remove('streaming');
  const finalText = fullText || fullStreamBuffer;
  streamingContainer.innerHTML = `<div class="markdown-content">${renderMarkdown(finalText)}</div>`;

  currentTextChunk = null;
  streamingContainer = null;
  scrollToBottom(false);
}

function appendError(message: string) {
  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  outputEl.appendChild(errorEl);
  scrollToBottom(false);
}

function scrollToBottom(force: boolean = true) {
  if (!force && !shouldAutoFollowOutput) return;
  outputEl.scrollTop = outputEl.scrollHeight;
  if (force) shouldAutoFollowOutput = true;
}

function isOutputNearBottom(thresholdPx: number = AUTO_SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  const distanceFromBottom = outputEl.scrollHeight - (outputEl.scrollTop + outputEl.clientHeight);
  return distanceFromBottom <= thresholdPx;
}

function updateOutputAutoFollowState() {
  shouldAutoFollowOutput = isOutputNearBottom();
}

function handleOutputWheel(event: WheelEvent) {
  // If user scrolls upward during streaming, stop auto-follow immediately.
  if (event.deltaY < 0) {
    shouldAutoFollowOutput = false;
  }
}

// ============================================================================
// CONVERSATIONS
// ============================================================================

async function loadConversations() {
  const conversations = await window.api.listConversations();
  conversationsList.innerHTML = '';

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.id === activeChatTabId ? 'active' : ''}`;
    item.innerHTML = `<span class="conversation-item-title">${escapeHtml(conv.title)}</span>`;
    item.addEventListener('click', async () => {
      await openConversationInChatTab(conv.id);
      conversationsDropdown.classList.add('hidden');
    });
    conversationsList.appendChild(item);
  }
}

async function loadConversation(id: string) {
  await openConversationInChatTab(id);
}

// ============================================================================
// BROWSER
// ============================================================================

async function navigateToFrequentSite(entry: FrequentSiteEntry) {
  browserUrlInput.value = entry.url;
  await window.api.browserNavigate(entry.url);
}

async function navigateBrowser() {
  let url = browserUrlInput.value.trim();
  if (!url) return;

  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  await window.api.browserNavigate(url);
}

function syncBrowserBounds() {
  if (panelContainer.classList.contains('hidden')) {
    console.log('[Renderer] syncBrowserBounds: panel is hidden, skipping');
    return;
  }

  // Anchor BrowserView to the actual viewport host area to avoid clipping from
  // accumulated header math and fractional pixel rounding.
  const viewportHost = panelContainer.querySelector('.browser-placeholder') as HTMLElement | null;
  const rect = (viewportHost ?? panelContainer).getBoundingClientRect();

  const bounds = {
    x: Math.floor(rect.left),
    y: Math.floor(rect.top),
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
  console.log('[Renderer] syncBrowserBounds:', JSON.stringify(bounds));
  window.api.browserSetBounds(bounds);
}

// ============================================================================
// UTILITIES
// ============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text: string): string {
  // Simple markdown rendering
  let html = escapeHtml(text)
    // Code blocks — wrapped in a container with a copy button
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<div class="code-block-wrapper"><button type="button" class="code-copy-btn" title="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><pre><code>$2</code></pre></div>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  html = html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    let display = match;
    let host = match;
    try {
      const parsed = new URL(match);
      host = parsed.hostname;
      let rest = parsed.pathname.replace(/\/$/, '');
      if (rest.length > 20) {
        rest = rest.slice(0, 20) + '…';
      }
      display = `${host}${rest}${parsed.search ? parsed.search : ''}`;
    } catch {
      /* ignore */
    }

    return `<a href="${match}" class="source-link" data-source-url="${match}" data-source-title="${escapeHtml(display)}" title="${escapeHtml(match)}" target="_blank" rel="noreferrer">${escapeHtml(
      display
    )}</a>`;
  });

  return `<p>${html}</p>`;
}

// ============================================================================
// START
// ============================================================================

console.log('[Renderer] Starting...');
console.log('[Renderer] window.api:', window.api);

if (!window.api) {
  console.error('[Renderer] ERROR: window.api is not defined! Preload script may not have loaded.');
  document.body.innerHTML = '<h1 style="color: red; padding: 20px;">Error: Preload script not loaded. Check console.</h1>';
} else {
  console.log('[Renderer] API available, initializing...');
  init();
}
