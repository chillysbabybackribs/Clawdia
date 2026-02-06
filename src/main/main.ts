// Must run before Electron app initialization so Linux packaging paths do not hit SUID sandbox startup checks.
if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = 'true';
}

import { app, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { DocumentMeta } from '../shared/types';
import { extractDocument } from './documents/extractor';
import { createDocument } from './documents/creator';
import { setupBrowserIpc, setMainWindow, closeBrowser, initPlaywright, setCdpPort, stopSessionReaper, killOrphanedCDPProcesses } from './browser/manager';
import { registerPlaywrightSearchFallback } from './browser/tools';
import { AnthropicClient } from './llm/client';
import { ConversationManager } from './llm/conversation';
import { ToolLoop, clearPrefetchCache } from './llm/tool-loop';
import { store, runMigrations, resetStore, type ChatTabState, type ClawdiaStoreSchema } from './store';
import { DEFAULT_MODEL } from '../shared/models';
import { usageTracker } from './usage-tracker';
import { createLogger, setLogLevel, type LogLevel } from './logger';
import { handleValidated, ipcSchemas } from './ipc-validator';

const log = createLogger('main');

// Pick a free CDP port before Electron starts.
// Must be synchronous because appendSwitch must run at module load time.
function pickFreePort(candidates: number[]): number {
  for (const port of candidates) {
    try {
      // ss output format: "LISTEN  0  10  127.0.0.1:9222  0.0.0.0:*"
      // Use grep -E with word boundary after port number to avoid partial matches.
      execSync(`ss -tln | grep -qE ':${port}\\b'`, { stdio: 'ignore' });
      // grep succeeded → port is in use, skip.
      log.debug(`Port ${port} in use, trying next...`);
    } catch {
      // grep failed → port is free.
      return port;
    }
  }
  return candidates[0];
}

const CDP_CANDIDATES = [9222, 9223, 9224, 9225, 9226, 9227];
const envPort = process.env.CLAWDIA_CDP_PORT ? Number(process.env.CLAWDIA_CDP_PORT) : null;
const portList = envPort ? [envPort, ...CDP_CANDIDATES.filter((p) => p !== envPort)] : CDP_CANDIDATES;
const REMOTE_DEBUGGING_PORT = pickFreePort(portList);

app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUGGING_PORT));
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
}
// FedCM is currently flaky in embedded Chromium flows (e.g., Google sign-in on claude.ai).
// Force classic OAuth popup/redirect fallback instead of navigator.credentials.get().
app.commandLine.appendSwitch('disable-features', 'FedCm');
log.info(`CDP debug port: ${REMOTE_DEBUGGING_PORT}`);

if (process.env.NODE_ENV !== 'production') {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

let mainWindow: BrowserWindow | null = null;
let conversationManager: ConversationManager;
let activeToolLoop: ToolLoop | null = null;

// Cache the AnthropicClient to reuse HTTP connection pooling.
let cachedClient: AnthropicClient | null = null;
let cachedClientApiKey: string | null = null;
let cachedClientModel: string | null = null;

function getClient(apiKey: string, model: string): AnthropicClient {
  if (cachedClient && cachedClientApiKey === apiKey && cachedClientModel === model) return cachedClient;
  cachedClient = new AnthropicClient(apiKey, model);
  cachedClientApiKey = apiKey;
  cachedClientModel = model;
  return cachedClient;
}

function getSelectedModel(): string {
  return ((store.get('selectedModel') as string) || DEFAULT_MODEL);
}
const CHAT_TAB_STATE_KEY: keyof ClawdiaStoreSchema = 'chat_tab_state';
const CONNECTION_WARMUP_TARGETS = [
  'https://api.anthropic.com/',
  'https://google.serper.dev/',
  'https://api.search.brave.com/',
];

function getAnthropicApiKey(): string {
  return ((store.get('anthropicApiKey') as string | undefined) ?? '').trim();
}

function getMaskedAnthropicApiKey(): string {
  const key = getAnthropicApiKey();
  if (!key) return '';
  const suffix = key.slice(-4);
  return `sk-ant-...${suffix}`;
}

function sanitizeChatTabState(input: unknown): ChatTabState {
  const state = (input ?? {}) as Partial<ChatTabState>;
  const tabIds = Array.isArray(state.tabIds)
    ? state.tabIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const activeId = typeof state.activeId === 'string' ? state.activeId : null;
  return { tabIds, activeId };
}

async function warmConnections(): Promise<void> {
  await Promise.allSettled(
    CONNECTION_WARMUP_TARGETS.map((url) =>
      fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      })
    )
  );
}

