"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ipc_channels_1 = require("../shared/ipc-channels");
// ============================================================================
// TYPE-SAFE API EXPOSED TO RENDERER
// ============================================================================
const api = {
    // -------------------------------------------------------------------------
    // Chat
    // -------------------------------------------------------------------------
    sendMessage: (conversationId, content) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_SEND, conversationId, content),
    stopGeneration: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_STOP),
    newConversation: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_NEW),
    listConversations: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_LIST),
    loadConversation: (id) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_LOAD, id),
    deleteConversation: (id) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.CHAT_DELETE, id),
    // Chat event listeners
    onStreamText: (callback) => {
        const handler = (_event, text) => callback(text);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_TEXT, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_TEXT, handler);
    },
    onStreamEnd: (callback) => {
        const handler = (_event, fullText) => callback(fullText);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_END, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_END, handler);
    },
    onToolStart: (callback) => {
        const handler = (_event, data) => callback(data);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.CHAT_TOOL_START, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.CHAT_TOOL_START, handler);
    },
    onToolResult: (callback) => {
        const handler = (_event, data) => callback(data);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.CHAT_TOOL_RESULT, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.CHAT_TOOL_RESULT, handler);
    },
    onChatError: (callback) => {
        const handler = (_event, error) => callback(error);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.CHAT_ERROR, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.CHAT_ERROR, handler);
    },
    onResearchProgress: (callback) => {
        const handler = (_event, progress) => callback(progress);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.RESEARCH_PROGRESS, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.RESEARCH_PROGRESS, handler);
    },
    // -------------------------------------------------------------------------
    // Browser
    // -------------------------------------------------------------------------
    browserNavigate: (url) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.BROWSER_NAVIGATE, url),
    browserBack: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.BROWSER_BACK),
    browserForward: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.BROWSER_FORWARD),
    browserRefresh: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.BROWSER_REFRESH),
    browserSetBounds: (bounds) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.BROWSER_SET_BOUNDS, bounds),
    // Browser event listeners
    onBrowserNavigated: (callback) => {
        const handler = (_event, url) => callback(url);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.BROWSER_NAVIGATED, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.BROWSER_NAVIGATED, handler);
    },
    onBrowserTitle: (callback) => {
        const handler = (_event, title) => callback(title);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.BROWSER_TITLE, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.BROWSER_TITLE, handler);
    },
    onBrowserLoading: (callback) => {
        const handler = (_event, loading) => callback(loading);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.BROWSER_LOADING, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.BROWSER_LOADING, handler);
    },
    onBrowserError: (callback) => {
        const handler = (_event, error) => callback(error);
        electron_1.ipcRenderer.on(ipc_channels_1.IPC_EVENTS.BROWSER_ERROR, handler);
        return () => electron_1.ipcRenderer.removeListener(ipc_channels_1.IPC_EVENTS.BROWSER_ERROR, handler);
    },
    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------
    getSettings: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.SETTINGS_GET),
    setSetting: (key, value) => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.SETTINGS_SET, key, value),
    // -------------------------------------------------------------------------
    // Window
    // -------------------------------------------------------------------------
    windowMinimize: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.WINDOW_MINIMIZE),
    windowMaximize: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.WINDOW_MAXIMIZE),
    windowClose: () => electron_1.ipcRenderer.invoke(ipc_channels_1.IPC.WINDOW_CLOSE),
};
// Expose to renderer
console.log('[Preload] Exposing API to renderer...');
electron_1.contextBridge.exposeInMainWorld('api', api);
console.log('[Preload] API exposed successfully');
//# sourceMappingURL=preload.js.map