// Log tap — mirrors all stdout/stderr to ~/.clawdia-live.log for AI monitoring
import './log-tap';

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import {
  ToolLoopEmitter,
  type CapabilityPlatformStatus,
  type CapabilityRuntimeEvent,
  type MCPServerConfig,
  type MCPServerHealthEvent,
  type MCPServerHealthStatus,
} from '../shared/types';
import { extractDocument } from './documents/extractor';
import { createDocument } from './documents/creator';
import { setupBrowserIpc, setMainWindow, closeBrowser, initPlaywright, setCdpPort, stopSessionReaper, killOrphanedCDPProcesses } from './browser/manager';
import { BROWSER_TOOL_DEFINITIONS, registerPlaywrightSearchFallback } from './browser/tools';
import { AnthropicClient } from './llm/client';
import { ConversationManager } from './llm/conversation';
import { ToolLoop, clearPrefetchCache } from './llm/tool-loop';
import { processChatMessage } from './llm/chat-pipeline';
import { initHeadlessRunner } from './tasks/headless-runner';
import { shutdown as shutdownTaskBrowser } from './tasks/task-browser';
import { TaskScheduler, setSchedulerInstance } from './tasks/scheduler';
import { getTaskDashboardItems } from './tasks/task-dashboard';
import { getTask, listTasks, deleteTask, pauseTask, resumeTask, getRunsForTask, getRun, updateRun, cleanupZombieRuns, getExecutorForTask } from './tasks/task-store';
import { detectFastPathTools } from './llm/tool-bootstrap';
import { initializeCapabilityRegistry } from './capabilities/registry';
import { getCapabilityPlatformFlags, setCapabilityPlatformFlags } from './capabilities/feature-flags';
import { loadConfiguredMcpServersSync, type DiscoveredMcpServer } from './capabilities/mcp-discovery';
import { createCapabilityPlatformServices } from './capabilities/services';
import { detectContainerRuntime, getContainerNetworkMode } from './capabilities/container-executor';
import { setAmbientSummary } from './llm/system-prompt';
import { strategyCache } from './llm/strategy-cache';
import { store, runMigrations, resetStore, DEFAULT_AMBIENT_SETTINGS, type AmbientSettings, type ChatTabState, type ClawdiaStoreSchema } from './store';
import { DEFAULT_MODEL } from '../shared/models';
import { usageTracker } from './usage-tracker';
import { createLogger, setLogLevel, type LogLevel } from './logger';
import { handleValidated, ipcSchemas } from './ipc-validator';
import { initSearchCache, closeSearchCache } from './cache/search-cache';
import { initArchive, closeArchive } from './archive/writer';
import { listAccounts, addAccount, removeAccount } from './accounts/account-store';
import { initLearningSystem, shutdownLearningSystem, siteKnowledge, userMemory } from './learning';
import { initVault } from './vault/db';
import { IngestionManager, ingestionEmitter } from './ingestion/manager';
import { VaultSearch } from './vault/search';
import { getIngestionJob } from './vault/documents';
import { createPlan, addAction, getPlan, getActions } from './actions/ledger';
import { ActionExecutor } from './actions/executor';
import { ActionType, IngestionJob } from '../shared/vault-types';
import { generateDashboardInsights, getCachedInsights } from './dashboard/suggestions';
import { DashboardExecutor } from './dashboard/executor';
import {
  shouldAuthorize,
  classifyAction,
  clearTaskApprovals
} from './autonomy-gate';
import {
  AutonomyMode,
  ApprovalRequest,
  ApprovalDecision,
  AutonomyOverrides,
  RiskLevel
} from '../shared/autonomy';
import { collectAmbientData, collectAmbientContext, formatCompactSummary } from './dashboard/ambient';
import { loadDashboardState, saveDashboardState, computeContextHash, sessionHadActivity } from './dashboard/persistence';
import { buildProjectCards, buildActivityFeed } from './dashboard/state-builder';
import { setTokenUsageCallback } from './llm/tool-loop';
import { getBrowserStatus } from './browser/manager';
import { logCookieDiagnostic } from './tasks/cookie-export';
import { startTelegramBot, stopTelegramBot, notifyTaskResult, isTelegramBotRunning } from './integrations/telegram-bot';

const log = createLogger('main');
// TEST FIX: Verifying cascade restart issue is resolved - 2026-02-07 TESTING NOW

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

function buildCdpCandidates(): number[] {
  // Prefer a process-scoped high port first to avoid collisions with
  // system Chrome instances that often occupy 9222/9223.
  const processScoped = 12000 + (process.pid % 1000);
  const legacy = [9222, 9223, 9224, 9225, 9226, 9227];
  const expanded: number[] = [];
  for (let port = 9228; port <= 9260; port += 1) {
    expanded.push(port);
  }
  return Array.from(new Set([processScoped, ...legacy, ...expanded]));
}

const CDP_CANDIDATES = buildCdpCandidates();
const envPort = process.env.CLAWDIA_CDP_PORT ? Number(process.env.CLAWDIA_CDP_PORT) : null;
const portList = envPort ? [envPort, ...CDP_CANDIDATES.filter((p) => p !== envPort)] : CDP_CANDIDATES;
const REMOTE_DEBUGGING_PORT = pickFreePort(portList);

app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUGGING_PORT));
if (process.platform === 'linux') {
  // GPU stability: prevent GPU process crashes that kill the app on Linux/NVIDIA
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
}
// FedCM is currently flaky in embedded Chromium flows (e.g., Google sign-in on claude.ai).
// Force classic OAuth popup/redirect fallback instead of navigator.credentials.get().
app.commandLine.appendSwitch('disable-features', 'FedCm');
log.info(`CDP debug port: ${REMOTE_DEBUGGING_PORT}`);

if (process.env.NODE_ENV !== 'production') {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayFirstMinimize = true; // Show notification only on first minimize-to-tray
let savedWindowBounds: Electron.Rectangle | null = null; // Restore size after hide on Linux
let conversationManager: ConversationManager;
let activeToolLoop: ToolLoop | null = null;
let dashboardExecutor: DashboardExecutor | null = null;
let taskScheduler: TaskScheduler | null = null;
let lastMessageTimestamp: number | null = null;
let taskUnreadCount = 0;
const capabilityPlatform = createCapabilityPlatformServices();
const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright-cdp';
const MCP_HEALTH_POLL_INTERVAL_MS = 7_500;
const MCP_HEALTH_RESTART_COOLDOWN_MS = 30_000;
const MCP_HEALTH_FAILURE_THRESHOLD = 3;
let mcpHealthMonitorTimer: ReturnType<typeof setInterval> | null = null;
const lastMcpHealthKeyByServer = new Map<string, string>();
let lastMcpRestartAttemptAt = 0;
const externalMcpConfigs = new Map<string, DiscoveredMcpServer>();
const externalMcpProcesses = new Map<string, ChildProcess>();
const externalMcpRestartAttempts = new Map<string, number>();

// Cache the AnthropicClient to reuse HTTP connection pooling.
let cachedClient: AnthropicClient | null = null;
let cachedClientApiKey: string | null = null;
let cachedClientModel: string | null = null;

// Autonomy approval tracking
const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
/** Tracks the source of the last resolved approval for audit events. */
export const approvalSources = new Map<string, 'desktop' | 'telegram'>();

import { sendApprovalRequest } from './integrations/telegram-bot';
import { initAuditStore, closeAuditStore, appendAuditEvent, queryAuditEvents, getAuditSummary, clearAuditEvents, onAuditEvent } from './audit/audit-store';
import { setDecisionSourceResolver } from './autonomy-gate';

/**
 * Solicitor for autonomy approvals.
 * Emits event to renderer and waits for response.
 */
async function solicitorApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  const { requestId, expiresAt } = request;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        log.warn(`[Autonomy] Approval ${requestId} timed out, defaulting to DENY`);
        pendingApprovals.delete(requestId);
        appendAuditEvent({
          ts: Date.now(),
          kind: 'tool_expired',
          requestId,
          toolName: request.tool,
          risk: request.risk,
          outcome: 'expired',
          detail: 'Approval expired (no response within 90s)',
        });
        resolve('DENY');
      }
    }, expiresAt - Date.now());

    const resolveOnce = (decision: ApprovalDecision) => {
      if (pendingApprovals.has(requestId)) {
        clearTimeout(timeout);
        pendingApprovals.delete(requestId);
        resolve(decision);
      }
    };

    pendingApprovals.set(requestId, resolveOnce);

    // Desktop notification
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.APPROVAL_REQUEST, request);
    }

    // Telegram notification
    if (store.get('telegramEnabled')) {
      sendApprovalRequest(request, resolveOnce).catch(err => {
        log.warn(`[Autonomy] Telegram approval request failed: ${err.message}`);
      });
    }
  });
}

