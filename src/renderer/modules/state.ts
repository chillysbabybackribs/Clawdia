import type { API } from '../../main/preload';
import type { ResearchSourcePreview, DocumentMeta } from '../../shared/types';
import { DEFAULT_MODEL } from '../../shared/models';

// Keep renderer access typed via preload API definition.
declare global {
  interface Window {
    api: API;
    clawdia: API;
  }
}

export type ChatConversation = {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; images?: import('../../shared/types').ImageAttachment[]; documents?: DocumentMeta[] }>;
};

export type ChatTab = {
  id: string;
  title: string;
};

export interface PendingImage {
  id: string;
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  thumbnailUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface PendingDocument {
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

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 50;
export const SCROLL_CHEVRON_EDGE_THRESHOLD_PX = 50;
export const SCROLL_CHEVRON_IDLE_TIMEOUT_MS = 2200;
export const ADDRESS_HISTORY_STORAGE_KEY = 'clawdia.browser.address-history.v1';
export const ADDRESS_HISTORY_MAX_ITEMS = 120;
export const ADDRESS_HISTORY_VISIBLE_SUGGESTIONS = 8;

export const MANUAL_TAB_PREFIX = 'manual-tab-';
export const DEFAULT_TAB_ID = `${MANUAL_TAB_PREFIX}google-home`;
export const DEFAULT_TAB_URL = 'https://www.google.com';
export const DEFAULT_TAB_TITLE = 'Google';
export const EMPTY_TAB_URL = '';
export const EMPTY_TAB_TITLE = 'New Tab';
export const DEFAULT_CHAT_TAB_TITLE = 'New Chat';
export const CHAT_TAB_TITLE_MAX = 25;
export const COPY_NOTE_DURATION_MS = 900;
export const COPY_BUTTON_SUCCESS_DURATION_MS = 700;
export const MAX_PROMPT_CHARS = 24000;
export const SAFE_MARKDOWN_RENDER_CHARS = 60000;
export const MARKDOWN_RENDER_BUSY_TEXT = 'Rendering response...';
export const COPY_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const ANTHROPIC_CONSOLE_URL = 'https://console.anthropic.com';

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
export const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4000;
export const VALID_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'csv', 'json', 'html', 'htm',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'php', 'swift', 'kt', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'r', 'lua', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'dockerfile', 'makefile', 'cmake', 'gitignore', 'env',
]);

