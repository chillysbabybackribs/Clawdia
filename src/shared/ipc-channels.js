"use strict";
// ============================================================================
// IPC CHANNEL NAMES
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPC_EVENTS = exports.IPC = void 0;
// Renderer → Main (invoke)
exports.IPC = {
    // Chat
    CHAT_SEND: 'chat:send',
    CHAT_STOP: 'chat:stop',
    CHAT_NEW: 'chat:new',
    CHAT_LIST: 'chat:list',
    CHAT_LOAD: 'chat:load',
    CHAT_DELETE: 'chat:delete',
    // Browser (manual user control)
    BROWSER_NAVIGATE: 'browser:navigate',
    BROWSER_BACK: 'browser:back',
    BROWSER_FORWARD: 'browser:forward',
    BROWSER_REFRESH: 'browser:refresh',
    BROWSER_SET_BOUNDS: 'browser:set-bounds',
    // Settings
    SETTINGS_GET: 'settings:get',
    SETTINGS_SET: 'settings:set',
    // Window
    WINDOW_MINIMIZE: 'window:minimize',
    WINDOW_MAXIMIZE: 'window:maximize',
    WINDOW_CLOSE: 'window:close',
};
// Main → Renderer (send)
exports.IPC_EVENTS = {
    // Chat streaming
    CHAT_STREAM_TEXT: 'chat:stream:text',
    CHAT_STREAM_END: 'chat:stream:end',
    CHAT_TOOL_START: 'chat:tool:start',
    CHAT_TOOL_RESULT: 'chat:tool:result',
    CHAT_ERROR: 'chat:error',
    // Browser state
    BROWSER_NAVIGATED: 'browser:navigated',
    BROWSER_TITLE: 'browser:title',
    BROWSER_LOADING: 'browser:loading',
    BROWSER_ERROR: 'browser:error',
    RESEARCH_PROGRESS: 'research:progress',
};
//# sourceMappingURL=ipc-channels.js.map