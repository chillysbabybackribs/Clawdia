/**
 * Standalone Playwright browser for headless task execution.
 *
 * Completely separate from Electron's BrowserView — uses playwright.chromium.launch()
 * to start a fresh Chromium process. Each task gets its own BrowserContext + Page
 * via createTaskContext(), while the underlying browser instance is shared and reused.
 *
 * Cookie injection is AUTOMATIC — every context gets the user's Electron session
 * cookies (and Chrome OS cookies as fallback) without the caller needing to opt in.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { createLogger } from '../logger';
import { getCookiesForTask } from './cookie-export';
import type { PlaywrightCookie } from './cookie-import';

const log = createLogger('task-browser');

let browser: Browser | null = null;
let launchPromise: Promise<Browser | null> | null = null;
let shuttingDown = false;

function cookieKey(cookie: PlaywrightCookie): string {
  return `${cookie.domain}:${cookie.path || '/'}:${cookie.name}`;
}

function dedupeCookies(cookies: PlaywrightCookie[]): PlaywrightCookie[] {
  const seen = new Set<string>();
  const out: PlaywrightCookie[] = [];
  for (const c of cookies) {
    const key = cookieKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Lazily launch the standalone Playwright Chromium browser.
 * Returns the browser instance, or null if launch fails.
 */
async function ensureBrowser(): Promise<Browser | null> {
  if (browser && browser.isConnected()) return browser;

  // Coalesce concurrent launch requests
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    try {
      log.info('[TaskBrowser] Launching standalone Chromium...');
      browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
        ],
      });

      browser.on('disconnected', () => {
        if (!shuttingDown) {
          log.warn('[TaskBrowser] Browser disconnected unexpectedly');
        }
        browser = null;
        launchPromise = null;
      });

      log.info('[TaskBrowser] Standalone Chromium launched');
      return browser;
    } catch (err: any) {
      log.error(`[TaskBrowser] Failed to launch Chromium: ${err?.message}`);
      browser = null;
      return null;
    } finally {
      launchPromise = null;
    }
  })();

  return launchPromise;
}

export async function getSharedTaskBrowser(): Promise<Browser | null> {
  return ensureBrowser();
}

export interface TaskBrowserContext {
  context: BrowserContext;
  page: Page;
  cleanup: () => Promise<void>;
}

export interface CreateTaskContextOptions {
  /** Optional URL hint — used to prioritize cookies for the target domain */
  targetUrl?: string;
  /** Optional explicit cookies to inject (merged with auto-exported cookies) */
  cookies?: PlaywrightCookie[];
}

export async function getMergedTaskCookies(targetUrls?: string[], explicitCookies?: PlaywrightCookie[]): Promise<PlaywrightCookie[]> {
  const urls = Array.from(
    new Set(
      (targetUrls || [])
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => u.length > 0),
    ),
  );

  let cookiesToInject: PlaywrightCookie[] = [];

  if (urls.length === 0) {
    try {
      cookiesToInject = await getCookiesForTask();
    } catch (err: any) {
      log.warn(`[TaskBrowser] Failed to export cookies: ${err?.message}`);
    }
  } else {
    const cookieSets = await Promise.all(
      urls.map(async (url) => {
        try {
          return await getCookiesForTask(url);
        } catch (err: any) {
          log.warn(`[TaskBrowser] Failed to export cookies for ${url}: ${err?.message}`);
          return [];
        }
      }),
    );
    cookiesToInject = cookieSets.flat();
  }

  if (explicitCookies && explicitCookies.length > 0) {
    const explicitMap = new Map<string, PlaywrightCookie>();
    for (const c of explicitCookies) {
      explicitMap.set(cookieKey(c), c);
    }
    cookiesToInject = cookiesToInject.filter((c) => !explicitMap.has(cookieKey(c)));
    cookiesToInject.push(...explicitCookies);
  }

  return dedupeCookies(cookiesToInject);
}

/**
 * Create an isolated BrowserContext + Page for a single task.
 * The underlying Chromium process is lazily started on first call and shared.
 *
 * Cookie injection is AUTOMATIC:
 * 1. Exports fresh cookies from Electron's BrowserView session
 * 2. Falls back to Chrome OS cookies if Electron has none for the target domain
 * 3. Merges with any explicit cookies passed in options
 *
 * @returns Object with context, page, and cleanup() — caller MUST call cleanup when done.
 *          Returns null if Playwright is unavailable.
 */
export async function createTaskContext(options?: CreateTaskContextOptions): Promise<TaskBrowserContext | null> {
  const b = await ensureBrowser();
  if (!b) {
    log.warn('[TaskBrowser] Browser unavailable — task will run without browser tools');
    return null;
  }

  try {
    const context = await b.newContext();

    const cookiesToInject = await getMergedTaskCookies(
      options?.targetUrl ? [options.targetUrl] : undefined,
      options?.cookies,
    );

    // Inject cookies into the context
    if (cookiesToInject.length > 0) {
      await context.addCookies(cookiesToInject);
      log.info(`[TaskBrowser] Injected ${cookiesToInject.length} cookies into task context`);
    } else {
      log.warn('[TaskBrowser] No cookies available — task context has no authentication');
    }

    const page = await context.newPage();

    const cleanup = async () => {
      try {
        if (!page.isClosed()) await page.close().catch(() => {});
      } catch { /* ignore */ }
      try {
        await context.close().catch(() => {});
      } catch { /* ignore */ }
      log.info('[TaskBrowser] Task context cleaned up');
    };

    log.info('[TaskBrowser] Created task context + page');
    return { context, page, cleanup };
  } catch (err: any) {
    log.error(`[TaskBrowser] Failed to create task context: ${err?.message}`);
    return null;
  }
}

/**
 * Whether the standalone browser is currently launched and connected.
 */
export function isAvailable(): boolean {
  return browser !== null && browser.isConnected();
}

/**
 * Shut down the standalone Playwright browser.
 * Called during app quit.
 */
export async function shutdown(): Promise<void> {
  if (!browser) return;
  shuttingDown = true;
  try {
    log.info('[TaskBrowser] Shutting down standalone Chromium...');
    await browser.close();
    log.info('[TaskBrowser] Standalone Chromium closed');
  } catch (err: any) {
    log.warn(`[TaskBrowser] Error during shutdown: ${err?.message}`);
  } finally {
    browser = null;
    launchPromise = null;
    shuttingDown = false;
  }
}
