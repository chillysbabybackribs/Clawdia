import type { BrowserTabInfo, ResearchSourcePreview, ResearchProgress, ImageAttachment, DocumentAttachment, DocumentMeta } from '../shared/types';
import { CLAUDE_MODELS } from '../shared/models';
import { showArcade, hideArcade, resetArcadeDismissed } from './arcade/menu';

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  interface Window {
    api: {
      // Chat
      sendMessage: (conversationId: string, content: string, images?: ImageAttachment[], documents?: DocumentAttachment[]) => Promise<{ conversationId?: string; error?: string }>;
      stopGeneration: () => Promise<{ stopped: boolean }>;
      newConversation: () => Promise<{ id: string; title: string }>;
      listConversations: () => Promise<Array<{ id: string; title: string; updatedAt: string }>>;
      loadConversation: (id: string) => Promise<{ id: string; title: string; messages: Array<{ role: string; content: string; images?: ImageAttachment[]; documents?: DocumentMeta[] }> } | undefined>;
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

      // Browser data management
      browserHistoryGet: () => Promise<{ success: boolean; history: Array<{ id: string; url: string; title: string; timestamp: number }> }>;
      browserHistoryClear: () => Promise<{ success: boolean }>;
      browserCookiesClear: () => Promise<{ success: boolean }>;
      browserClearAll: () => Promise<{ success: boolean }>;

      // Browser events
      onBrowserNavigated: (callback: (url: string) => void) => () => void;
      onBrowserTitle: (callback: (title: string) => void) => () => void;
      onBrowserLoading: (callback: (loading: boolean) => void) => () => void;
      onBrowserError: (callback: (error: string) => void) => () => void;
      onTabsUpdated: (callback: (tabs: BrowserTabInfo[]) => void) => () => void;

      // Settings
      getApiKey: () => Promise<string>;
      setApiKey: (key: string) => Promise<{ success: boolean }>;
      hasCompletedSetup: () => Promise<boolean>;
      clearApiKey: () => Promise<{ success: boolean }>;
      validateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      getSettings: () => Promise<{
        anthropic_api_key: string;
        anthropic_key_masked?: string;
        has_completed_setup?: boolean;
        selected_model?: string;
        serper_api_key: string;
        brave_api_key: string;
        serpapi_api_key: string;
        bing_api_key: string;
        search_backend: string;
      }>;
      setSetting: (key: string, value: string | boolean) => Promise<{ success: boolean }>;
      getSelectedModel: () => Promise<string>;
      setSelectedModel: (model: string) => Promise<{ success: boolean }>;
      validateApiKeyWithModel: (key: string, model: string) => Promise<{ valid: boolean; error?: string }>;

      // Window
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      clipboardWriteText: (text: string) => Promise<{ success: boolean }>;

      // Documents
      extractDocument: (data: { buffer: number[]; filename: string; mimeType: string }) => Promise<{ success: boolean; text?: string; pageCount?: number; sheetNames?: string[]; truncated?: boolean; error?: string }>;
      saveDocument: (sourcePath: string, suggestedName: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      openDocumentFolder: (filePath: string) => Promise<{ success: boolean }>;
      onDocumentCreated: (callback: (data: { filePath: string; filename: string; sizeBytes: number; format: string }) => void) => () => void;
    };
    clawdia: Window['api'];
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
let shouldAutoFollowOutput = true;
const copyNoteHideTimers = new WeakMap<HTMLElement, number>();
const copyButtonStateTimers = new WeakMap<HTMLButtonElement, number>();

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 50;
const SCROLL_CHEVRON_EDGE_THRESHOLD_PX = 50;
const SCROLL_CHEVRON_IDLE_TIMEOUT_MS = 2200;
const ADDRESS_HISTORY_STORAGE_KEY = 'clawdia.browser.address-history.v1';
const ADDRESS_HISTORY_MAX_ITEMS = 120;
const ADDRESS_HISTORY_VISIBLE_SUGGESTIONS = 8;

const MANUAL_TAB_PREFIX = 'manual-tab-';
const DEFAULT_TAB_ID = `${MANUAL_TAB_PREFIX}google-home`;
const DEFAULT_TAB_URL = 'https://www.google.com';
const DEFAULT_TAB_TITLE = 'Google';
const EMPTY_TAB_URL = '';
const EMPTY_TAB_TITLE = 'New Tab';
const DEFAULT_CHAT_TAB_TITLE = 'New Chat';
const CHAT_TAB_TITLE_MAX = 25;
const COPY_NOTE_DURATION_MS = 900;
const COPY_BUTTON_SUCCESS_DURATION_MS = 700;
const COPY_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ADDRESS_BAR_TRACKING_QUERY_PARAMS = new Set([
  'aqs',
  'dclid',
  'ei',
  'fbclid',
  'gclid',
  'gs_lcrp',
  'iflsig',
  'igshid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'msclkid',
  'no_sw_cr',
  'oq',
  'ref',
  'ref_src',
  'sca_esv',
  'si',
  'sourceid',
  'uact',
  'ved',
  'zx',
]);

type ChatConversation = {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; images?: ImageAttachment[]; documents?: DocumentMeta[] }>;
};

type ChatTab = {
  id: string;
  title: string;
};

let openChatTabs: ChatTab[] = [];
let activeChatTabId: string | null = null;
const chatScrollPositions = new Map<string, number>();
let chatSwitchToken = 0;
let hasInitializedChatShell = false;
let isSetupMode = false;
let isValidatingSetupKey = false;
let currentSelectedModel = 'claude-sonnet-4-20250514';

// Image attachment state
interface PendingImage {
  id: string;
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  thumbnailUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_IMAGE_DIMENSION = 4000;
const VALID_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'csv', 'json', 'html', 'htm',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'php', 'swift', 'kt', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'r', 'lua', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'dockerfile', 'makefile', 'cmake', 'gitignore', 'env',
]);

let pendingAttachments: PendingImage[] = [];

interface PendingDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractionStatus: 'pending' | 'extracting' | 'done' | 'error';
  extractedText?: string;
  pageCount?: number;
  sheetNames?: string[];
  truncated?: boolean;
  errorMessage?: string;
}

let pendingDocuments: PendingDocument[] = [];

const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com';

let browserAddressHistory: string[] = [];
let visibleAddressSuggestions: string[] = [];
let highlightedAddressSuggestionIndex = -1;

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const outputEl = document.getElementById('output')!;
const chatTabsContainer = document.getElementById('chat-tabs') as HTMLDivElement;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const chatAppShell = document.getElementById('chat-app-shell') as HTMLDivElement;
const setupView = document.getElementById('setup-view') as HTMLDivElement;
const setupApiKeyInput = document.getElementById('setup-api-key-input') as HTMLInputElement;
const setupToggleVisibilityBtn = document.getElementById('setup-toggle-visibility') as HTMLButtonElement;
const setupSaveKeyBtn = document.getElementById('setup-save-key-btn') as HTMLButtonElement;
const setupSaveKeyText = document.getElementById('setup-save-key-text') as HTMLSpanElement;
const setupSaveKeySpinner = document.getElementById('setup-save-key-spinner') as HTMLSpanElement;
const setupSaveKeyCheck = document.getElementById('setup-save-key-check') as HTMLSpanElement;
const setupErrorEl = document.getElementById('setup-error') as HTMLParagraphElement;
const setupGetKeyLinkBtn = document.getElementById('setup-get-key-link') as HTMLButtonElement;
const setupArcadeBtn = document.getElementById('setup-arcade-btn') as HTMLButtonElement;
const setupArcadeHost = document.getElementById('setup-arcade-host') as HTMLDivElement;
const setupArcadeOutput = document.getElementById('setup-arcade-output') as HTMLDivElement;

