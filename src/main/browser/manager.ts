import { BrowserView, BrowserWindow, session } from 'electron';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { IPC, IPC_EVENTS } from '../../shared/ipc-channels';
import { BrowserTabInfo } from '../../shared/types';
import { wireUniversalPopupDismissal } from './popup-dismissal';
import { store, BrowserHistoryEntry } from '../store';
import { tryDetectAndMerge } from '../accounts/detector';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { homedir } from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { createLogger } from '../logger';
import { withTimeout, withSoftTimeout } from '../utils/timeout';
import { handleValidated, ipcSchemas } from '../ipc-validator';
import { importCookiesForDomain } from '../tasks/cookie-import';

const log = createLogger('browser-manager');

/** Dark premium scrollbar CSS injected into every BrowserView page */
const DARK_SCROLLBAR_CSS = `
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}
::-webkit-scrollbar-thumb:active {
  background: rgba(255, 255, 255, 0.35);
}
::-webkit-scrollbar-corner {
  background: transparent;
}
* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) rgba(0, 0, 0, 0.15);
}
`;

export async function exportCookiesForUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    const cookies = await session.defaultSession.cookies.get({ url: parsed.origin });
    if (!cookies || cookies.length === 0) return null;
    const lines: string[] = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
      const rawDomain = c.domain || parsed.hostname;
      const domain = rawDomain.startsWith('.') ? rawDomain : rawDomain;
      const includeSub = rawDomain.startsWith('.') ? 'TRUE' : 'FALSE';
      const pathValue = c.path || '/';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expires = typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : 0;
      lines.push([domain, includeSub, pathValue, secure, expires, c.name, c.value].join('\t'));
    }
    const filename = `clawdia-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const filePath = path.join('/tmp', filename);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  } catch (err: any) {
    log.warn(`Failed to export cookies: ${err?.message || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Playwright session tracking — detect and clean up leaked resources
// ---------------------------------------------------------------------------

interface PlaywrightSession {
  id: string;
  browserContext: BrowserContext | null;
  pages: Page[];
  createdAt: number;
  lastActivityAt: number;
  associatedTabId: string | null;
  status: 'active' | 'idle' | 'orphaned' | 'closing';
}

const activeSessions = new Map<string, PlaywrightSession>();
let reaperInterval: ReturnType<typeof setInterval> | null = null;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REAPER_INTERVAL_MS = 60_000; // 60 seconds
const CLEANUP_STEP_TIMEOUT_MS = 5_000; // 5 seconds per cleanup step
const MEMORY_WARN_MB = 1024; // 1 GB
const MEMORY_CRITICAL_MB = 2048; // 2 GB

const TABS_UPDATED_EVENT = IPC_EVENTS.BROWSER_TABS_UPDATED;

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;
let currentBounds: { x: number; y: number; width: number; height: number } | null = null;

// Playwright state — optional overlay for automation / page reading.
let playwrightBrowser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let playwrightPage: Page | null = null;   // Wraps the BrowserView CDP target
let playwrightInitStarted = false;
let playwrightInitCompleted = false;
let playwrightInitFailed = false;

// Simple tab bookkeeping driven by BrowserView (no Playwright newPage).
let tabCounter = 0;
interface TabEntry {
  id: string;
  url: string;
  title: string;
  historyBack: string[];   // stack of URLs we can go back to
  historyForward: string[]; // stack of URLs we can go forward to
}
const tabs: Map<string, TabEntry> = new Map();
let activeTabId: string | null = null;
let livePreviewTabId: string | null = null;

// Flag: when true, the next did-navigate should NOT push onto the tab history.
// Set before programmatic navigations (goBack, goForward, switchTab).
let suppressHistoryPush = false;

// Chrome cookie import state — tracks domains already imported into BrowserView session
const cookieImportedDomains = new Set<string>();
const cookieImportCooldown = new Map<string, number>(); // domain → last import timestamp
const COOKIE_IMPORT_COOLDOWN_MS = 30_000; // 30 seconds per domain

// Promise that resolves once initPlaywright() completes (success or failure).
let playwrightReadyResolve: () => void;
const playwrightReady = new Promise<void>((resolve) => {
  playwrightReadyResolve = resolve;
});

const NOISY_SOURCES = [
  'shopify.com', 'klaviyo.com', 'goaffpro.com', 'bugsnag', 'pagefly',
  'littlebesidesme.com', 'web-pixels', 'sandbox/modern', 'googletagmanager',
  'google-analytics', 'fbevents', 'hotjar', 'clarity.ms', 'segment.com',
  'mixpanel', 'amplitude', 'intercom', 'crisp', 'drift', 'tawk', 'zendesk',
  'cdn.shopify.com/extensions', 'sentry.io', 'googleadservices',
  'onetag-sys.com', 'googletag', 'gpt.js', 'pubads_impl', 'adsbygoogle',
  'doubleclick.net', 'adsense', 'google_ads', 'taboola', 'outbrain',
  'hbspt', 'hubspot', 'optimizely', 'crazyegg', 'mouseflow',
];

const NOISE_PATTERNS = [
  'already loaded', 'pixel install successful', 'pixel version',
  'theme extension loaded', 'sandbox_bundle', 'content-security-policy',
  'overflow: visible', 'productatcs', 'display cart', '%c', 'sectionfocus',
  'customer events tracker', 'run pagefly', 'm.ai', 'k-web-pixel',
  'sandbox warning',
  // CSP / permissions / feature-policy noise from visited sites
  'violates the following content security policy',
  'permissions policy violation',
  'error with feature-policy header',
  'unrecognized feature:',
  'mixed content:',
  'err_blocked_by_csp',
  // Ad/tracking script errors
  'encryptedsignalproviders',
  'google deploy of the sharedid',
  'wcpconsent is not defined',
  'is not defined',
  // Device API warnings
  'devicemotion events are blocked',
  'deviceorientation events are blocked',
  // Deprecation warnings
  'deprecated',
];

const BENIGN_PAGE_ERROR_PATTERNS = [
  'routechange aborted',
  'minified react error #421',
  "unexpected token '&'",
  'net::err_aborted',
  'failed to load resource',
];


// ---------------------------------------------------------------------------
// Chrome cookie import — inject OS Chrome cookies into BrowserView session
// ---------------------------------------------------------------------------

const SKIP_COOKIE_SCHEMES = ['data:', 'file:', 'about:', 'chrome:', 'devtools:'];

/**
 * Import Chrome OS cookies for a domain into Electron's defaultSession.
 * Fire-and-forget — does not block navigation.
 */
async function maybeImportCookiesForNavigation(url: string): Promise<void> {
  try {
    // Skip non-http(s) URLs
    if (SKIP_COOKIE_SCHEMES.some(scheme => url.startsWith(scheme))) return;

    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    if (!hostname) return;

    // Extract base domain (e.g., mail.google.com → google.com)
    const parts = hostname.split('.');
    const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;

    // Skip if already imported this session
    if (cookieImportedDomains.has(baseDomain)) return;

    // Cooldown check (30s per domain)
    const lastImport = cookieImportCooldown.get(baseDomain) || 0;
    if (Date.now() - lastImport < COOKIE_IMPORT_COOLDOWN_MS) return;

    cookieImportCooldown.set(baseDomain, Date.now());

    // Import cookies from Chrome OS
    let imported = await importCookiesForDomain(baseDomain);
    if (imported.length === 0 && hostname !== baseDomain) {
      // Also try the full hostname (e.g., mail.google.com)
      imported = await importCookiesForDomain(hostname);
    }
    if (imported.length === 0) return;

    // Inject into Electron's default session (shared with BrowserView)
    let injected = 0;
    for (const cookie of imported) {
      try {
        const cleanDomain = cookie.domain.replace(/^\./, '');
        const cookieUrl = `http${cookie.secure ? 's' : ''}://${cleanDomain}${cookie.path || '/'}`;
        await session.defaultSession.cookies.set({
          url: cookieUrl,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
        });
        injected++;
      } catch {
        // Individual cookie set failure — skip silently
      }
    }

    if (injected > 0) {
      cookieImportedDomains.add(baseDomain);
      log.info(`[Cookie] Imported ${injected} cookies for ${baseDomain} into BrowserView session`);
    }
  } catch (err: any) {
    log.warn(`[Cookie] Import failed for navigation: ${err?.message || err}`);
  }
}

function sanitizeUserAgent(userAgent: string): string {
  return userAgent.replace(/\s*Electron\/\S+/i, '').replace(/\s*clawdia\/\S+/i, '');
}

function withProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return 'about:blank';
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('file://')
  ) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