export function getClient(apiKey: string, model: string): AnthropicClient {
  if (cachedClient && cachedClientApiKey === apiKey && cachedClientModel === model) return cachedClient;
  cachedClient = new AnthropicClient(apiKey, model);
  cachedClientApiKey = apiKey;
  cachedClientModel = model;
  return cachedClient;
}

const CHAT_TAB_STATE_KEY: keyof ClawdiaStoreSchema = 'chat_tab_state';
const CONNECTION_WARMUP_TARGETS = [
  'https://api.anthropic.com/',
  'https://google.serper.dev/',
];

/** Wrap a BrowserWindow as a ToolLoopEmitter. */
function wrapWindow(win: BrowserWindow): ToolLoopEmitter {
  return {
    send(channel: string, ...args: any[]) { win.webContents.send(channel, ...args); },
    isDestroyed() { return win.isDestroyed(); },
  };
}

export function getAnthropicApiKey(): string {
  return ((store.get('anthropicApiKey') as string | undefined) ?? '').trim();
}

export function getSelectedModel(): string {
  return ((store.get('selectedModel') as string) || DEFAULT_MODEL);
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

/** Broadcast current task list to renderer for dashboard update (debounced) */
let _broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let _taskStateDirty = false;
function broadcastTaskState(): void {
  if (_broadcastTimer) return;              // already scheduled
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      // Window unavailable (tray mode) — mark dirty so next show picks it up
      _taskStateDirty = true;
      return;
    }
    _taskStateDirty = false;
    const items = getTaskDashboardItems();
    mainWindow.webContents.send(IPC_EVENTS.TASK_STATE_UPDATE, items);
  }, 300);
}

/** Flush pending task state update after window (re)creation. */
export function flushPendingTaskState(): void {
  if (_taskStateDirty && mainWindow && !mainWindow.isDestroyed()) {
    _taskStateDirty = false;
    const items = getTaskDashboardItems();
    mainWindow.webContents.send(IPC_EVENTS.TASK_STATE_UPDATE, items);
  }
}

export { broadcastTaskState };

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function emitCapabilityRuntimeEvent(payload: CapabilityRuntimeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC_EVENTS.CAPABILITY_EVENT, payload);
  if (!getCapabilityPlatformFlags().lifecycleEvents) return;

  if (payload.eventName === 'MCP_SERVER_HEALTH') {
    mainWindow.webContents.send(IPC_EVENTS.MCP_SERVER_HEALTH, payload);
  } else if (payload.eventName === 'TASK_EVIDENCE_SUMMARY') {
    mainWindow.webContents.send(IPC_EVENTS.TASK_EVIDENCE_SUMMARY, payload);
  }
}

function mapBrowserStatusToMcpHealth(
  status: ReturnType<typeof getBrowserStatus>['status'],
  consecutiveFailures: number,
): MCPServerHealthStatus {
  if (status === 'disabled') return 'stopped';
  if (status === 'error') {
    return consecutiveFailures >= MCP_HEALTH_FAILURE_THRESHOLD ? 'unhealthy' : 'degraded';
  }
  if (status === 'busy') return 'starting';
  return 'healthy';
}

function getMcpEventStatus(status: MCPServerHealthStatus): 'success' | 'error' | 'warning' | 'pending' {
  if (status === 'healthy') return 'success';
  if (status === 'starting') return 'pending';
  if (status === 'degraded' || status === 'stopped') return 'warning';
  return 'error';
}

function emitMcpHealthState(state: {
  name: string;
  status: MCPServerHealthStatus;
  restartCount: number;
  consecutiveFailures: number;
  lastError?: string;
}, detail: string): void {
  const dedupeKey = `${state.status}|${detail}`;
  if (lastMcpHealthKeyByServer.get(state.name) === dedupeKey) {
    return;
  }
  lastMcpHealthKeyByServer.set(state.name, dedupeKey);

  const metadata: MCPServerHealthEvent = {
    serverName: state.name,
    status: state.status,
    detail,
    restartCount: state.restartCount,
    consecutiveFailures: state.consecutiveFailures,
    timestamp: Date.now(),
  };
  const payload: CapabilityRuntimeEvent = {
    toolId: 'mcp-runtime',
    toolName: 'mcp_runtime_manager',
    type: 'mcp_server_health',
    eventName: 'MCP_SERVER_HEALTH',
    status: getMcpEventStatus(state.status),
    message: `MCP server ${state.name} is ${state.status}.`,
    detail,
    metadata: metadata as unknown as Record<string, unknown>,
  };
  emitCapabilityRuntimeEvent(payload);

  appendAuditEvent({
    ts: Date.now(),
    kind: 'capability_event',
    toolName: 'mcp_runtime_manager',
    outcome: state.status === 'healthy' ? 'info' : state.status === 'unhealthy' ? 'blocked' : 'pending',
    detail: `${state.name} ${state.status} | ${detail}`.slice(0, 300),
    errorPreview: state.status === 'healthy' ? undefined : (state.lastError || detail).slice(0, 200),
  });
}

function buildPlaywrightMcpConfig(): MCPServerConfig {
  return {
    name: PLAYWRIGHT_MCP_SERVER_NAME,
    command: 'electron-cdp',
    args: [`--port=${REMOTE_DEBUGGING_PORT}`],
    tools: BROWSER_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  };
}

