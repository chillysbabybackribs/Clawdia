// ============================================================================
// IPC CHANNEL NAMES
// ============================================================================

// Renderer → Main (invoke)
export const IPC = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_NEW: 'chat:new',
  CHAT_LIST: 'chat:list',
  CHAT_LOAD: 'chat:load',
  CHAT_DELETE: 'chat:delete',
  CHAT_GET_TITLE: 'chat:get-title',
  CHAT_TABS_GET_STATE: 'chat:tabs:get-state',
  CHAT_TABS_SET_STATE: 'chat:tabs:set-state',

  // Browser (manual user control)
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_BACK: 'browser:back',
  BROWSER_FORWARD: 'browser:forward',
  BROWSER_REFRESH: 'browser:refresh',
  BROWSER_SET_BOUNDS: 'browser:set-bounds',
  BROWSER_TAB_NEW: 'browser:tab:new',
  BROWSER_TAB_LIST: 'browser:tab:list',
  BROWSER_TAB_SWITCH: 'browser:tab:switch',
  BROWSER_TAB_CLOSE: 'browser:tab:close',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // API key / setup
  API_KEY_GET: 'api-key:get',
  API_KEY_SET: 'api-key:set',
  API_KEY_CLEAR: 'api-key:clear',
  API_KEY_VALIDATE: 'api-key:validate',
  HAS_COMPLETED_SETUP: 'setup:has-completed',

  // Model
  MODEL_GET: 'model:get',
  MODEL_SET: 'model:set',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  GET_FREQUENT_SITES: 'frequent-sites:get',
} as const;

// Main → Renderer (send)
export const IPC_EVENTS = {
  // Chat streaming
  CHAT_STREAM_TEXT: 'chat:stream:text',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_THINKING: 'chat:thinking',
  CHAT_TOOL_START: 'chat:tool:start',
  CHAT_TOOL_RESULT: 'chat:tool:result',
  CHAT_ERROR: 'chat:error',
  CHAT_LIVE_HTML_START: 'chat:live-html:start',
  CHAT_LIVE_HTML_END: 'chat:live-html:end',

  // Browser state
  BROWSER_NAVIGATED: 'browser:navigated',
  BROWSER_TITLE: 'browser:title',
  BROWSER_LOADING: 'browser:loading',
  BROWSER_ERROR: 'browser:error',
  BROWSER_TABS_UPDATED: 'browser:tabs-updated',

  RESEARCH_PROGRESS: 'research:progress',
  FREQUENT_SITES_UPDATED: 'frequent-sites:updated',
} as const;
