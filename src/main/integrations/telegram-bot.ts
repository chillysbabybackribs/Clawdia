/**
 * Telegram Bot — pure message relay.
 * Relay IN:  Telegram → processChatMessage (same handler as desktop IPC)
 * Relay OUT: IPC_EVENTS on emitter → buffer → send to Telegram
 * Notify:    Task run completes → send result to Telegram
 */
import TelegramBot from 'node-telegram-bot-api';
import { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { processChatMessage } from '../llm/chat-pipeline';
import { listTasks } from '../tasks/task-store';
import { collectMetrics } from '../dashboard/metrics';
import type { AnthropicClient } from '../llm/client';
import type { ConversationManager } from '../llm/conversation';
import type { ToolLoopEmitter } from '../../shared/types';
import type { PersistentTask } from '../../shared/task-types';
import { createLogger } from '../logger';

const log = createLogger('telegram');
const MAX_MSG = 4096;

// P1: Channels that should NOT be forwarded to the desktop window from
// Telegram-originated messages — they'd appear in the wrong conversation tab.
const SUPPRESS_TO_DESKTOP: Set<string> = new Set([
  IPC_EVENTS.CHAT_STREAM_TEXT,
  IPC_EVENTS.CHAT_STREAM_END,
  IPC_EVENTS.CHAT_THINKING,
]);

// P1: Sanitize bot tokens from error messages before logging.
function sanitizeTelegramError(msg: string): string {
  return msg.replace(/\d{8,}:[A-Za-z0-9_-]{35,}/g, 'BOT_TOKEN_REDACTED');
}

// P1: Health monitoring — track consecutive polling errors.
let consecutiveErrors = 0;
const MAX_ERRORS_BEFORE_WARNING = 3;
const MAX_ERRORS_BEFORE_DISCONNECTED = 10;

export interface TelegramDeps {
  getApiKey: () => string;
  getSelectedModel: () => string;
  getClient: (apiKey: string, model: string) => AnthropicClient;
  conversationManager: ConversationManager;
  getMainWindow: () => BrowserWindow | null;
  getAuthorizedChatId: () => number | undefined;
  setAuthorizedChatId: (chatId: number) => void;
}

let bot: TelegramBot | null = null;
let deps: TelegramDeps | null = null;
let activeConvId: string | null = null;

function mdToHtml(t: string): string {
  return t
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`{3}(\w*)\n([\s\S]*?)\n`{3}/g, '<pre>$2</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function splitMsg(text: string): string[] {
  if (text.length <= MAX_MSG) return [text];
  const out: string[] = [];
  let rem = text;
  while (rem.length > MAX_MSG) {
    let i = rem.lastIndexOf('\n\n', MAX_MSG);
    if (i < 100) i = rem.lastIndexOf('\n', MAX_MSG);
    if (i < 100) i = MAX_MSG;
    out.push(rem.slice(0, i));
    rem = rem.slice(i).trimStart();
  }
  if (rem) out.push(rem);
  return out;
}

async function send(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  for (const chunk of splitMsg(mdToHtml(text))) {
    try { await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' }); }
    catch { await bot.sendMessage(chatId, chunk).catch(() => { }); }
  }
}

// P0 fix: resBuf/resResolve are scoped per-request inside the emitter closure.
// P1 fix: stream events are NOT forwarded to the desktop window — they'd
// appear in the wrong conversation tab. Tool activity is still forwarded
// so the desktop activity panel stays accurate.
function createEmitter(chatId: number): { emitter: ToolLoopEmitter; responseP: Promise<string>; resolve: (t: string) => void } {
  const win = deps?.getMainWindow();
  let resBuf = '';
  let resolved = false;
  let resResolve: ((t: string) => void) | null = null;
  const responseP = new Promise<string>((r) => { resResolve = r; });

  // Exposed resolve — prefers accumulated streamed text over the argument.
  const resolve = (fallback: string) => {
    if (resolved) return;
    resolved = true;
    resResolve?.(resBuf || fallback);
    resResolve = null;
  };

  const emitter: ToolLoopEmitter = {
    send(channel: string, ...args: any[]) {
      // Forward non-stream events to desktop (tool activity, tool results, etc.)
      if (win && !win.isDestroyed() && !SUPPRESS_TO_DESKTOP.has(channel)) {
        win.webContents.send(channel, ...args);
      }
      if (channel === IPC_EVENTS.CHAT_STREAM_TEXT) resBuf += (args[0] as string) || '';
      if (channel === IPC_EVENTS.CHAT_TOOL_ACTIVITY) {
        const e = args[0] as { tool?: string; status?: string };
        if (e?.tool && e?.status === 'running') send(chatId, `\u{1F527} ${e.tool}...`).catch(() => { });
      }
    },
    isDestroyed() { return false; },
  };

  return { emitter, responseP, resolve };
}

// P0 fix: queue serializes message processing — prevents concurrent corruption.
let messageQueue: Promise<void> = Promise.resolve();

function handleMessage(msg: TelegramBot.Message): void {
  messageQueue = messageQueue
    .then(() => handleMessageInner(msg))
    .catch((e) => log.error(`[Telegram] Queued message error: ${sanitizeTelegramError(String(e))}`));
}

async function handleMessageInner(msg: TelegramBot.Message): Promise<void> {
  if (!deps || !bot) return;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  // P1: Reset error counter on successful message receipt
  consecutiveErrors = 0;

  const authId = deps.getAuthorizedChatId();
  if (!authId) {
    deps.setAuthorizedChatId(chatId);
    log.info(`Telegram authorized chat: ${chatId}`);
    await bot.sendMessage(chatId, 'Linked! You are now the authorized Clawdia user.');
    return;
  }
  if (chatId !== authId) { await bot.sendMessage(chatId, 'Unauthorized.'); return; }
  if (text.startsWith('/')) { await handleCmd(chatId, text); return; }

  const apiKey = deps.getApiKey();
  if (!apiKey) { await bot.sendMessage(chatId, 'No API key configured.'); return; }

  const { emitter, responseP, resolve } = createEmitter(chatId);

  try {
    const result = await processChatMessage({
      message: text,
      conversationId: activeConvId || undefined,
      emitter,
      client: deps.getClient(apiKey, deps.getSelectedModel()),
      conversationManager: deps.conversationManager,
      onResponse: (response) => {
        // ToolLoop doesn't emit CHAT_STREAM_END — resolve from here.
        // For streaming: resBuf has the accumulated text. For non-streaming: use response.
        resolve(response);
      },
      onError: (err) => {
        resolve(`Error: ${err.message}`);
      },
    });
    activeConvId = result.conversationId;
    const final = await responseP;
    await send(chatId, final || result.response || '[No response]');
  } catch (err: any) {
    await send(chatId, `Error: ${sanitizeTelegramError(err?.message || 'Unknown error')}`);
  }
}

async function handleCmd(chatId: number, text: string): Promise<void> {
  if (!bot) return;
  const cmd = text.split(' ')[0];
  switch (cmd) {
    case '/tasks': {
      const tasks = listTasks();
      if (!tasks.length) { await bot.sendMessage(chatId, 'No tasks.'); return; }
      const lines = tasks.slice(0, 20).map((t) => {
        const ic = t.status === 'active' ? '\u25B6' : t.status === 'paused' ? '\u23F8' : '\u2705';
        return `${ic} <b>${t.description.slice(0, 60)}</b> [${t.status}]`;
      });
      await send(chatId, lines.join('\n'));
      return;
    }
    case '/status': {
      const m = await collectMetrics();
      await bot.sendMessage(chatId, [
        `CPU: ${m.cpu.usagePercent.toFixed(0)}% (${m.cpu.cores} cores)`,
        `RAM: ${m.memory.usedMB.toFixed(0)}/${m.memory.totalMB.toFixed(0)} MB (${m.memory.usagePercent.toFixed(0)}%)`,
        `Disk: ${m.disk.usedGB.toFixed(1)}/${m.disk.totalGB.toFixed(1)} GB`,
        `Uptime: ${m.uptime}`,
      ].join('\n'));
      return;
    }
    case '/new':
      activeConvId = null;
      await bot.sendMessage(chatId, 'New conversation started.');
      return;
    case '/help':
      await bot.sendMessage(chatId,
        '/tasks \u2014 list tasks\n/status \u2014 system metrics\n/new \u2014 new conversation\n/help \u2014 this message\n\nAnything else is sent as a chat message.');
      return;
    default:
      await bot.sendMessage(chatId, `Unknown command: ${cmd}. Type /help`);
  }
}

export function notifyTaskResult(task: PersistentTask, result: {
  status: string; responseText: string; errorMessage?: string; durationMs: number;
}): void {
  if (!bot || !deps) return;
  const chatId = deps.getAuthorizedChatId();
  if (!chatId) return;
  const ok = result.status === 'completed';
  const body = (ok ? result.responseText : result.errorMessage || 'Unknown error').slice(0, 500);
  send(chatId, `${ok ? '\u2705' : '\u274C'} <b>${task.description.slice(0, 80)}</b>\n${(result.durationMs / 1000).toFixed(1)}s\n\n${body}`).catch(() => { });
}

import { ApprovalRequest, ApprovalDecision } from '../../shared/autonomy';

const callbackRateLimits = new Map<number, number[]>(); // chatId -> timestamps
const CALLBACK_LIMIT_WINDOW_MS = 60000;
const CALLBACK_LIMIT_MAX = 10;

function isRateLimited(chatId: number): boolean {
  const now = Date.now();
  const stamps = callbackRateLimits.get(chatId) || [];
  const valid = stamps.filter(s => now - s < CALLBACK_LIMIT_WINDOW_MS);
  if (valid.length >= CALLBACK_LIMIT_MAX) return true;
  valid.push(now);
  callbackRateLimits.set(chatId, valid);
  return false;
}

export async function sendApprovalRequest(request: ApprovalRequest, onDecision: (decision: ApprovalDecision) => void): Promise<void> {
  if (!bot || !deps) return;
  const activeBot = bot;
  const chatId = deps.getAuthorizedChatId();
  if (!chatId) return;

  const { requestId, tool, risk, reason, detail, autonomyMode } = request;

  // Format detail: truncated but with full detail as code block if reasonable
  const detailTruncated = detail.length > 200 ? detail.slice(0, 197) + '...' : detail;
  const detailBlock = detail.length <= 1000 ? `\n\n<code>${detail}</code>` : `\n\n<code>${detailTruncated}</code>`;

  const message = [
    `\u26A0 <b>Approval Required</b>`,
    `<b>Mode:</b> ${autonomyMode}`,
    `<b>Risk:</b> ${risk}`,
    `<b>Tool:</b> ${tool}`,
    `<b>Reason:</b> ${reason}`,
    detailBlock
  ].join('\n');

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${requestId}` },
        { text: 'For this task', callback_data: `task:${requestId}` }
      ],
      [
        { text: 'Always approve', callback_data: `always:${requestId}` },
        { text: 'Deny', callback_data: `deny:${requestId}` }
      ]
    ]
  };

  try {
    const sentMsg = await activeBot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });

    const handler = async (query: TelegramBot.CallbackQuery) => {
      if (query.message?.message_id !== sentMsg.message_id) return;
      if (query.from.id !== chatId) {
        await activeBot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
        return;
      }

      if (isRateLimited(chatId)) {
        await activeBot.answerCallbackQuery(query.id, { text: 'Too many requests. Please slow down.', show_alert: true });
        return;
      }

      const data = query.data || '';
      const [action, reqId] = data.split(':');
      if (reqId !== requestId) return;

      let decision: ApprovalDecision;
      switch (action) {
        case 'approve': decision = 'APPROVE'; break;
        case 'task': decision = 'TASK'; break;
        case 'always': decision = 'ALWAYS'; break;
        case 'deny':
        default: decision = 'DENY'; break;
      }

      // Tag source for audit trail — import at runtime to avoid circular dependency
      try {
        const mainMod = require('../main');
        if (mainMod?.approvalSources) {
          mainMod.approvalSources.set(requestId, 'telegram');
          setTimeout(() => mainMod.approvalSources.delete(requestId), 5000);
        }
      } catch { /* ignore if unavailable */ }

      onDecision(decision);

      // Update message to show decision
      await activeBot.editMessageText(
        message + `\n\n<b>Decision: ${decision}</b>`,
        {
          chat_id: chatId,
          message_id: sentMsg.message_id,
          parse_mode: 'HTML'
        }
      );

      await activeBot.answerCallbackQuery(query.id, { text: `Decision: ${decision}` });
      activeBot.off('callback_query', handler);
    };

    activeBot.on('callback_query', handler);

    // Auto-cleanup handler after expiration + buffer
    setTimeout(() => {
      activeBot.off('callback_query', handler);
    }, (request.expiresAt - Date.now()) + 10000);

  } catch (err: any) {
    log.error(`[Telegram] Failed to send approval request: ${sanitizeTelegramError(err.message)}`);
  }
}

export function startTelegramBot(token: string, d: TelegramDeps): void {
  stopTelegramBot();
  deps = d;
  consecutiveErrors = 0;
  try {
    bot = new TelegramBot(token, { polling: true });
    bot.on('message', (msg) => handleMessage(msg));
    bot.on('polling_error', (err) => {
      consecutiveErrors++;
      const safeMsg = sanitizeTelegramError(err.message);
      if (consecutiveErrors === MAX_ERRORS_BEFORE_WARNING) {
        log.warn(`[Telegram] Bot experiencing connection issues (${consecutiveErrors} consecutive errors): ${safeMsg}`);
      } else if (consecutiveErrors >= MAX_ERRORS_BEFORE_DISCONNECTED) {
        log.error(`[Telegram] Bot appears disconnected (${consecutiveErrors} errors). Check network and token.`);
      } else {
        log.warn(`TG poll error: ${safeMsg}`);
      }
    });
    log.info('Telegram bot started (long polling)');
  } catch (err: any) {
    log.error(`Telegram bot start failed: ${sanitizeTelegramError(err?.message ?? '')}`);
    bot = null;
  }
}

export function stopTelegramBot(): void {
  if (bot) { bot.stopPolling(); bot = null; consecutiveErrors = 0; log.info('Telegram bot stopped'); }
}

export function isTelegramBotRunning(): boolean {
  return bot !== null && consecutiveErrors < MAX_ERRORS_BEFORE_DISCONNECTED;
}
