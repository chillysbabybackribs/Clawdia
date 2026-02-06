import { app, BrowserWindow, ipcMain } from 'electron';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { setupBrowserIpc, setMainWindow, closeBrowser, initPlaywright, setCdpPort } from './browser/manager';
import { registerPlaywrightSearchFallback } from './browser/tools';
import { AnthropicClient } from './llm/client';
import { ConversationManager } from './llm/conversation';
import { ToolLoop } from './llm/tool-loop';
import { store, migrateLegacyStoreSchema, type ChatTabState, type ClawdiaStoreSchema } from './store';
import { DEFAULT_MODEL } from '../shared/models';

// Pick a free CDP port before Electron starts.
// Must be synchronous because appendSwitch must run at module load time.
function pickFreePort(candidates: number[]): number {
  for (const port of candidates) {
    try {
      // ss output format: "LISTEN  0  10  127.0.0.1:9222  0.0.0.0:*"
      // Use grep -E with word boundary after port number to avoid partial matches.
      execSync(`ss -tln | grep -qE ':${port}\\b'`, { stdio: 'ignore' });
      // grep succeeded → port is in use, skip.
      console.log(`[Main] Port ${port} in use, trying next...`);
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
// Use Chromium's native dark-mode rendering instead of custom per-site CSS overrides.
app.commandLine.appendSwitch('force-dark-mode');
app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark');
console.log(`[Main] CDP debug port: ${REMOTE_DEBUGGING_PORT}`);

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

migrateLegacyStoreSchema();

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
  console.log('[Main] Preload absolute path:', preloadPath);

  if (!fs.existsSync(preloadPath)) {
    console.error('[Main] ERROR: Preload file does not exist at:', preloadPath);
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

  setMainWindow(mainWindow);
  conversationManager = new ConversationManager(store);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // CDP server is reliably up once the window is ready to show.
    // Kick off Playwright connection here so it doesn't race.
    void initPlaywright().then(() => registerPlaywrightSearchFallback());

    // Warm DNS + TCP + TLS connections to API endpoints (fire-and-forget).
    // Eliminates cold-start latency on first search/LLM call.
    void warmConnections();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    void closeBrowser();
  });
}

function setupIpcHandlers(): void {
  ipcMain.handle(IPC.CHAT_SEND, async (_event, conversationId: string, content: string) => {
    if (!mainWindow) return { error: 'No window' };

    let conversation = conversationManager.get(conversationId);
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

    try {
      const response = await loop.run(content, history);
      // If the loop streamed chunks itself (real-time streaming with HTML interception),
      // we only need to send the end event. Otherwise send the full text.
      if (!loop.streamed) {
        mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, response);
      }
      mainWindow.webContents.send(IPC_EVENTS.CHAT_STREAM_END, response);

      conversationManager.addMessage(conversation.id, { role: 'user', content });
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

  ipcMain.handle(IPC.CHAT_STOP, async () => {
    if (activeToolLoop) {
      activeToolLoop.abort();
      activeToolLoop = null;
    }
    mainWindow?.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
    return { stopped: true };
  });

  ipcMain.handle(IPC.CHAT_NEW, async () => conversationManager.create());
  ipcMain.handle(IPC.CHAT_LIST, async () => conversationManager.list());
  ipcMain.handle(IPC.CHAT_LOAD, async (_event, id: string) => conversationManager.get(id));
  ipcMain.handle(IPC.CHAT_DELETE, async (_event, id: string) => {
    conversationManager.delete(id);
    return { deleted: true };
  });
  ipcMain.handle(IPC.CHAT_GET_TITLE, async (_event, id: string) => conversationManager.getTitle(id));
  ipcMain.handle(IPC.CHAT_TABS_GET_STATE, async () => {
    const stored = store.get(CHAT_TAB_STATE_KEY);
    return sanitizeChatTabState(stored);
  });
  ipcMain.handle(IPC.CHAT_TABS_SET_STATE, async (_event, state: ChatTabState) => {
    const sanitized = sanitizeChatTabState(state);
    store.set(CHAT_TAB_STATE_KEY, sanitized);
    return { success: true };
  });

  ipcMain.handle(IPC.API_KEY_GET, async () => getAnthropicApiKey());

  ipcMain.handle(IPC.API_KEY_SET, async (_event, key: string) => {
    const normalized = key.trim();
    store.set('anthropicApiKey', normalized);
    store.set('hasCompletedSetup', Boolean(normalized));
    return { success: true };
  });

  ipcMain.handle(IPC.HAS_COMPLETED_SETUP, async () => Boolean(store.get('hasCompletedSetup')));

  ipcMain.handle(IPC.API_KEY_CLEAR, async () => {
    store.set('anthropicApiKey', '');
    store.set('hasCompletedSetup', false);
    return { success: true };
  });

  ipcMain.handle(IPC.API_KEY_VALIDATE, async (_event, key: string, model?: string) => validateAnthropicApiKey(key, model));

  ipcMain.handle(IPC.MODEL_GET, async () => (store.get('selectedModel') as string) || DEFAULT_MODEL);

  ipcMain.handle(IPC.MODEL_SET, async (_event, model: string) => {
    store.set('selectedModel', model);
    // Invalidate cached client so next request uses the new model.
    cachedClient = null;
    cachedClientApiKey = null;
    cachedClientModel = null;
    return { success: true };
  });

  ipcMain.handle(IPC.SETTINGS_GET, async () => ({
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

  ipcMain.handle(IPC.SETTINGS_SET, async (_event, key: string, value: string | boolean) => {
    if (key === 'anthropic_api_key' || key === 'anthropicApiKey') {
      const normalized = String(value ?? '').trim();
      store.set('anthropicApiKey', normalized);
      store.set('hasCompletedSetup', Boolean(normalized));
      return { success: true };
    }
    store.set(key as keyof ClawdiaStoreSchema, value as any);
    return { success: true };
  });

  ipcMain.handle(IPC.GET_FREQUENT_SITES, async () => []);

  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => {
    mainWindow?.minimize();
  });

  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    mainWindow?.close();
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

// Clean shutdown on SIGTERM (nodemon restart) — release CDP port immediately.
process.on('SIGTERM', () => {
  console.log('[Main] SIGTERM received, shutting down...');
  void closeBrowser().then(() => app.quit());
});

process.on('SIGINT', () => {
  console.log('[Main] SIGINT received, shutting down...');
  void closeBrowser().then(() => app.quit());
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