let knownCdpPort: number | null = null;

export function setCdpPort(port: number): void {
  knownCdpPort = port;
}

function cdpPort(): number {
  return knownCdpPort ?? Number(process.env.CLAWDIA_CDP_PORT ?? '9222');
}

// ---------------------------------------------------------------------------
// Tab state helpers (driven by BrowserView, not Playwright pages)
// ---------------------------------------------------------------------------

function getTabsSnapshot(): BrowserTabInfo[] {
  return Array.from(tabs.values()).map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.id === activeTabId,
  }));
}

function emitTabState(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send(TABS_UPDATED_EVENT, getTabsSnapshot());
}

function updateActiveTab(): void {
  if (!browserView || !activeTabId) return;
  const entry = tabs.get(activeTabId);
  if (!entry) return;
  entry.url = browserView.webContents.getURL() || entry.url;
  entry.title = browserView.webContents.getTitle() || entry.title;
}

/**
 * Push a new URL onto the active tab's per-tab history.
 * Skipped when suppressHistoryPush is set (back/forward/switchTab navigations).
 */
function pushTabHistory(url: string): void {
  if (suppressHistoryPush) {
    suppressHistoryPush = false;
    return;
  }
  if (!activeTabId) return;
  const entry = tabs.get(activeTabId);
  if (!entry) return;
  // Don't push duplicate consecutive URLs
  const prevUrl = entry.historyBack.length > 0 ? entry.historyBack[entry.historyBack.length - 1] : null;
  const currentUrl = entry.url;
  if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== url) {
    entry.historyBack.push(currentUrl);
  }
  // Any new navigation clears the forward stack
  entry.historyForward = [];
}

// ---------------------------------------------------------------------------
// Browser history tracking
// ---------------------------------------------------------------------------

const BROWSER_HISTORY_MAX = 500;

function recordHistoryEntry(url: string, title: string): void {
  if (!url || url === 'about:blank' || url.startsWith('data:')) return;
  const history = (store.get('browserHistory') as BrowserHistoryEntry[] | undefined) ?? [];
  // Skip duplicate consecutive entries
  if (history.length > 0 && history[0].url === url) return;
  const entry: BrowserHistoryEntry = {
    id: randomUUID(),
    url,
    title: title || url,
    timestamp: Date.now(),
  };
  history.unshift(entry);
  store.set('browserHistory', history.slice(0, BROWSER_HISTORY_MAX));
}

export function getBrowserHistory(): BrowserHistoryEntry[] {
  return (store.get('browserHistory') as BrowserHistoryEntry[] | undefined) ?? [];
}

export function clearBrowserHistory(): void {
  store.set('browserHistory', []);
}

export async function clearBrowserCookies(): Promise<void> {
  const ses = session.defaultSession;
  await ses.clearStorageData({ storages: ['cookies'] });
}

export async function clearAllBrowserData(): Promise<void> {
  store.set('browserHistory', []);
  const ses = session.defaultSession;
  await ses.clearCache();
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'cachestorage'],
  });
}

// ---------------------------------------------------------------------------
// OAuth / auth popup support
// ---------------------------------------------------------------------------

const AUTH_URL_PATTERNS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'consent.google.com',
  'myaccount.google.com',
  'gds.google.com',
  'appleid.apple.com/auth',
  'login.microsoftonline.com',
  'login.live.com',
  'github.com/login',
  'github.com/session',
  'api.twitter.com/oauth',
  'twitter.com/i/flow/login',
  'www.facebook.com/v',
  'www.facebook.com/dialog/oauth',
  'www.facebook.com/login',
  'discord.com/oauth2',
  'discord.com/login',
  'slack.com/oauth',
  'login.salesforce.com',
  'auth0.com/authorize',
  'accounts.spotify.com',
  'login.yahoo.com',
  'open.login.yahooapis.com',
];

function isAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const full = parsed.hostname + parsed.pathname;
    return AUTH_URL_PATTERNS.some((pattern) => full.includes(pattern));
  } catch {
    return false;
  }
}

function wireAuthPopup(popup: BrowserWindow, initialUrl: string): void {
  log.info(`Auth popup created for: ${initialUrl}`);

  // Match BrowserView UA so auth providers do not branch to Electron-specific behavior.
  popup.webContents.setUserAgent(sanitizeUserAgent(popup.webContents.getUserAgent()));

  popup.webContents.on('will-navigate', (_event, navUrl) => {
    log.debug(`Auth popup navigating to: ${navUrl}`);
  });

  // Handle nested popups / window.open inside the auth popup — keep them in-app.
  // Without this, auth flows that open secondary windows (e.g. CAPTCHA, 2FA) go
  // to the system browser and break the flow.
  popup.webContents.setWindowOpenHandler((details) => {
    log.info(`Auth popup opening child window: ${details.url}`);
    // Allow auth URLs and blank popups as child windows inside the app
    if (isAuthUrl(details.url) || isBlankPopupUrl(details.url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          parent: popup,
          modal: false,
          show: true,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    // Non-auth URLs from auth popup: load inside the popup itself instead of
    // falling through to the system browser.
    popup.loadURL(details.url).catch(() => {});
    return { action: 'deny' };
  });

  // Wire nested popups created by the auth popup
  popup.webContents.on('did-create-window', (childPopup, details) => {
    wireAuthPopup(childPopup, details.url);
  });

  // Let the popup complete callback scripts naturally, then refresh parent view on close.
  popup.on('closed', () => {
    log.debug('Auth popup closed');
  });
}

function isBlankPopupUrl(url: string): boolean {
  return url === 'about:blank' || url === '';
}

// ---------------------------------------------------------------------------
// BrowserView — the real, visible browser inside the app
// ---------------------------------------------------------------------------

function ensureBrowserView(): BrowserView {
  if (browserView) return browserView;

  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const cleanUA = sanitizeUserAgent(browserView.webContents.getUserAgent());
  browserView.webContents.setUserAgent(cleanUA);
  log.debug(`UA set to: ${cleanUA}`);

  if (mainWindow) {
    mainWindow.addBrowserView(browserView);
    if (currentBounds) {
      browserView.setBounds(currentBounds);
    }

    browserView.webContents.on('did-start-navigation', (_event, url) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
      // Fire-and-forget: import Chrome cookies for this domain into BrowserView session
      void maybeImportCookiesForNavigation(url);
    });

    browserView.webContents.on('did-navigate', (_event, url) => {
      pushTabHistory(url);
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_NAVIGATED, url);
      updateActiveTab();
      emitTabState();
      recordHistoryEntry(url, browserView!.webContents.getTitle() || '');
      void tryDetectAndMerge(url);
    });

    browserView.webContents.on('did-navigate-in-page', (_event, url) => {
      pushTabHistory(url);
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_NAVIGATED, url);
      updateActiveTab();
      emitTabState();
      recordHistoryEntry(url, browserView!.webContents.getTitle() || '');
      void tryDetectAndMerge(url);
    });

    browserView.webContents.on('page-title-updated', (_event, title) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE, title);
      updateActiveTab();
      emitTabState();
      // Update the most recent history entry's title if URL matches
      const history = (store.get('browserHistory') as BrowserHistoryEntry[] | undefined) ?? [];
      const currentUrl = browserView!.webContents.getURL();
      if (history.length > 0 && history[0].url === currentUrl && title) {
        history[0].title = title;
        store.set('browserHistory', history);
      }
    });

    browserView.webContents.on('did-start-loading', () => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    });

    browserView.webContents.on('did-stop-loading', () => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
      // Inject dark premium scrollbar into browsed pages
      browserView!.webContents.insertCSS(DARK_SCROLLBAR_CSS).catch(() => {});
    });

    browserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      // Common during redirects / rapid SPA navigations; not a user-facing failure.
      if (errorCode === -3) return; // ERR_ABORTED
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_ERROR, `${errorDescription} (${errorCode})`);
    });

    browserView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (!message) return;
      const normalizedMessage = message.toLowerCase();
      const normalizedSource = (sourceId || '').toLowerCase();
      if (NOISY_SOURCES.some((src) => normalizedSource.includes(src) || normalizedMessage.includes(src))) return;
      if (NOISE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern))) return;
      if (BENIGN_PAGE_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern))) return;
      if (level < 2) return;

      const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? `L${level}`;
      const preview = message.length > 200 ? `${message.slice(0, 200)}...` : message;
      const srcInfo = sourceId ? ` (${sourceId}:${line})` : '';
      log.debug(`[BrowserView:${levelName}] ${preview}${srcInfo}`);
    });

    browserView.webContents.on('did-create-window', (popup, details) => {
      // Wire ALL popups that were allowed through setWindowOpenHandler —
      // they need UA sanitization and nested popup handling to stay in-app.
      wireAuthPopup(popup, details.url);
    });

    browserView.webContents.setWindowOpenHandler((details) => {
      const { url } = details;
      const hasUserGesture = 'userGesture' in details;
      const userGesture = hasUserGesture ? Boolean(details.userGesture) : true;
      const isBlank = isBlankPopupUrl(url);
      const isAuth = isAuthUrl(url);

      // Allow auth popups and blank popups (common for OAuth flows) as in-app windows.
      // Also allow any popup triggered by user gesture — the user clicked something
      // and expects the result to stay inside the app (e.g., Gmail sign-in, OAuth).
      if (isAuth || isBlank || userGesture) {
        log.info(`Allowing in-app popup (auth=${isAuth}, blank=${isBlank}, gesture=${userGesture}): ${url || 'about:blank'}`);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 500,
            height: 700,
            parent: mainWindow ?? undefined,
            modal: false,
            show: true,
            autoHideMenuBar: true,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          },
        };
      }
      // Script-initiated popups with no user gesture and no auth URL: load inline.
      log.debug(`Denying popup (no gesture, not auth), navigating inline: ${url}`);
      void navigate(url);
      return { action: 'deny' };
    });

    // BrowserView crash recovery — reload instead of leaving a dead panel
    browserView.webContents.on('render-process-gone', (_event, details) => {
      log.error(`BrowserView renderer gone: reason=${details.reason}, exitCode=${details.exitCode}`);
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        log.warn('BrowserView crashed — will recreate on next navigation');
        // Mark as dead so next ensureBrowserView() creates a fresh one
        if (browserView && !browserView.webContents.isDestroyed()) {
          try { browserView.webContents.close(); } catch { /* ignore */ }
        }
        if (mainWindow && !mainWindow.isDestroyed() && browserView) {
          try { mainWindow.removeBrowserView(browserView); } catch { /* ignore */ }
        }
        browserView = null;
        sessionInvalidated = true;
      }
    });
  }

  return browserView;
}

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  log.info('setMainWindow called, creating BrowserView...');
  ensureBrowserView();
  log.debug(`BrowserView created, attached=${!!browserView}`);
}

