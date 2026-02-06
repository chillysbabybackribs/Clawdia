"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const ipc_channels_1 = require("../shared/ipc-channels");
const manager_1 = require("./browser/manager");
const client_1 = require("./llm/client");
const conversation_1 = require("./llm/conversation");
const tool_loop_1 = require("./llm/tool-loop");
const tools_1 = require("./browser/tools");
const router_1 = require("./llm/router");
const synthesizer_1 = require("./llm/synthesizer");
const runner_1 = require("./executor/runner");
const pool_1 = require("./browser/pool");
const summarizer_1 = require("./executor/summarizer");
const electron_store_1 = __importDefault(require("electron-store"));
// ============================================================================
// GLOBALS
// ============================================================================
let mainWindow = null;
let conversationManager;
let activeToolLoop = null;
let browserPool = null;
let activeExecutor = null;
const store = new electron_store_1.default();
let handleResearchRouteV2 = null;
if (process.env.SEARCH_PIPELINE === 'v2') {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const searchV2Module = require('../../search_v2/main/handler');
        handleResearchRouteV2 = searchV2Module.handleResearchRouteV2;
        console.log('[Main] SearchV2 handler loaded');
    }
    catch (error) {
        console.warn('[Main] Failed to load SearchV2 handler:', error);
    }
}
// ============================================================================
// WINDOW CREATION
// ============================================================================
function createWindow() {
    const preloadPath = path.join(__dirname, 'preload.js');
    console.log('[Main] Preload absolute path:', preloadPath);
    // Verify preload exists
    const fs = require('fs');
    if (!fs.existsSync(preloadPath)) {
        console.error('[Main] ERROR: Preload file does not exist at:', preloadPath);
    }
    else {
        console.log('[Main] Preload file exists');
    }
    mainWindow = new electron_1.BrowserWindow({
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
            sandbox: false, // Required for preload to work with contextBridge
            preload: preloadPath,
        },
    });
    // Set up browser subsystem
    (0, manager_1.setMainWindow)(mainWindow);
    (0, manager_1.setupBrowserIpc)();
    // Initialize services
    conversationManager = new conversation_1.ConversationManager(store);
    // Load UI
    console.log('[Main] NODE_ENV:', process.env.NODE_ENV);
    console.log('[Main] Preload path:', path.join(__dirname, 'preload.js'));
    if (process.env.NODE_ENV === 'development') {
        console.log('[Main] Loading from Vite dev server...');
        mainWindow.loadURL('http://localhost:5173');
    }
    else {
        console.log('[Main] Loading from file...');
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
    // Log when preload is ready
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[Main] Page loaded');
    });
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        (0, manager_1.closeBrowser)();
    });
}
// ============================================================================
// IPC HANDLERS
// ============================================================================
function setupIpcHandlers() {
    // -------------------------------------------------------------------------
    // Chat
    // -------------------------------------------------------------------------
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_SEND, async (_event, conversationId, content) => {
        if (!mainWindow)
            return { error: 'No window' };
        let conversation = conversationManager.get(conversationId);
        if (!conversation) {
            conversation = conversationManager.create();
        }
        conversationManager.addMessage(conversation.id, { role: 'user', content });
        const apiKey = store.get('anthropic_api_key');
        if (!apiKey) {
            mainWindow.webContents.send(ipc_channels_1.IPC_EVENTS.CHAT_ERROR, { error: 'No API key configured' });
            return { error: 'No API key' };
        }
        try {
            const router = new router_1.Router(apiKey);
            const result = await router.classify({ latestMessage: content });
            console.log(`[Main] Route: ${result.route}`);
            let response;
            switch (result.route) {
                case 'chat':
                    response = await handleChatRoute(apiKey, conversation.messages, mainWindow);
                    break;
                case 'browse':
                    response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
                    break;
                case 'research':
                    if (process.env.SEARCH_PIPELINE === 'v2' && handleResearchRouteV2) {
                        response = await handleResearchRouteV2(apiKey, content, mainWindow);
                    }
                    else {
                        response = await handleResearchRoute(apiKey, content, result.taskSpec, mainWindow);
                    }
                    break;
                default:
                    response = await handleBrowseRoute(apiKey, conversation.messages, mainWindow);
            }
            conversationManager.addMessage(conversation.id, { role: 'assistant', content: response });
            return { conversationId: conversation.id };
        }
        catch (error) {
            console.error('[Main] Error:', error);
            mainWindow.webContents.send(ipc_channels_1.IPC_EVENTS.CHAT_ERROR, { error: error.message });
            return { error: error.message };
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_STOP, async () => {
        if (activeToolLoop) {
            activeToolLoop.stop();
            activeToolLoop = null;
        }
        if (activeExecutor) {
            activeExecutor.stop();
            activeExecutor = null;
        }
        return { stopped: true };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_NEW, async () => {
        const conversation = conversationManager.create();
        return conversation;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_LIST, async () => {
        return conversationManager.list();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_LOAD, async (_event, id) => {
        return conversationManager.get(id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.CHAT_DELETE, async (_event, id) => {
        conversationManager.delete(id);
        return { deleted: true };
    });
    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------
    electron_1.ipcMain.handle(ipc_channels_1.IPC.SETTINGS_GET, async () => {
        return {
            anthropic_api_key: store.get('anthropic_api_key') ? '••••••••' : '',
        };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.SETTINGS_SET, async (_event, key, value) => {
        store.set(key, value);
        return { success: true };
    });
    // -------------------------------------------------------------------------
    // Window controls
    // -------------------------------------------------------------------------
    electron_1.ipcMain.handle(ipc_channels_1.IPC.WINDOW_MINIMIZE, () => {
        mainWindow?.minimize();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.WINDOW_MAXIMIZE, () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow?.maximize();
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.WINDOW_CLOSE, () => {
        mainWindow?.close();
    });
}
// ============================================================================ //
// ROUTE HANDLERS
// ============================================================================ //
async function handleChatRoute(apiKey, messages, win) {
    const client = new client_1.AnthropicClient(apiKey);
    let fullResponse = '';
    const response = await client.chat(messages, [], 'You are a helpful AI assistant. Respond naturally and helpfully.', (text) => {
        fullResponse += text;
        win.webContents.send(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_TEXT, text);
    });
    const textContent = response.content.find((b) => b.type === 'text');
    if (textContent && textContent.type === 'text') {
        fullResponse = textContent.text;
    }
    win.webContents.send(ipc_channels_1.IPC_EVENTS.CHAT_STREAM_END, fullResponse);
    return fullResponse;
}
async function handleBrowseRoute(apiKey, messages, win) {
    const llmClient = new client_1.AnthropicClient(apiKey);
    const browserTools = new tools_1.BrowserTools();
    const loop = new tool_loop_1.ToolLoop(llmClient, browserTools, win);
    activeToolLoop = loop;
    try {
        return await loop.run(messages);
    }
    finally {
        if (activeToolLoop === loop) {
            activeToolLoop = null;
        }
    }
}
async function handleResearchRoute(apiKey, query, taskSpec, win) {
    if (!browserPool) {
        browserPool = new pool_1.BrowserPool(win, {
            discoveryCount: 1,
            evidenceCount: 1,
            useSharedSession: true,
        });
    }
    win.webContents.send(ipc_channels_1.IPC_EVENTS.RESEARCH_PROGRESS, {
        phase: 'intake',
        message: `Planning: ${taskSpec.actions.length} sources to search, ${taskSpec.successCriteria.length} criteria to cover`,
    });
    console.log('[Research] TaskSpec:', JSON.stringify(taskSpec, null, 2));
    activeExecutor = new runner_1.ExecutorRunner(apiKey, browserPool, win);
    const results = await activeExecutor.execute(taskSpec);
    activeExecutor = null;
    const successCount = results.filter((r) => r.status === 'success').length;
    console.log(`[Research] Done: ${successCount}/${results.length} actions succeeded`);
    const summarizer = new summarizer_1.Summarizer();
    const eligibleEvidence = summarizer.getAllEvidence(results);
    win.webContents.send(ipc_channels_1.IPC_EVENTS.RESEARCH_PROGRESS, {
        phase: 'checkpoint',
        message: `Collected ${eligibleEvidence.length} evidence sources from ${successCount} successful actions.`,
        checkpointNumber: -1,
    });
    const synthesizer = new synthesizer_1.Synthesizer(apiKey, win);
    let response = '';
    let retryIds;
    let attempt = 0;
    while (attempt <= synthesizer_1.Synthesizer.MAX_RETRIES) {
        try {
            response = await synthesizer.synthesize(taskSpec, results, retryIds ? { missingSourceIds: retryIds } : undefined);
            break;
        }
        catch (error) {
            if (error instanceof synthesizer_1.SynthesizerError && attempt < synthesizer_1.Synthesizer.MAX_RETRIES) {
                attempt += 1;
                retryIds = error.uncitedSourceIds;
                win.webContents.send(ipc_channels_1.IPC_EVENTS.RESEARCH_PROGRESS, {
                    phase: 'checkpoint',
                    message: `Synthesizer missing citations for ${retryIds
                        .map((id) => `[${id}]`)
                        .join(', ')}, retrying...`,
                    checkpointNumber: -1,
                });
                continue;
            }
            throw error;
        }
    }
    if (!response) {
        throw new Error('Synthesizer failed to produce a response.');
    }
    return response;
}
// ============================================================================
// APP LIFECYCLE
// ============================================================================
// Prevent multiple instances
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        // Focus the existing window if a second instance tries to open
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
        }
    });
    electron_1.app.whenReady().then(() => {
        setupIpcHandlers();
        createWindow();
        electron_1.app.on('activate', () => {
            if (electron_1.BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
// Handle certificate errors in development
electron_1.app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    if (process.env.NODE_ENV === 'development') {
        event.preventDefault();
        callback(true);
    }
    else {
        callback(false);
    }
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});
//# sourceMappingURL=main.js.map