const conversationsToggle = document.getElementById('conversations-toggle')!;
const conversationsDropdown = document.getElementById('conversations-dropdown')!;
const conversationsList = document.getElementById('conversations-list')!;
const newConversationBtn = document.getElementById('new-conversation-btn')!;

const settingsToggle = document.getElementById('settings-toggle')!;
const settingsModal = document.getElementById('settings-modal')!;
const settingsClose = document.getElementById('settings-close')!;
const settingsApiKeyMasked = document.getElementById('settings-api-key-masked') as HTMLDivElement;
const changeApiKeyBtn = document.getElementById('change-api-key-btn') as HTMLButtonElement;
const removeApiKeyBtn = document.getElementById('remove-api-key-btn') as HTMLButtonElement;
const changeApiKeyForm = document.getElementById('change-api-key-form') as HTMLDivElement;
const changeApiKeyInput = document.getElementById('change-api-key-input') as HTMLInputElement;
const changeApiKeyVisibilityBtn = document.getElementById('change-api-key-visibility') as HTMLButtonElement;
const saveChangedApiKeyBtn = document.getElementById('save-changed-api-key-btn') as HTMLButtonElement;
const cancelChangeApiKeyBtn = document.getElementById('cancel-change-api-key-btn') as HTMLButtonElement;
const changeApiKeyErrorEl = document.getElementById('change-api-key-error') as HTMLParagraphElement;
const serperKeyInput = document.getElementById('serper-key') as HTMLInputElement;
const braveKeyInput = document.getElementById('brave-key') as HTMLInputElement;
const serpapiKeyInput = document.getElementById('serpapi-key') as HTMLInputElement;
const bingKeyInput = document.getElementById('bing-key') as HTMLInputElement;
const searchBackendSelect = document.getElementById('search-backend-select') as HTMLSelectElement;
const saveSettingsBtn = document.getElementById('save-settings')!;
const settingsModelSelect = document.getElementById('settings-model-select') as HTMLSelectElement;
const setupModelSelect = document.getElementById('setup-model-select') as HTMLSelectElement;
const modelPickerBtn = document.getElementById('model-picker-btn') as HTMLButtonElement;
const modelPickerLabel = document.getElementById('model-picker-label') as HTMLSpanElement;
const modelPickerPopup = document.getElementById('model-picker-popup') as HTMLDivElement;
const modelPickerList = document.getElementById('model-picker-list') as HTMLDivElement;

const attachBtn = document.getElementById('attach-btn') as HTMLButtonElement;
const attachmentBar = document.getElementById('attachment-bar') as HTMLDivElement;
const chatArea = document.querySelector('.chat-area') as HTMLElement;

const browserToggle = document.getElementById('browser-toggle')!;
const panelContainer = document.getElementById('panel-container')!;
const browserUrlInput = document.getElementById('browser-url') as HTMLInputElement;
const browserUrlSuggestions = document.getElementById('browser-url-suggestions') as HTMLDivElement;
const browserGoBtn = document.getElementById('browser-go')!;
const browserBackBtn = document.getElementById('browser-back')!;
const browserForwardBtn = document.getElementById('browser-forward')!;
const browserReloadBtn = document.getElementById('browser-reload')!;
const sourceTabsContainer = document.getElementById('source-tabs') as HTMLDivElement;

// Panel window controls
const panelMinBtn = document.getElementById('panel-min-btn');
const panelMaxBtn = document.getElementById('panel-max-btn');
const panelCloseBtn = document.getElementById('panel-close-btn');

// README panel
const readmeToggle = document.getElementById('readme-toggle') as HTMLButtonElement;
const readmeView = document.getElementById('readme-view') as HTMLDivElement;
const readmeClose = document.getElementById('readme-close') as HTMLButtonElement;

// Browser menu
const browserMenuBtn = document.getElementById('browser-menu-btn') as HTMLButtonElement;
const browserMenuDropdown = document.getElementById('browser-menu-dropdown') as HTMLDivElement;

// Confirmation dialog
const confirmDialog = document.getElementById('confirm-dialog') as HTMLDivElement;
const confirmDialogTitle = document.getElementById('confirm-dialog-title') as HTMLHeadingElement;
const confirmDialogMessage = document.getElementById('confirm-dialog-message') as HTMLParagraphElement;
const confirmDialogCancel = document.getElementById('confirm-dialog-cancel') as HTMLButtonElement;
const confirmDialogConfirm = document.getElementById('confirm-dialog-confirm') as HTMLButtonElement;

// ============================================================================
// ARCADE EMPTY STATE
// ============================================================================

function updateEmptyState(): void {
  if (isSetupMode) return;
  const hasMessages = outputEl.children.length > 0;
  if (hasMessages) {
    hideArcade();
  } else {
    showArcade(outputEl);
  }
}

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

function setVisibilityToggleState(button: HTMLButtonElement, visible: boolean): void {
  const eye = button.querySelector('.icon-eye');
  const eyeOff = button.querySelector('.icon-eye-off');
  eye?.classList.toggle('hidden', visible);
  eyeOff?.classList.toggle('hidden', !visible);
  button.title = visible ? 'Hide API key' : 'Show API key';
  button.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
}

function togglePasswordInputVisibility(input: HTMLInputElement, button: HTMLButtonElement): void {
  const visible = input.type !== 'password';
  input.type = visible ? 'password' : 'text';
  setVisibilityToggleState(button, !visible);
}

function setSetupValidationState(options: { loading: boolean; success: boolean; text: string }): void {
  setupSaveKeyBtn.disabled = options.loading;
  setupSaveKeyText.textContent = options.text;
  setupSaveKeySpinner.classList.toggle('hidden', !options.loading);
  setupSaveKeyCheck.classList.toggle('hidden', !options.success);
  setupSaveKeyBtn.classList.toggle('success', options.success);
}

function setSetupError(message: string | null): void {
  if (!message) {
    setupErrorEl.classList.add('hidden');
    setupErrorEl.textContent = '';
    return;
  }
  setupErrorEl.textContent = message;
  setupErrorEl.classList.remove('hidden');
}

function setChangeKeyError(message: string | null): void {
  if (!message) {
    changeApiKeyErrorEl.classList.add('hidden');
    changeApiKeyErrorEl.textContent = '';
    return;
  }
  changeApiKeyErrorEl.textContent = message;
  changeApiKeyErrorEl.classList.remove('hidden');
}

function setSetupArcadeVisible(visible: boolean): void {
  if (visible) {
    setupArcadeHost.classList.remove('hidden');
    resetArcadeDismissed();
    showArcade(setupArcadeOutput);
    setupArcadeBtn.textContent = 'Hide arcade';
    return;
  }
  hideArcade();
  setupArcadeHost.classList.add('hidden');
  setupArcadeBtn.textContent = 'Play arcade while you set up';
}

// ============================================================================
// MODEL SELECTOR HELPERS
// ============================================================================

function getShortModelLabel(modelId: string): string {
  const full = CLAUDE_MODELS.find((m) => m.id === modelId)?.label || modelId;
  // Strip "Claude " prefix to keep it compact
  return full.replace(/^Claude\s+/, '');
}

function syncAllModelSelects(modelId: string): void {
  settingsModelSelect.value = modelId;
  setupModelSelect.value = modelId;
  modelPickerLabel.textContent = getShortModelLabel(modelId);
  renderModelPickerList();
}