// ---------------------------------------------------------------------------
// Playwright CDP connection (optional — wraps BrowserView for tool automation)
// ---------------------------------------------------------------------------

const CDP_MAX_RETRIES = 3;
const CDP_RETRY_DELAY_MS = 500;
const CDP_CONNECT_TIMEOUT_MS = 5000;

async function probeCDP(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const info = await res.json();
      log.debug(`CDP probe :${port} OK — ${info?.Browser || 'unknown'}`);
      return info?.webSocketDebuggerUrl || null;
    }
  } catch { /* not responding */ }
  return null;
}

function normalizeCdpEndpoint(endpoint: string, fallbackPort: number): string {
  try {
    const parsed = new URL(endpoint);
    const host = (parsed.hostname || '').toLowerCase();
    if (!host || host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost') {
      parsed.hostname = '127.0.0.1';
    }
    if (!parsed.port) parsed.port = String(fallbackPort);
    return parsed.toString();
  } catch {
    return `http://127.0.0.1:${fallbackPort}`;
  }
}


// ---------------------------------------------------------------------------
// Session lifecycle — create, update, cleanup
// ---------------------------------------------------------------------------

function registerSession(ctx: BrowserContext | null, tabId: string | null): PlaywrightSession {
  const session: PlaywrightSession = {
    id: randomUUID(),
    browserContext: ctx,
    pages: ctx ? ctx.pages() : [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    associatedTabId: tabId,
    status: 'active',
  };
  activeSessions.set(session.id, session);
  log.info(`Session registered: ${session.id} (tab=${tabId}, pages=${session.pages.length})`);
  return session;
}

function touchSession(): void {
  for (const s of activeSessions.values()) {
    if (s.status === 'active' || s.status === 'idle') {
      s.lastActivityAt = Date.now();
      s.status = 'active';
    }
  }
}

/** Flag indicating the tool loop's browser session was externally closed. */
let sessionInvalidated = false;

export function isSessionInvalidated(): boolean {
  return sessionInvalidated;
}

export function clearSessionInvalidated(): void {
  sessionInvalidated = false;
}

async function cleanupSession(session: PlaywrightSession, reason: string): Promise<void> {
  if (session.status === 'closing') return;
  session.status = 'closing';
  log.info(`Cleaning up session ${session.id}: reason=${reason}`);

  // IMPORTANT: We must NOT close the browserContext or its pages here.
  // There is only one browserContext — it's the CDP connection wrapping the
  // BrowserView. Closing it destroys the BrowserView's webContents, which
  // triggers window-all-closed → app.quit().
  //
  // The session tracker exists for bookkeeping (idle detection, memory
  // monitoring). Actual browser teardown only happens in closeBrowser()
  // during app shutdown.
  //
  // For the 'browser-close' reason (called from closeBrowser), we DO close
  // pages and context since the app is shutting down intentionally.
  if (reason === 'browser-close') {
    for (const page of session.pages) {
      try {
        if (!page.isClosed()) {
          await withSoftTimeout(page.close(), CLEANUP_STEP_TIMEOUT_MS, `close page ${page.url()}`);
        }
      } catch (err: any) {
        log.warn(`Failed to close page: ${err?.message}`);
      }
    }

    if (session.browserContext) {
      try {
        await withSoftTimeout(session.browserContext.close(), CLEANUP_STEP_TIMEOUT_MS, 'close browser context');
      } catch (err: any) {
        log.warn(`Failed to close context: ${err?.message}`);
      }
    }
  }

  // Remove from tracker
  activeSessions.delete(session.id);
  log.info(`Session ${session.id} cleaned up (reason=${reason})`);
}

async function cleanupAllSessions(reason: string): Promise<void> {
  const sessions = Array.from(activeSessions.values());
  if (sessions.length === 0) return;
  log.info(`Cleaning up ${sessions.length} session(s): reason=${reason}`);
  await Promise.allSettled(sessions.map((s) => cleanupSession(s, reason)));
}

function findSessionByTab(tabId: string): PlaywrightSession | null {
  for (const s of activeSessions.values()) {
    if (s.associatedTabId === tabId && s.status !== 'closing') return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session reaper — periodic idle/orphan/stale detection + memory monitoring
// ---------------------------------------------------------------------------

async function isSessionAlive(session: PlaywrightSession): Promise<boolean> {
  if (!session.browserContext) return false;
  try {
    const pages = session.browserContext.pages();
    if (pages.length === 0) return false;
    // Lightweight CDP ping — evaluate a trivial expression
    const result = await withSoftTimeout(pages[0].evaluate(() => 1), CLEANUP_STEP_TIMEOUT_MS, 'CDP ping');
    if (result === null) return false; // timeout means dead
    return true;
  } catch {
    return false;
  }
}

function logMemoryUsage(): void {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const info = {
    heapUsedMB: heapMB,
    rssMB,
    activeSessions: activeSessions.size,
    totalPages: Array.from(activeSessions.values()).reduce((sum, s) => sum + s.pages.length, 0),
  };

  if (rssMB >= MEMORY_CRITICAL_MB) {
    log.warn('Memory critical', info);
    // Clean up ONLY idle/orphaned sessions — never kill active sessions mid-task.
    // Killing active sessions during large tasks causes cascading failures and app crashes.
    const toClean = Array.from(activeSessions.values()).filter(
      (s) => s.status === 'idle' || s.status === 'orphaned'
    );
    if (toClean.length === 0) {
      log.warn('Memory critical but all sessions are active — skipping aggressive cleanup');
    }
    for (const s of toClean) {
      void cleanupSession(s, 'memory-critical');
    }
    // Hint GC if exposed
    if (typeof global.gc === 'function') global.gc();
  } else if (rssMB >= MEMORY_WARN_MB) {
    log.warn('Memory usage high', info);
  } else {
    log.info('Memory usage', info);
  }
}

async function runSessionReaper(): Promise<void> {
  const now = Date.now();
  for (const session of Array.from(activeSessions.values())) {
    if (session.status === 'closing') continue;

    // Orphan detection: tab no longer exists
    if (session.associatedTabId && !tabs.has(session.associatedTabId)) {
      await cleanupSession(session, 'orphaned');
      sessionInvalidated = true;
      continue;
    }

    // Idle timeout: no activity for 5 minutes — log but do NOT destroy the
    // session. There is only one CDP session for the BrowserView; destroying it
    // kills the BrowserView and cascades into app.quit(). Just mark idle.
    if (now - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
      if (session.status !== 'idle') {
        log.info(`Session ${session.id} is idle (>5min inactivity)`);
        session.status = 'idle';
      }
      continue;
    }

    // Stale CDP: connection is dead
    if (!(await isSessionAlive(session))) {
      await cleanupSession(session, 'cdp-dead');
      sessionInvalidated = true;
      continue;
    }
  }

  logMemoryUsage();
}

export function startSessionReaper(): void {
  if (reaperInterval) return;
  // Use setTimeout chaining instead of setInterval to prevent overlapping runs
  const scheduleNext = () => {
    reaperInterval = setTimeout(async () => {
      await runSessionReaper().catch((err: any) => {
        log.warn(`Session reaper error: ${err?.message}`);
      });
      if (reaperInterval) scheduleNext(); // Re-arm only if not stopped
    }, REAPER_INTERVAL_MS);
  };
  scheduleNext();
  log.info('Session reaper started');
}

export function stopSessionReaper(): void {
  if (reaperInterval) {
    clearTimeout(reaperInterval);
    reaperInterval = null;
    log.info('Session reaper stopped');
  }
}

// ---------------------------------------------------------------------------
// Startup cleanup — kill orphaned CDP processes from prior crashed sessions
// ---------------------------------------------------------------------------

/**
 * Kill orphaned processes on CDP ports from a prior crashed session.
 * Skips our own CDP port to avoid self-killing.
 */
export async function killOrphanedCDPProcesses(): Promise<void> {
  const ownPort = cdpPort();
  const candidates = [9222, 9223, 9224, 9225, 9226, 9227];

  const execPromise = (cmd: string) => new Promise<void>((resolve, reject) => {
    const proc = spawn('/bin/bash', ['-c', cmd], { stdio: 'ignore' });
    proc.on('close', code => code === 0 ? resolve() : reject());
    proc.on('error', reject);
  });

  for (const port of candidates) {
    if (port === ownPort) continue; // Don't kill our own process
    try {
      await execPromise(`ss -tln | grep -qE ':${port}\\b'`);
      log.info(`Killing orphaned process on CDP port ${port}`);
      // Send SIGTERM first for graceful shutdown; fall back to SIGKILL
      await execPromise(`fuser -TERM ${port}/tcp 2>/dev/null || fuser -k ${port}/tcp 2>/dev/null || true`);
    } catch {
      // Port not in use or command failed — nothing to clean up
    }
  }
}

async function connectCDP(): Promise<boolean> {
  const port = cdpPort();
  log.info(`Will connect to CDP on :${port} (PID ${process.pid})`);

  for (let attempt = 1; attempt <= CDP_MAX_RETRIES; attempt++) {
    const wsUrl = await probeCDP(port);
    if (!wsUrl) {
      log.debug(`CDP :${port} not responding (attempt ${attempt}/${CDP_MAX_RETRIES})`);
      if (attempt < CDP_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, CDP_RETRY_DELAY_MS));
      }
      continue;
    }

    try {
      const wsEndpoint = normalizeCdpEndpoint(wsUrl, port);
      const httpEndpoint = normalizeCdpEndpoint(`http://127.0.0.1:${port}`, port);

      log.info(`Connecting Playwright via ${wsEndpoint} (attempt ${attempt})...`);
      try {
        playwrightBrowser = await withTimeout(
          chromium.connectOverCDP(wsEndpoint),
          CDP_CONNECT_TIMEOUT_MS,
          'connectOverCDP'
        );
      } catch (wsErr: any) {
        // Some Chromium builds expose a ws URL that is probeable but not connectable.
        // Retry against the canonical HTTP endpoint before failing this attempt.
        log.warn(`CDP WS endpoint failed (${wsErr?.message || wsErr}); falling back to ${httpEndpoint}`);
        playwrightBrowser = await withTimeout(
          chromium.connectOverCDP(httpEndpoint),
          CDP_CONNECT_TIMEOUT_MS,
          'connectOverCDP'
        );
      }

      const contexts = playwrightBrowser.contexts();
      log.info(`Playwright connected with ${contexts.length} context(s)`);
      return true;
    } catch (err: any) {
      log.warn(`CDP connect failed: ${err?.message || err}`);
      playwrightBrowser = null;
      if (attempt < CDP_MAX_RETRIES) {
        log.debug(`Waiting ${CDP_RETRY_DELAY_MS}ms before retry ${attempt + 1}...`);
        await new Promise((resolve) => setTimeout(resolve, CDP_RETRY_DELAY_MS));
      }
    }
  }
  return false;
}

/**
 * Find the Playwright Page that corresponds to our BrowserView's CDP target.
 * We match by comparing the BrowserView's webContents URL with the CDP target list.
 */
function findBrowserViewPage(): Page | null {
  if (!browserContext || !browserView) return null;

  const bvUrl = browserView.webContents.getURL() || '';
  const allPages = browserContext.pages();
  log.debug(`Looking for BrowserView page among ${allPages.length} CDP page(s), BV url="${bvUrl}"`);

  // Prefer exact URL match when possible.
  if (bvUrl) {
    for (const page of allPages) {
      const pUrl = page.url() || '';
      if (pUrl === bvUrl) {
        log.debug(`Matched BrowserView page by exact URL: ${pUrl}`);
        return page;
      }
    }
  }

  // Otherwise pick the most likely browser surface (not app renderer/devtools).
  for (const page of allPages) {
    const pUrl = page.url() || '';
    if (!pUrl.includes('localhost:5173') && !pUrl.includes('devtools://')) {
      log.debug(`Matched BrowserView page: ${pUrl}`);
      return page;
    }
  }

  // Fallback: pick the last page (BrowserView is usually created after the main window).
  if (allPages.length > 1) {
    const last = allPages[allPages.length - 1];
    log.debug(`Fallback: using last page: ${last.url()}`);
    return last;
  }

  return null;
}

function bindPlaywrightPage(page: Page): void {
  playwrightPage = page;
  wireUniversalPopupDismissal(playwrightPage);
}

function ensurePlaywrightPageBinding(): void {
  if (!browserContext) return;
  if (playwrightPage && !playwrightPage.isClosed()) return;

  const page = findBrowserViewPage();
  if (!page) return;

  bindPlaywrightPage(page);
  log.debug(`Bound Playwright page: ${page.url()}`);
}

export async function initPlaywright(): Promise<void> {
  log.info('initPlaywright called');
  playwrightInitStarted = true;
  playwrightInitCompleted = false;
  playwrightInitFailed = false;

  if (playwrightBrowser && browserContext) {
    log.debug('Already initialized, resolving immediately');
    playwrightInitCompleted = true;
    playwrightReadyResolve();
    return;
  }

  const connected = await connectCDP();
  log.info(`connectCDP returned: ${connected}`);

  if (!connected) {
    log.error('CDP connection failed. Playwright tools unavailable, BrowserView-only mode.');
    playwrightInitFailed = true;
    playwrightInitCompleted = true;
    playwrightReadyResolve();
    return;
  }

  browserContext = playwrightBrowser!.contexts()[0] ?? null;
  if (!browserContext) {
    log.error('No browser context found after CDP connect.');
    playwrightInitFailed = true;
    playwrightInitCompleted = true;
    playwrightReadyResolve();
    return;
  }
  await browserContext.clearPermissions().catch(() => null);
  await browserContext.grantPermissions([]).catch(() => null);

  // Find the page backing our BrowserView — don't create new pages.
  const page = findBrowserViewPage();
  if (page) {
    bindPlaywrightPage(page);
    log.info(`Playwright wrapping BrowserView page: ${page.url()}`);
  } else {
    log.warn('Could not find BrowserView page in CDP targets. Tools may not work.');
  }

  // Register the CDP session for tracking
  registerSession(browserContext, activeTabId);
  startSessionReaper();

  playwrightInitCompleted = true;
  playwrightReadyResolve();
}

// ---------------------------------------------------------------------------
// Navigation — BrowserView is primary, Playwright mirrors
// ---------------------------------------------------------------------------

export async function navigate(url: string): Promise<{ success: boolean; url?: string; error?: string }> {
  const targetUrl = withProtocol(url);
  mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);

  const view = ensureBrowserView();

  try {
    await view.webContents.loadURL(targetUrl);
  } catch (error: any) {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
    return { success: false, error: error?.message || 'Navigation failed' };
  }

  updateActiveTab();
  emitTabState();
  return { success: true, url: targetUrl };
}