export const ADDRESS_BAR_TRACKING_QUERY_PARAMS = new Set([
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

export const appState = {
  isStreaming: false,
  currentConversationId: null as string | null,
  streamingContainer: null as HTMLDivElement | null,
  currentTextChunk: null as HTMLSpanElement | null,
  fullStreamBuffer: '',
  pendingStreamTextChunks: [] as string[],
  streamFlushRafId: null as number | null,
  thinkingEl: null as HTMLDivElement | null,
  thinkingTextEl: null as HTMLSpanElement | null,
  currentThought: '',
  thinkingVisible: false,
  thinkingTransitionToken: 0,
  thinkingHideTimer: null as number | null,
  thinkingSwapTimer: null as number | null,
  thinkingListenersBound: false,
  researchContainer: null as HTMLDivElement | null,
  knownActions: new Map<
    string,
    {
      source: string;
      status: string;
      preview?: string;
      executionStatus?: string;
      reason?: string;
      producedSources?: ResearchSourcePreview[];
    }
  >(),
  sourceTabs: new Map<string, ResearchSourcePreview>(),
  activeSourceId: null as string | null,
  shouldAutoFollowOutput: true,
  copyNoteHideTimers: new WeakMap<HTMLElement, number>(),
  copyButtonStateTimers: new WeakMap<HTMLButtonElement, number>(),
  openChatTabs: [] as ChatTab[],
  activeChatTabId: null as string | null,
  chatScrollPositions: new Map<string, number>(),
  chatSwitchToken: 0,
  hasInitializedChatShell: false,
  isSetupMode: false,
  isValidatingSetupKey: false,
  currentSelectedModel: DEFAULT_MODEL,
  pendingAttachments: [] as PendingImage[],
  pendingDocuments: [] as PendingDocument[],
  browserAddressHistory: [] as string[],
  visibleAddressSuggestions: [] as string[],
  highlightedAddressSuggestionIndex: -1,
  currentBrowserUrl: '',  // tracks the actual URL of the active browser tab
  readmeVisible: false,
};

export const elements = {} as {
  outputEl: HTMLDivElement;
  chatTabsContainer: HTMLDivElement;
  promptEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  chatAppShell: HTMLDivElement;
  tokenStatsEl: HTMLDivElement;
  setupView: HTMLDivElement;
  setupApiKeyInput: HTMLInputElement;
  setupToggleVisibilityBtn: HTMLButtonElement;
  setupSaveKeyBtn: HTMLButtonElement;
  setupSaveKeyText: HTMLSpanElement;
  setupSaveKeySpinner: HTMLSpanElement;
  setupSaveKeyCheck: HTMLSpanElement;
  setupErrorEl: HTMLParagraphElement;
  setupGetKeyLinkBtn: HTMLButtonElement;
  setupArcadeBtn: HTMLButtonElement;
  setupArcadeHost: HTMLDivElement;
  setupArcadeOutput: HTMLDivElement;
  conversationsToggle: HTMLElement;
  conversationsDropdown: HTMLElement;
  conversationsList: HTMLElement;
  newConversationBtn: HTMLElement;
  settingsToggle: HTMLElement;
  settingsModal: HTMLDivElement;
  settingsClose: HTMLElement;
  settingsApiKeyMasked: HTMLDivElement;
  changeApiKeyBtn: HTMLButtonElement;
  removeApiKeyBtn: HTMLButtonElement;
  changeApiKeyForm: HTMLDivElement;
  changeApiKeyInput: HTMLInputElement;
  changeApiKeyVisibilityBtn: HTMLButtonElement;
  saveChangedApiKeyBtn: HTMLButtonElement;
  cancelChangeApiKeyBtn: HTMLButtonElement;
  changeApiKeyErrorEl: HTMLParagraphElement;
  serperKeyInput: HTMLInputElement;
  serpapiKeyInput: HTMLInputElement;
  bingKeyInput: HTMLInputElement;
  searchBackendSelect: HTMLSelectElement;
  saveSettingsBtn: HTMLElement;
  settingsModelSelect: HTMLSelectElement;
  setupModelSelect: HTMLSelectElement;
  modelPickerBtn: HTMLButtonElement;
  modelPickerLabel: HTMLSpanElement;
  modelPickerPopup: HTMLDivElement;
  modelPickerList: HTMLDivElement;
  attachBtn: HTMLButtonElement;
  attachmentBar: HTMLDivElement;
  chatArea: HTMLElement;
  browserToggle: HTMLElement;
  panelContainer: HTMLDivElement;
  browserUrlInput: HTMLInputElement;
  browserUrlSuggestions: HTMLDivElement;
  browserGoBtn: HTMLElement;
  browserBackBtn: HTMLElement;
  browserForwardBtn: HTMLElement;
  browserReloadBtn: HTMLElement;
  sourceTabsContainer: HTMLDivElement;
  panelMinBtn: HTMLElement | null;
  panelMaxBtn: HTMLElement | null;
  panelCloseBtn: HTMLElement | null;
  readmeToggle: HTMLButtonElement;
  readmeView: HTMLDivElement;
  readmeClose: HTMLButtonElement;
  browserMenuBtn: HTMLButtonElement;
  browserMenuDropdown: HTMLDivElement;
  browserMenuBody: HTMLDivElement;
  browserHiddenQuote: HTMLParagraphElement;
  accountsList: HTMLDivElement;
  addAccountForm: HTMLDivElement;
  addAccountPlatform: HTMLInputElement;
  addAccountUsername: HTMLInputElement;
  addAccountDomain: HTMLInputElement;
  saveAccountBtn: HTMLButtonElement;
  cancelAccountBtn: HTMLButtonElement;
  addAccountBtn: HTMLButtonElement;
  minBtn: HTMLElement | null;
  maxBtn: HTMLElement | null;
  closeBtn: HTMLElement | null;
};

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`[Renderer] Missing required element: #${id}`);
  }
  return el as T;
}

function queryRequired<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) {
    throw new Error(`[Renderer] Missing required element: ${selector}`);
  }
  return el as T;
}

