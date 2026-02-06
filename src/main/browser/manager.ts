import { BrowserView, BrowserWindow, ipcMain } from 'electron';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { IPC, IPC_EVENTS } from '../../shared/ipc-channels';
import { BrowserTabInfo } from '../../shared/types';
import { wireUniversalPopupDismissal } from './popup-dismissal';

const TABS_UPDATED_EVENT = IPC_EVENTS.BROWSER_TABS_UPDATED;

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;
let currentBounds: { x: number; y: number; width: number; height: number } | null = null;

// Playwright state — optional overlay for automation / page reading.
let playwrightBrowser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let playwrightPage: Page | null = null;   // Wraps the BrowserView CDP target

// Simple tab bookkeeping driven by BrowserView (no Playwright newPage).
let tabCounter = 0;
interface TabEntry { id: string; url: string; title: string; }
const tabs: Map<string, TabEntry> = new Map();
let activeTabId: string | null = null;
let livePreviewTabId: string | null = null;

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
];

const NOISE_PATTERNS = [
  'already loaded', 'pixel install successful', 'pixel version',
  'theme extension loaded', 'sandbox_bundle', 'content-security-policy',
  'overflow: visible', 'productatcs', 'display cart', '%c', 'sectionfocus',
  'customer events tracker', 'run pagefly', 'm.ai', 'k-web-pixel',
  'sandbox warning',
];

function withProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return 'about:blank';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('about:')) {
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

// ---------------------------------------------------------------------------
// OAuth / auth popup support
// ---------------------------------------------------------------------------

const AUTH_URL_PATTERNS = [
  'accounts.google.com',
  'appleid.apple.com/auth',
  'login.microsoftonline.com',
  'github.com/login/oauth',
  'api.twitter.com/oauth',
  'www.facebook.com/v',
  'www.facebook.com/dialog/oauth',
  'discord.com/oauth2',
  'slack.com/oauth',
  'login.salesforce.com',
  'auth0.com/authorize',
  'accounts.spotify.com',
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

function openAuthPopup(url: string): void {
  console.log(`[Auth] Opening auth popup for: ${url}`);

  // Extract the origin of the page that initiated the auth flow
  const openerOrigin = browserView
    ? new URL(browserView.webContents.getURL()).origin
    : null;

  const popup = new BrowserWindow({
    width: 500,
    height: 700,
    parent: mainWindow ?? undefined,
    modal: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Clean the user agent to match the BrowserView
  const defaultUA = popup.webContents.getUserAgent();
  const cleanUA = defaultUA.replace(/\s*Electron\/\S+/i, '').replace(/\s*clawdia\/\S+/i, '');
  popup.webContents.setUserAgent(cleanUA);

  popup.webContents.on('will-navigate', (_event, navUrl) => {
    console.log(`[Auth] Popup navigating to: ${navUrl}`);
  });

  // Detect when the OAuth flow redirects back to the opener's origin.
  // This means auth is complete — close the popup and reload the BrowserView.
  popup.webContents.on('did-navigate', (_event, navUrl) => {
    try {
      const navOrigin = new URL(navUrl).origin;
      if (openerOrigin && navOrigin === openerOrigin) {
        console.log(`[Auth] Auth complete — redirected back to ${navOrigin}`);
        if (browserView) {
          void browserView.webContents.loadURL(navUrl).catch(() => null);
        }
        popup.close();
      }
    } catch { /* ignore invalid URLs */ }
  });

  // Handle the popup closing itself (window.close()) — standard OAuth behavior
  popup.on('closed', () => {
    console.log('[Auth] Auth popup closed');
    // Refresh the BrowserView to pick up any new session/cookies
    if (browserView) {
      browserView.webContents.reload();
    }
  });

  void popup.loadURL(url);
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

  const defaultUA = browserView.webContents.getUserAgent();
  const cleanUA = defaultUA.replace(/\s*Electron\/\S+/i, '').replace(/\s*clawdia\/\S+/i, '');
  browserView.webContents.setUserAgent(cleanUA);
  console.log(`[BrowserView] UA set to: ${cleanUA}`);

  if (mainWindow) {
    mainWindow.addBrowserView(browserView);
    if (currentBounds) {
      browserView.setBounds(currentBounds);
    }

    browserView.webContents.on('did-start-navigation', () => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    });

    browserView.webContents.on('did-navigate', (_event, url) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_NAVIGATED, url);
      updateActiveTab();
      emitTabState();
    });

    browserView.webContents.on('did-navigate-in-page', (_event, url) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_NAVIGATED, url);
      updateActiveTab();
      emitTabState();
    });

    browserView.webContents.on('page-title-updated', (_event, title) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE, title);
      updateActiveTab();
      emitTabState();
    });

    browserView.webContents.on('did-start-loading', () => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    });

    browserView.webContents.on('did-stop-loading', () => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
    });

    browserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_ERROR, `${errorDescription} (${errorCode})`);
    });

    browserView.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (!message) return;
      const normalizedMessage = message.toLowerCase();
      const normalizedSource = (sourceId || '').toLowerCase();
      if (NOISY_SOURCES.some((src) => normalizedSource.includes(src) || normalizedMessage.includes(src))) return;
      if (NOISE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern))) return;
      if (level < 2) return;

      const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? `L${level}`;
      const preview = message.length > 200 ? `${message.slice(0, 200)}...` : message;
      const srcInfo = sourceId ? ` (${sourceId}:${line})` : '';
      console.log(`[BrowserView:${levelName}] ${preview}${srcInfo}`);
    });

    browserView.webContents.setWindowOpenHandler(({ url }) => {
      if (isAuthUrl(url)) {
        openAuthPopup(url);
        return { action: 'deny' };
      }
      void navigate(url);
      return { action: 'deny' };
    });
  }

  return browserView;
}

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  console.log('[BrowserView] setMainWindow called, creating BrowserView...');
  ensureBrowserView();
  console.log(`[BrowserView] BrowserView created, attached=${!!browserView}`);
}