// ---------------------------------------------------------------------------
// Tab management — lightweight, BrowserView-based
// ---------------------------------------------------------------------------

function makeTabId(): string {
  return `tab-${++tabCounter}`;
}

function newTab(url: string): string {
  const id = makeTabId();
  tabs.set(id, { id, url, title: '', historyBack: [], historyForward: [] });
  activeTabId = id;
  return id;
}

export async function createTab(url = 'about:blank'): Promise<string> {
  const targetUrl = withProtocol(url);
  const tabId = newTab(targetUrl);
  log.info(`createTab: ${tabId} -> ${targetUrl}`);

  const view = ensureBrowserView();
  if (targetUrl !== 'about:blank') {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    try {
      await view.webContents.loadURL(targetUrl);
    } catch (error: any) {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_ERROR, error?.message || 'Navigation failed');
    }
  }

  updateActiveTab();
  emitTabState();
  return tabId;
}

export async function switchTab(tabId: string): Promise<void> {
  const entry = tabs.get(tabId);
  if (!entry) return;

  // Save current tab state before switching
  if (activeTabId && browserView) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.url = browserView.webContents.getURL() || prev.url;
      prev.title = browserView.webContents.getTitle() || prev.title;
    }
  }

  activeTabId = tabId;

  // Load the tab's last known URL in the BrowserView.
  // Suppress history push so tab-switch doesn't pollute per-tab history.
  const view = ensureBrowserView();
  if (entry.url && entry.url !== 'about:blank') {
    suppressHistoryPush = true;
    try { await view.webContents.loadURL(entry.url); } catch { suppressHistoryPush = false; }
  }

  updateActiveTab();
  emitTabState();
}

