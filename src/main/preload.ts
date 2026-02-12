import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { DEFAULT_MODEL } from '../shared/models';
import {
  BrowserTabInfo,
  ImageAttachment,
  DocumentAttachment,
  DocProgressEvent,
  ToolActivityEntry,
  ToolActivitySummary,
  ToolExecStartEvent,
  ToolExecCompleteEvent,
  ToolStepProgressEvent,
  ToolLoopCompleteEvent,
} from '../shared/types';
import {
  ApprovalRequest,
  ApprovalDecision,
} from '../shared/autonomy';
import type { AuditEvent, AuditQueryFilters, AuditSummary } from '../shared/audit-types';
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

  onStreamReset: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_EVENTS.CHAT_STREAM_RESET, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_STREAM_RESET, handler);
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

  onToolLimitReached: (callback: (data: { toolCallCount: number; maxToolCalls: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_TOOL_LIMIT_REACHED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_TOOL_LIMIT_REACHED, handler);
  },

  respondToToolLimit: (shouldContinue: boolean) => {
    return ipcRenderer.invoke(IPC.CHAT_CONTINUE_RESPONSE, { continue: shouldContinue });
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

  // Live tool execution feed
  onToolExecStart: (callback: (payload: ToolExecStartEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ToolExecStartEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOOL_EXEC_START, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_EXEC_START, handler);
  },

  onToolExecComplete: (callback: (payload: ToolExecCompleteEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ToolExecCompleteEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOOL_EXEC_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_EXEC_COMPLETE, handler);
  },

  onToolStepProgress: (callback: (payload: ToolStepProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ToolStepProgressEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOOL_STEP_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_STEP_PROGRESS, handler);
  },

  onToolOutput: (callback: (data: { toolId: string; chunk: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.TOOL_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_OUTPUT, handler);
  },

  onToolLoopComplete: (callback: (payload: ToolLoopCompleteEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ToolLoopCompleteEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOOL_LOOP_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_LOOP_COMPLETE, handler);
  },

  onToolTiming: (callback: (payload: import('../shared/types').ToolTimingEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('../shared/types').ToolTimingEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOOL_TIMING, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOOL_TIMING, handler);
  },

  onTokenUsageUpdate: (callback: (payload: import('../shared/types').TokenUsageUpdateEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('../shared/types').TokenUsageUpdateEvent) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.TOKEN_USAGE_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TOKEN_USAGE_UPDATE, handler);
  },
  onRouteInfo: (callback: (info: { model: string; iteration: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; durationMs: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on(IPC_EVENTS.CHAT_ROUTE_INFO, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_ROUTE_INFO, handler);
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

  onChatUpdated: (callback: (data: { conversationId: string; conversation: any }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_UPDATED, handler);
  },

  onAgentCountUpdate: (callback: (count: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, count: number) => callback(count);
    ipcRenderer.on(IPC_EVENTS.AGENT_COUNT_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.AGENT_COUNT_UPDATE, handler);
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

  openFile: (filePath: string) =>
    invokeChecked(IPC.FILE_OPEN, { filePath }),

  openFileInApp: (filePath: string) =>
    invokeChecked(IPC.FILE_OPEN_IN_APP, { filePath }),

  onDocumentCreated: (callback: (data: { filePath: string; filename: string; sizeBytes: number; format: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.CHAT_DOCUMENT_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.CHAT_DOCUMENT_CREATED, handler);
  },

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  listAccounts: () => invokeChecked(IPC.ACCOUNTS_LIST),
  addAccount: (data: { domain: string; platform: string; username: string; profileUrl: string }) =>
    invokeChecked(IPC.ACCOUNTS_ADD, data),
  removeAccount: (id: string) => invokeChecked(IPC.ACCOUNTS_REMOVE, { id }),
  onAccountsUpdated: (cb: (accounts: any[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, accounts: any[]) => cb(accounts);
    ipcRenderer.on(IPC_EVENTS.ACCOUNTS_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.ACCOUNTS_UPDATED, handler);
  },

  // -------------------------------------------------------------------------
  // Store management
  // -------------------------------------------------------------------------
  resetStore: () => invokeChecked(IPC.STORE_RESET),

  // Learning / memory
  memoryGetAll: () => invokeChecked(IPC.MEMORY_GET_ALL),
  memoryForget: (category: string, key: string) => invokeChecked(IPC.MEMORY_FORGET, { category, key }),
  memoryReset: () => invokeChecked(IPC.MEMORY_RESET),
  siteKnowledgeGet: (hostname: string) => invokeChecked(IPC.SITE_KNOWLEDGE_GET, { hostname }),
  siteKnowledgeReset: () => invokeChecked(IPC.SITE_KNOWLEDGE_RESET),

  // -------------------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------------------
  vaultIngest: (filePath: string) => invokeChecked(IPC.VAULT_INGEST_FILE, { filePath }),

  vaultSearch: (query: string, limit?: number) => invokeChecked(IPC.VAULT_SEARCH, { query, limit }),

  vaultGetJob: (id: string) => invokeChecked(IPC.VAULT_GET_JOB, { id }),

  onVaultJobUpdate: (callback: (job: import('../shared/vault-types').IngestionJob) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, job: any) => callback(job);
    ipcRenderer.on(IPC_EVENTS.VAULT_JOB_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.VAULT_JOB_UPDATE, handler);
  },

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  actionCreatePlan: (description: string) => invokeChecked(IPC.ACTION_CREATE_PLAN, { description }),

  actionAddItem: (planId: string, type: import('../shared/vault-types').ActionType, payload: any, sequenceOrder: number) =>
    invokeChecked(IPC.ACTION_ADD_ITEM, { planId, type, payload, sequenceOrder }),

  actionExecutePlan: (planId: string) => invokeChecked(IPC.ACTION_EXECUTE_PLAN, { planId }),

  actionUndoPlan: (planId: string) => invokeChecked(IPC.ACTION_UNDO_PLAN, { planId }),

  actionGetPlan: (planId: string) => invokeChecked(IPC.ACTION_GET_PLAN, { planId }),

  actionGetItems: (planId: string) => invokeChecked(IPC.ACTION_GET_ITEMS, { planId }),

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------
  getDashboard: () => invokeChecked(IPC.DASHBOARD_GET),

  dismissDashboardRule: (ruleId: string) =>
    invokeChecked(IPC.DASHBOARD_DISMISS_RULE, { ruleId }),

  dismissDashboardAlert: (alertId: string) =>
    invokeChecked(IPC.DASHBOARD_DISMISS_ALERT, { alertId }),

  setDashboardVisible: (visible: boolean) =>
    invokeChecked(IPC.DASHBOARD_SET_VISIBLE, { visible }),

  onDashboardUpdate: (callback: (state: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: any) => callback(state);
    ipcRenderer.on(IPC_EVENTS.DASHBOARD_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.DASHBOARD_UPDATE, handler);
  },

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  taskList: () => invokeChecked(IPC.TASK_LIST),
  taskGet: (taskId: string) => invokeChecked(IPC.TASK_GET, { taskId }),
  taskDelete: (taskId: string) => invokeChecked(IPC.TASK_DELETE, { taskId }),
  taskPause: (taskId: string) => invokeChecked(IPC.TASK_PAUSE, { taskId }),
  taskResume: (taskId: string) => invokeChecked(IPC.TASK_RESUME, { taskId }),
  taskRunNow: (taskId: string) => invokeChecked(IPC.TASK_RUN_NOW, { taskId }),
  taskApproveRun: (runId: string) => invokeChecked(IPC.TASK_APPROVE_RUN, { runId }),
  taskDismissRun: (runId: string) => invokeChecked(IPC.TASK_DISMISS_RUN, { runId }),
  taskGetUnread: () => invokeChecked(IPC.TASK_GET_UNREAD),
  taskClearUnread: () => invokeChecked(IPC.TASK_CLEAR_UNREAD),
  taskGetRuns: (taskId: string) => invokeChecked(IPC.TASK_GET_RUNS, { taskId }),
  taskGetExecutor: (taskId: string) => invokeChecked(IPC.TASK_GET_EXECUTOR, { taskId }),

  onTaskStateUpdate: (callback: (items: any[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: any[]) => callback(items);
    ipcRenderer.on(IPC_EVENTS.TASK_STATE_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TASK_STATE_UPDATE, handler);
  },

  onTaskFocus: (callback: (taskId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string) => callback(taskId);
    ipcRenderer.on(IPC_EVENTS.TASK_FOCUS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TASK_FOCUS, handler);
  },

  onTaskApprovalFocus: (callback: (runId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, runId: string) => callback(runId);
    ipcRenderer.on(IPC_EVENTS.TASK_APPROVAL_FOCUS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TASK_APPROVAL_FOCUS, handler);
  },

  onTaskRunNotification: (callback: (data: {
    taskId: string;
    description: string;
    status: string;
    responseText: string;
    errorMessage?: string;
    durationMs: number;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_EVENTS.TASK_RUN_NOTIFICATION, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.TASK_RUN_NOTIFICATION, handler);
  },

  // -------------------------------------------------------------------------
  // Ambient Settings
  // -------------------------------------------------------------------------
  getAmbientSettings: () => invokeChecked(IPC.AMBIENT_SETTINGS_GET),

  setAmbientSettings: (settings: Record<string, unknown>) =>
    invokeChecked(IPC.AMBIENT_SETTINGS_SET, { settings }),

  // -------------------------------------------------------------------------
  // Autonomy mode
  // -------------------------------------------------------------------------
  getAutonomyMode: () => invokeChecked(IPC.AUTONOMY_GET),

  setAutonomyMode: (mode: string, confirmUnrestricted?: boolean) =>
    invokeChecked(IPC.AUTONOMY_SET, { mode, confirmUnrestricted }),

  onApprovalRequest: (callback: (request: ApprovalRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ApprovalRequest) => callback(request);
    ipcRenderer.on(IPC_EVENTS.APPROVAL_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.APPROVAL_REQUEST, handler);
  },

  sendApprovalResponse: (id: string, decision: ApprovalDecision) =>
    invokeChecked(IPC.APPROVAL_RESPONSE, { id, decision }),

  getAutonomyAlwaysApprovals: () => invokeChecked(IPC.AUTONOMY_GET_ALWAYS_APPROVALS),

  removeAutonomyAlwaysApproval: (risk: string) => invokeChecked(IPC.AUTONOMY_REMOVE_ALWAYS_APPROVAL, { risk }),

  // -------------------------------------------------------------------------
  // Audit / Security Timeline
  // -------------------------------------------------------------------------
  getAuditEvents: (filters?: AuditQueryFilters): Promise<AuditEvent[]> =>
    ipcRenderer.invoke(IPC.AUDIT_GET_EVENTS, filters || {}),

  clearAuditEvents: (): Promise<{ success: boolean; count: number }> =>
    ipcRenderer.invoke(IPC.AUDIT_CLEAR),

  getAuditSummary: (): Promise<AuditSummary> =>
    ipcRenderer.invoke(IPC.AUDIT_GET_SUMMARY),

  onAuditEvent: (callback: (event: AuditEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, auditEvent: AuditEvent) => callback(auditEvent);
    ipcRenderer.on(IPC_EVENTS.AUDIT_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.AUDIT_EVENT, handler);
  },

  // -------------------------------------------------------------------------
  // Telegram
  // -------------------------------------------------------------------------
  telegramGetConfig: () => invokeChecked(IPC.TELEGRAM_GET_CONFIG),

  telegramSetToken: (token: string) => invokeChecked(IPC.TELEGRAM_SET_TOKEN, { token }),

  telegramSetEnabled: (enabled: boolean) => invokeChecked(IPC.TELEGRAM_SET_ENABLED, { enabled }),

  telegramClearAuth: () => invokeChecked(IPC.TELEGRAM_CLEAR_AUTH),

};

// Expose to renderer
log.info('Exposing API to renderer');
contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('clawdia', api);
log.info('API exposed successfully');

// Type declaration for renderer
export type API = typeof api;
