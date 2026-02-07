import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { DEFAULT_MODEL } from '../shared/models';
import { BrowserTabInfo, ImageAttachment, DocumentAttachment, DocProgressEvent, ToolActivityEntry, ToolActivitySummary } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('preload');

type InvalidPayloadResponse = {
  code: 'INVALID_PAYLOAD';
  error: string;
};

function isInvalidPayloadResponse(value: unknown): value is InvalidPayloadResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'code' in (value as Record<string, unknown>) &&
      'error' in (value as Record<string, unknown>) &&
      (value as Record<string, unknown>).code === 'INVALID_PAYLOAD'
  );
}

async function invokeChecked(channel: string, payload?: unknown): Promise<any> {
  const result = payload === undefined
    ? await ipcRenderer.invoke(channel)
    : await ipcRenderer.invoke(channel, payload);

  if (isInvalidPayloadResponse(result)) {
    const message = `IPC payload rejected [${channel}]: ${result.error}`;
    log.warn(message);
    console.error(message);
  }

  return result;
}

// ============================================================================
// TYPE-SAFE API EXPOSED TO RENDERER
// ============================================================================

const api = {
  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  sendMessage: (conversationId: string, content: string, images?: ImageAttachment[], documents?: DocumentAttachment[], messageId?: string) =>
    invokeChecked(IPC.CHAT_SEND, {
      conversationId,
      message: content,
      images,
      documents,
      messageId,
    }),

  stopGeneration: () => invokeChecked(IPC.CHAT_STOP),

  newConversation: () => invokeChecked(IPC.CHAT_NEW),

  listConversations: () => invokeChecked(IPC.CHAT_LIST),

  loadConversation: (id: string) => invokeChecked(IPC.CHAT_LOAD, { id }),

  deleteConversation: (id: string) => invokeChecked(IPC.CHAT_DELETE, { id }),

  getConversationTitle: (id: string) => invokeChecked(IPC.CHAT_GET_TITLE, { id }),

  getChatTabState: () => invokeChecked(IPC.CHAT_TABS_GET_STATE),

  saveChatTabState: (state: { tabIds: string[]; activeId: string | null }) =>
    invokeChecked(IPC.CHAT_TABS_SET_STATE, state),

  // Chat event listeners
  onStreamText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
    ipcRenderer.on(IPC_EVENTS.CHAT_STREAM_TEXT, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_STREAM_TEXT, handler);
  },

  onStreamEnd: (callback: (fullText: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, fullText: string) => callback(fullText);
    ipcRenderer.on(IPC_EVENTS.CHAT_STREAM_END, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_STREAM_END, handler);
  },

  onThinking: (callback: (thought: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, thought: string) => callback(thought);
    ipcRenderer.on(IPC_EVENTS.CHAT_THINKING, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_THINKING, handler);
  },

  onToolStart: (callback: (data: { id: string; name: string; input: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_TOOL_START, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_TOOL_START, handler);
  },

  onToolResult: (callback: (data: { id: string; result: string; isError: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_TOOL_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_TOOL_RESULT, handler);
  },

  onChatError: (callback: (error: { error: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: any) => callback(error);
    ipcRenderer.on(IPC_EVENTS.CHAT_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_ERROR, handler);
  },

  onToolActivity: (callback: (entry: ToolActivityEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: ToolActivityEntry) => callback(entry);
    ipcRenderer.on(IPC_EVENTS.CHAT_TOOL_ACTIVITY, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_TOOL_ACTIVITY, handler);
  },

  onToolActivitySummary: (callback: (summary: ToolActivitySummary) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, summary: ToolActivitySummary) => callback(summary);
    ipcRenderer.on(IPC_EVENTS.CHAT_TOOL_ACTIVITY_SUMMARY, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_TOOL_ACTIVITY_SUMMARY, handler);
  },

  onLiveHtmlStart: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_EVENTS.CHAT_LIVE_HTML_START, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_LIVE_HTML_START, handler);
  },

  onLiveHtmlEnd: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_EVENTS.CHAT_LIVE_HTML_END, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_LIVE_HTML_END, handler);
  },

  onResearchProgress: (callback: (progress: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress);
    ipcRenderer.on(IPC_EVENTS.RESEARCH_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.RESEARCH_PROGRESS, handler);
  },

  onDocProgress: (callback: (payload: DocProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DocProgressEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.DOC_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.DOC_PROGRESS, handler);
  },

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------
  browserNavigate: (url: string) => invokeChecked(IPC.BROWSER_NAVIGATE, { url }),

  browserBack: () => invokeChecked(IPC.BROWSER_BACK),

  browserForward: () => invokeChecked(IPC.BROWSER_FORWARD),

  browserRefresh: () => invokeChecked(IPC.BROWSER_REFRESH),

  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    invokeChecked(IPC.BROWSER_SET_BOUNDS, bounds),

  browserTabNew: (url?: string) => invokeChecked(IPC.BROWSER_TAB_NEW, { url }),

  browserTabList: () => invokeChecked(IPC.BROWSER_TAB_LIST),

  browserTabSwitch: (tabId: string) => invokeChecked(IPC.BROWSER_TAB_SWITCH, { tabId }),

  browserTabClose: (tabId: string) => invokeChecked(IPC.BROWSER_TAB_CLOSE, { tabId }),

  // Browser data management
  browserHistoryGet: () => invokeChecked(IPC.BROWSER_HISTORY_GET),
  browserHistoryClear: () => invokeChecked(IPC.BROWSER_HISTORY_CLEAR),
  browserCookiesClear: () => invokeChecked(IPC.BROWSER_COOKIES_CLEAR),
  browserClearAll: () => invokeChecked(IPC.BROWSER_CLEAR_ALL),

  // Browser event listeners
  onBrowserNavigated: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on(IPC_EVENTS.BROWSER_NAVIGATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.BROWSER_NAVIGATED, handler);
  },

  onBrowserTitle: (callback: (title: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, title: string) => callback(title);
    ipcRenderer.on(IPC_EVENTS.BROWSER_TITLE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.BROWSER_TITLE, handler);
  },

  onBrowserLoading: (callback: (loading: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, loading: boolean) => callback(loading);
    ipcRenderer.on(IPC_EVENTS.BROWSER_LOADING, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.BROWSER_LOADING, handler);
  },

  onBrowserError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on(IPC_EVENTS.BROWSER_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.BROWSER_ERROR, handler);
  },

  onTabsUpdated: (callback: (tabs: BrowserTabInfo[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabs: BrowserTabInfo[]) => callback(tabs);
    ipcRenderer.on(IPC_EVENTS.BROWSER_TABS_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.BROWSER_TABS_UPDATED, handler);
  },

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  getApiKey: () => invokeChecked(IPC.API_KEY_GET),

  setApiKey: (key: string) => invokeChecked(IPC.API_KEY_SET, { key }),

  hasCompletedSetup: () => invokeChecked(IPC.HAS_COMPLETED_SETUP),

  clearApiKey: () => invokeChecked(IPC.API_KEY_CLEAR),

  validateApiKey: async (key: string) => {
    const model = await invokeChecked(IPC.MODEL_GET);
    const safeModel = typeof model === 'string' && model.trim() ? model : DEFAULT_MODEL;
    return invokeChecked(IPC.API_KEY_VALIDATE, { key, model: safeModel });
  },

  getSettings: () => invokeChecked(IPC.SETTINGS_GET),

  setSetting: (key: string, value: string | boolean) => invokeChecked(IPC.SETTINGS_SET, { key, value }),

  getSelectedModel: () => invokeChecked(IPC.MODEL_GET),

  setSelectedModel: (model: string) => invokeChecked(IPC.MODEL_SET, { model }),

  validateApiKeyWithModel: (key: string, model: string) => invokeChecked(IPC.API_KEY_VALIDATE, { key, model }),

  // -------------------------------------------------------------------------
  // Window
  // -------------------------------------------------------------------------
  windowMinimize: () => invokeChecked(IPC.WINDOW_MINIMIZE),

  windowMaximize: () => invokeChecked(IPC.WINDOW_MAXIMIZE),

  windowClose: () => invokeChecked(IPC.WINDOW_CLOSE),

  clipboardWriteText: (text: string) => invokeChecked(IPC.CLIPBOARD_WRITE_TEXT, { text }),

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  extractDocument: (data: { buffer: number[]; filename: string; mimeType: string }) =>
    invokeChecked(IPC.DOCUMENT_EXTRACT, data),

  saveDocument: (sourcePath: string, suggestedName: string) =>
    invokeChecked(IPC.DOCUMENT_SAVE, { sourcePath, suggestedName }),

  openDocumentFolder: (filePath: string) =>
    invokeChecked(IPC.DOCUMENT_OPEN_FOLDER, { filePath }),

  onDocumentCreated: (callback: (data: { filePath: string; filename: string; sizeBytes: number; format: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_DOCUMENT_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_DOCUMENT_CREATED, handler);
  },

  // -------------------------------------------------------------------------
  // Store management
  // -------------------------------------------------------------------------
  resetStore: () => invokeChecked(IPC.STORE_RESET),
};

// Expose to renderer
log.info('Exposing API to renderer');
contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('clawdia', api);
log.info('API exposed successfully');

// Type declaration for renderer
export type API = typeof api;