export function initElements(): void {
  elements.outputEl = required<HTMLDivElement>('output');
  elements.chatTabsContainer = required<HTMLDivElement>('chat-tabs');
  elements.promptEl = required<HTMLTextAreaElement>('prompt');
  elements.sendBtn = required<HTMLButtonElement>('send');
  elements.cancelBtn = required<HTMLButtonElement>('cancel');
  elements.chatAppShell = required<HTMLDivElement>('chat-app-shell');
  elements.tokenStatsEl = required<HTMLDivElement>('token-stats');
  elements.setupView = required<HTMLDivElement>('setup-view');
  elements.setupApiKeyInput = required<HTMLInputElement>('setup-api-key-input');
  elements.setupToggleVisibilityBtn = required<HTMLButtonElement>('setup-toggle-visibility');
  elements.setupSaveKeyBtn = required<HTMLButtonElement>('setup-save-key-btn');
  elements.setupSaveKeyText = required<HTMLSpanElement>('setup-save-key-text');
  elements.setupSaveKeySpinner = required<HTMLSpanElement>('setup-save-key-spinner');
  elements.setupSaveKeyCheck = required<HTMLSpanElement>('setup-save-key-check');
  elements.setupErrorEl = required<HTMLParagraphElement>('setup-error');
  elements.setupGetKeyLinkBtn = required<HTMLButtonElement>('setup-get-key-link');
  elements.setupArcadeBtn = required<HTMLButtonElement>('setup-arcade-btn');
  elements.setupArcadeHost = required<HTMLDivElement>('setup-arcade-host');
  elements.setupArcadeOutput = required<HTMLDivElement>('setup-arcade-output');
  elements.conversationsToggle = required<HTMLElement>('conversations-toggle');
  elements.conversationsDropdown = required<HTMLElement>('conversations-dropdown');
  elements.conversationsList = required<HTMLElement>('conversations-list');
  elements.newConversationBtn = required<HTMLElement>('new-conversation-btn');
  elements.settingsToggle = required<HTMLElement>('settings-toggle');
  elements.settingsModal = required<HTMLDivElement>('settings-modal');
  elements.settingsClose = required<HTMLElement>('settings-close');
  elements.settingsApiKeyMasked = required<HTMLDivElement>('settings-api-key-masked');
  elements.changeApiKeyBtn = required<HTMLButtonElement>('change-api-key-btn');
  elements.removeApiKeyBtn = required<HTMLButtonElement>('remove-api-key-btn');
  elements.changeApiKeyForm = required<HTMLDivElement>('change-api-key-form');
  elements.changeApiKeyInput = required<HTMLInputElement>('change-api-key-input');
  elements.changeApiKeyVisibilityBtn = required<HTMLButtonElement>('change-api-key-visibility');
  elements.saveChangedApiKeyBtn = required<HTMLButtonElement>('save-changed-api-key-btn');
  elements.cancelChangeApiKeyBtn = required<HTMLButtonElement>('cancel-change-api-key-btn');
  elements.changeApiKeyErrorEl = required<HTMLParagraphElement>('change-api-key-error');
  elements.serperKeyInput = required<HTMLInputElement>('serper-key');
  elements.serpapiKeyInput = required<HTMLInputElement>('serpapi-key');
  elements.bingKeyInput = required<HTMLInputElement>('bing-key');
  elements.searchBackendSelect = required<HTMLSelectElement>('search-backend-select');
  elements.saveSettingsBtn = required<HTMLElement>('save-settings');
  elements.settingsModelSelect = required<HTMLSelectElement>('settings-model-select');
  elements.setupModelSelect = required<HTMLSelectElement>('setup-model-select');
  elements.modelPickerBtn = required<HTMLButtonElement>('model-picker-btn');
  elements.modelPickerLabel = required<HTMLSpanElement>('model-picker-label');
  elements.modelPickerPopup = required<HTMLDivElement>('model-picker-popup');
  elements.modelPickerList = required<HTMLDivElement>('model-picker-list');
  elements.attachBtn = required<HTMLButtonElement>('attach-btn');
  elements.attachmentBar = required<HTMLDivElement>('attachment-bar');
  elements.chatArea = queryRequired<HTMLElement>('.chat-area');
  elements.browserToggle = required<HTMLElement>('browser-toggle');
  elements.panelContainer = required<HTMLDivElement>('panel-container');
  elements.browserUrlInput = required<HTMLInputElement>('browser-url');
  elements.browserUrlSuggestions = required<HTMLDivElement>('browser-url-suggestions');
  elements.browserGoBtn = required<HTMLElement>('browser-go');
  elements.browserBackBtn = required<HTMLElement>('browser-back');
  elements.browserForwardBtn = required<HTMLElement>('browser-forward');
  elements.browserReloadBtn = required<HTMLElement>('browser-reload');
  elements.sourceTabsContainer = required<HTMLDivElement>('source-tabs');
  elements.panelMinBtn = document.getElementById('panel-min-btn');
  elements.panelMaxBtn = document.getElementById('panel-max-btn');
  elements.panelCloseBtn = document.getElementById('panel-close-btn');
  elements.readmeToggle = required<HTMLButtonElement>('readme-toggle');
  elements.readmeView = required<HTMLDivElement>('readme-view');
  elements.readmeClose = required<HTMLButtonElement>('readme-close');
  elements.browserMenuBtn = required<HTMLButtonElement>('browser-menu-btn');
  elements.browserMenuDropdown = required<HTMLDivElement>('browser-menu-dropdown');
  elements.browserMenuBody = required<HTMLDivElement>('browser-menu-body');
  elements.browserHiddenQuote = required<HTMLParagraphElement>('browser-hidden-quote');
  elements.accountsList = required<HTMLDivElement>('accounts-list');
  elements.addAccountForm = required<HTMLDivElement>('add-account-form');
  elements.addAccountPlatform = required<HTMLInputElement>('add-account-platform');
  elements.addAccountUsername = required<HTMLInputElement>('add-account-username');
  elements.addAccountDomain = required<HTMLInputElement>('add-account-domain');
  elements.saveAccountBtn = required<HTMLButtonElement>('save-account-btn');
  elements.cancelAccountBtn = required<HTMLButtonElement>('cancel-account-btn');
  elements.addAccountBtn = required<HTMLButtonElement>('add-account-btn');
  elements.minBtn = document.getElementById('min-btn');
  elements.maxBtn = document.getElementById('max-btn');
  elements.closeBtn = document.getElementById('close-btn');
}