function safeTerminateProcess(proc: ChildProcess, name: string): void {
  if (proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch (err: any) {
    log.warn(`[MCP Runtime] Failed to SIGTERM ${name}: ${err?.message || err}`);
  }
  setTimeout(() => {
    if (proc.exitCode !== null || proc.killed) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 1500);
}

function startExternalMcpProcess(config: DiscoveredMcpServer, reason: string): void {
  if (externalMcpProcesses.has(config.name)) return;

  let child: ChildProcess;
  try {
    child = spawn(config.command, config.args, {
      cwd: homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    const state = capabilityPlatform.mcpRuntime.updateHealth(
      config.name,
      'unhealthy',
      `${reason}: spawn failed (${err?.message || err})`,
    );
    if (state) emitMcpHealthState(state, `${reason}: spawn failed`);
    return;
  }

  externalMcpProcesses.set(config.name, child);
  const startedState = capabilityPlatform.mcpRuntime.updateHealth(
    config.name,
    'starting',
    `${reason}: pid=${child.pid ?? 'unknown'}`,
  );
  if (startedState) {
    emitMcpHealthState(startedState, `${reason}: pid=${child.pid ?? 'unknown'}`);
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log.debug(`[MCP:${config.name}] ${line.slice(0, 220)}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log.warn(`[MCP:${config.name}] ${line.slice(0, 220)}`);
  });

  child.on('spawn', () => {
    const state = capabilityPlatform.mcpRuntime.updateHealth(
      config.name,
      'healthy',
      `spawned pid=${child.pid ?? 'unknown'}`,
    );
    if (state) emitMcpHealthState(state, `spawned pid=${child.pid ?? 'unknown'}`);
  });

  child.on('error', (err: Error) => {
    externalMcpProcesses.delete(config.name);
    const state = capabilityPlatform.mcpRuntime.updateHealth(
      config.name,
      'unhealthy',
      `process error: ${err.message}`,
    );
    if (state) emitMcpHealthState(state, `process error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    externalMcpProcesses.delete(config.name);
    const detail = `process exited code=${code ?? 'null'} signal=${signal ?? 'none'}`;
    const state = capabilityPlatform.mcpRuntime.updateHealth(config.name, 'unhealthy', detail);
    if (state) emitMcpHealthState(state, detail);
  });
}

async function refreshMcpRuntimeHealth(reason: string): Promise<void> {
  const flags = getCapabilityPlatformFlags();
  if (!flags.enabled || !flags.mcpRuntimeManager) return;

  const browser = getBrowserStatus();
  const baselineStatus = mapBrowserStatusToMcpHealth(browser.status, 0);
  const initial = capabilityPlatform.mcpRuntime.updateHealth(
    PLAYWRIGHT_MCP_SERVER_NAME,
    baselineStatus,
    `${reason}: browser=${browser.status}`,
  );
  if (!initial) return;

  let current = initial;
  if (browser.status === 'error' && current.consecutiveFailures >= MCP_HEALTH_FAILURE_THRESHOLD) {
    const unhealthy = capabilityPlatform.mcpRuntime.updateHealth(
      PLAYWRIGHT_MCP_SERVER_NAME,
      'unhealthy',
      `${reason}: repeated browser CDP failures`,
    );
    if (unhealthy) current = unhealthy;

    const now = Date.now();
    if (now - lastMcpRestartAttemptAt >= MCP_HEALTH_RESTART_COOLDOWN_MS) {
      lastMcpRestartAttemptAt = now;
      const restarted = capabilityPlatform.mcpRuntime.recordRestart(
        PLAYWRIGHT_MCP_SERVER_NAME,
        'Automatic restart after health threshold breach',
      );
      if (restarted) {
        emitMcpHealthState(
          restarted,
          `${reason}: attempting runtime restart (#${restarted.restartCount})`,
        );
      }
      try {
        await initPlaywright();
        registerPlaywrightSearchFallback();
      } catch (err: any) {
        log.warn(`[CapabilityPlatform] MCP runtime restart attempt failed: ${err?.message || err}`);
      }
      const postRestartBrowser = getBrowserStatus();
      const postRestartState = capabilityPlatform.mcpRuntime.updateHealth(
        PLAYWRIGHT_MCP_SERVER_NAME,
        mapBrowserStatusToMcpHealth(postRestartBrowser.status, current.consecutiveFailures),
        `${reason}: post-restart browser=${postRestartBrowser.status}`,
      );
      if (postRestartState) current = postRestartState;
    }
  }

  const playwrightDetail = [
    `reason=${reason}`,
    `browser=${browser.status}`,
    current.lastError ? `error=${current.lastError}` : '',
    `failures=${current.consecutiveFailures}`,
    `restarts=${current.restartCount}`,
  ].filter(Boolean).join(' | ');
  emitMcpHealthState(current, playwrightDetail);

  for (const [serverName, config] of externalMcpConfigs.entries()) {
    const proc = externalMcpProcesses.get(serverName);
    if (proc && proc.exitCode === null && !proc.killed) {
      const healthyState = capabilityPlatform.mcpRuntime.updateHealth(
        serverName,
        'healthy',
        `${reason}: process running pid=${proc.pid ?? 'unknown'}`,
      );
      if (healthyState) {
        emitMcpHealthState(healthyState, `${reason}: process running pid=${proc.pid ?? 'unknown'}`);
      }
      continue;
    }

    const unhealthyState = capabilityPlatform.mcpRuntime.updateHealth(
      serverName,
      'unhealthy',
      `${reason}: process not running`,
    );
    if (unhealthyState) {
      emitMcpHealthState(unhealthyState, `${reason}: process not running`);
    }

    const failures = unhealthyState?.consecutiveFailures || 0;
    if (failures < MCP_HEALTH_FAILURE_THRESHOLD) continue;

    const now = Date.now();
    const lastRestartAt = externalMcpRestartAttempts.get(serverName) || 0;
    if (now - lastRestartAt < MCP_HEALTH_RESTART_COOLDOWN_MS) continue;
    externalMcpRestartAttempts.set(serverName, now);

    const restartState = capabilityPlatform.mcpRuntime.recordRestart(
      serverName,
      `${reason}: automatic restart after ${failures} failures`,
    );
    if (restartState) {
      emitMcpHealthState(
        restartState,
        `${reason}: restarting ${serverName} (#${restartState.restartCount})`,
      );
    }
    startExternalMcpProcess(config, `${reason}: health-restart`);
  }
}

function startMcpRuntimeManager(): void {
  const flags = getCapabilityPlatformFlags();
  if (!flags.enabled || !flags.mcpRuntimeManager) return;

  const discovered = loadConfiguredMcpServersSync();
  if (discovered.warnings.length > 0) {
    for (const warning of discovered.warnings) {
      log.warn(`[MCP Discovery] ${warning}`);
    }
  }
  externalMcpConfigs.clear();
  for (const server of discovered.servers) {
    if (server.name === PLAYWRIGHT_MCP_SERVER_NAME) {
      log.warn(`[MCP Discovery] Skipping ${server.name} from ${server.source}: reserved runtime name`);
      continue;
    }
    externalMcpConfigs.set(server.name, server);
  }

  if (!capabilityPlatform.mcpRuntime.list().some((s) => s.name === PLAYWRIGHT_MCP_SERVER_NAME)) {
    const config: MCPServerConfig = buildPlaywrightMcpConfig();
    const state = capabilityPlatform.mcpRuntime.registerServer(config);
    emitMcpHealthState(state, `registered on port ${REMOTE_DEBUGGING_PORT}`);
  }

  for (const server of externalMcpConfigs.values()) {
    if (!capabilityPlatform.mcpRuntime.list().some((s) => s.name === server.name)) {
      const state = capabilityPlatform.mcpRuntime.registerServer(server);
      emitMcpHealthState(state, `registered from ${server.source}`);
    }
    startExternalMcpProcess(server, 'startup');
  }

  void refreshMcpRuntimeHealth('startup');
  if (mcpHealthMonitorTimer) clearInterval(mcpHealthMonitorTimer);
  mcpHealthMonitorTimer = setInterval(() => {
    void refreshMcpRuntimeHealth('poll');
  }, MCP_HEALTH_POLL_INTERVAL_MS);
}

function stopMcpRuntimeManager(): void {
  if (mcpHealthMonitorTimer) {
    clearInterval(mcpHealthMonitorTimer);
    mcpHealthMonitorTimer = null;
  }

  for (const [serverName, proc] of externalMcpProcesses.entries()) {
    safeTerminateProcess(proc, serverName);
    externalMcpProcesses.delete(serverName);
  }
  externalMcpConfigs.clear();
  externalMcpRestartAttempts.clear();

  for (const state of capabilityPlatform.mcpRuntime.list()) {
    const next = capabilityPlatform.mcpRuntime.updateHealth(
      state.name,
      'stopped',
      'application shutdown',
    );
    if (next) {
      emitMcpHealthState(next, 'application shutdown');
    }
  }
}

async function buildCapabilityPlatformStatus(): Promise<CapabilityPlatformStatus> {
  const flags = getCapabilityPlatformFlags();
  const containerRuntime = await detectContainerRuntime();
  const mcpRuntime = capabilityPlatform.mcpRuntime.list();
  const allowedRoots = [homedir(), '/tmp'];

  const mcpProcesses = [
    {
      name: PLAYWRIGHT_MCP_SERVER_NAME,
      source: 'internal',
      command: 'electron-cdp',
      args: [`--port=${REMOTE_DEBUGGING_PORT}`],
      running: getBrowserStatus().status !== 'error',
    },
    ...Array.from(externalMcpConfigs.values()).map((config) => {
      const proc = externalMcpProcesses.get(config.name);
      return {
        name: config.name,
        source: config.source,
        command: config.command,
        args: config.args,
        pid: proc?.pid,
        running: Boolean(proc && proc.exitCode === null && !proc.killed),
      };
    }),
  ];

  return {
    flags,
    sandboxRuntime: capabilityPlatform.sandbox.activeRuntime(),
    containerRuntime: {
      available: containerRuntime.available,
      runtime: containerRuntime.runtime,
      detail: containerRuntime.detail,
      checkedAt: containerRuntime.checkedAt,
    },
    containerPolicy: {
      networkMode: getContainerNetworkMode(),
      allowedRoots,
    },
    mcpRuntime,
    mcpProcesses,
  };
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
  log.debug(`[API Request] model=${model} | endpoint=warmup`);
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
log.info(`[STARTUP] storedModel=${(store.get('selectedModel') as string) || '(none)'} | effectiveModel=${getSelectedModel()}`);
const capabilityFlags = getCapabilityPlatformFlags();
log.info(
  `[CapabilityPlatform] enabled=${capabilityFlags.enabled} cohort=${capabilityFlags.cohort} ` +
  `install=${capabilityFlags.installOrchestrator} lifecycle=${capabilityFlags.lifecycleEvents} ` +
  `checkpoint=${capabilityFlags.checkpointRollback} container=${capabilityFlags.containerExecution}`,
);
if (capabilityFlags.containerExecution) {
  void detectContainerRuntime().then((status) => {
    log.info(`[CapabilityPlatform] container runtime: ${status.detail}`);
  });
}

async function validateAnthropicApiKey(key: string, model?: string): Promise<{ valid: boolean; error?: string }> {
  const normalized = key.trim();
  if (!normalized) {
    return { valid: false, error: 'API key is required.' };
  }

  const validationModel = model || getSelectedModel();
  log.info(`[API Request] model=${validationModel} | endpoint=validateApiKey`);

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

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (process.platform !== 'linux') {
      // macOS/Windows: show() after hide() works reliably
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      log.info('[Tray] Window restored from tray');
      return;
    }
    // Linux: frameless windows produce a 10x10 ghost on show() after hide().
    // Remove the close-to-hide handler before destroying so it doesn't re-hide.
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
    mainWindow = null;
  }
  // (Re)create the window — all app state lives in memory, not the window.
  createWindow();
  log.info('[Tray] Window recreated from tray');
}

function initTelegramIfEnabled(): void {
  const enabled = store.get('telegramEnabled') as boolean | undefined;
  const token = (store.get('telegramBotToken') as string | undefined)?.trim();
  if (!enabled || !token) return;
  startTelegramBot(token, {
    getApiKey: getAnthropicApiKey,
    getSelectedModel,
    getClient,
    conversationManager,
    getMainWindow: () => mainWindow,
    getAuthorizedChatId: () => store.get('telegramAuthorizedChatId') as number | undefined,
    setAuthorizedChatId: (chatId: number) => { store.set('telegramAuthorizedChatId', chatId); },
    setTelegramConversationId: (conversationId: string | null) => {
      if (conversationId) store.set('telegramConversationId', conversationId);
      else store.delete('telegramConversationId');
    },
  });
}

function createTray(): void {
  // Resolve tray icon: prefer 32px for crisp tray rendering, fall back to build icon.
  // In packaged builds, extraResources places icon.png next to the asar.
  const candidates = [
    path.join(__dirname, '../../release/.icon-set/icon_32.png'),  // dev: small icon
    path.join(__dirname, '../../build/icon.png'),                  // dev: build icon
    path.join(process.resourcesPath || '', 'icon.png'),            // packaged: extraResources
  ];
  const usePath = candidates.find(p => fs.existsSync(p)) || candidates[1];

  const icon = nativeImage.createFromPath(usePath);
  tray = new Tray(icon);
  tray.setToolTip('Clawdia');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Clawdia',
      click: () => showWindow(),
    },
    {
      label: 'Pause all tasks',
      click: () => {
        log.info('[Tray] Pause all tasks clicked (not yet implemented)');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click opens the window (Linux/Windows behavior)
  tray.on('click', () => showWindow());
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
      // Keep renderer isolated, but disable Chromium sandbox for preload module
      // resolution. Sandboxed preload cannot reliably resolve cross-directory
      // relative imports like ../shared/ipc-channels in this build layout.
      sandbox: false,
      preload: preloadPath,
    },
  });
  log.info('[MainWindow] webPreferences: contextIsolation=true, nodeIntegration=false, sandbox=false');

  // Prevent the native WM system menu on right-click of the title bar drag region.
  // On Linux this menu's Move/Resize actions enter a modal pointer grab that
  // freezes all input except the mouse and spins the CPU.
  mainWindow.on('system-context-menu', (event) => {
    event.preventDefault();
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
  const mainWebContentsId = mainWindow.webContents.id;
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Only inject CSP for the main renderer window, not the BrowserView panel.
    // The BrowserView shares the default session but needs to load real websites
    // without our restrictive CSP blocking their external scripts/styles/fonts.
    if (details.webContentsId !== mainWebContentsId) {
      callback({ cancel: false });
      return;
    }
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

  const DEV_LOAD_URL = 'http://localhost:5173';
  const MAX_LOAD_RETRIES = 5;
  const LOAD_RETRY_MS = 2000;
  const win = mainWindow!;

  const loadWindowUrl = () => {
    if (win.isDestroyed()) return;
    if (isDev) {
      win.loadURL(DEV_LOAD_URL);
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
  };

  loadWindowUrl();

  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || win.isDestroyed()) return;
    if (isDev && validatedURL === DEV_LOAD_URL) {
      const retries = (win as any).__loadRetries ?? 0;
      (win as any).__loadRetries = retries + 1;
      if (retries < MAX_LOAD_RETRIES) {
        log.warn(`[Main] Dev load failed (${errorCode}), retrying in ${LOAD_RETRY_MS}ms (${retries + 1}/${MAX_LOAD_RETRIES})`);
        setTimeout(loadWindowUrl, LOAD_RETRY_MS);
      } else {
        const errorHtml = `data:text/html,${encodeURIComponent(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clawdia</title></head><body style="font-family:sans-serif;padding:2rem;max-width:32rem;">
            <h1>Could not load app</h1>
            <p>Dev server at <code>http://localhost:5173</code> did not respond after ${MAX_LOAD_RETRIES} attempts.</p>
            <p>Start the dev server with <code>npm run dev</code> (or ensure <code>npm run dev:renderer</code> is running), then click below.</p>
            <button onclick="location.href='${DEV_LOAD_URL}'" style="padding:0.5rem 1rem;cursor:pointer;">Retry</button>
          </body></html>`
        )}`;
        win.loadURL(errorHtml).catch(() => { });
      }
    } else if (!isDev) {
      log.error('[Main] Failed to load renderer', { errorCode, validatedURL });
    }
  });

  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    delete (win as any).__loadRetries;
    // In dev, show only after main frame has loaded to avoid blank window on restart.
    if (isDev) win.show();
    // Flush any task state updates that arrived while window was closed
    setTimeout(() => flushPendingTaskState(), 500);
  });

  mainWindow.once('ready-to-show', () => {
    if (!isDev) mainWindow?.show();
    // Kill any orphaned CDP processes from a prior crashed session before connecting.
    killOrphanedCDPProcesses();
    // CDP server is reliably up once the window is ready to show.
    // Kick off Playwright connection here so it doesn't race.
    void initPlaywright().then(() => {
      registerPlaywrightSearchFallback();
      void refreshMcpRuntimeHealth('playwright-init');
    });

    // Log diagnostic summary of available session cookies (fire-and-forget).
    void logCookieDiagnostic();

    // Warm DNS + TCP + TLS connections to API endpoints (fire-and-forget).
    // Eliminates cold-start latency on first search/LLM call.
    void warmConnections();

    // Initialize capability registry + detect fast-path CLI tools in background.
    void initializeCapabilityRegistry();
    void detectFastPathTools();
    startMcpRuntimeManager();

    // Dashboard executor — starts immediately (static layer works without rules).
    // Haiku rules generation is async and loaded when ready.
    dashboardExecutor = new DashboardExecutor({
      getSelectedModel,
      storeGet: (key: string) => store.get(key as any),
      getBrowserStatus,
      lastMessageGetter: () => lastMessageTimestamp,
      getTaskDashboardItems,
      getTaskUnreadCount: () => taskUnreadCount,
    });

    dashboardExecutor.setUpdateEmitter((state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_EVENTS.DASHBOARD_UPDATE, state);
      }
    });

    // Forward token usage from tool-loop to executor
    setTokenUsageCallback((data) => dashboardExecutor?.addTokenUsage(data));

    dashboardExecutor.start();

    // Async: collect ambient data + generate insights via Haiku (with persistence)
    const dashApiKey = getAnthropicApiKey();
    if (dashApiKey) {
      void (async () => {
        try {
          // Step 1: Load persisted state from disk
          const persisted = loadDashboardState();

          // Step 2: Collect fresh ambient data
          let ambientData;
          let ambientCtx = '';
          try {
            const [rawResult, fmtResult] = await Promise.all([
              collectAmbientData(),
              collectAmbientContext(),
            ]);
            ambientData = rawResult;
            ambientCtx = fmtResult.combined;
            log.info(`[Ambient] Collected raw data + ${ambientCtx.length} chars formatted context`);

            // Inject compact summary into LLM system prompt
            const compactSummary = formatCompactSummary(rawResult);
            if (compactSummary) {
              setAmbientSummary(compactSummary);
              log.info(`[Ambient] Summary injected: ${compactSummary.length} chars`);
            }
          } catch (err: any) {
            log.warn(`[Ambient] Context collection failed: ${err?.message || err}`);
          }

          // Step 3: Compute context hash and decide startup strategy
          const freshHash = ambientData ? computeContextHash(ambientData) : '';
          const hashesMatch = persisted && freshHash === persisted.contextHash;

          if (hashesMatch && !persisted.sessionHadActivity) {
            // Case A: Hashes match, last session idle → reuse persisted state, skip Haiku
            log.info(`[Dashboard] Persistence: reusing cached state (no activity change, hash=${freshHash.slice(0, 8)})`);
            dashboardExecutor?.setAmbientData(
              ambientData!,
              persisted.haiku,
            );
            // No Haiku call — render immediately from persisted data
          } else {
            // Case B (hash differs) or Case C (no persisted state)
            // Show persisted state as placeholder if available
            if (persisted && ambientData) {
              log.info(`[Dashboard] Persistence: showing cached state as placeholder, refreshing in background (hash ${persisted.contextHash.slice(0, 8)} → ${freshHash.slice(0, 8)})`);
              dashboardExecutor?.setAmbientData(ambientData, persisted.haiku);
            } else if (ambientData) {
              log.info(`[Dashboard] Persistence: no cached state, normal startup`);
              dashboardExecutor?.setAmbientData(ambientData, null);
            }

            // Haiku call for fresh insights
            const dashClient = getClient(dashApiKey, getSelectedModel());
            let memCtx = '';
            try { memCtx = userMemory?.getPromptContext(600) || ''; } catch { /* db may not be ready */ }

            let topSites = '';
            try {
              const sk = siteKnowledge;
              if (sk) {
                const sites = (sk as any).db
                  .prepare(`SELECT hostname, SUM(success_count) AS total FROM site_knowledge GROUP BY hostname ORDER BY total DESC LIMIT 10`)
                  .all() as Array<{ hostname: string; total: number }>;
                topSites = sites.map(s => `${s.hostname} (${s.total})`).join(', ');
                if (topSites) topSites = `Top sites: ${topSites}`;
              }
            } catch { /* site knowledge may not be ready */ }

            let recentConvos = '';
            try {
              const convos = conversationManager.list().slice(0, 5);
              if (convos.length > 0) {
                recentConvos = convos.map(c => {
                  const ago = Math.round((Date.now() - new Date(c.updatedAt).getTime()) / 60_000);
                  const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
                  return `- "${c.title}" (${agoStr})`;
                }).join('\n');
              }
            } catch { /* conversations may not be ready */ }

            const haiku = await generateDashboardInsights(dashClient, {
              userMemoryContext: memCtx,
              topSitesContext: topSites,
              recentConversations: recentConvos,
              ambientContext: ambientCtx,
            });

            // Re-feed with Haiku enrichment
            if (ambientData) {
              dashboardExecutor?.setAmbientData(ambientData, haiku);

              // Save fresh state to disk
              saveDashboardState({
                haiku,
                projectCards: buildProjectCards(ambientData, haiku),
                activityFeed: buildActivityFeed(ambientData),
                contextHash: freshHash,
                sessionHadActivity: sessionHadActivity(),
                savedAt: Date.now(),
              });
            }
            log.info('[Dashboard] Insights ready');
          }
        } catch (err: any) {
          log.warn(`[Dashboard] Insights generation failed: ${err?.message || err}`);
        }
      })();
    }
  });

  // --- Crash recovery: GPU and renderer process deaths ---
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
      log.warn('Attempting to reload renderer after crash...');
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const isDev = process.env.NODE_ENV === 'development';
          if (isDev) {
            mainWindow.loadURL('http://localhost:5173');
          } else {
            mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
          }
        }
      } catch (reloadErr: any) {
        log.error(`Failed to reload after crash: ${reloadErr?.message}`);
      }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    log.warn('Main window became unresponsive — waiting for recovery...');
  });

  mainWindow.webContents.on('responsive', () => {
    log.info('Main window is responsive again');
  });

  // Hide to tray instead of closing. The window is only actually destroyed when
  // app.quit() is called (via tray menu or gracefulShutdown), which sets app.isQuitting.
  mainWindow.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault();
      if (mainWindow) {
        savedWindowBounds = mainWindow.getBounds();
        mainWindow.hide();
      }
      log.info('[Tray] Window hidden to tray');

      if (trayFirstMinimize && Notification.isSupported()) {
        trayFirstMinimize = false;
        new Notification({
          title: 'Clawdia',
          body: 'Still running in the background. Right-click the tray icon to quit.',
          silent: true,
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    usageTracker.setWarningEmitter(null);
    mainWindow = null;
    void closeBrowser();
  });
}

function setupIpcHandlers(): void {
  log.info('[IPC] setupIpcHandlers() starting — registering all IPC handlers');
  handleValidated(IPC.CHAT_SEND, ipcSchemas[IPC.CHAT_SEND], async (_event, payload) => {
    const { conversationId, message, images, documents, messageId } = payload;
    if (!mainWindow) return { error: 'No window' };

    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      mainWindow.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
      mainWindow.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: 'No API key configured' });
      return { error: 'No API key' };
    }

    const model = getSelectedModel();
    log.info(`[CHAT_SEND] selectedModel=${model}`);
    const client = getClient(apiKey, model);
    const win = mainWindow;

    try {
      const result = await processChatMessage({
        message,
        conversationId,
        messageId,
        emitter: wrapWindow(win),
        client,
        conversationManager,
        images,
        documents,
        requestApproval: solicitorApproval,
        onToolLoopCreated: (loop) => { activeToolLoop = loop; },
        onResponse: (response, loop) => {
          if (!win.isDestroyed()) {
            if (!loop.streamed) {
              win.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, response);
            }
            win.webContents.send(IPC_EVENTS.CHAT_STREAM_END, response);
          }
        },
        onError: (error) => {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_EVENTS.CHAT_THINKING, '');
            win.webContents.send(IPC_EVENTS.CHAT_ERROR, { error: error?.message || 'Unknown error' });
          }
        },
      });
      return { conversationId: result.conversationId };
    } catch (error: any) {
      return { error: error?.message || 'Unknown error' };
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
    strategyCache.clear();
    const conv = conversationManager.create();
    clearTaskApprovals(conv.id);
    return { id: conv.id };
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
    const previousModel = (store.get('selectedModel') as string) || DEFAULT_MODEL;
    store.set('selectedModel', model);
    log.info(`[MODEL_SET] previousModel=${previousModel} | newModel=${model}`);
    // Invalidate cached client so next request uses the new model.
    cachedClient = null;
    cachedClientApiKey = null;
    cachedClientModel = null;
    return { success: true };
  });

  handleValidated(IPC.AUTONOMY_GET, ipcSchemas[IPC.AUTONOMY_GET], async () => ({
    mode: (store.get('autonomyMode') as string) || 'guided',
    unrestrictedConfirmed: Boolean(store.get('unrestrictedConfirmed')),
  }));

  log.info(`[Main] Registering IPC handler for ${IPC.AUTONOMY_SET}`);
  handleValidated(IPC.AUTONOMY_SET, (ipcSchemas as any)[IPC.AUTONOMY_SET], async (_event, payload) => {
    const { mode, confirmUnrestricted } = payload as any;
    log.info(`[AUTONOMY_SET] requested mode=${mode}, confirmUnrestricted=${confirmUnrestricted}`);

    if (mode === 'unrestricted' && !store.get('unrestrictedConfirmed') && !confirmUnrestricted) {
      log.warn('[AUTONOMY_SET] Unrestricted mode blocked: missing confirmation');
      return { success: false, error: 'Unrestricted mode requires confirmation' };
    }

    if (confirmUnrestricted) {
      store.set('unrestrictedConfirmed', true);
      log.info('[AUTONOMY_SET] Unrestricted mode confirmed');
    }

    const prevMode = (store.get('autonomyMode') as string) || 'guided';
    store.set('autonomyMode', mode);
    log.info(`[AUTONOMY_SET] Mode updated to: ${mode}`);
    if (prevMode !== mode) {
      appendAuditEvent({
        ts: Date.now(),
        kind: 'mode_changed',
        autonomyMode: mode,
        detail: `Autonomy mode changed from ${prevMode} to ${mode}`,
        outcome: 'info',
      });
    }
    return { success: true, mode };
  });

  handleValidated(IPC.CAPABILITY_PLATFORM_STATUS_GET, (ipcSchemas as any)[IPC.CAPABILITY_PLATFORM_STATUS_GET], async () => {
    return buildCapabilityPlatformStatus();
  });

  handleValidated(IPC.CAPABILITY_PLATFORM_FLAGS_SET, (ipcSchemas as any)[IPC.CAPABILITY_PLATFORM_FLAGS_SET], async (_event, payload: any) => {
    const previous = getCapabilityPlatformFlags();
    const next = setCapabilityPlatformFlags(payload.flags || {});
    log.info(
      `[CapabilityPlatform] flags updated: mcpRuntimeManager=${next.mcpRuntimeManager} containerExecution=${next.containerExecution}`
    );

    if (!previous.mcpRuntimeManager && next.mcpRuntimeManager) {
      startMcpRuntimeManager();
    } else if (previous.mcpRuntimeManager && !next.mcpRuntimeManager) {
      stopMcpRuntimeManager();
    }

    if (!previous.containerExecution && next.containerExecution) {
      const runtime = await detectContainerRuntime();
      log.info(`[CapabilityPlatform] container runtime after enable: ${runtime.detail}`);
    }

    return {
      success: true,
      status: await buildCapabilityPlatformStatus(),
    };
  });

  handleValidated(IPC.SETTINGS_GET, ipcSchemas[IPC.SETTINGS_GET], async () => ({
    anthropic_api_key: getMaskedAnthropicApiKey(),
    anthropic_key_masked: getMaskedAnthropicApiKey(),
    has_completed_setup: Boolean(store.get('hasCompletedSetup')),
    selected_model: (store.get('selectedModel') as string) || DEFAULT_MODEL,
    serper_api_key: store.get('serper_api_key') ? '••••••••' : '',
    serpapi_api_key: store.get('serpapi_api_key') ? '••••••••' : '',
    bing_api_key: store.get('bing_api_key') ? '••••••••' : '',
    search_backend: store.get('search_backend') || 'serper',
    mcp_servers_count: Array.isArray(store.get('mcpServers' as any)) ? (store.get('mcpServers' as any) as unknown[]).length : 0,
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

  handleValidated(IPC.FILE_OPEN, ipcSchemas[IPC.FILE_OPEN], async (_event, payload) => {
    try {
      let filePath = String(payload.filePath || '').trim();
      if (filePath.startsWith('~')) {
        filePath = path.join(homedir(), filePath.slice(1));
      }
      filePath = path.resolve(filePath);
      if (!filePath.startsWith(homedir())) {
        return { success: false, error: 'Refusing to open files outside the user home directory.' };
      }
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        return { success: false, error: 'Path is not a file.' };
      }
      await shell.openPath(filePath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to open file.' };
    }
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

  handleValidated(IPC.ACCOUNTS_LIST, ipcSchemas[IPC.ACCOUNTS_LIST], async () => listAccounts());

  handleValidated(IPC.ACCOUNTS_ADD, ipcSchemas[IPC.ACCOUNTS_ADD], async (_event, payload) => {
    const account = addAccount({ ...payload, isManual: true });
    mainWindow?.webContents.send(IPC_EVENTS.ACCOUNTS_UPDATED, listAccounts());
    return account;
  });

  handleValidated(IPC.ACCOUNTS_REMOVE, ipcSchemas[IPC.ACCOUNTS_REMOVE], async (_event, payload) => {
    const removed = removeAccount(payload.id);
    if (removed) {
      mainWindow?.webContents.send(IPC_EVENTS.ACCOUNTS_UPDATED, listAccounts());
    }
    return { removed };
  });

  handleValidated(IPC.STORE_RESET, ipcSchemas[IPC.STORE_RESET], async () => {
    resetStore(store);
    return { success: true };
  });

  handleValidated(IPC.MEMORY_GET_ALL, ipcSchemas[IPC.MEMORY_GET_ALL], async () => {
    return userMemory?.recallAll() ?? [];
  });

  handleValidated(IPC.MEMORY_FORGET, ipcSchemas[IPC.MEMORY_FORGET], async (_event, payload) => {
    userMemory?.forget(payload.category, payload.key);
    return { success: true };
  });

  handleValidated(IPC.MEMORY_RESET, ipcSchemas[IPC.MEMORY_RESET], async () => {
    userMemory?.reset();
    return { success: true };
  });

  handleValidated(IPC.SITE_KNOWLEDGE_GET, ipcSchemas[IPC.SITE_KNOWLEDGE_GET], async (_event, payload) => {
    return siteKnowledge?.getContextForHostname(payload.hostname) ?? '';
  });

  handleValidated(IPC.SITE_KNOWLEDGE_RESET, ipcSchemas[IPC.SITE_KNOWLEDGE_RESET], async () => {
    siteKnowledge?.reset();
    return { success: true };
  });

  // Vault Handlers
  ingestionEmitter.on('job-update', (job: IngestionJob) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_EVENTS.VAULT_JOB_UPDATE, job);
    });
  });

  handleValidated(IPC.VAULT_INGEST_FILE, ipcSchemas[IPC.VAULT_INGEST_FILE], async (_event, payload) => {
    try {
      const docId = await IngestionManager.ingest(payload.filePath);
      return { success: true, docId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  handleValidated(IPC.VAULT_SEARCH, ipcSchemas[IPC.VAULT_SEARCH], async (_event, payload) => {
    const results = await VaultSearch.search(payload.query, payload.limit);
    return { success: true, results };
  });

  handleValidated(IPC.VAULT_GET_JOB, ipcSchemas[IPC.VAULT_GET_JOB], async (_event, payload) => {
    const job = getIngestionJob(payload.id);
    return { success: true, job };
  });

  // Action Handlers
  handleValidated(IPC.ACTION_CREATE_PLAN, ipcSchemas[IPC.ACTION_CREATE_PLAN], async (_event, payload) => {
    const plan = createPlan(payload.description);
    return { success: true, plan };
  });

  handleValidated(IPC.ACTION_ADD_ITEM, ipcSchemas[IPC.ACTION_ADD_ITEM], async (_event, payload) => {
    const action = addAction(payload.planId, payload.type as ActionType, payload.payload, payload.sequenceOrder);
    return { success: true, action };
  });

  handleValidated(IPC.ACTION_EXECUTE_PLAN, ipcSchemas[IPC.ACTION_EXECUTE_PLAN], async (_event, payload) => {
    try {
      await ActionExecutor.executePlan(payload.planId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  handleValidated(IPC.ACTION_UNDO_PLAN, ipcSchemas[IPC.ACTION_UNDO_PLAN], async (_event, payload) => {
    try {
      await ActionExecutor.undoPlan(payload.planId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  handleValidated(IPC.ACTION_GET_PLAN, ipcSchemas[IPC.ACTION_GET_PLAN], async (_event, payload) => {
    const plan = getPlan(payload.planId);
    return { success: true, plan };
  });

  handleValidated(IPC.ACTION_GET_ITEMS, ipcSchemas[IPC.ACTION_GET_ITEMS], async (_event, payload) => {
    const items = getActions(payload.planId);
    return { success: true, items };
  });

  // Dashboard
  handleValidated(IPC.DASHBOARD_GET, ipcSchemas[IPC.DASHBOARD_GET], async () => {
    return dashboardExecutor?.getCurrentState() ?? null;
  });

  handleValidated(IPC.DASHBOARD_DISMISS_RULE, ipcSchemas[IPC.DASHBOARD_DISMISS_RULE], async (_event, { ruleId }) => {
    dashboardExecutor?.dismissAlert(ruleId);
    return { success: true };
  });

  handleValidated(IPC.DASHBOARD_DISMISS_ALERT, ipcSchemas[IPC.DASHBOARD_DISMISS_ALERT], async (_event, { alertId }) => {
    dashboardExecutor?.dismissAlert(alertId);
    return { success: true };
  });

  handleValidated(IPC.DASHBOARD_SET_VISIBLE, ipcSchemas[IPC.DASHBOARD_SET_VISIBLE], async (_event, { visible }) => {
    dashboardExecutor?.setDashboardVisible(visible);
    return { success: true };
  });

  // Ambient settings
  handleValidated(IPC.AMBIENT_SETTINGS_GET, ipcSchemas[IPC.AMBIENT_SETTINGS_GET], async () => {
    const saved = store.get('ambientSettings') as AmbientSettings | undefined;
    return saved ?? { ...DEFAULT_AMBIENT_SETTINGS };
  });

  handleValidated(IPC.AMBIENT_SETTINGS_SET, ipcSchemas[IPC.AMBIENT_SETTINGS_SET], async (_event, { settings }) => {
    const current = (store.get('ambientSettings') as AmbientSettings | undefined) ?? { ...DEFAULT_AMBIENT_SETTINGS };
    const merged = { ...current, ...settings } as AmbientSettings;
    // Validate scanRoots is an array of strings
    if (Array.isArray(merged.scanRoots)) {
      merged.scanRoots = merged.scanRoots.filter((r: unknown) => typeof r === 'string' && r.trim().length > 0);
    } else {
      merged.scanRoots = DEFAULT_AMBIENT_SETTINGS.scanRoots;
    }
    // Clamp browserHistoryHours
    if (typeof merged.browserHistoryHours !== 'number' || merged.browserHistoryHours < 1) {
      merged.browserHistoryHours = DEFAULT_AMBIENT_SETTINGS.browserHistoryHours;
    }
    store.set('ambientSettings', merged);

    // Re-scan immediately so changes take effect without restart
    void (async () => {
      try {
        const rawData = await collectAmbientData();
        const compact = formatCompactSummary(rawData);
        if (compact) setAmbientSummary(compact);
        log.info('[Ambient] Re-scanned after settings change');
      } catch (err: any) {
        log.warn(`[Ambient] Re-scan failed: ${err?.message || err}`);
      }
    })();

    return { success: true };
  });

  // Task handlers
  handleValidated(IPC.TASK_LIST, ipcSchemas[IPC.TASK_LIST], async () => {
    return getTaskDashboardItems();
  });

  handleValidated(IPC.TASK_GET, ipcSchemas[IPC.TASK_GET], async (_event, { taskId }) => {
    const task = getTask(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    const runs = getRunsForTask(taskId, 5);
    return { success: true, task, runs };
  });

  handleValidated(IPC.TASK_DELETE, ipcSchemas[IPC.TASK_DELETE], async (_event, { taskId }) => {
    deleteTask(taskId);
    broadcastTaskState();
    return { success: true };
  });

  handleValidated(IPC.TASK_PAUSE, ipcSchemas[IPC.TASK_PAUSE], async (_event, { taskId }) => {
    pauseTask(taskId);
    taskScheduler?.onTaskPaused(taskId);
    broadcastTaskState();
    return { success: true };
  });

  handleValidated(IPC.TASK_RESUME, ipcSchemas[IPC.TASK_RESUME], async (_event, { taskId }) => {
    resumeTask(taskId);
    taskScheduler?.onTaskResumed(taskId);
    broadcastTaskState();
    return { success: true };
  });

  handleValidated(IPC.TASK_RUN_NOW, ipcSchemas[IPC.TASK_RUN_NOW], async (_event, { taskId }) => {
    const result = await taskScheduler?.triggerManualRun(taskId);
    broadcastTaskState();
    return { success: true, result };
  });

  handleValidated(IPC.TASK_APPROVE_RUN, ipcSchemas[IPC.TASK_APPROVE_RUN], async (_event, { runId }) => {
    // Approve: mark run as cancelled (we'll create a fresh run via triggerManualRun)
    const run = getRun(runId);
    if (!run) return { success: false, error: 'Run not found' };
    updateRun(runId, { status: 'cancelled' });
    // Trigger actual execution
    const result = await taskScheduler?.triggerManualRun(run.taskId);
    broadcastTaskState();
    return { success: true, result };
  });

  handleValidated(IPC.TASK_DISMISS_RUN, ipcSchemas[IPC.TASK_DISMISS_RUN], async (_event, { runId }) => {
    updateRun(runId, { status: 'cancelled' });
    broadcastTaskState();
    return { success: true };
  });

  handleValidated(IPC.TASK_GET_UNREAD, ipcSchemas[IPC.TASK_GET_UNREAD], async () => {
    return { count: taskUnreadCount };
  });

  handleValidated(IPC.TASK_CLEAR_UNREAD, ipcSchemas[IPC.TASK_CLEAR_UNREAD], async () => {
    taskUnreadCount = 0;
    return { success: true };
  });

  handleValidated(IPC.TASK_GET_RUNS, ipcSchemas[IPC.TASK_GET_RUNS], async (_event, { taskId }) => {
    const runs = getRunsForTask(taskId, 20);
    return { success: true, runs };
  });

  handleValidated(IPC.TASK_GET_EXECUTOR, ipcSchemas[IPC.TASK_GET_EXECUTOR], async (_event, { taskId }) => {
    const executor = getExecutorForTask(taskId);
    return { success: true, executor };
  });

  // Telegram config
  handleValidated(IPC.TELEGRAM_GET_CONFIG, ipcSchemas[IPC.TELEGRAM_GET_CONFIG], async () => ({
    enabled: Boolean(store.get('telegramEnabled')),
    hasToken: Boolean((store.get('telegramBotToken') as string | undefined)?.trim()),
    authorizedChatId: store.get('telegramAuthorizedChatId') as number | undefined,
    conversationId: (store.get('telegramConversationId') as string | undefined) || null,
    running: isTelegramBotRunning(),
  }));

  handleValidated(IPC.TELEGRAM_SET_TOKEN, ipcSchemas[IPC.TELEGRAM_SET_TOKEN], async (_event, { token }) => {
    store.set('telegramBotToken', token.trim());
    // Restart bot if enabled
    if (store.get('telegramEnabled')) initTelegramIfEnabled();
    return { success: true };
  });

  handleValidated(IPC.TELEGRAM_SET_ENABLED, ipcSchemas[IPC.TELEGRAM_SET_ENABLED], async (_event, { enabled }) => {
    store.set('telegramEnabled', enabled);
    if (enabled) {
      initTelegramIfEnabled();
    } else {
      stopTelegramBot();
    }
    return { success: true };
  });

  handleValidated(IPC.TELEGRAM_CLEAR_AUTH, ipcSchemas[IPC.TELEGRAM_CLEAR_AUTH], async () => {
    store.set('telegramAuthorizedChatId', undefined as any);
    store.delete('telegramConversationId');
    return { success: true };
  });

  handleValidated(IPC.APPROVAL_RESPONSE, (ipcSchemas as any)[IPC.APPROVAL_RESPONSE], async (_event, payload: any) => {
    const { id, decision } = payload;
    const resolver = pendingApprovals.get(id);
    if (resolver) {
      approvalSources.set(id, 'desktop');
      // Clean up source after 5s (autonomy-gate reads it synchronously after resolve)
      setTimeout(() => approvalSources.delete(id), 5000);
      // Call resolver BEFORE deleting from map — resolveOnce guards on pendingApprovals.has()
      resolver(decision as ApprovalDecision);
      return { success: true };
    }
    return { success: false, error: 'Approval request not found or expired' };
  });

  // --- Audit / Security Timeline ---
  ipcMain.handle(IPC.AUDIT_GET_EVENTS, async (_event, filters: any) => {
    return queryAuditEvents(filters || {});
  });

  ipcMain.handle(IPC.AUDIT_CLEAR, async () => {
    const count = clearAuditEvents();
    return { success: true, count };
  });

  ipcMain.handle(IPC.AUDIT_GET_SUMMARY, async () => {
    return getAuditSummary();
  });

  handleValidated(IPC.AUTONOMY_GET_ALWAYS_APPROVALS, (ipcSchemas as any)[IPC.AUTONOMY_GET_ALWAYS_APPROVALS], async () => {
    return (store.get('autonomyOverrides' as any) as AutonomyOverrides) || {};
  });

  handleValidated(IPC.AUTONOMY_REMOVE_ALWAYS_APPROVAL, (ipcSchemas as any)[IPC.AUTONOMY_REMOVE_ALWAYS_APPROVAL], async (_event, payload: any) => {
    const { risk } = payload;
    const current = (store.get('autonomyOverrides' as any) as AutonomyOverrides) || {};
    const next = { ...current };
    delete next[risk as RiskLevel];
    store.set('autonomyOverrides' as any, next);
    log.info(`[Autonomy] Removed global override for ${risk}`);
    appendAuditEvent({
      ts: Date.now(),
      kind: 'override_removed',
      risk: risk as RiskLevel,
      detail: `Always-approve removed for ${risk}`,
      outcome: 'info',
    });
    return { success: true };
  });

  log.info('[IPC] setupIpcHandlers() complete — all handlers registered');
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    setupIpcHandlers();
    setupBrowserIpc();
    setCdpPort(REMOTE_DEBUGGING_PORT);
    initSearchCache();
    initAuditStore();
    setDecisionSourceResolver((requestId) => approvalSources.get(requestId));
    // Push new audit events to renderer for live timeline updates
    onAuditEvent((event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_EVENTS.AUDIT_EVENT, event);
      }
    });
    initLearningSystem();
    initArchive();
    initVault();

    // Clean up zombie task runs left over from a prior crash/quit.
    // Must happen after initVault() (DB available) but before scheduler starts.
    const zombieCount = cleanupZombieRuns();
    if (zombieCount > 0) {
      log.info(`[Startup] Cleaned up ${zombieCount} zombie task run(s)`);
    }

    initHeadlessRunner({
      getApiKey: () => getAnthropicApiKey() || '',
      getClient: (key, mod) => getClient(key, mod),
      getDefaultModel: () => getSelectedModel(),
      requestApproval: solicitorApproval,
    });
    taskScheduler = new TaskScheduler({
      getApiKey: getAnthropicApiKey,
      getSelectedModel,
      lastMessageGetter: () => lastMessageTimestamp,
      getMainWindow: () => mainWindow,
      onRunCompleted: (task, result) => {
        // Track unread if window is hidden/minimized
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
          taskUnreadCount++;
        }
        // Push updated task state to renderer
        broadcastTaskState();
        // Notify Telegram if running
        notifyTaskResult(task, result);
      },
      onApprovalNeeded: (task, runId) => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
          taskUnreadCount++;
        }
        broadcastTaskState();
      },
    });
    setSchedulerInstance(taskScheduler);
    taskScheduler.start();
    createTray();
    createWindow();
    initTelegramIfEnabled();

    // initPlaywright() is now called from mainWindow 'ready-to-show' event
    // to ensure CDP server is up before attempting connection.

    app.on('activate', () => {
      // macOS dock click — show existing hidden window or create a new one
      if (mainWindow && !mainWindow.isDestroyed()) {
        showWindow();
      } else {
        createWindow();
        // initPlaywright will be triggered by ready-to-show in createWindow.
      }
    });
  });
}

app.on('window-all-closed', () => {
  // On Linux, we destroy + recreate the window on tray restore, which triggers
  // window-all-closed briefly. Only clean up if actually quitting.
  if (!(app as any).isQuitting) {
    log.info('[Tray] window-all-closed (tray mode — keeping background services alive)');
    return;
  }
  log.info('[Tray] window-all-closed (quitting — cleaning up)');
  try {
    const currentState = dashboardExecutor?.getCurrentState();
    if (currentState) {
      const existing = loadDashboardState();
      saveDashboardState({
        haiku: getCachedInsights() || existing?.haiku || null,
        projectCards: currentState.projects,
        activityFeed: currentState.activityFeed,
        contextHash: existing?.contextHash || '',
        sessionHadActivity: sessionHadActivity(),
        savedAt: Date.now(),
      });
    }
  } catch (err: any) {
    log.warn(`[Dashboard] Failed to save state on quit: ${err?.message || err}`);
  }
  dashboardExecutor?.stop();
  taskScheduler?.stop();
  stopMcpRuntimeManager();
  stopSessionReaper();
  closeSearchCache();
  closeArchive();
  closeAuditStore();
  shutdownLearningSystem();
});

// Ensure isQuitting is set for any quit path (Cmd+Q on macOS, SIGTERM, tray Quit, etc.)
app.on('before-quit', () => {
  (app as any).isQuitting = true;
  stopMcpRuntimeManager();
});

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  if (process.env.NODE_ENV === 'development') {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// GPU / child process crash recovery — prevent cascading app death.
app.on('child-process-gone', (_event, details) => {
  log.error(`Child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`);
  if (details.type === 'GPU') {
    log.warn('GPU process crashed — app continues with software rendering');
    // With --in-process-gpu on Linux this shouldn't happen, but if it does
    // the app can continue; Chromium falls back to software rendering automatically.
  }
});

// Hardened shutdown — clean up all sessions with a hard timeout.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  log.info(`${signal} received, shutting down...`);
  (app as any).isQuitting = true;
  taskScheduler?.stop();
  stopTelegramBot();
  stopSessionReaper();

  if (tray) {
    tray.destroy();
    tray = null;
  }

  const shutdownTimer = setTimeout(() => {
    log.warn(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    app.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await shutdownTaskBrowser();
    await closeBrowser();
    closeArchive();
    shutdownLearningSystem();
  } catch (err: any) {
    log.warn(`closeBrowser error during shutdown: ${err?.message}`);
  } finally {
    clearTimeout(shutdownTimer);
    await killOrphanedCDPProcesses();
    app.quit();
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// SIGPIPE: broken pipe from stdout/stderr (e.g., piped to a dead process).
// Default Node.js behavior is to crash — we suppress it entirely.
process.on('SIGPIPE', () => {
  log.debug('SIGPIPE received (suppressed)');
});

process.on('uncaughtException', (error) => {
  // EPIPE / SIGPIPE errors should never crash the app — they just mean
  // a pipe (stdout/stderr) was broken, which is harmless.
  if (error && (error as any).code === 'EPIPE') {
    log.debug('EPIPE exception suppressed');
    return;
  }
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
