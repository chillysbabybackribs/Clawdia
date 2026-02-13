import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { createLogger } from '../logger';
import { getPlaywrightBrowser } from './manager';
import { compressPageContent } from '../content/compressor';

const log = createLogger('browser-pool');

// Standalone headless browser for batch operations (CDP can't create new pages)
let standaloneBrowser: Browser | null = null;

async function getStandaloneBrowser(): Promise<Browser> {
  if (!standaloneBrowser || !standaloneBrowser.isConnected()) {
    log.info('Launching standalone headless browser for batch operations');
    standaloneBrowser = await chromium.launch({
      headless: true,
    });
  }
  return standaloneBrowser;
}

export async function closeStandaloneBrowser(): Promise<void> {
  if (standaloneBrowser) {
    log.info('Closing standalone browser');
    await standaloneBrowser.close().catch(() => null);
    standaloneBrowser = null;
  }
}

const DEFAULT_MAX_CONCURRENCY = 5;
const HARD_MAX_CONCURRENCY = 5;
const HARD_MAX_OPERATIONS = 10;
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 5_000;

export interface PoolConfig {
  maxConcurrency: number;
  pageTimeout: number;
  batchTimeout: number;
}

export type PageAction = 'extract' | 'screenshot' | 'pdf' | 'intercept_network';

export interface PageOperation {
  url: string;
  actions: PageAction[];
  extract_schema?: Record<string, string>;
  wait_for?: 'networkidle' | 'domcontentloaded' | 'load' | string;
  evaluate?: string;
  full_page?: boolean;
}

export interface InterceptedRequest {
  url: string;
  method: string;
  status?: number;
  response_type: string;
}

export interface SourceFragment {
  type: string;
  html: string;
  text: string;
}

export interface PageResult {
  url: string;
  status: 'success' | 'error';
  title?: string;
  content?: string;
  extracted?: Record<string, unknown>;
  fragments?: SourceFragment[];
  favicon?: string;
  screenshot_base64?: string;
  pdf_base64?: string;
  intercepted_requests?: InterceptedRequest[];
  evaluated?: unknown;
  error?: string;
  time_ms: number;
}

export interface PoolExecuteOptions {
  parallel?: boolean;
  extractor?: (
    pageData: Record<string, unknown>,
    schema: Record<string, string>
  ) => Promise<Record<string, unknown>>;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return this.makeRelease();
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

class PlaywrightPool {
  private config: PoolConfig;

  constructor(private readonly getBrowser: () => Browser | null, config?: Partial<PoolConfig>) {
    this.config = {
      maxConcurrency: Math.min(HARD_MAX_CONCURRENCY, Math.max(1, config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)),
      pageTimeout: config?.pageTimeout ?? DEFAULT_PAGE_TIMEOUT_MS,
      batchTimeout: config?.batchTimeout ?? DEFAULT_BATCH_TIMEOUT_MS,
    };
  }

  setConfig(next: Partial<PoolConfig>): void {
    this.config = {
      maxConcurrency: Math.min(HARD_MAX_CONCURRENCY, Math.max(1, next.maxConcurrency ?? this.config.maxConcurrency)),
      pageTimeout: next.pageTimeout ?? this.config.pageTimeout,
      batchTimeout: next.batchTimeout ?? this.config.batchTimeout,
    };
  }