async function selectModel(modelId: string): Promise<void> {
  currentSelectedModel = modelId;
  await window.api.setSelectedModel(modelId);
  syncAllModelSelects(modelId);
}

function renderModelPickerList(): void {
  modelPickerList.innerHTML = '';
  for (const model of CLAUDE_MODELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `model-picker-item${model.id === currentSelectedModel ? ' active' : ''}`;
    const check = model.id === currentSelectedModel ? '✓' : '';
    const expensiveTag = model.expensive ? '<span class="model-picker-item-expensive">expensive</span>' : '';
    btn.innerHTML = `<span class="model-picker-item-check">${check}</span><span>${escapeHtml(model.label)}</span>${expensiveTag}`;
    btn.addEventListener('click', () => {
      void selectModel(model.id);
      closeModelPicker();
    });
    modelPickerList.appendChild(btn);
  }
}

function toggleModelPicker(): void {
  const isOpen = !modelPickerPopup.classList.contains('hidden');
  if (isOpen) {
    closeModelPicker();
  } else {
    renderModelPickerList();
    modelPickerPopup.classList.remove('hidden');
    modelPickerBtn.classList.add('open');
  }
}

function closeModelPicker(): void {
  modelPickerPopup.classList.add('hidden');
  modelPickerBtn.classList.remove('open');
}

// ============================================================================
// README PANEL
// ============================================================================

let readmeVisible = false;

function setReadmeVisible(visible: boolean): void {
  readmeVisible = visible;
  readmeView.classList.toggle('hidden', !visible);
  chatAppShell.classList.toggle('hidden', visible);
  readmeToggle.classList.toggle('active', visible);
  if (visible) {
    hideArcade();
    settingsModal.classList.add('hidden');
    conversationsDropdown.classList.add('hidden');
  }
}

function toggleReadme(): void {
  setReadmeVisible(!readmeVisible);
}

// ============================================================================
// CONFIRMATION DIALOG
// ============================================================================

let confirmResolve: ((confirmed: boolean) => void) | null = null;

function showConfirmDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
  confirmDialogTitle.textContent = title;
  confirmDialogMessage.textContent = message;
  confirmDialogConfirm.textContent = confirmLabel;
  confirmDialog.classList.remove('hidden');
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirmDialog(result: boolean): void {
  confirmDialog.classList.add('hidden');
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
}

// ============================================================================
// BROWSER MENU
// ============================================================================

function toggleBrowserMenu(): void {
  browserMenuDropdown.classList.toggle('hidden');
}

function closeBrowserMenu(): void {
  browserMenuDropdown.classList.add('hidden');
}