export async function closeTab(tabId: string): Promise<void> {
  // Immediately clean up any Playwright session associated with this tab
  const session = findSessionByTab(tabId);
  if (session) {
    sessionInvalidated = true;
    void cleanupSession(session, 'tab-closed');
  }

  tabs.delete(tabId);
  if (activeTabId === tabId) {
    const next = Array.from(tabs.keys())[0] ?? null;
    activeTabId = next;
    if (next) {
      await switchTab(next);
    } else {
      await createTab('about:blank');
    }
  }
  emitTabState();
}

// ---------------------------------------------------------------------------
// Live Preview — stream HTML from LLM directly into BrowserView
// ---------------------------------------------------------------------------

const QUALITY_BASELINE_CSS = `<style data-clawdia-baseline>
*,*::before,*::after{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
text-rendering:optimizeLegibility;overflow-x:hidden}
body{margin:0;overflow-x:hidden}
img,video,svg{max-width:100%;height:auto;display:block}
@keyframes _clawdia-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
body>*{animation:_clawdia-fade .4s ease both}
body>:nth-child(2){animation-delay:.05s}
body>:nth-child(3){animation-delay:.1s}
body>:nth-child(4){animation-delay:.15s}
body>:nth-child(5){animation-delay:.2s}
</style>`;