// ---------------------------------------------------------------------------
// Playwright CDP connection (optional — wraps BrowserView for tool automation)
// ---------------------------------------------------------------------------

const CDP_MAX_RETRIES = 5;
const CDP_RETRY_DELAY_MS = 1000;

async function probeCDP(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const info = await res.json();
      console.log(`[Browser] CDP probe :${port} OK — ${info?.Browser || 'unknown'}`);
      return info?.webSocketDebuggerUrl || null;
    }
  } catch { /* not responding */ }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function connectCDP(): Promise<boolean> {
  const port = cdpPort();
  console.log(`[Browser] Will connect to CDP on :${port} (PID ${process.pid})`);

  for (let attempt = 1; attempt <= CDP_MAX_RETRIES; attempt++) {
    const wsUrl = await probeCDP(port);
    if (!wsUrl) {
      console.log(`[Browser] CDP :${port} not responding (attempt ${attempt}/${CDP_MAX_RETRIES})`);
      if (attempt < CDP_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, CDP_RETRY_DELAY_MS));
      }
      continue;
    }

    try {
      const httpEndpoint = `http://127.0.0.1:${port}`;
      console.log(`[Browser] Connecting Playwright via ${httpEndpoint} (attempt ${attempt})...`);
      playwrightBrowser = await withTimeout(chromium.connectOverCDP(httpEndpoint), 10000, 'connectOverCDP');
      const contexts = playwrightBrowser.contexts();
      console.log(`[Browser] Playwright connected — ${contexts.length} context(s)`);
      return true;
    } catch (err: any) {
      console.warn(`[Browser] CDP connect failed: ${err?.message || err}`);
      playwrightBrowser = null;
      if (attempt < CDP_MAX_RETRIES) {
        console.log(`[Browser] Waiting ${CDP_RETRY_DELAY_MS}ms before retry ${attempt + 1}...`);
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
  console.log(`[Browser] Looking for BrowserView page among ${allPages.length} CDP page(s), BV url="${bvUrl}"`);

  // The BrowserView is typically the page whose URL is NOT the renderer (localhost:5173).
  for (const page of allPages) {
    const pUrl = page.url() || '';
    if (!pUrl.includes('localhost:5173') && !pUrl.includes('devtools://')) {
      console.log(`[Browser] Matched BrowserView page: ${pUrl}`);
      return page;
    }
  }

  // Fallback: pick the last page (BrowserView is usually created after the main window).
  if (allPages.length > 1) {
    const last = allPages[allPages.length - 1];
    console.log(`[Browser] Fallback: using last page: ${last.url()}`);
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
  console.log(`[Browser] Bound Playwright page: ${page.url()}`);
}

export async function initPlaywright(): Promise<void> {
  console.log('[Browser] initPlaywright called');
  if (playwrightBrowser && browserContext) {
    console.log('[Browser] Already initialized, resolving immediately');
    playwrightReadyResolve();
    return;
  }

  const connected = await connectCDP();
  console.log(`[Browser] connectCDP returned: ${connected}`);

  if (!connected) {
    console.error('[Browser] CDP connection failed. Playwright tools unavailable — BrowserView-only mode.');
    playwrightReadyResolve();
    return;
  }

  browserContext = playwrightBrowser!.contexts()[0] ?? null;
  if (!browserContext) {
    console.error('[Browser] No browser context found after CDP connect.');
    playwrightReadyResolve();
    return;
  }
  await browserContext.clearPermissions().catch(() => null);
  await browserContext.grantPermissions([]).catch(() => null);

  // Find the page backing our BrowserView — don't create new pages.
  const page = findBrowserViewPage();
  if (page) {
    bindPlaywrightPage(page);
    console.log(`[Browser] Playwright wrapping BrowserView page: ${page.url()}`);
  } else {
    console.warn('[Browser] Could not find BrowserView page in CDP targets. Tools may not work.');
  }

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
  tabs.set(id, { id, url, title: '' });
  activeTabId = id;
  return id;
}

export async function createTab(url = 'about:blank'): Promise<string> {
  const targetUrl = withProtocol(url);
  const tabId = newTab(targetUrl);
  console.log(`[Browser] createTab: ${tabId} → ${targetUrl}`);

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
  activeTabId = tabId;

  // Load the tab's last known URL in the BrowserView.
  const view = ensureBrowserView();
  if (entry.url && entry.url !== 'about:blank') {
    try { await view.webContents.loadURL(entry.url); } catch { /* best-effort */ }
  }

  updateActiveTab();
  emitTabState();
}

export async function closeTab(tabId: string): Promise<void> {
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
    console.log('[LivePreview] Reusing tab, calling document.open()');
    await view.webContents.executeJavaScript('document.open(); "ok"');
    await view.webContents.executeJavaScript(`document.write(${JSON.stringify(QUALITY_BASELINE_CSS)})`);
    console.log('[LivePreview] document.open() done + baseline CSS injected');
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
  console.log('[LivePreview] New tab loaded, calling document.open()');
  await view.webContents.executeJavaScript('document.open(); "ok"');
  await view.webContents.executeJavaScript(`document.write(${JSON.stringify(QUALITY_BASELINE_CSS)})`);
  console.log('[LivePreview] document.open() done + baseline CSS injected');

  emitTabState();
  return tabId;
}

/**
 * Write a chunk of HTML to the live preview document.
 */
export async function writeLiveHtml(html: string): Promise<void> {
  if (!browserView) {
    console.warn('[LivePreview] write skipped: no browserView');
    return;
  }
  try {
    const escaped = JSON.stringify(html);
    const preview = html.length > 80 ? html.slice(0, 80) + '...' : html;
    console.log(`[LivePreview] writing ${html.length} chars: ${preview}`);
    await browserView.webContents.executeJavaScript(`document.write(${escaped})`);
  } catch (err: any) {
    console.warn('[LivePreview] write failed:', err?.message);
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
    console.warn('[LivePreview] close failed:', err?.message);
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
export function waitForLoad(timeoutMs = 3000): Promise<void> {
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
  ipcMain.handle(IPC.BROWSER_NAVIGATE, async (_event, url: string) => navigate(url));

  ipcMain.handle(IPC.BROWSER_BACK, async () => {
    const view = browserView;
    if (!view) return { success: false };
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    view.webContents.goBack();
    return { success: true };
  });

  ipcMain.handle(IPC.BROWSER_FORWARD, async () => {
    const view = browserView;
    if (!view) return { success: false };
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    view.webContents.goForward();
    return { success: true };
  });

  ipcMain.handle(IPC.BROWSER_REFRESH, async () => {
    const view = browserView;
    if (!view) return { success: false };
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    view.webContents.reload();
    return { success: true };
  });

  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    currentBounds = bounds;
    if (browserView) {
      browserView.setBounds(bounds);
    }
    return { success: true };
  });

  ipcMain.handle(IPC.BROWSER_TAB_NEW, async (_event, url?: string) => {
    const tabId = await createTab(url || 'about:blank');
    return { success: true, tabId };
  });

  ipcMain.handle(IPC.BROWSER_TAB_LIST, async () => ({
    success: true,
    tabs: getTabsSnapshot(),
  }));

  ipcMain.handle(IPC.BROWSER_TAB_SWITCH, async (_event, tabId: string) => {
    await switchTab(tabId);
    return { success: true };
  });

  ipcMain.handle(IPC.BROWSER_TAB_CLOSE, async (_event, tabId: string) => {
    await closeTab(tabId);
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
  return playwrightPage;
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

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function closeBrowser(): Promise<void> {
  tabs.clear();
  activeTabId = null;
  playwrightPage = null;

  if (playwrightBrowser) {
    await playwrightBrowser.close().catch(() => null);
    playwrightBrowser = null;
    browserContext = null;
  }

  if (browserView && mainWindow) {
    mainWindow.removeBrowserView(browserView);
    browserView.webContents.close();
    browserView = null;
  }
}