async function handleBrowserMenuAction(action: string): Promise<void> {
  closeBrowserMenu();

  switch (action) {
    case 'history':
      await showBrowserHistoryPage();
      break;
    case 'clear-history': {
      const confirmed = await showConfirmDialog(
        'Clear Browser History?',
        'This removes your browsing history from Clawdia. Your login sessions will not be affected.',
        'Clear History'
      );
      if (confirmed) await window.api.browserHistoryClear();
      break;
    }
    case 'clear-cookies': {
      const confirmed = await showConfirmDialog(
        'Clear All Cookies?',
        'This will log you out of all websites. Claude will no longer be able to access your authenticated accounts until you log in again.',
        'Clear Cookies'
      );
      if (confirmed) await window.api.browserCookiesClear();
      break;
    }
    case 'clear-all': {
      const confirmed = await showConfirmDialog(
        'Clear All Browser Data?',
        'This removes history, cookies, cache, and all stored data. You will be logged out of every site and all browsing data will be erased. This cannot be undone.',
        'Clear Everything'
      );
      if (confirmed) await window.api.browserClearAll();
      break;
    }
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return 'Older';
}

async function showBrowserHistoryPage(): Promise<void> {
  const result = await window.api.browserHistoryGet();
  const history = result.history || [];

  let lastGroup = '';
  let entriesHtml = '';

  if (history.length === 0) {
    entriesHtml = '<div class="empty">No browsing history yet</div>';
  } else {
    for (const entry of history) {
      const group = getDateGroup(entry.timestamp);
      if (group !== lastGroup) {
        entriesHtml += `<div class="date-group">${group}</div>`;
        lastGroup = group;
      }
      const displayUrl = entry.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const time = formatRelativeTime(entry.timestamp);
      entriesHtml += `<a class="entry" href="${entry.url}" data-url="${entry.url}">
        <div class="entry-info">
          <div class="entry-title">${escapeHtml(entry.title)}</div>
          <div class="entry-url">${escapeHtml(displayUrl)}</div>
        </div>
        <div class="entry-time">${time}</div>
      </a>`;
    }
  }

  const html = `<!DOCTYPE html>
<html><head><style>
body{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:40px;margin:0}
h1{font-size:24px;font-weight:400;margin-bottom:24px}
.search{width:100%;padding:10px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#e0e0e0;font-size:14px;margin-bottom:24px;outline:none;box-sizing:border-box}
.search:focus{border-color:rgba(255,255,255,0.2)}
.date-group{font-size:12px;opacity:0.5;text-transform:uppercase;letter-spacing:0.1em;margin:20px 0 8px}
.entry{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:6px;cursor:pointer;text-decoration:none;color:inherit}
.entry:hover{background:rgba(255,255,255,0.05)}
.entry-info{min-width:0;flex:1}
.entry-title{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry-url{font-size:12px;opacity:0.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry-time{font-size:12px;opacity:0.4;white-space:nowrap;flex-shrink:0}
.empty{text-align:center;opacity:0.3;margin-top:60px;font-size:14px}
</style></head><body>
<h1>History</h1>
<input class="search" placeholder="Search history..." oninput="filterEntries(this.value)">
<div id="entries">${entriesHtml}</div>
<script>
function filterEntries(q){
  q=q.toLowerCase();
  document.querySelectorAll('.entry').forEach(el=>{
    el.style.display=el.textContent.toLowerCase().includes(q)?'flex':'none';
  });
}
document.addEventListener('click',function(e){
  var entry=e.target.closest('.entry');
  if(entry){
    e.preventDefault();
    window.location.href=entry.dataset.url;
  }
});
</script></body></html>`;

  // Navigate to the history page by creating a data URL
  // Use the browser's navigate to set content via data URL
  await window.api.browserNavigate('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function setSetupMode(enabled: boolean): void {
  isSetupMode = enabled;
  chatAppShell.classList.toggle('hidden', enabled);
  setupView.classList.toggle('hidden', !enabled);
  setReadmeVisible(false);

  if (enabled) {
    hideArcade();
    setupArcadeHost.classList.add('hidden');
    setupArcadeBtn.textContent = 'Play arcade while you set up';
    settingsModal.classList.add('hidden');
    conversationsDropdown.classList.add('hidden');
    setupApiKeyInput.value = '';
    setupApiKeyInput.type = 'password';
    setVisibilityToggleState(setupToggleVisibilityBtn, false);
    setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
    setSetupError(null);
    setupApiKeyInput.focus();
  } else {
    setSetupArcadeVisible(false);
  }
}

async function navigatePanelToAnthropicConsole(): Promise<void> {
  if (panelContainer.classList.contains('hidden')) {
    panelContainer.classList.remove('hidden');
    syncBrowserBounds();
  }
  setBrowserAddressValue(ANTHROPIC_CONSOLE_URL);
  await window.api.browserNavigate(ANTHROPIC_CONSOLE_URL);
}

async function validateAndPersistAnthropicKey(key: string): Promise<{ valid: boolean; error?: string }> {
  const normalized = key.trim();
  if (!normalized) {
    return { valid: false, error: 'Please enter an API key.' };
  }

  const validation = await window.api.validateApiKey(normalized);
  if (!validation.valid) {
    return validation;
  }

  await window.api.setApiKey(normalized);
  return { valid: true };
}

async function ensureChatShellInitialized(): Promise<void> {
  if (hasInitializedChatShell) return;
  await initializeChatTabs();
  hasInitializedChatShell = true;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  const chatScrollRegion = outputEl.parentElement;
  if (chatScrollRegion) {
    setupScrollChevrons(outputEl, chatScrollRegion as HTMLElement);
  }
  initializeAddressHistory();
  setupEventListeners();
  setupChatListeners();
  setupThinkingIndicator();
  setupBrowserListeners();

  // Sync browser bounds immediately — must happen before any awaits
  // so the BrowserView gets positioned even if Playwright is slow to connect.
  requestAnimationFrame(() => syncBrowserBounds());

  await ensureLandingTab();

  // Load selected model and sync all dropdowns
  try {
    currentSelectedModel = await window.api.getSelectedModel();
  } catch { /* use default */ }
  syncAllModelSelects(currentSelectedModel);

  const hasCompletedSetup = await window.api.hasCompletedSetup();
  if (!hasCompletedSetup) {
    setSetupMode(true);
    return;
  }

  setSetupMode(false);
  await ensureChatShellInitialized();
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

  // Image attachment handlers (paste, drag-drop, paperclip)
  setupImageEventListeners();

  setupToggleVisibilityBtn.addEventListener('click', () => {
    togglePasswordInputVisibility(setupApiKeyInput, setupToggleVisibilityBtn);
    setupApiKeyInput.focus();
  });

  setupGetKeyLinkBtn.addEventListener('click', () => {
    void navigatePanelToAnthropicConsole();
  });

  setupArcadeBtn.addEventListener('click', () => {
    const nextVisible = setupArcadeHost.classList.contains('hidden');
    setSetupArcadeVisible(nextVisible);
  });

  setupApiKeyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    setupSaveKeyBtn.click();
  });

  setupSaveKeyBtn.addEventListener('click', async () => {
    if (isValidatingSetupKey) return;
    isValidatingSetupKey = true;
    setSetupError(null);
    setSetupValidationState({ loading: true, success: false, text: 'Validating...' });

    try {
      // Validate with the model the user selected in setup
      const apiKey = setupApiKeyInput.value.trim();
      if (!apiKey) {
        setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
        setSetupError('Please enter an API key.');
        return;
      }
      const result = await window.api.validateApiKeyWithModel(apiKey, currentSelectedModel);
      if (!result.valid) {
        setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
        setSetupError(result.error || 'Invalid API key. Please check and try again.');
        return;
      }

      // Persist key and model
      await window.api.setApiKey(apiKey);
      await window.api.setSelectedModel(currentSelectedModel);
      syncAllModelSelects(currentSelectedModel);

      setSetupValidationState({ loading: false, success: true, text: 'Saved' });
      await new Promise((resolve) => window.setTimeout(resolve, 380));
      setSetupMode(false);
      await ensureChatShellInitialized();
      promptEl.focus();
    } finally {
      isValidatingSetupKey = false;
      setSetupValidationState({ loading: false, success: false, text: 'Validate & Save' });
    }
  });

  // Conversations dropdown
  conversationsToggle.addEventListener('click', () => {
    conversationsDropdown.classList.toggle('hidden');
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (!conversationsDropdown.contains(target) && target !== conversationsToggle) {
      conversationsDropdown.classList.add('hidden');
    }
    if (!browserMenuDropdown.contains(target) && target !== browserMenuBtn) {
      closeBrowserMenu();
    }
  });

  // README panel
  readmeToggle.addEventListener('click', toggleReadme);
  readmeClose.addEventListener('click', () => setReadmeVisible(false));

  // Browser menu
  browserMenuBtn.addEventListener('click', toggleBrowserMenu);
  browserMenuDropdown.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.browser-menu-item') as HTMLElement | null;
    if (target?.dataset.action) {
      void handleBrowserMenuAction(target.dataset.action);
    }
  });

  // Confirmation dialog
  confirmDialogCancel.addEventListener('click', () => closeConfirmDialog(false));
  confirmDialogConfirm.addEventListener('click', () => closeConfirmDialog(true));
  confirmDialog.querySelector('.confirm-dialog-backdrop')?.addEventListener('click', () => closeConfirmDialog(false));

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
      settingsApiKeyMasked.textContent = settings.anthropic_key_masked || settings.anthropic_api_key || 'Not configured';
      searchBackendSelect.value = settings.search_backend || 'serper';
      if (settings.selected_model) {
        currentSelectedModel = settings.selected_model;
        syncAllModelSelects(currentSelectedModel);
      }
      changeApiKeyForm.classList.add('hidden');
      changeApiKeyInput.value = '';
      changeApiKeyInput.type = 'password';
      setVisibilityToggleState(changeApiKeyVisibilityBtn, false);
      setChangeKeyError(null);
    } catch { /* ignore */ }
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  settingsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  changeApiKeyBtn.addEventListener('click', () => {
    changeApiKeyForm.classList.remove('hidden');
    setChangeKeyError(null);
    changeApiKeyInput.focus();
  });

  cancelChangeApiKeyBtn.addEventListener('click', () => {
    changeApiKeyForm.classList.add('hidden');
    changeApiKeyInput.value = '';
    changeApiKeyInput.type = 'password';
    setVisibilityToggleState(changeApiKeyVisibilityBtn, false);
    setChangeKeyError(null);
  });

  changeApiKeyVisibilityBtn.addEventListener('click', () => {
    togglePasswordInputVisibility(changeApiKeyInput, changeApiKeyVisibilityBtn);
    changeApiKeyInput.focus();
  });

  changeApiKeyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveChangedApiKeyBtn.click();
  });

  saveChangedApiKeyBtn.addEventListener('click', async () => {
    const nextKey = changeApiKeyInput.value.trim();
    if (!nextKey) {
      setChangeKeyError('Please enter an API key.');
      return;
    }

    const prevText = saveChangedApiKeyBtn.textContent || 'Validate & Save Key';
    saveChangedApiKeyBtn.disabled = true;
    saveChangedApiKeyBtn.textContent = 'Validating...';
    setChangeKeyError(null);

    try {
      const result = await validateAndPersistAnthropicKey(nextKey);
      if (!result.valid) {
        setChangeKeyError(result.error || 'Invalid API key. Please check and try again.');
        return;
      }

      saveChangedApiKeyBtn.textContent = 'Saved';
      const settings = await window.api.getSettings();
      settingsApiKeyMasked.textContent = settings.anthropic_key_masked || settings.anthropic_api_key || 'Configured';
      changeApiKeyForm.classList.add('hidden');
      changeApiKeyInput.value = '';
      changeApiKeyInput.type = 'password';
      setVisibilityToggleState(changeApiKeyVisibilityBtn, false);
      setChangeKeyError(null);
    } finally {
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      saveChangedApiKeyBtn.disabled = false;
      saveChangedApiKeyBtn.textContent = prevText;
    }
  });

  removeApiKeyBtn.addEventListener('click', async () => {
    const confirmed = window.confirm('This will clear your key and return to setup. Continue?');
    if (!confirmed) return;
    await window.api.clearApiKey();
    settingsModal.classList.add('hidden');
    if (isStreaming) {
      await window.api.stopGeneration();
      hideThinking();
      setStreaming(false);
    }
    setSetupMode(true);
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const keyPairs: [HTMLInputElement, string][] = [
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

  // Get-key buttons — navigate browser panel to the service's key page
  settingsModal.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.get-key-btn') as HTMLElement | null;
    if (!btn) return;
    const url = btn.dataset.url;
    if (url) {
      void window.api.browserNavigate(url);
    }
  });

  // Model dropdown in settings — persist immediately on change
  settingsModelSelect.addEventListener('change', () => {
    void selectModel(settingsModelSelect.value);
  });

  // Model dropdown in setup — update local state only (persisted on save)
  setupModelSelect.addEventListener('change', () => {
    currentSelectedModel = setupModelSelect.value;
  });

  // Model picker toggle in input bar
  modelPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelPicker();
  });

  // Close model picker when clicking outside
  document.addEventListener('click', (e) => {
    if (!modelPickerPopup.contains(e.target as Node) && e.target !== modelPickerBtn && !modelPickerBtn.contains(e.target as Node)) {
      closeModelPicker();
    }
  });

  // Browser panel toggle
  browserToggle.addEventListener('click', () => {
    panelContainer.classList.toggle('hidden');
    if (!panelContainer.classList.contains('hidden')) {
      syncBrowserBounds();
    }
  });

  // Browser controls
  browserGoBtn.addEventListener('click', () => {
    void navigateBrowser();
  });
  browserUrlInput.addEventListener('focus', () => {
    refreshAddressSuggestions();
  });
  browserUrlInput.addEventListener('input', () => {
    refreshAddressSuggestions();
  });
  browserUrlInput.addEventListener('paste', () => {
    window.setTimeout(() => refreshAddressSuggestions(), 0);
  });
  browserUrlInput.addEventListener('blur', () => {
    window.setTimeout(() => closeAddressSuggestions(), 120);
  });
  browserUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (browserUrlSuggestions.classList.contains('hidden')) {
        refreshAddressSuggestions();
      }
      shiftHighlightedAddressSuggestion(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (browserUrlSuggestions.classList.contains('hidden')) {
        refreshAddressSuggestions();
      }
      shiftHighlightedAddressSuggestion(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const highlighted = visibleAddressSuggestions[highlightedAddressSuggestionIndex];
      if (highlighted) {
        void navigateBrowser(highlighted);
        return;
      }
      void navigateBrowser();
      return;
    }
    if (e.key === 'Escape') {
      closeAddressSuggestions();
    }
  });
  browserUrlSuggestions.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  browserUrlSuggestions.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('.browser-url-suggestion') as HTMLButtonElement | null;
    if (!target) return;
    const url = target.dataset.url;
    if (!url) return;
    void navigateBrowser(url);
  });
  browserUrlSuggestions.addEventListener('mousemove', (event) => {
    const target = (event.target as HTMLElement).closest('.browser-url-suggestion') as HTMLButtonElement | null;
    if (!target) return;
    const index = Number(target.dataset.index);
    if (Number.isNaN(index) || index < 0 || index >= visibleAddressSuggestions.length) return;
    setHighlightedAddressSuggestion(index);
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (browserUrlInput.contains(target) || browserUrlSuggestions.contains(target)) return;
    closeAddressSuggestions();
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

  window.api.onDocumentCreated((data) => {
    renderDownloadCard(data);
    scrollToBottom();
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
    setBrowserAddressValue(url);
    addAddressHistoryEntry(url);
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
        setBrowserAddressValue(tab.url);
        addAddressHistoryEntry(tab.url);
      } else {
        setBrowserAddressValue('');
      }
    }
  }

  sourceTabs = nextTabs;
  activeSourceId = nextActive;
  renderSourceTabs();
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
  void window.api.browserTabNew().then(() => {
    setBrowserAddressValue('');
    browserUrlInput.focus();
    browserUrlInput.select();
  });
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
    setBrowserAddressValue('');
    browserUrlInput.focus();
  } else {
    setBrowserAddressValue(tab.url);
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
      const existingTimer = copyButtonStateTimers.get(btn);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      const nextTimer = window.setTimeout(() => {
        btn.classList.remove('is-copied');
        copyButtonStateTimers.delete(btn);
      }, COPY_BUTTON_SUCCESS_DURATION_MS);
      copyButtonStateTimers.set(btn, nextTimer);

      if (wrapper) {
        showCopyNote(wrapper, 'Copied');
      }
    })
    .catch((error) => {
      console.error('[Renderer] failed to copy code block:', error);
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
// IMAGE ATTACHMENT HELPERS
// ============================================================================

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = URL.createObjectURL(file);
  });
}