/**
 * Create (or reuse) a Live Preview tab and open it for document.write streaming.
 * Returns the tab ID. After calling this, use writeLiveHtml() to push chunks
 * and closeLiveHtml() when the stream ends.
 */
export async function createLivePreviewTab(): Promise<string> {
  const view = ensureBrowserView();

  // Reuse existing live preview tab if it exists
  if (livePreviewTabId && tabs.has(livePreviewTabId)) {
    activeTabId = livePreviewTabId;
    // Navigate to a minimal data URI so document.open() works reliably
    await view.webContents.loadURL('data:text/html,<html><head></head><body></body></html>');
    log.debug('LivePreview reusing tab, calling document.open()');
    await view.webContents.executeJavaScript('document.open(); "ok"');
    await view.webContents.executeJavaScript(`document.write(${JSON.stringify(QUALITY_BASELINE_CSS)})`);
    log.debug('LivePreview document.open() done and baseline CSS injected');
    emitTabState();
    return livePreviewTabId;
  }

  // Create a new tab
  const tabId = newTab('about:blank');
  livePreviewTabId = tabId;
  const entry = tabs.get(tabId)!;
  entry.title = 'Live Preview';

  // Use data URI instead of about:blank — about:blank can have restrictions
  await view.webContents.loadURL('data:text/html,<html><head></head><body></body></html>');
  log.debug('LivePreview new tab loaded, calling document.open()');
  await view.webContents.executeJavaScript('document.open(); "ok"');
  await view.webContents.executeJavaScript(`document.write(${JSON.stringify(QUALITY_BASELINE_CSS)})`);
  log.debug('LivePreview document.open() done and baseline CSS injected');

  emitTabState();
  return tabId;
}

/**
 * Write a chunk of HTML to the live preview document.
 */
export async function writeLiveHtml(html: string): Promise<void> {
  if (!browserView) {
    log.warn('LivePreview write skipped: no browserView');
    return;
  }
  try {
    const escaped = JSON.stringify(html);
    const preview = html.length > 80 ? html.slice(0, 80) + '...' : html;
    log.debug(`LivePreview writing ${html.length} chars: ${preview}`);
    await browserView.webContents.executeJavaScript(`document.write(${escaped})`);
  } catch (err: any) {
    log.warn('LivePreview write failed:', err?.message);
  }
}

/**
 * Close the live preview document (finalizes rendering, activates scripts).
 */
export async function closeLiveHtml(): Promise<void> {
  if (!browserView) return;
  try {
    await browserView.webContents.executeJavaScript('document.close()');
  } catch (err: any) {
    log.warn('LivePreview close failed:', err?.message);
  }
  // Update tab title from the rendered page
  if (livePreviewTabId) {
    const entry = tabs.get(livePreviewTabId);
    if (entry) {
      const title = browserView.webContents.getTitle();
      entry.title = title || 'Live Preview';
      emitTabState();
    }
  }
}

// ---------------------------------------------------------------------------
// Wait for BrowserView load — event-driven replacement for hardcoded timeouts
// ---------------------------------------------------------------------------

/**
 * Wait for the BrowserView's `did-stop-loading` event, with a timeout.
 * Resolves immediately if the view is already loaded (not loading).
 */
export function waitForLoad(timeoutMs = 1500): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!browserView) { resolve(); return; }
    const wc = browserView.webContents;
    if (!wc.isLoading()) { resolve(); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, timeoutMs);
    const onStop = () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(); }
    };
    wc.once('did-stop-loading', onStop);
    wc.once('did-fail-load', onStop);
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

