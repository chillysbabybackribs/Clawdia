import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { BrowserTabInfo, FrequentSiteEntry } from '../shared/types';

// ============================================================================
// TYPE-SAFE API EXPOSED TO RENDERER
// ============================================================================

const api = {
  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  sendMessage: (conversationId: string, content: string) =>
    ipcRenderer.invoke(IPC.CHAT_SEND, conversationId, content),

  stopGeneration: () => ipcRenderer.invoke(IPC.CHAT_STOP),

  newConversation: () => ipcRenderer.invoke(IPC.CHAT_NEW),

  listConversations: () => ipcRenderer.invoke(IPC.CHAT_LIST),

  loadConversation: (id: string) => ipcRenderer.invoke(IPC.CHAT_LOAD, id),

  deleteConversation: (id: string) => ipcRenderer.invoke(IPC.CHAT_DELETE, id),

  getConversationTitle: (id: string) => ipcRenderer.invoke(IPC.CHAT_GET_TITLE, id),

  getChatTabState: () => ipcRenderer.invoke(IPC.CHAT_TABS_GET_STATE),

  saveChatTabState: (state: { tabIds: string[]; activeId: string | null }) =>
    ipcRenderer.invoke(IPC.CHAT_TABS_SET_STATE, state),

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

  getFrequentSites: () => ipcRenderer.invoke(IPC.GET_FREQUENT_SITES),
  onFrequentSitesUpdate: (callback: (entries: any[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entries: any[]) => callback(entries);
    ipcRenderer.on(IPC_EVENTS.FREQUENT_SITES_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.FREQUENT_SITES_UPDATED, handler);
  },

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------
  browserNavigate: (url: string) => ipcRenderer.invoke(IPC.BROWSER_NAVIGATE, url),

  browserBack: () => ipcRenderer.invoke(IPC.BROWSER_BACK),

  browserForward: () => ipcRenderer.invoke(IPC.BROWSER_FORWARD),

  browserRefresh: () => ipcRenderer.invoke(IPC.BROWSER_REFRESH),

  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke(IPC.BROWSER_SET_BOUNDS, bounds),

  browserTabNew: (url?: string) => ipcRenderer.invoke(IPC.BROWSER_TAB_NEW, url),

  browserTabList: () => ipcRenderer.invoke(IPC.BROWSER_TAB_LIST),

  browserTabSwitch: (tabId: string) => ipcRenderer.invoke(IPC.BROWSER_TAB_SWITCH, tabId),

  browserTabClose: (tabId: string) => ipcRenderer.invoke(IPC.BROWSER_TAB_CLOSE, tabId),

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
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),

  setSetting: (key: string, value: string) => ipcRenderer.invoke(IPC.SETTINGS_SET, key, value),

  // -------------------------------------------------------------------------
  // Window
  // -------------------------------------------------------------------------
  windowMinimize: () => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),

  windowMaximize: () => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE),

  windowClose: () => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
};

// Expose to renderer
console.log('[Preload] Exposing API to renderer...');
contextBridge.exposeInMainWorld('api', api);
console.log('[Preload] API exposed successfully');

// Type declaration for renderer
export type API = typeof api;