function resizeImageIfNeeded(file: File, width: number, height: number): Promise<{ base64: string; width: number; height: number }> {
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    return fileToBase64(file).then((base64) => ({ base64, width, height }));
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(MAX_IMAGE_DIMENSION / img.naturalWidth, MAX_IMAGE_DIMENSION / img.naturalHeight);
      const newW = Math.round(img.naturalWidth * scale);
      const newH = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, newW, newH);
      const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mediaType, 0.92);
      resolve({ base64: dataUrl.split(',')[1], width: newW, height: newH });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      fileToBase64(file).then((base64) => resolve({ base64, width, height }));
    };
    img.src = URL.createObjectURL(file);
  });
}

async function handleImageAttachment(file: File): Promise<void> {
  if (file.size > MAX_IMAGE_SIZE) {
    showAttachmentError(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.`);
    return;
  }
  if (!VALID_IMAGE_TYPES.includes(file.type)) {
    showAttachmentError('Unsupported format. Use PNG, JPEG, GIF, or WebP.');
    return;
  }
  if (pendingAttachments.length + pendingDocuments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    return;
  }

  const dimensions = await getImageDimensions(file);
  const resized = await resizeImageIfNeeded(file, dimensions.width, dimensions.height);
  const thumbnailUrl = URL.createObjectURL(file);

  const attachment: PendingImage = {
    id: crypto.randomUUID(),
    base64: resized.base64,
    mediaType: file.type as PendingImage['mediaType'],
    thumbnailUrl,
    width: resized.width,
    height: resized.height,
    sizeBytes: file.size,
  };

  pendingAttachments.push(attachment);
  renderAttachmentBar();
}

function removePendingAttachment(id: string): void {
  const idx = pendingAttachments.findIndex((a) => a.id === id);
  if (idx >= 0) {
    URL.revokeObjectURL(pendingAttachments[idx].thumbnailUrl);
    pendingAttachments.splice(idx, 1);
    renderAttachmentBar();
  }
}

function clearPendingAttachments(): void {
  for (const a of pendingAttachments) {
    URL.revokeObjectURL(a.thumbnailUrl);
  }
  pendingAttachments = [];
  pendingDocuments = [];
  renderAttachmentBar();
}

function renderAttachmentBar(): void {
  attachmentBar.innerHTML = '';
  const total = pendingAttachments.length + pendingDocuments.length;
  if (total === 0) {
    attachmentBar.classList.remove('has-attachments');
    return;
  }
  attachmentBar.classList.add('has-attachments');

  // Render image thumbnails
  for (const attachment of pendingAttachments) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';

    const img = document.createElement('img');
    img.src = attachment.thumbnailUrl;
    img.alt = 'Attached image';
    thumb.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removePendingAttachment(attachment.id));
    thumb.appendChild(removeBtn);

    attachmentBar.appendChild(thumb);
  }

  // Render document thumbnails
  for (const doc of pendingDocuments) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-doc';

    const icon = document.createElement('span');
    icon.className = 'attachment-doc-icon';
    icon.textContent = getDocIcon(doc.filename);
    thumb.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'attachment-doc-info';

    const name = document.createElement('div');
    name.className = 'attachment-doc-name';
    name.textContent = truncateFilename(doc.filename);
    name.title = doc.filename;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'attachment-doc-meta';
    if (doc.extractionStatus === 'extracting') {
      meta.textContent = 'Extracting...';
    } else if (doc.extractionStatus === 'error') {
      meta.textContent = doc.errorMessage || 'Error';
      meta.style.color = 'var(--error)';
    } else {
      meta.textContent = formatFileSize(doc.sizeBytes);
    }
    info.appendChild(meta);

    thumb.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attachment-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removePendingDocument(doc.id));
    thumb.appendChild(removeBtn);

    attachmentBar.appendChild(thumb);
  }
}

function showAttachmentError(msg: string): void {
  // Brief inline error — reuse the attachment bar area
  const el = document.createElement('div');
  el.style.cssText = 'color: var(--error); font-size: 12px; padding: 4px 12px;';
  el.textContent = msg;
  attachmentBar.classList.add('has-attachments');
  attachmentBar.appendChild(el);
  setTimeout(() => {
    if (el.parentNode === attachmentBar) el.remove();
    if (pendingAttachments.length === 0 && pendingDocuments.length === 0) attachmentBar.classList.remove('has-attachments');
  }, 3000);
}

function hasAttachableFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const item of dt.items) {
    if (item.kind === 'file') return true;
  }
  return false;
}

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function isDocumentFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  // Also accept files with no extension that aren't images
  if (!ext && !file.type.startsWith('image/')) return true;
  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateFilename(name: string, max: number = 20): string {
  if (name.length <= max) return name;
  const ext = getFileExtension(name);
  const base = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const keep = max - ext.length - 4; // 4 = "..." + "."
  if (keep < 3) return name.slice(0, max - 3) + '...';
  return base.slice(0, keep) + '...' + (ext ? '.' + ext : '');
}

function getDocIcon(filename: string): string {
  const ext = getFileExtension(filename);
  switch (ext) {
    case 'pdf': return '\ud83d\udcc4';
    case 'docx': case 'doc': return '\ud83d\uddd2\ufe0f';
    case 'xlsx': case 'xls': case 'csv': return '\ud83d\udcca';
    case 'json': case 'xml': case 'yaml': case 'yml': case 'toml': return '\ud83d\udccb';
    case 'html': case 'htm': case 'css': case 'scss': return '\ud83c\udf10';
    case 'md': case 'txt': case 'log': return '\ud83d\udcdd';
    default: return '\ud83d\udcc1';
  }
}

async function handleDocumentAttachment(file: File): Promise<void> {
  if (file.size > MAX_DOCUMENT_SIZE) {
    showAttachmentError(`File too large (${formatFileSize(file.size)}). Max 50MB.`);
    return;
  }
  const totalCount = pendingAttachments.length + pendingDocuments.length;
  if (totalCount >= MAX_ATTACHMENTS) {
    showAttachmentError(`Max ${MAX_ATTACHMENTS} attachments per message`);
    return;
  }

  const doc: PendingDocument = {
    id: crypto.randomUUID(),
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    extractionStatus: 'extracting',
  };
  pendingDocuments.push(doc);
  renderAttachmentBar();

  try {
    const arrayBuf = await file.arrayBuffer();
    const buffer = Array.from(new Uint8Array(arrayBuf));
    const result = await window.api.extractDocument({
      buffer,
      filename: file.name,
      mimeType: doc.mimeType,
    });

    const found = pendingDocuments.find((d) => d.id === doc.id);
    if (!found) return; // was removed while extracting

    if (result.success) {
      found.extractionStatus = 'done';
      found.extractedText = result.text;
      found.pageCount = result.pageCount;
      found.sheetNames = result.sheetNames;
      found.truncated = result.truncated;
    } else {
      found.extractionStatus = 'error';
      found.errorMessage = result.error || 'Extraction failed';
    }
  } catch (err: any) {
    const found = pendingDocuments.find((d) => d.id === doc.id);
    if (found) {
      found.extractionStatus = 'error';
      found.errorMessage = err?.message || 'Extraction failed';
    }
  }

  renderAttachmentBar();
}

function removePendingDocument(id: string): void {
  const idx = pendingDocuments.findIndex((d) => d.id === id);
  if (idx >= 0) {
    pendingDocuments.splice(idx, 1);
    renderAttachmentBar();
  }
}

function renderMessageImages(images: ImageAttachment[], container: HTMLElement): void {
  const imagesDiv = document.createElement('div');
  imagesDiv.className = 'message-images' + (images.length === 1 ? ' single' : '');

  for (const img of images) {
    const imgEl = document.createElement('img');
    imgEl.className = 'message-image';
    imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
    imgEl.alt = 'Attached image';
    imgEl.addEventListener('click', () => openImageLightbox(imgEl.src));
    imagesDiv.appendChild(imgEl);
  }

  container.appendChild(imagesDiv);
}

function openImageLightbox(src: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);

  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', handler);
    }
  });

  document.body.appendChild(overlay);
}

function routeFileAttachment(file: File): void {
  if (VALID_IMAGE_TYPES.includes(file.type)) {
    handleImageAttachment(file);
  } else if (isDocumentFile(file)) {
    handleDocumentAttachment(file);
  }
  // else: ignore unsupported files silently
}

function setupImageEventListeners(): void {
  // Paste handler on the prompt wrapper (catches image/file pastes into textarea area)
  const promptWrapper = promptEl.closest('.prompt-wrapper') || promptEl.parentElement!;
  promptWrapper.addEventListener('paste', (e: Event) => {
    const clipboardEvent = e as ClipboardEvent;
    const items = clipboardEvent.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.kind === 'file') {
        clipboardEvent.preventDefault();
        const file = item.getAsFile();
        if (file) routeFileAttachment(file);
        return;
      }
    }
  });

  // Drag-and-drop on the chat area
  let dragCounter = 0;
  chatArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (hasAttachableFiles((e as DragEvent).dataTransfer)) {
      chatArea.classList.add('drag-over');
    }
  });

  chatArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      chatArea.classList.remove('drag-over');
    }
  });

  chatArea.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    chatArea.classList.remove('drag-over');
    const files = (e as DragEvent).dataTransfer?.files;
    if (files) {
      for (const file of files) {
        routeFileAttachment(file);
      }
    }
  });

  // Paperclip button — native file picker (accepts images and documents)
  attachBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.multiple = true;
    input.onchange = () => {
      if (input.files) {
        for (const file of input.files) {
          routeFileAttachment(file);
        }
      }
    };
    input.click();
  });
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

function renderConversationMessages(messages: Array<{ role: string; content: string; images?: ImageAttachment[]; documents?: DocumentMeta[] }>) {
  for (const msg of messages) {
    if (msg.role === 'user') {
      appendUserMessage(msg.content, false, msg.images, msg.documents);
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
  updateEmptyState();

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
  resetArcadeDismissed();
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
    updateEmptyState();
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
  if (isSetupMode) return;
  const content = promptEl.value.trim();
  const hasImages = pendingAttachments.length > 0;
  const hasDocs = pendingDocuments.length > 0;
  const hasAnyAttachments = hasImages || hasDocs;

  // Block send if documents are still extracting
  if (pendingDocuments.some((d) => d.extractionStatus === 'extracting')) {
    showAttachmentError('Wait for document extraction to finish');
    return;
  }

  if ((!content && !hasAnyAttachments) || isStreaming) return;

  if (!activeChatTabId) {
    await createNewChatTab();
  }

  if (!currentConversationId) {
    currentConversationId = activeChatTabId;
  }
  if (!currentConversationId) return;

  // Capture images before clearing
  const images: ImageAttachment[] | undefined = hasImages
    ? pendingAttachments.map((a) => ({
        base64: a.base64,
        mediaType: a.mediaType,
        width: a.width,
        height: a.height,
      }))
    : undefined;

  // Capture documents before clearing (only successfully extracted ones)
  const documents: DocumentAttachment[] | undefined = hasDocs
    ? pendingDocuments
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

  // Build document metas for display in user message
  const documentMetas: DocumentMeta[] | undefined = documents?.map((d) => ({
    filename: d.filename,
    originalName: d.originalName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    pageCount: d.pageCount,
    sheetNames: d.sheetNames,
    truncated: d.truncated,
  }));

  appendUserMessage(content, true, images, documentMetas);
  promptEl.value = '';
  clearPendingAttachments();

  const attachCount = (images?.length || 0) + (documents?.length || 0);
  const displayText = content || (attachCount > 0 ? `[${attachCount} attachment${attachCount > 1 ? 's' : ''}]` : '');
  const activeTitle = getChatTabTitle(currentConversationId);
  if (activeTitle === DEFAULT_CHAT_TAB_TITLE) {
    setChatTabTitle(currentConversationId, displayText);
    renderChatTabs();
    void persistChatTabState();
  }

  setStreaming(true);
  fullStreamBuffer = '';

  const result = await window.api.sendMessage(currentConversationId, content, images, documents);
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

function renderMessageDocuments(documents: DocumentMeta[], container: HTMLElement): void {
  const docsDiv = document.createElement('div');
  docsDiv.className = 'message-documents';

  for (const doc of documents) {
    const card = document.createElement('div');
    card.className = 'document-card';

    const icon = document.createElement('span');
    icon.className = 'document-card-icon';
    icon.textContent = getDocIcon(doc.filename);
    card.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'document-card-info';

    const name = document.createElement('div');
    name.className = 'document-card-name';
    name.textContent = doc.originalName;
    name.title = doc.originalName;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'document-card-meta';
    const parts = [formatFileSize(doc.sizeBytes)];
    if (doc.pageCount) parts.push(`${doc.pageCount} pages`);
    if (doc.sheetNames?.length) parts.push(`${doc.sheetNames.length} sheets`);
    if (doc.truncated) parts.push('truncated');
    meta.textContent = parts.join(' \u00b7 ');
    info.appendChild(meta);

    card.appendChild(info);
    docsDiv.appendChild(card);
  }

  container.appendChild(docsDiv);
}

function renderDownloadCard(data: { filePath: string; filename: string; sizeBytes: number; format: string }): void {
  const card = document.createElement('div');
  card.className = 'download-card';

  const icon = document.createElement('span');
  icon.className = 'download-card-icon';
  icon.textContent = getDocIcon(data.filename);
  card.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'download-card-info';

  const name = document.createElement('div');
  name.className = 'download-card-name';
  name.textContent = data.filename;
  name.title = data.filePath;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'download-card-meta';
  meta.textContent = `${formatFileSize(data.sizeBytes)} \u00b7 ${data.format.toUpperCase()}`;
  info.appendChild(meta);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'download-card-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'download-card-btn';
  saveBtn.textContent = 'Save As';
  saveBtn.addEventListener('click', () => {
    window.api.saveDocument(data.filePath, data.filename);
  });
  actions.appendChild(saveBtn);

  const folderBtn = document.createElement('button');
  folderBtn.className = 'download-card-btn';
  folderBtn.textContent = 'Open Folder';
  folderBtn.addEventListener('click', () => {
    window.api.openDocumentFolder(data.filePath);
  });
  actions.appendChild(folderBtn);

  card.appendChild(actions);
  outputEl.appendChild(card);
}

function appendUserMessage(content: string, shouldScroll: boolean = true, images?: ImageAttachment[], documents?: DocumentMeta[]) {
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

  outputEl.appendChild(wrapper);
  if (shouldScroll) {
    scrollToBottom();
  }
}

function startAssistantMessage() {
  hideArcade();
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
  hideArcade();
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

const SITE_SHORTCUTS: Record<string, string> = {
  // AI tools
  'claude': 'https://claude.ai',
  'chatgpt': 'https://chatgpt.com',
  'gemini': 'https://gemini.google.com',
  'perplexity': 'https://perplexity.ai',
  'midjourney': 'https://midjourney.com',
  'huggingface': 'https://huggingface.co',
  'hf': 'https://huggingface.co',
  // Dev tools
  'github': 'https://github.com',
  'gh': 'https://github.com',
  'gitlab': 'https://gitlab.com',
  'stackoverflow': 'https://stackoverflow.com',
  'so': 'https://stackoverflow.com',
  'npm': 'https://www.npmjs.com',
  'mdn': 'https://developer.mozilla.org',
  'codepen': 'https://codepen.io',
  'replit': 'https://replit.com',
  'vercel': 'https://vercel.com',
  'netlify': 'https://netlify.com',
  // Google services
  'google': 'https://www.google.com',
  'gmail': 'https://mail.google.com',
  'drive': 'https://drive.google.com',
  'docs': 'https://docs.google.com',
  'sheets': 'https://sheets.google.com',
  'slides': 'https://slides.google.com',
  'calendar': 'https://calendar.google.com',
  'maps': 'https://maps.google.com',
  'youtube': 'https://www.youtube.com',
  'yt': 'https://www.youtube.com',
  // Social
  'twitter': 'https://x.com',
  'x': 'https://x.com',
  'reddit': 'https://www.reddit.com',
  'linkedin': 'https://www.linkedin.com',
  'facebook': 'https://www.facebook.com',
  'fb': 'https://www.facebook.com',
  'instagram': 'https://www.instagram.com',
  'ig': 'https://www.instagram.com',
  'threads': 'https://www.threads.net',
  'discord': 'https://discord.com',
  'slack': 'https://slack.com',
  'twitch': 'https://www.twitch.tv',
  // Shopping
  'amazon': 'https://www.amazon.com',
  'ebay': 'https://www.ebay.com',
  'walmart': 'https://www.walmart.com',
  'target': 'https://www.target.com',
  'bestbuy': 'https://www.bestbuy.com',
  'homedepot': 'https://www.homedepot.com',
  'home depot': 'https://www.homedepot.com',
  'lowes': 'https://www.lowes.com',
  'costco': 'https://www.costco.com',
  'etsy': 'https://www.etsy.com',
  // Media & Entertainment
  'netflix': 'https://www.netflix.com',
  'hulu': 'https://www.hulu.com',
  'spotify': 'https://open.spotify.com',
  // Productivity
  'notion': 'https://www.notion.so',
  'figma': 'https://www.figma.com',
  'canva': 'https://www.canva.com',
  'trello': 'https://trello.com',
  'jira': 'https://www.atlassian.com/software/jira',
  // News
  'hackernews': 'https://news.ycombinator.com',
  'hn': 'https://news.ycombinator.com',
  'hacker news': 'https://news.ycombinator.com',
  'techcrunch': 'https://techcrunch.com',
  'tc': 'https://techcrunch.com',
  'producthunt': 'https://www.producthunt.com',
  'ph': 'https://www.producthunt.com',
  // Finance
  'robinhood': 'https://robinhood.com',
  'coinbase': 'https://www.coinbase.com',
  'paypal': 'https://www.paypal.com',
  'venmo': 'https://venmo.com',
};

function resolveAddressInput(input: string): string {
  const query = input.trim();
  if (!query) return '';

  // Already a full URL
  if (query.startsWith('http://') || query.startsWith('https://')) {
    return query;
  }

  // Localhost
  if (query === 'localhost' || query.startsWith('localhost:')) {
    return `http://${query}`;
  }

  // IP addresses
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(query)) {
    return `http://${query}`;
  }

  // Looks like a URL (contains a dot and no spaces)
  if (/^[^\s]+\.[^\s]+$/.test(query)) {
    return `https://${query}`;
  }

  // Known site shortcut
  const shortcut = SITE_SHORTCUTS[query.toLowerCase()];
  if (shortcut) return shortcut;

  // Single word — guess .com
  if (/^[a-zA-Z0-9-]+$/.test(query)) {
    return `https://${query.toLowerCase()}.com`;
  }

  // Everything else — Google search
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function isTrackingQueryParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith('utm_') || ADDRESS_BAR_TRACKING_QUERY_PARAMS.has(normalized);
}