export function setupBrowserIpc(): void {
  handleValidated(IPC.BROWSER_NAVIGATE, ipcSchemas[IPC.BROWSER_NAVIGATE], async (_event, payload) => navigate(payload.url));

  handleValidated(IPC.BROWSER_BACK, ipcSchemas[IPC.BROWSER_BACK], async () => {
    const view = browserView;
    if (!view || !activeTabId) return { success: false };
    const entry = tabs.get(activeTabId);
    if (!entry || entry.historyBack.length === 0) return { success: false };

    // Pop from back stack, push current URL onto forward stack
    const prevUrl = entry.historyBack.pop()!;
    entry.historyForward.push(entry.url);

    suppressHistoryPush = true;
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    try {
      await view.webContents.loadURL(prevUrl);
    } catch {
      // Restore stacks on failure
      entry.historyBack.push(prevUrl);
      entry.historyForward.pop();
      suppressHistoryPush = false;
    }
    updateActiveTab();
    emitTabState();
    return { success: true };
  });

  handleValidated(IPC.BROWSER_FORWARD, ipcSchemas[IPC.BROWSER_FORWARD], async () => {
    const view = browserView;
    if (!view || !activeTabId) return { success: false };
    const entry = tabs.get(activeTabId);
    if (!entry || entry.historyForward.length === 0) return { success: false };

    // Pop from forward stack, push current URL onto back stack
    const nextUrl = entry.historyForward.pop()!;
    entry.historyBack.push(entry.url);

    suppressHistoryPush = true;
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    try {
      await view.webContents.loadURL(nextUrl);
    } catch {
      // Restore stacks on failure
      entry.historyForward.push(nextUrl);
      entry.historyBack.pop();
      suppressHistoryPush = false;
    }
    updateActiveTab();
    emitTabState();
    return { success: true };
  });

  handleValidated(IPC.BROWSER_REFRESH, ipcSchemas[IPC.BROWSER_REFRESH], async () => {
    const view = browserView;
    if (!view) return { success: false };
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    view.webContents.reload();
    return { success: true };
  });

  handleValidated(IPC.BROWSER_SET_BOUNDS, ipcSchemas[IPC.BROWSER_SET_BOUNDS], async (_event, bounds) => {
    currentBounds = bounds;
    if (browserView) {
      browserView.setBounds(bounds);
    }
    return { success: true };
  });

  handleValidated(IPC.BROWSER_TAB_NEW, ipcSchemas[IPC.BROWSER_TAB_NEW], async (_event, payload) => {
    const tabId = await createTab(payload.url || 'about:blank');
    return { success: true, tabId };
  });

  handleValidated(IPC.FILE_OPEN_IN_APP, ipcSchemas[IPC.FILE_OPEN_IN_APP], async (_event, payload) => {
    try {
      let filePath = String(payload.filePath || '').trim();
      if (filePath.startsWith('~')) {
        filePath = path.join(homedir(), filePath.slice(1));
      }
      filePath = path.resolve(filePath);
      if (!filePath.startsWith(homedir())) {
        return { success: false, error: 'Refusing to open files outside the user home directory.' };
      }
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return { success: false, error: 'Path is not a file.' };
      }
      const fileUrl = pathToFileURL(filePath).toString();
      const tabId = await createTab(fileUrl);
      return { success: true, tabId };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Failed to open file in app.' };
    }
  });

  handleValidated(IPC.BROWSER_TAB_LIST, ipcSchemas[IPC.BROWSER_TAB_LIST], async () => ({
    success: true,
    tabs: getTabsSnapshot(),
  }));

  handleValidated(IPC.BROWSER_TAB_SWITCH, ipcSchemas[IPC.BROWSER_TAB_SWITCH], async (_event, payload) => {
    await switchTab(payload.tabId);
    return { success: true };
  });

  handleValidated(IPC.BROWSER_TAB_CLOSE, ipcSchemas[IPC.BROWSER_TAB_CLOSE], async (_event, payload) => {
    await closeTab(payload.tabId);
    return { success: true };
  });

  handleValidated(IPC.BROWSER_HISTORY_GET, ipcSchemas[IPC.BROWSER_HISTORY_GET], async () => ({
    success: true,
    history: getBrowserHistory(),
  }));

  handleValidated(IPC.BROWSER_HISTORY_CLEAR, ipcSchemas[IPC.BROWSER_HISTORY_CLEAR], async () => {
    clearBrowserHistory();
    return { success: true };
  });

  handleValidated(IPC.BROWSER_COOKIES_CLEAR, ipcSchemas[IPC.BROWSER_COOKIES_CLEAR], async () => {
    await clearBrowserCookies();
    return { success: true };
  });

  handleValidated(IPC.BROWSER_CLEAR_ALL, ipcSchemas[IPC.BROWSER_CLEAR_ALL], async () => {
    await clearAllBrowserData();
    return { success: true };
  });
}

// ---------------------------------------------------------------------------
// Exports used by tools.ts (Playwright-based page reading/interaction)
// ---------------------------------------------------------------------------

/**
 * Get the Playwright Page that wraps the BrowserView.
 * Returns null if Playwright isn't connected.
 */
export function getActivePage(): Page | null {
  ensurePlaywrightPageBinding();
  touchSession();
  return playwrightPage;
}

export function getPlaywrightBrowser(): Browser | null {
  return playwrightBrowser;
}

export async function executeInBrowserView<T = unknown>(script: string): Promise<T | null> {
  if (!browserView) return null;
  try {
    return await browserView.webContents.executeJavaScript(script, true) as T;
  } catch {
    return null;
  }
}

export async function captureBrowserViewScreenshot(quality = 60): Promise<Buffer | null> {
  if (!browserView) return null;
  try {
    const image = await browserView.webContents.capturePage();
    return image.toJPEG(Math.max(20, Math.min(100, quality)));
  } catch {
    return null;
  }
}

export function getAllPages(): Map<string, Page> {
  ensurePlaywrightPageBinding();
  // For tool compat — return the single page if we have it.
  const result = new Map<string, Page>();
  if (playwrightPage && activeTabId) {
    result.set(activeTabId, playwrightPage);
  }
  return result;
}

export function getActiveTabId(): string | null {
  return activeTabId;
}

export function getActiveTabUrl(): string | null {
  if (!activeTabId) return null;
  const entry = tabs.get(activeTabId);
  return entry?.url ?? null;
}

export function listTabs(): BrowserTabInfo[] {
  return getTabsSnapshot();
}

export function getBrowserStatus(): { status: 'ready' | 'active' | 'busy' | 'error' | 'disabled'; currentUrl: string | null } {
  // Check if any session is active
  for (const [, sess] of activeSessions) {
    if (sess.status === 'active') {
      const url = getActiveTabUrl();
      return { status: 'active', currentUrl: url };
    }
  }
  // Has browser context but no active session
  if (browserContext) {
    return { status: 'ready', currentUrl: null };
  }

  if (playwrightInitStarted && !playwrightInitCompleted) {
    return { status: 'busy', currentUrl: null };
  }

  if (playwrightInitCompleted && playwrightInitFailed) {
    return { status: 'error', currentUrl: null };
  }

  return { status: 'ready', currentUrl: null };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function closeBrowser(): Promise<void> {
  stopSessionReaper();
  await cleanupAllSessions('browser-close');

  tabs.clear();
  activeTabId = null;
  playwrightPage = null;

  if (playwrightBrowser) {
    await withSoftTimeout(playwrightBrowser.close(), CLEANUP_STEP_TIMEOUT_MS, 'close playwright browser')
      .catch(() => null);
    playwrightBrowser = null;
    browserContext = null;
  }

  if (browserView) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeBrowserView(browserView);
    }
    if (browserView.webContents && !browserView.webContents.isDestroyed()) {
      browserView.webContents.close();
    }
    browserView = null;
  }
}