  async execute(operations: PageOperation[], options?: PoolExecuteOptions): Promise<PageResult[]> {
    if (operations.length > HARD_MAX_OPERATIONS) {
      return operations.map((op) => ({
        url: op.url,
        status: 'error',
        error: `Too many operations: ${operations.length}. Maximum is ${HARD_MAX_OPERATIONS}.`,
        time_ms: 0,
      }));
    }

    // Use standalone headless browser for batch operations (CDP can't create new pages)
    let browser: Browser;
    try {
      browser = await getStandaloneBrowser();
    } catch (err: any) {
      return operations.map((op) => ({
        url: op.url,
        status: 'error',
        error: `Failed to launch standalone browser: ${err?.message || 'Unknown error'}`,
        time_ms: 0,
      }));
    }

    const batchStart = Date.now();

    const maxConcurrency = options?.parallel === false
      ? 1
      : Math.min(this.config.maxConcurrency, Math.max(1, operations.length));

    const semaphore = new Semaphore(maxConcurrency);
    const contexts = new Set<BrowserContext>();
    const pageStates = operations.map((op) => ({
      url: op.url,
      startedAt: Date.now(),
      settled: false,
      result: null as PageResult | null,
    }));

    let batchTimedOut = false;

    // Create a fresh context in the standalone browser for this batch
    let sharedContext: BrowserContext;
    try {
      sharedContext = await browser.newContext();
      contexts.add(sharedContext);
    } catch (err: any) {
      return operations.map((op) => ({
        url: op.url,
        status: 'error' as const,
        error: `Failed to create browser context: ${err?.message || 'Unknown error'}`,
        time_ms: 0,
      }));
    }

    const pagesToCleanup = new Set<Page>();

    const tasks = operations.map(async (op, index) => {
      const release = await semaphore.acquire();
      if (batchTimedOut) {
        release();
        return;
      }

      let page: Page | null = null;
      try {
        // Create a new page within the shared context (works with CDP)
        page = await sharedContext.newPage();
        pagesToCleanup.add(page);
        const result = await this.executeOperationWithPage(page, op, options);
        if (!pageStates[index].settled) {
          pageStates[index].settled = true;
          pageStates[index].result = result;
        }
      } catch (err: any) {
        if (!pageStates[index].settled) {
          pageStates[index].settled = true;
          pageStates[index].result = {
            url: op.url,
            status: 'error',
            error: err?.message || 'Operation failed',
            time_ms: Date.now() - pageStates[index].startedAt,
          };
        }
      } finally {
        if (page) {
          pagesToCleanup.delete(page);
          await page.close().catch(() => null);
        }
        release();
      }
    });

    const allDone = Promise.allSettled(tasks);
    const timeoutSignal = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), this.config.batchTimeout);
    });

    const raceResult = await Promise.race([allDone, timeoutSignal]);

    if (raceResult === 'timeout') {
      batchTimedOut = true;

      for (const [index, state] of pageStates.entries()) {
        if (!state.settled) {
          state.settled = true;
          state.result = {
            url: operations[index].url,
            status: 'error',
            error: `Batch timeout after ${this.config.batchTimeout}ms`,
            time_ms: this.config.batchTimeout,
          };
        }
      }

      await Promise.allSettled(
        Array.from(contexts.values()).map((ctx) => ctx.close().catch(() => null))
      );
    }

    const results = pageStates.map((state, index) => state.result ?? {
      url: operations[index].url,
      status: 'error' as const,
      error: 'Operation did not complete',
      time_ms: Date.now() - state.startedAt,
    });

    const totalMs = Date.now() - batchStart;
    log.info('Pool batch complete', {
      operations: operations.length,
      maxConcurrency,
      batchTimedOut,
      totalMs,
      succeeded: results.filter((r) => r.status === 'success').length,
      failed: results.filter((r) => r.status === 'error').length,
    });

    return results;
  }

  private async executeOperation(
    context: BrowserContext,
    op: PageOperation,
    options?: PoolExecuteOptions,
  ): Promise<PageResult> {
    const page = await context.newPage();
    try {
      return await this.executeOperationWithPage(page, op, options);
    } finally {
      await page.close().catch(() => null);
    }
  }

  private async executeOperationWithPage(
    page: Page,
    op: PageOperation,
    options?: PoolExecuteOptions,
  ): Promise<PageResult> {
    const start = Date.now();
    page.setDefaultTimeout(this.config.pageTimeout);
    page.setDefaultNavigationTimeout(this.config.pageTimeout);

    const result: PageResult = {
      url: op.url,
      status: 'success',
      time_ms: 0,
    };

    try {
      let intercepted: InterceptedRequest[] = [];

      if (op.actions.includes('intercept_network')) {
        page.on('response', (response) => {
          const req = response.request();
          const type = req.resourceType();
          if (type !== 'xhr' && type !== 'fetch') return;
          intercepted.push({
            url: response.url(),
            method: req.method(),
            status: response.status(),
            response_type: response.headers()['content-type'] || 'unknown',
          });
        });
      }

      const waitFor = op.wait_for;
      const waitUntil = waitFor === 'networkidle' || waitFor === 'domcontentloaded' || waitFor === 'load'
        ? waitFor
        : 'load';

      await page.goto(op.url, { waitUntil, timeout: this.config.pageTimeout });

      if (waitFor && !['networkidle', 'domcontentloaded', 'load'].includes(waitFor)) {
        await page.waitForSelector(waitFor, { timeout: 5_000 }).catch(() => null);
      }

      result.title = await page.title().catch(() => '');
      const rawContent = await page.evaluate(() => {
        const main = document.querySelector('main, article, [role="main"]');
        const text = (main || document.body).textContent?.trim() || '';
        return text.substring(0, 30_000); // Grab more raw text; compressor will reduce it
      });
      const compressed = compressPageContent(rawContent, { maxChars: 8_000 });
      result.content = compressed.text;

      // Extract favicon
      result.favicon = await page.evaluate(() => {
        const link = document.querySelector('link[rel*="icon"]') as HTMLLinkElement | null;
        if (link?.href) return link.href;
        // Fallback to /favicon.ico
        return new URL('/favicon.ico', window.location.origin).href;
      }).catch(() => undefined);

      // Extract key fragments for source collage
      result.fragments = await page.evaluate(() => {
        const fragments: Array<{ type: string; html: string; text: string }> = [];
        const seen = new Set<string>();
        const addFragment = (type: string, el: Element) => {
          const text = el.textContent?.trim() || '';
          if (!text || text.length < 20 || seen.has(text)) return;
          seen.add(text);
          // Clone and sanitize HTML
          const clone = el.cloneNode(true) as Element;
          // Remove scripts, styles, event handlers
          clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
          // Remove all event handlers and dangerous attributes
          const sanitize = (node: Element) => {
            Array.from(node.attributes).forEach(attr => {
              if (attr.name.startsWith('on') || attr.name === 'href' && attr.value.startsWith('javascript:')) {
                node.removeAttribute(attr.name);
              }
            });
            Array.from(node.children).forEach(sanitize);
          };
          sanitize(clone);
          fragments.push({
            type,
            html: clone.outerHTML.substring(0, 2000), // Limit HTML size
            text: text.substring(0, 500),
          });
        };

        const main = document.querySelector('main, article, [role="main"]') || document.body;
        
        // Get main headline
        const h1 = main.querySelector('h1');
        if (h1) addFragment('headline', h1);
        
        // Get key subheadings (first 2)
        const h2s = main.querySelectorAll('h2');
        Array.from(h2s).slice(0, 2).forEach(h => addFragment('headline', h));
        
        // Get lead paragraphs (first 2 substantial ones)
        const paragraphs = main.querySelectorAll('p');
        let pCount = 0;
        for (const p of Array.from(paragraphs)) {
          const text = p.textContent?.trim() || '';
          if (text.length > 80 && pCount < 2) {
            addFragment('paragraph', p);
            pCount++;
          }
        }
        
        // Get blockquotes
        const quotes = main.querySelectorAll('blockquote');
        Array.from(quotes).slice(0, 1).forEach(q => addFragment('quote', q));
        
        // Get lists with useful content
        const lists = main.querySelectorAll('ul, ol');
        for (const list of Array.from(lists).slice(0, 1)) {
          const items = list.querySelectorAll('li');
          if (items.length >= 3 && items.length <= 10) {
            addFragment('list', list);
          }
        }

        return fragments.slice(0, 5); // Max 5 fragments per page
      }).catch(() => []);

      if (op.actions.includes('extract') && op.extract_schema) {
        const pageData = await page.evaluate(() => {
          const desc = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
          return {
            title: document.title,
            metaDescription: desc?.content || '',
            headings: Array.from(document.querySelectorAll('h1,h2,h3'))
              .map((h) => h.textContent?.trim() || '')
              .filter(Boolean),
            mainText: (
              document.querySelector('main, article, [role="main"]')?.textContent?.trim()
              || document.body.textContent?.trim()
              || ''
            ).substring(0, 8_000),
            links: Array.from(document.querySelectorAll('a[href]'))
              .slice(0, 50)
              .map((a) => ({
                text: a.textContent?.trim() || '',
                href: (a as HTMLAnchorElement).href,
              })),
          };
        });

        if (options?.extractor) {
          result.extracted = await options.extractor(pageData, op.extract_schema);
        } else {
          result.extracted = pageData;
        }
      }

      if (op.actions.includes('screenshot')) {
        const screenshot = await page.screenshot({ type: 'png', fullPage: Boolean(op.full_page) });
        result.screenshot_base64 = screenshot.toString('base64');
      }

      if (op.actions.includes('pdf')) {
        const pdf = await page.pdf({ format: 'A4' });
        result.pdf_base64 = pdf.toString('base64');
      }

      if (op.actions.includes('intercept_network')) {
        result.intercepted_requests = intercepted;
      }

      if (op.evaluate && op.evaluate.trim()) {
        result.evaluated = await this.evaluateWithTimeout(page, op.evaluate, DEFAULT_EVALUATE_TIMEOUT_MS);
      }

      result.time_ms = Date.now() - start;
      log.info('Pool page complete', {
        url: op.url,
        status: result.status,
        timeMs: result.time_ms,
      });
      return result;
    } catch (err: any) {
      const failed: PageResult = {
        url: op.url,
        status: 'error',
        error: err?.message || 'Operation failed',
        time_ms: Date.now() - start,
      };
      log.warn('Pool page failed', {
        url: op.url,
        timeMs: failed.time_ms,
        error: failed.error,
      });
      return failed;
    }
  }

  private async evaluateWithTimeout(page: Page, script: string, timeoutMs: number): Promise<unknown> {
    return await Promise.race([
      page.evaluate((code) => {
        // eslint-disable-next-line no-eval
        return eval(code);
      }, script),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`page.evaluate timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }
}

let singleton: PlaywrightPool | null = null;

export function getPlaywrightPool(config?: Partial<PoolConfig>): PlaywrightPool {
  if (!singleton) {
    singleton = new PlaywrightPool(() => getPlaywrightBrowser(), config);
  } else if (config) {
    singleton.setConfig(config);
  }
  return singleton;
}

export function resetPlaywrightPoolForTests(): void {
  singleton = null;
}