function formatAddressBarValue(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === 'about:blank') return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return trimmed;
    }

    const host = parsed.host.replace(/^www\./i, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const params = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      if (!isTrackingQueryParam(key)) {
        params.append(key, value);
      }
    });
    const query = params.toString();
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return trimmed;
  }
}

function initializeAddressHistory(): void {
  browserAddressHistory = readAddressHistoryFromStorage();
  closeAddressSuggestions();
}

function readAddressHistoryFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(ADDRESS_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => normalizeAddressHistoryEntry(entry))
      .filter((entry): entry is string => entry !== null)
      .slice(0, ADDRESS_HISTORY_MAX_ITEMS);
  } catch {
    return [];
  }
}

function persistAddressHistory(): void {
  try {
    localStorage.setItem(ADDRESS_HISTORY_STORAGE_KEY, JSON.stringify(browserAddressHistory));
  } catch {
    // Ignore storage errors (e.g. quota/private mode).
  }
}

function normalizeAddressHistoryEntry(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function addAddressHistoryEntry(url: string): void {
  const normalized = normalizeAddressHistoryEntry(url);
  if (!normalized) return;

  browserAddressHistory = [
    normalized,
    ...browserAddressHistory.filter((entry) => entry !== normalized),
  ].slice(0, ADDRESS_HISTORY_MAX_ITEMS);

  persistAddressHistory();
  if (document.activeElement === browserUrlInput) {
    refreshAddressSuggestions();
  }
}

function collectAddressSuggestions(input: string): string[] {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return browserAddressHistory.slice(0, ADDRESS_HISTORY_VISIBLE_SUGGESTIONS);
  }

  const startsWithMatches: string[] = [];
  const containsMatches: string[] = [];

  for (const url of browserAddressHistory) {
    const rawValue = url.toLowerCase();
    const displayValue = formatAddressBarValue(url).toLowerCase();
    const startsWith = rawValue.startsWith(normalizedInput) || displayValue.startsWith(normalizedInput);
    const contains = rawValue.includes(normalizedInput) || displayValue.includes(normalizedInput);

    if (startsWith) {
      startsWithMatches.push(url);
      continue;
    }
    if (contains) {
      containsMatches.push(url);
    }
  }

  return [...startsWithMatches, ...containsMatches].slice(0, ADDRESS_HISTORY_VISIBLE_SUGGESTIONS);
}