async function warmAnthropicMessagesConnection(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) return;
  const model = getSelectedModel();
  try {
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    // Connection warmup is best effort.
  }
}

runMigrations(store);

async function validateAnthropicApiKey(key: string, model?: string): Promise<{ valid: boolean; error?: string }> {
  const normalized = key.trim();
  if (!normalized) {
    return { valid: false, error: 'API key is required.' };
  }

  const validationModel = model || getSelectedModel();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': normalized,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: validationModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok || response.status === 200) {
      return { valid: true };
    }

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.status === 401) {
      return { valid: false, error: 'Invalid API key.' };
    }
    if (response.status === 403) {
      return { valid: false, error: 'API key lacks permissions. Check your Anthropic console.' };
    }
    return {
      valid: false,
      error: payload?.error?.message || 'Validation failed.',
    };
  } catch {
    return { valid: false, error: 'Could not reach Anthropic API. Check your internet connection.' };
  }
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, 'preload.js');
  log.debug(`Preload absolute path: ${preloadPath}`);

  if (!fs.existsSync(preloadPath)) {
    log.error(`Preload file does not exist at: ${preloadPath}`);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#161616',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
    },
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      event.preventDefault();
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // -------------------------------------------------------------------
  // CSP header enforcement (defense in depth — HTTP headers override meta tags)
  // In production: locked-down policy, no eval, no inline scripts.
  // In development: permissive for Vite HMR hot reload.
  // Only applied to the renderer's own pages, NOT the BrowserView panel.
  // -------------------------------------------------------------------
  const PROD_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data: blob: https://www.google.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  const DEV_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' http://localhost:* ws://localhost:*",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
  ].join('; ');

  const isDev = process.env.NODE_ENV === 'development';
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? DEV_CSP : PROD_CSP],
      },
    });
  });

  setMainWindow(mainWindow);
  usageTracker.setWarningEmitter((event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(event, payload);
  });
  conversationManager = new ConversationManager(store);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Kill any orphaned CDP processes from a prior crashed session before connecting.
    killOrphanedCDPProcesses();
    // CDP server is reliably up once the window is ready to show.
    // Kick off Playwright connection here so it doesn't race.
    void initPlaywright().then(() => registerPlaywrightSearchFallback());

    // Warm DNS + TCP + TLS connections to API endpoints (fire-and-forget).
    // Eliminates cold-start latency on first search/LLM call.
    void warmConnections();
  });

  mainWindow.on('closed', () => {
    usageTracker.setWarningEmitter(null);
    mainWindow = null;
    void closeBrowser();
  });
}

