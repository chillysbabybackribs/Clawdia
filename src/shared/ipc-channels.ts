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

  // Browser data management
  BROWSER_HISTORY_GET: 'browser:history:get',
  BROWSER_HISTORY_CLEAR: 'browser:history:clear',
  BROWSER_COOKIES_CLEAR: 'browser:cookies:clear',
  BROWSER_CLEAR_ALL: 'browser:clear-all',

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

  // Documents
  DOCUMENT_EXTRACT: 'document:extract',
  DOCUMENT_SAVE: 'document:save',
  DOCUMENT_OPEN_FOLDER: 'document:open-folder',
  FILE_OPEN: 'file:open',
  FILE_OPEN_IN_APP: 'file:open-in-app',

  // Utilities
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',

  // Logging
  LOG_LEVEL_SET: 'log:level:set',

  // Accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ADD: 'accounts:add',
  ACCOUNTS_REMOVE: 'accounts:remove',

  // Store management
  STORE_RESET: 'store:reset',

  // Learning / memory
  MEMORY_GET_ALL: 'memory:get-all',
  MEMORY_FORGET: 'memory:forget',
  MEMORY_RESET: 'memory:reset',
  SITE_KNOWLEDGE_GET: 'site-knowledge:get',
  SITE_KNOWLEDGE_RESET: 'site-knowledge:reset',

  // Vault
  VAULT_INGEST_FILE: 'vault:ingest:file',
  VAULT_SEARCH: 'vault:search',
  VAULT_GET_JOB: 'vault:get-job',
  VAULT_GET_DOC: 'vault:get-doc',

  // Tool loop continuation
  CHAT_CONTINUE_RESPONSE: 'chat:continue-response',

  // Dashboard
  DASHBOARD_GET: 'dashboard:get',
  DASHBOARD_DISMISS_RULE: 'dashboard:dismiss-rule',
  DASHBOARD_DISMISS_ALERT: 'dashboard:dismiss-alert',
  DASHBOARD_SET_VISIBLE: 'dashboard:set-visible',

  // Ambient settings
  AMBIENT_SETTINGS_GET: 'ambient:settings:get',
  AMBIENT_SETTINGS_SET: 'ambient:settings:set',

  // Tasks
  TASK_LIST: 'task:list',
  TASK_GET: 'task:get',
  TASK_DELETE: 'task:delete',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_RUN_NOW: 'task:run-now',
  TASK_APPROVE_RUN: 'task:approve-run',
  TASK_DISMISS_RUN: 'task:dismiss-run',
  TASK_GET_UNREAD: 'task:get-unread',
  TASK_CLEAR_UNREAD: 'task:clear-unread',
  TASK_GET_RUNS: 'task:get-runs',
  TASK_GET_EXECUTOR: 'task:get-executor',

  // Telegram
  TELEGRAM_GET_CONFIG: 'telegram:get-config',
  TELEGRAM_SET_TOKEN: 'telegram:set-token',
  TELEGRAM_SET_ENABLED: 'telegram:set-enabled',
  TELEGRAM_CLEAR_AUTH: 'telegram:clear-auth',

  // Actions
  ACTION_CREATE_PLAN: 'action:create-plan',
  ACTION_ADD_ITEM: 'action:add-item',
  ACTION_EXECUTE_PLAN: 'action:execute-plan',
  ACTION_UNDO_PLAN: 'action:undo-plan',
  ACTION_GET_PLAN: 'action:get-plan',
  ACTION_GET_ITEMS: 'action:get-items',
} as const;

// Main → Renderer (send)
export const IPC_EVENTS = {
  // Chat streaming
  CHAT_STREAM_TEXT: 'chat:stream:text',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_STREAM_RESET: 'chat:stream:reset',
  CHAT_THINKING: 'chat:thinking',
  CHAT_TOOL_START: 'chat:tool:start',
  CHAT_TOOL_RESULT: 'chat:tool:result',
  TOOL_EXEC_START: 'chat:tool-exec:start',
  TOOL_EXEC_COMPLETE: 'chat:tool-exec:complete',
  TOOL_STEP_PROGRESS: 'chat:tool-exec:step-progress',
  TOOL_LOOP_COMPLETE: 'chat:tool-exec:loop-complete',
  TOKEN_USAGE_UPDATE: 'chat:token-usage:update',
  CHAT_ERROR: 'chat:error',
  CHAT_LIVE_HTML_START: 'chat:live-html:start',
  CHAT_LIVE_HTML_END: 'chat:live-html:end',
  CHAT_TOOL_ACTIVITY: 'chat:tool:activity',
  CHAT_TOOL_ACTIVITY_SUMMARY: 'chat:tool:activity:summary',
  CHAT_UPDATED: 'chat:updated',
  API_USAGE_WARNING: 'api:usage:warning',
  CHAT_ROUTE_INFO: 'chat:route:info',
  CHAT_TOOL_LIMIT_REACHED: 'chat:tool-limit:reached',

  // Browser state
  BROWSER_NAVIGATED: 'browser:navigated',
  BROWSER_TITLE: 'browser:title',
  BROWSER_LOADING: 'browser:loading',
  BROWSER_ERROR: 'browser:error',
  BROWSER_TABS_UPDATED: 'browser:tabs-updated',

  RESEARCH_PROGRESS: 'research:progress',

  // Documents
  DOC_PROGRESS: 'doc:progress',
  CHAT_DOCUMENT_CREATED: 'chat:document:created',

  // Accounts
  ACCOUNTS_UPDATED: 'accounts:updated',
  VAULT_JOB_UPDATE: 'vault:job:update',

  // Dashboard
  DASHBOARD_UPDATE: 'dashboard:update',

  // Tasks
  TASK_STATE_UPDATE: 'task:state:update',
  TASK_FOCUS: 'task:focus',
  TASK_APPROVAL_FOCUS: 'task:approval:focus',
  TASK_RUN_NOTIFICATION: 'task:run:notification',
} as const;