function refreshAddressSuggestions(): void {
  if (document.activeElement !== browserUrlInput) return;

  visibleAddressSuggestions = collectAddressSuggestions(browserUrlInput.value);
  highlightedAddressSuggestionIndex = -1;
  renderAddressSuggestions();
}

function renderAddressSuggestions(): void {
  if (visibleAddressSuggestions.length === 0) {
    closeAddressSuggestions();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < visibleAddressSuggestions.length; index += 1) {
    const url = visibleAddressSuggestions[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-url-suggestion';
    button.dataset.url = url;
    button.dataset.index = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', 'false');

    const formattedValue = formatAddressBarValue(url) || url;
    const valueEl = document.createElement('span');
    valueEl.className = 'browser-url-suggestion-value';
    valueEl.textContent = formattedValue;

    const fullEl = document.createElement('span');
    fullEl.className = 'browser-url-suggestion-full';
    fullEl.textContent = url;

    button.append(valueEl, fullEl);
    fragment.appendChild(button);
  }

  browserUrlSuggestions.replaceChildren(fragment);
  browserUrlSuggestions.classList.remove('hidden');
  browserUrlInput.setAttribute('aria-expanded', 'true');
}

function setHighlightedAddressSuggestion(index: number): void {
  const nextIndex = index >= 0 && index < visibleAddressSuggestions.length ? index : -1;
  highlightedAddressSuggestionIndex = nextIndex;

  const items = browserUrlSuggestions.querySelectorAll('.browser-url-suggestion');
  items.forEach((item, itemIndex) => {
    const isActive = itemIndex === nextIndex;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
      (item as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  });
}

function shiftHighlightedAddressSuggestion(direction: number): void {
  const total = visibleAddressSuggestions.length;
  if (total === 0) return;

  if (highlightedAddressSuggestionIndex === -1) {
    setHighlightedAddressSuggestion(direction > 0 ? 0 : total - 1);
    return;
  }

  const nextIndex = (highlightedAddressSuggestionIndex + direction + total) % total;
  setHighlightedAddressSuggestion(nextIndex);
}

function closeAddressSuggestions(): void {
  visibleAddressSuggestions = [];
  highlightedAddressSuggestionIndex = -1;
  browserUrlSuggestions.replaceChildren();
  browserUrlSuggestions.classList.add('hidden');
  browserUrlInput.setAttribute('aria-expanded', 'false');
}

function setBrowserAddressValue(url: string): void {
  browserUrlInput.value = formatAddressBarValue(url);
}

async function navigateBrowser(inputOverride?: string) {
  const resolved = resolveAddressInput(inputOverride ?? browserUrlInput.value);
  if (!resolved) return;

  closeAddressSuggestions();
  setBrowserAddressValue(resolved);
  const result = await window.api.browserNavigate(resolved);
  if (result?.success) {
    addAddressHistoryEntry(resolved);
  }
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

async function copyTextToClipboard(text: string): Promise<void> {
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

function showCopyNote(wrapper: HTMLElement, text: string): void {
  let noteEl = wrapper.querySelector('.code-copy-note') as HTMLSpanElement | null;
  if (!noteEl) {
    noteEl = document.createElement('span');
    noteEl.className = 'code-copy-note';
    wrapper.appendChild(noteEl);
  }

  noteEl.textContent = text;
  noteEl.classList.add('visible');

  const existingTimer = copyNoteHideTimers.get(wrapper);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }
  const nextTimer = window.setTimeout(() => {
    noteEl?.classList.remove('visible');
    copyNoteHideTimers.delete(wrapper);
  }, COPY_NOTE_DURATION_MS);
  copyNoteHideTimers.set(wrapper, nextTimer);
}

function renderMarkdown(text: string): string {
  // Simple markdown rendering
  let html = escapeHtml(text)
    // Code blocks — wrapped in a container with a copy button
    .replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_match, _language, code) =>
        `<div class="code-block-wrapper"><button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code">${COPY_ICON_SVG}</button><pre><code>${code}</code></pre></div>`
    )
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