function setupIpcHandlers(): void {
  handleValidated(IPC.CHAT_SEND, ipcSchemas[IPC.CHAT_SEND], async (_event, payload) => {
    const { conversationId, message, images, documents, messageId } = payload;
    if (!mainWindow) return { error: 'No window' };

    let conversation = conversationManager.get(conversationId || '');
    if (!conversation) {
      conversation = conversationManager.create();
    }

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      mainWindow.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
      mainWindow.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: 'No API key configured' });
      return { error: 'No API key' };
    }

    const model = getSelectedModel();
    const client = getClient(apiKey, model);
    const history = conversation.messages;
    const loop = new ToolLoop(mainWindow, client);
    activeToolLoop = loop;

    // Convert DocumentAttachment[] to DocumentMeta[] for storage (strip extracted text)
    const documentMetas: DocumentMeta[] | undefined = documents?.map((d) => ({
      filename: d.filename,
      originalName: d.originalName,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      pageCount: d.pageCount,
      sheetNames: d.sheetNames,
      truncated: d.truncated,
    }));

    try {
      const response = await usageTracker.runWithConversation(conversation.id, () =>
        loop.run(message, history, images, documents, {
          conversationId: conversation.id,
          messageId: messageId || randomUUID(),
        })
      );
      // If the loop streamed chunks itself (real-time streaming with HTML interception),
      // we only need to send the end event. Otherwise send the full text.
      if (!loop.streamed) {
        mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, response);
      }
      mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_END, response);

      conversationManager.addMessage(conversation.id, { role: 'user', content: message, images, documents: documentMetas });
      conversationManager.addMessage(conversation.id, { role: 'assistant', content: response });

      return { conversationId: conversation.id };
    } catch (error: any) {
      mainWindow.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
      mainWindow.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: error?.message || 'Unknown error' });
      return { error: error?.message || 'Unknown error' };
    } finally {
      if (activeToolLoop === loop) {
        activeToolLoop = null;
      }
    }
  });

  handleValidated(IPC.CHAT_STOP, ipcSchemas[IPC.CHAT_STOP], async () => {
    if (activeToolLoop) {
      activeToolLoop.abort();
      activeToolLoop = null;
    }
    mainWindow?.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
    return { stopped: true };
  });

  handleValidated(IPC.CHAT_NEW, ipcSchemas[IPC.CHAT_NEW], async () => {
    clearPrefetchCache();
    return conversationManager.create();
  });
  handleValidated(IPC.CHAT_LIST, ipcSchemas[IPC.CHAT_LIST], async () => conversationManager.list());
  handleValidated(IPC.CHAT_LOAD, ipcSchemas[IPC.CHAT_LOAD], async (_event, payload) => {
    const { id } = payload;
    clearPrefetchCache();
    return conversationManager.get(id);
  });
  handleValidated(IPC.CHAT_DELETE, ipcSchemas[IPC.CHAT_DELETE], async (_event, payload) => {
    const { id } = payload;
    conversationManager.delete(id);
    clearPrefetchCache();
    return { deleted: true };
  });
  handleValidated(IPC.CHAT_GET_TITLE, ipcSchemas[IPC.CHAT_GET_TITLE], async (_event, payload) => {
    return conversationManager.getTitle(payload.id);
  });
  handleValidated(IPC.CHAT_TABS_GET_STATE, ipcSchemas[IPC.CHAT_TABS_GET_STATE], async () => {
    const stored = store.get(CHAT_TAB_STATE_KEY);
    return sanitizeChatTabState(stored);
  });
  handleValidated(IPC.CHAT_TABS_SET_STATE, ipcSchemas[IPC.CHAT_TABS_SET_STATE], async (_event, payload) => {
    const sanitized = sanitizeChatTabState(payload);
    store.set(CHAT_TAB_STATE_KEY, sanitized);
    return { success: true };
  });

  handleValidated(IPC.API_KEY_GET, ipcSchemas[IPC.API_KEY_GET], async () => getAnthropicApiKey());

  handleValidated(IPC.API_KEY_SET, ipcSchemas[IPC.API_KEY_SET], async (_event, payload) => {
    const { key } = payload;
    const normalized = key.trim();
    store.set('anthropicApiKey', normalized);
    store.set('hasCompletedSetup', Boolean(normalized));
    void warmAnthropicMessagesConnection(normalized);
    return { success: true };
  });

  handleValidated(IPC.HAS_COMPLETED_SETUP, ipcSchemas[IPC.HAS_COMPLETED_SETUP], async () => Boolean(store.get('hasCompletedSetup')));

  handleValidated(IPC.API_KEY_CLEAR, ipcSchemas[IPC.API_KEY_CLEAR], async () => {
    store.set('anthropicApiKey', '');
    store.set('hasCompletedSetup', false);
    return { success: true };
  });

  handleValidated(IPC.API_KEY_VALIDATE, ipcSchemas[IPC.API_KEY_VALIDATE], async (_event, payload) => {
    const { key, model } = payload;
    const result = await validateAnthropicApiKey(key, model);
    if (result.valid) {
      void warmAnthropicMessagesConnection(key);
    }
    return result;
  });

  handleValidated(IPC.MODEL_GET, ipcSchemas[IPC.MODEL_GET], async () => (store.get('selectedModel') as string) || DEFAULT_MODEL);

  handleValidated(IPC.MODEL_SET, ipcSchemas[IPC.MODEL_SET], async (_event, payload) => {
    const { model } = payload;
    store.set('selectedModel', model);
    // Invalidate cached client so next request uses the new model.
    cachedClient = null;
    cachedClientApiKey = null;
    cachedClientModel = null;
    return { success: true };
  });

  handleValidated(IPC.SETTINGS_GET, ipcSchemas[IPC.SETTINGS_GET], async () => ({
    anthropic_api_key: getMaskedAnthropicApiKey(),
    anthropic_key_masked: getMaskedAnthropicApiKey(),
    has_completed_setup: Boolean(store.get('hasCompletedSetup')),
    selected_model: (store.get('selectedModel') as string) || DEFAULT_MODEL,
    serper_api_key: store.get('serper_api_key') ? '••••••••' : '',
    brave_api_key: store.get('brave_api_key') ? '••••••••' : '',
    serpapi_api_key: store.get('serpapi_api_key') ? '••••••••' : '',
    bing_api_key: store.get('bing_api_key') ? '••••••••' : '',
    search_backend: store.get('search_backend') || 'serper',
  }));

  handleValidated(IPC.SETTINGS_SET, ipcSchemas[IPC.SETTINGS_SET], async (_event, payload) => {
    const { key, value } = payload;
    if (key === 'anthropic_api_key' || key === 'anthropicApiKey') {
      const normalized = String(value ?? '').trim();
      store.set('anthropicApiKey', normalized);
      store.set('hasCompletedSetup', Boolean(normalized));
      void warmAnthropicMessagesConnection(normalized);
      return { success: true };
    }
    store.set(key as keyof ClawdiaStoreSchema, value as any);
    return { success: true };
  });

  handleValidated(IPC.WINDOW_MINIMIZE, ipcSchemas[IPC.WINDOW_MINIMIZE], () => {
    mainWindow?.minimize();
  });

  handleValidated(IPC.WINDOW_MAXIMIZE, ipcSchemas[IPC.WINDOW_MAXIMIZE], () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  handleValidated(IPC.WINDOW_CLOSE, ipcSchemas[IPC.WINDOW_CLOSE], () => {
    mainWindow?.close();
  });

  handleValidated(IPC.DOCUMENT_EXTRACT, ipcSchemas[IPC.DOCUMENT_EXTRACT], async (_event, data) => {
    try {
      const buf = Buffer.from(data.buffer);
      const result = await extractDocument(buf, data.filename, data.mimeType);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Extraction failed' };
    }
  });

  handleValidated(IPC.DOCUMENT_SAVE, ipcSchemas[IPC.DOCUMENT_SAVE], async (_event, payload) => {
    const { sourcePath, suggestedName } = payload;
    if (!mainWindow) return { success: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { success: false };
    try {
      await fs.promises.copyFile(sourcePath, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Save failed' };
    }
  });

  handleValidated(IPC.DOCUMENT_OPEN_FOLDER, ipcSchemas[IPC.DOCUMENT_OPEN_FOLDER], async (_event, payload) => {
    const { filePath } = payload;
    shell.showItemInFolder(filePath);
    return { success: true };
  });

  handleValidated(IPC.CLIPBOARD_WRITE_TEXT, ipcSchemas[IPC.CLIPBOARD_WRITE_TEXT], async (_event, payload) => {
    const { text } = payload;
    clipboard.writeText(String(text ?? ''));
    return { success: true };
  });

  handleValidated(IPC.LOG_LEVEL_SET, ipcSchemas[IPC.LOG_LEVEL_SET], async (_event, payload) => {
    const { level } = payload;
    const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (valid.includes(level as LogLevel)) {
      setLogLevel(level as LogLevel);
      log.info(`Log level set to: ${level}`);
      return { success: true };
    }
    return { success: false, error: `Invalid log level: ${level}` };
  });

  handleValidated(IPC.STORE_RESET, ipcSchemas[IPC.STORE_RESET], async () => {
    resetStore(store);
    return { success: true };
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setCdpPort(REMOTE_DEBUGGING_PORT);
    setupIpcHandlers();
    setupBrowserIpc();
    createWindow();
    // initPlaywright() is now called from mainWindow 'ready-to-show' event
    // to ensure CDP server is up before attempting connection.

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        // initPlaywright will be triggered by ready-to-show in createWindow.
      }
    });
  });
}

app.on('window-all-closed', () => {
  stopSessionReaper();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  if (process.env.NODE_ENV === 'development') {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Hardened shutdown — clean up all sessions with a hard timeout.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  log.info(`${signal} received, shutting down...`);
  stopSessionReaper();

  const shutdownTimer = setTimeout(() => {
    log.warn(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    app.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await closeBrowser();
  } catch (err: any) {
    log.warn(`closeBrowser error during shutdown: ${err?.message}`);
  } finally {
    clearTimeout(shutdownTimer);
    killOrphanedCDPProcesses();
    app.quit();
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
